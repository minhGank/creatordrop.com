-- Phase 9 security/correctness remediation only: stable inventory-pool identity,
-- opening-linked stock consumption, bidirectional opening-ledger linkage, and
-- non-reversible opening financial legs.

set role creatordrop_migrator;

-- Inventory-pool identity is operational state and must survive immutable reward
-- snapshot changes. Existing Phase 9 rows keep their current pool UUID; only the
-- relationship moves onto the reward-version snapshot.
alter table app.reward_versions
  add column inventory_pool_id uuid;

alter table app.reward_versions disable trigger reward_versions_published_immutable;
alter table app.reward_versions disable trigger reward_versions_referenced_immutable;

update app.reward_versions as reward_version
set inventory_pool_id = pool.id
from app.inventory_pools as pool
where pool.reward_version_id = reward_version.id;

alter table app.reward_versions enable trigger reward_versions_published_immutable;
alter table app.reward_versions enable trigger reward_versions_referenced_immutable;

drop trigger reward_versions_inventory_pool_sync on app.reward_versions;
drop function app_private.sync_reward_inventory_pool();
drop trigger inventory_pools_update_guard on app.inventory_pools;
drop function app_private.guard_inventory_pool_update();
drop trigger inventory_pools_delete_guard on app.inventory_pools;
drop function app_private.guard_inventory_pool_delete();

alter table app.inventory_pools
  drop constraint inventory_pools_reward_version_id_fkey,
  drop constraint inventory_pools_reward_version_id_key,
  drop constraint inventory_pools_reward_identity,
  drop column reward_version_id;

alter table app.reward_versions
  add constraint reward_versions_inventory_pool_fk
    foreign key (inventory_pool_id) references app.inventory_pools (id) on delete restrict,
  add constraint reward_versions_inventory_pool_shape check (
    (inventory_mode = 'unlimited' and inventory_pool_id is null)
    or (inventory_mode = 'finite' and inventory_pool_id is not null)
  );

create index reward_versions_inventory_pool_idx
  on app.reward_versions (inventory_pool_id, id)
  where inventory_pool_id is not null;

create table app.inventory_consumptions (
  opening_id uuid primary key
    references app.box_opens (id) on delete restrict deferrable initially deferred,
  inventory_pool_id uuid not null references app.inventory_pools (id) on delete restrict,
  quantity_consumed bigint not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint inventory_consumptions_one_unit check (quantity_consumed = 1),
  constraint inventory_consumptions_opening_pool_unique unique (opening_id, inventory_pool_id)
);

create index inventory_consumptions_pool_created_idx
  on app.inventory_consumptions (inventory_pool_id, created_at, opening_id);

-- Upgrade any valid local Phase 9 opening history without inventing backorders.
insert into app.inventory_consumptions (
  opening_id,
  inventory_pool_id,
  quantity_consumed,
  created_at
)
select
  opening.id,
  opening.inventory_pool_id,
  1,
  opening.created_at
from app.box_opens as opening
join app.fulfillment_obligations as obligation on obligation.opening_id = opening.id
where opening.inventory_pool_id is not null
  and obligation.status = 'pending_fulfillment';

do $migration_validation$
begin
  if exists (
    select 1
    from app.inventory_pools as pool
    left join app.inventory_consumptions as consumption
      on consumption.inventory_pool_id = pool.id
    group by pool.id
    having pool.initial_quantity - pool.available_quantity
      <> coalesce(sum(consumption.quantity_consumed), 0)
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'inventory_pool_legacy_reconciliation_invalid',
      message = 'Existing inventory pools do not reconcile with Phase 9 opening history.';
  end if;

  if exists (
    select 1
    from app.reward_versions as reward_version
    join app.rewards as reward on reward.id = reward_version.reward_id
    join app.inventory_pools as pool on pool.id = reward_version.inventory_pool_id
    where pool.creator_id <> reward.creator_id
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'reward_version_inventory_pool_creator_invalid',
      message = 'Existing reward-version inventory ownership is invalid.';
  end if;

  if exists (
    select 1
    from app.ledger_transactions as transaction
    left join app.box_opens as opening
      on (
        transaction.kind = 'box_open_sale'
        and opening.sale_ledger_transaction_id = transaction.id
      ) or (
        transaction.kind = 'box_open_allocation'
        and opening.allocation_ledger_transaction_id = transaction.id
      )
    where transaction.kind in ('box_open_sale', 'box_open_allocation')
      and opening.id is null
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'opening_ledger_legacy_linkage_invalid',
      message = 'Existing opening ledger history contains an orphan posting.';
  end if;

  if exists (
    select 1
    from app.ledger_transactions as reversal
    join app.ledger_transactions as original
      on original.id = reversal.reverses_ledger_transaction_id
    where reversal.kind = 'reversal'
      and original.kind in ('box_open_sale', 'box_open_allocation')
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'opening_ledger_legacy_reversal_invalid',
      message = 'Existing opening financial history contains a forbidden reversal.';
  end if;
end
$migration_validation$;

create function app_private.prepare_reward_inventory_pool()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  pool app.inventory_pools%rowtype;
  reward_creator_id uuid;
  pool_is_protected boolean;
begin
  select creator_id into strict reward_creator_id
  from app.rewards
  where id = new.reward_id;

  if new.inventory_mode = 'unlimited' then
    new.inventory_pool_id := null;
    return new;
  end if;

  if new.inventory_pool_id is null then
    if new.state <> 'draft' then
      raise exception using
        errcode = '23514',
        constraint = 'finite_reward_inventory_pool_required',
        message = 'A non-draft finite reward version requires an existing inventory pool.';
    end if;
    new.inventory_pool_id := extensions.gen_random_uuid();
    insert into app.inventory_pools (
      id,
      creator_id,
      stockout_policy,
      initial_quantity,
      available_quantity,
      created_at,
      updated_at
    ) values (
      new.inventory_pool_id,
      reward_creator_id,
      coalesce(new.inventory_stockout_policy, 'pause_box'),
      new.inventory_quantity,
      new.inventory_quantity,
      new.created_at,
      statement_timestamp()
    );
    return new;
  end if;

  select * into pool
  from app.inventory_pools
  where id = new.inventory_pool_id;
  if not found or pool.creator_id <> reward_creator_id then
    raise exception using
      errcode = '23514',
      constraint = 'reward_version_inventory_pool_creator_invalid',
      message = 'The inventory pool does not belong to the reward creator.';
  end if;

  select
    exists (
      select 1 from app.reward_versions
      where inventory_pool_id = pool.id and state <> 'draft'
    ) or exists (
      select 1 from app.inventory_consumptions
      where inventory_pool_id = pool.id
    )
  into pool_is_protected;

  if pool.initial_quantity <> new.inventory_quantity
    or pool.stockout_policy <> coalesce(new.inventory_stockout_policy, 'pause_box') then
    if new.state <> 'draft' or pool_is_protected then
      raise exception using
        errcode = '23514',
        constraint = 'shared_inventory_pool_configuration_immutable',
        message = 'A shared or published inventory pool cannot be reset by a reward version.';
    end if;
    update app.inventory_pools
    set stockout_policy = coalesce(new.inventory_stockout_policy, 'pause_box'),
        initial_quantity = new.inventory_quantity,
        available_quantity = new.inventory_quantity,
        updated_at = statement_timestamp()
    where id = pool.id;
  end if;

  return new;
end
$function$;

create trigger reward_versions_inventory_pool_prepare
before insert or update of inventory_mode, inventory_quantity,
  inventory_stockout_policy, inventory_pool_id
on app.reward_versions
for each row execute function app_private.prepare_reward_inventory_pool();

create function app_private.cleanup_unreferenced_inventory_pool()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  previous_pool_id uuid;
begin
  previous_pool_id := old.inventory_pool_id;
  if previous_pool_id is not null
    and (tg_op = 'DELETE' or new.inventory_pool_id is distinct from previous_pool_id)
    and not exists (
      select 1 from app.reward_versions where inventory_pool_id = previous_pool_id
    )
    and not exists (
      select 1 from app.inventory_consumptions where inventory_pool_id = previous_pool_id
    ) then
    delete from app.inventory_pools where id = previous_pool_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger reward_versions_inventory_pool_cleanup
after update of inventory_pool_id or delete on app.reward_versions
for each row execute function app_private.cleanup_unreferenced_inventory_pool();

create function app_private.guard_inventory_pool_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  pool_is_protected boolean;
begin
  select
    exists (
      select 1 from app.reward_versions
      where inventory_pool_id = old.id and state <> 'draft'
    ) or exists (
      select 1 from app.inventory_consumptions
      where inventory_pool_id = old.id
    )
  into pool_is_protected;

  if new.id is distinct from old.id
    or new.creator_id is distinct from old.creator_id
    or new.created_at is distinct from old.created_at
    or new.updated_at < old.updated_at then
    raise exception using
      errcode = '23514',
      constraint = 'inventory_pool_identity_immutable',
      message = 'Inventory-pool identity and ownership are immutable.';
  end if;

  if pool_is_protected then
    if new.stockout_policy is distinct from old.stockout_policy
      or new.initial_quantity is distinct from old.initial_quantity
      or new.available_quantity > old.available_quantity
      or new.available_quantity < old.available_quantity - 1 then
      raise exception using
        errcode = '23514',
        constraint = 'inventory_pool_update_invalid',
        message = 'Published inventory can only consume one available unit at a time.';
    end if;
  elsif new.available_quantity <> new.initial_quantity then
    raise exception using
      errcode = '23514',
      constraint = 'inventory_pool_draft_update_invalid',
      message = 'Unpublished inventory configuration must remain fully available.';
  end if;
  return new;
end
$function$;

create trigger inventory_pools_update_guard
before update on app.inventory_pools
for each row execute function app_private.guard_inventory_pool_update();

create function app_private.guard_inventory_pool_delete()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1 from app.reward_versions
    where inventory_pool_id = old.id and state <> 'draft'
  ) or exists (
    select 1 from app.inventory_consumptions
    where inventory_pool_id = old.id
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'inventory_pool_history_immutable',
      message = 'Published or consumed inventory history cannot be deleted.';
  end if;
  return old;
end
$function$;

create trigger inventory_pools_delete_guard
before delete on app.inventory_pools
for each row execute function app_private.guard_inventory_pool_delete();

create function app_private.validate_inventory_pool_reconciliation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  consumed_quantity numeric;
begin
  select coalesce(sum(quantity_consumed::numeric), 0)
  into consumed_quantity
  from app.inventory_consumptions
  where inventory_pool_id = new.id;

  if new.initial_quantity::numeric - new.available_quantity::numeric <> consumed_quantity then
    raise exception using
      errcode = '23514',
      constraint = 'inventory_pool_reconciliation_invalid',
      message = 'Inventory availability must reconcile with immutable consumption history.';
  end if;
  return new;
end
$function$;

create constraint trigger inventory_pools_reconciliation_guard
after insert or update on app.inventory_pools
deferrable initially deferred
for each row execute function app_private.validate_inventory_pool_reconciliation();

create function app_private.validate_inventory_consumption()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from app.box_opens as opening
    join app.reward_versions as reward_version on reward_version.id = opening.reward_version_id
    join app.fulfillment_obligations as obligation on obligation.opening_id = opening.id
    where opening.id = new.opening_id
      and opening.inventory_pool_id = new.inventory_pool_id
      and reward_version.inventory_mode = 'finite'
      and reward_version.inventory_pool_id = new.inventory_pool_id
      and obligation.status = 'pending_fulfillment'
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'inventory_consumption_opening_invalid',
      message = 'Inventory consumption requires its matching in-stock opening.';
  end if;
  return new;
end
$function$;

create constraint trigger inventory_consumptions_opening_guard
after insert on app.inventory_consumptions
deferrable initially deferred
for each row execute function app_private.validate_inventory_consumption();

create trigger inventory_consumptions_update_guard
before update or delete on app.inventory_consumptions
for each row execute function app_private.reject_phase9_history_mutation();

drop function app.consume_inventory_pool(uuid);

create function app.consume_inventory_pool(pool_id uuid, target_opening_id uuid)
returns setof app.inventory_pools
language plpgsql
security definer
set search_path = ''
as $function$
declare
  consumed app.inventory_pools%rowtype;
begin
  update app.inventory_pools
  set available_quantity = available_quantity - 1,
      updated_at = clock_timestamp()
  where id = pool_id and available_quantity > 0
  returning * into consumed;
  if not found then return; end if;

  insert into app.inventory_consumptions (
    opening_id,
    inventory_pool_id,
    quantity_consumed
  ) values (
    target_opening_id,
    pool_id,
    1
  );
  return next consumed;
end
$function$;

create or replace function app.pause_boxes_for_inventory_pool(pool_id uuid)
returns setof app.boxes
language sql
security definer
set search_path = ''
as $function$
  update app.boxes as box
  set status = 'paused',
      revision = revision + 1,
      updated_at = clock_timestamp()
  where exists (
    select 1 from app.inventory_pools as pool
    where pool.id = pool_id
      and pool.stockout_policy = 'pause_box'
      and pool.available_quantity = 0
  )
    and box.id in (
      select affected.id
      from app.boxes as affected
      join app.box_versions as version on version.id = affected.current_published_version_id
      join app.box_version_rewards as entry on entry.box_version_id = version.id
      join app.reward_versions as reward_version on reward_version.id = entry.reward_version_id
      where reward_version.inventory_pool_id = pool_id
        and affected.status = 'active'
      order by affected.id
      for update of affected
    )
  returning box.*;
$function$;

create function app.lock_box_publication_inventory_pools(
  target_box_version_id uuid,
  target_creator_id uuid
)
returns table (
  id uuid,
  creator_id uuid,
  stockout_policy text,
  available_quantity bigint
)
language sql
security definer
set search_path = ''
as $function$
  select
    pool.id,
    pool.creator_id,
    pool.stockout_policy,
    pool.available_quantity
  from app.inventory_pools as pool
  where pool.id in (
    select reward_version.inventory_pool_id
    from app.box_version_rewards as entry
    join app.reward_versions as reward_version on reward_version.id = entry.reward_version_id
    join app.rewards as reward on reward.id = reward_version.reward_id
    where entry.box_version_id = target_box_version_id
      and reward.creator_id = target_creator_id
      and reward_version.inventory_mode = 'finite'
      and reward_version.inventory_pool_id is not null
  )
    and pool.creator_id = target_creator_id
    and pool.stockout_policy = 'pause_box'
  order by pool.id
  for update of pool;
$function$;

create or replace function app_private.validate_phase9_box_publication()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  base_reward_count bigint;
begin
  if new.state <> 'published' or old.state = 'published' then
    return new;
  end if;
  if new.opening_compatibility_version <> 'opening-v1' then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_opening_compatibility_required',
      message = 'New published versions must explicitly opt in to opening-v1.';
  end if;
  select count(*) into base_reward_count
  from app.box_version_base_rewards
  where box_version_id = new.id;
  if base_reward_count <> 1 then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_exactly_one_base_reward',
      message = 'An opening-v1 published box requires exactly one base reward.';
  end if;
  if exists (
    select 1
    from app.box_version_rewards as entry
    join app.reward_versions as reward_version on reward_version.id = entry.reward_version_id
    join app.rewards as reward on reward.id = reward_version.reward_id
    join app.boxes as box on box.id = new.box_id
    left join app.inventory_pools as pool on pool.id = reward_version.inventory_pool_id
    where entry.box_version_id = new.id
      and reward_version.inventory_mode = 'finite'
      and (
        pool.id is null
        or pool.creator_id <> reward.creator_id
        or pool.creator_id <> box.creator_id
        or (
          pool.stockout_policy = 'pause_box'
          and pool.available_quantity <= 0
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_live_inventory_unavailable',
      message = 'An opening-v1 publication requires available creator-scoped pause inventory.';
  end if;
  return new;
end
$function$;

create or replace function app_private.validate_box_open()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  base_entry_id uuid;
  selected_inventory_mode text;
  selected_pool_id uuid;
  selected_pool_policy text;
  sale_shape_valid boolean;
  allocation_shape_valid boolean;
  obligation_status text;
  consumption_count bigint;
begin
  select base.box_version_reward_id into base_entry_id
  from app.box_version_base_rewards as base
  where base.box_version_id = new.box_version_id;

  if not exists (
    select 1 from app.box_versions as version
    where version.id = new.box_version_id
      and version.state = 'published'
      and version.opening_compatibility_version = 'opening-v1'
      and version.price_minor = new.gross_price_minor
      and version.currency = new.currency
      and version.configuration_hash = new.configuration_hash
      and version.rng_algorithm_version = new.rng_algorithm_version
  ) or base_entry_id is null then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_catalog_snapshot_invalid',
      message = 'The opening catalog snapshot is invalid or not opening-v1 compatible.';
  end if;

  if (new.selected_box_version_reward_id = base_entry_id) <> (new.bonus_points = 15) then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_points_selection_invalid',
      message = 'The points snapshot must match the designated base reward.';
  end if;

  select reward_version.inventory_mode, reward_version.inventory_pool_id, pool.stockout_policy
  into selected_inventory_mode, selected_pool_id, selected_pool_policy
  from app.reward_versions as reward_version
  left join app.inventory_pools as pool on pool.id = reward_version.inventory_pool_id
  where reward_version.id = new.reward_version_id;

  if (selected_inventory_mode = 'finite') <> (new.inventory_pool_id is not null)
    or new.inventory_pool_id is distinct from selected_pool_id then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_inventory_snapshot_invalid',
      message = 'The opening inventory snapshot does not match its reward version.';
  end if;

  select
    count(*) = 2
    and count(*) filter (
      where account.account_type = 'user_wallet'
        and account.owner_user_id = new.user_id
        and entry.amount_minor = -new.gross_price_minor
    ) = 1
    and count(*) filter (
      where account.account_type = 'box_sales_clearing'
        and entry.amount_minor = new.gross_price_minor
    ) = 1
  into sale_shape_valid
  from app.ledger_entries as entry
  join app.ledger_accounts as account on account.id = entry.ledger_account_id
  join app.ledger_transactions as transaction on transaction.id = entry.ledger_transaction_id
  where entry.ledger_transaction_id = new.sale_ledger_transaction_id
    and transaction.kind = 'box_open_sale'
    and transaction.status = 'posted'
    and transaction.currency = new.currency
    and transaction.actor_user_id = new.user_id
    and transaction.business_reference_type = 'box_open_sale'
    and transaction.business_reference_id = new.id;

  if not coalesce(sale_shape_valid, false) then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_sale_ledger_invalid',
      message = 'The opening sale ledger posting is invalid.';
  end if;

  select
    count(*) = case when new.platform_fee_minor = 0 then 2 else 3 end
    and count(*) filter (
      where account.account_type = 'box_sales_clearing'
        and entry.amount_minor = -new.gross_price_minor
    ) = 1
    and count(*) filter (
      where account.account_type = 'creator_pending_earnings'
        and account.owner_creator_id = new.creator_id
        and entry.amount_minor = new.creator_share_minor
    ) = 1
    and count(*) filter (
      where account.account_type = 'platform_fee'
        and entry.amount_minor = new.platform_fee_minor
    ) = case when new.platform_fee_minor = 0 then 0 else 1 end
  into allocation_shape_valid
  from app.ledger_entries as entry
  join app.ledger_accounts as account on account.id = entry.ledger_account_id
  join app.ledger_transactions as transaction on transaction.id = entry.ledger_transaction_id
  where entry.ledger_transaction_id = new.allocation_ledger_transaction_id
    and transaction.kind = 'box_open_allocation'
    and transaction.status = 'posted'
    and transaction.currency = new.currency
    and transaction.actor_user_id = new.user_id
    and transaction.business_reference_type = 'box_open_allocation'
    and transaction.business_reference_id = new.id;

  if not coalesce(allocation_shape_valid, false) then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_allocation_ledger_invalid',
      message = 'The opening allocation ledger posting is invalid.';
  end if;

  if not exists (
    select 1 from app.idempotency_records as record
    where record.id = new.idempotency_record_id
      and record.actor_user_id = new.user_id
      and record.operation = 'box.open'
      and record.status = 'completed'
      and record.resource_type = 'box_open'
      and record.resource_id = new.id
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_idempotency_invalid',
      message = 'The opening requires its completed matching idempotency record.';
  end if;

  select obligation.status into obligation_status
  from app.reward_wins as win
  join app.fulfillment_obligations as obligation on obligation.reward_win_id = win.id
  where win.opening_id = new.id
    and win.user_id = new.user_id
    and win.creator_id = new.creator_id
    and win.reward_version_id = new.reward_version_id
    and obligation.opening_id = new.id;

  if obligation_status is null
    or not (
      obligation_status = 'pending_fulfillment'
      or (
        obligation_status = 'awaiting_restock'
        and selected_inventory_mode = 'finite'
        and selected_pool_policy = 'backorder'
      )
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_win_obligation_invalid',
      message = 'The opening requires one matching win and fulfillment obligation.';
  end if;

  select count(*) into consumption_count
  from app.inventory_consumptions
  where opening_id = new.id
    and inventory_pool_id = new.inventory_pool_id;

  if (
    selected_inventory_mode = 'finite'
    and obligation_status = 'pending_fulfillment'
    and consumption_count <> 1
  ) or (
    (selected_inventory_mode = 'unlimited' or obligation_status = 'awaiting_restock')
    and consumption_count <> 0
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_inventory_consumption_invalid',
      message = 'Opening inventory consumption does not match the fulfillment result.';
  end if;

  if not exists (
    select 1 from app.creator_earnings as earning
    where earning.opening_id = new.id
      and earning.creator_id = new.creator_id
      and earning.ledger_transaction_id = new.allocation_ledger_transaction_id
      and earning.amount_minor = new.creator_share_minor
      and earning.currency = new.currency
      and earning.available_at = new.earnings_available_at
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_creator_earning_invalid',
      message = 'The opening requires one matching pending creator earning.';
  end if;

  if (
    select count(*) from app.event_outbox as event
    where event.aggregate_id = new.id
      and event.aggregate_type = 'box_open'
      and event.event_type in ('opening.completed.v1', 'drop.created.v1')
  ) <> 2 then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_outbox_invalid',
      message = 'The opening requires its private and public transactional outbox events.';
  end if;
  return new;
end
$function$;

create function app_private.validate_opening_ledger_linkage()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.kind = 'box_open_sale' then
    if (
      select count(*)
      from app.box_opens as opening
      where opening.sale_ledger_transaction_id = new.id
        and opening.id = new.business_reference_id
        and opening.user_id = new.actor_user_id
        and opening.currency = new.currency
        and new.business_reference_type = 'box_open_sale'
    ) <> 1 then
      raise exception using
        errcode = '23514',
        constraint = 'box_open_sale_opening_link_invalid',
        message = 'A box-open sale posting requires exactly one matching opening.';
    end if;
  elsif new.kind = 'box_open_allocation' then
    if (
      select count(*)
      from app.box_opens as opening
      where opening.allocation_ledger_transaction_id = new.id
        and opening.id = new.business_reference_id
        and opening.user_id = new.actor_user_id
        and opening.currency = new.currency
        and new.business_reference_type = 'box_open_allocation'
    ) <> 1 then
      raise exception using
        errcode = '23514',
        constraint = 'box_open_allocation_opening_link_invalid',
        message = 'A box-open allocation posting requires exactly one matching opening.';
    end if;
  elsif new.kind = 'reversal' and exists (
    select 1 from app.ledger_transactions as original
    where original.id = new.reverses_ledger_transaction_id
      and original.kind in ('box_open_sale', 'box_open_allocation')
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'box_open_financial_reversal_forbidden',
      message = 'Phase 9 opening financial postings cannot be reversed independently.';
  end if;
  return new;
end
$function$;

create constraint trigger ledger_transactions_opening_link_guard
after insert or update on app.ledger_transactions
deferrable initially deferred
for each row execute function app_private.validate_opening_ledger_linkage();

revoke all on table app.inventory_consumptions from public, creatordrop_app;
grant select on table app.inventory_consumptions to creatordrop_app;

revoke all on function app.consume_inventory_pool(uuid, uuid) from public;
revoke all on function app.lock_box_publication_inventory_pools(uuid, uuid) from public;
revoke all on function app.pause_boxes_for_inventory_pool(uuid) from public;
grant execute on function app.consume_inventory_pool(uuid, uuid) to creatordrop_app;
grant execute on function app.lock_box_publication_inventory_pools(uuid, uuid) to creatordrop_app;
grant execute on function app.pause_boxes_for_inventory_pool(uuid) to creatordrop_app;

comment on column app.reward_versions.inventory_pool_id is
  'Immutable historical reference to stable operational stock; NULL only for unlimited inventory.';
comment on table app.inventory_pools is
  'Stable creator-owned physical stock shared across reward versions and boxes.';
comment on table app.inventory_consumptions is
  'Immutable one-unit finite-stock movement linked one-to-one to its committed opening.';

reset role;
