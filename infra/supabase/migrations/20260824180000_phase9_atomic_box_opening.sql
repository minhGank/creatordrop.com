-- Phase 9 only: opening-v1 catalog compatibility, shared inventory, atomic
-- box-opening history, earnings, points snapshots, and transactional outbox.

set role creatordrop_migrator;

alter table app.box_versions
  add column opening_compatibility_version text,
  add constraint box_versions_opening_compatibility_check check (
    opening_compatibility_version is null
    or opening_compatibility_version = 'opening-v1'
  ),
  add constraint box_versions_id_box_unique unique (id, box_id);

alter table app.box_version_rewards
  add constraint box_version_rewards_id_version_reward_unique unique (
    id,
    box_version_id,
    reward_version_id
  ),
  add constraint box_version_rewards_id_version_unique unique (id, box_version_id);

alter table app.reward_versions
  add column inventory_stockout_policy text,
  add constraint reward_versions_inventory_stockout_policy_check check (
    (inventory_mode = 'unlimited' and inventory_stockout_policy is null)
    or (
      inventory_mode = 'finite'
      and (
        inventory_stockout_policy is null
        or inventory_stockout_policy in ('pause_box', 'backorder')
      )
    )
  );

alter table app.boxes
  add constraint boxes_id_creator_unique unique (id, creator_id);

alter table app.rewards
  add constraint rewards_id_creator_unique unique (id, creator_id);

create table app.box_version_base_rewards (
  id uuid primary key,
  box_version_id uuid not null references app.box_versions (id) on delete restrict,
  box_version_reward_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint box_version_base_rewards_association_unique unique (box_version_reward_id),
  constraint box_version_base_rewards_version_association_unique unique (
    box_version_id,
    box_version_reward_id
  ),
  constraint box_version_base_rewards_association_scope_fk foreign key (
    box_version_reward_id,
    box_version_id
  ) references app.box_version_rewards (
    id,
    box_version_id
  ) on delete restrict
);

create index box_version_base_rewards_version_idx
  on app.box_version_base_rewards (box_version_id, id);

create table app.inventory_pools (
  id uuid primary key,
  reward_version_id uuid not null unique references app.reward_versions (id) on delete restrict,
  creator_id uuid not null references app.creators (id) on delete restrict,
  stockout_policy text not null,
  initial_quantity bigint not null,
  available_quantity bigint not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint inventory_pools_reward_identity check (id = reward_version_id),
  constraint inventory_pools_policy_check check (
    stockout_policy in ('pause_box', 'backorder')
  ),
  constraint inventory_pools_quantities_check check (
    initial_quantity >= 0
    and available_quantity >= 0
    and available_quantity <= initial_quantity
  ),
  constraint inventory_pools_timestamp_order check (updated_at >= created_at),
  constraint inventory_pools_id_creator_unique unique (id, creator_id)
);

create index inventory_pools_creator_idx
  on app.inventory_pools (creator_id, id);

insert into app.inventory_pools (
  id,
  reward_version_id,
  creator_id,
  stockout_policy,
  initial_quantity,
  available_quantity,
  created_at,
  updated_at
)
select
  reward_version.id,
  reward_version.id,
  reward.creator_id,
  coalesce(reward_version.inventory_stockout_policy, 'pause_box'),
  reward_version.inventory_quantity,
  reward_version.inventory_quantity,
  reward_version.created_at,
  statement_timestamp()
from app.reward_versions as reward_version
join app.rewards as reward on reward.id = reward_version.reward_id
where reward_version.inventory_mode = 'finite';

alter table app.ledger_accounts
  add column owner_creator_id uuid references app.creators (id) on delete restrict;

alter table app.ledger_accounts
  drop constraint ledger_accounts_type_check,
  drop constraint ledger_accounts_owner_shape,
  add constraint ledger_accounts_type_check check (
    account_type in (
      'user_wallet',
      'system_test_funding',
      'box_sales_clearing',
      'creator_pending_earnings',
      'platform_fee'
    )
  ),
  add constraint ledger_accounts_owner_shape check (
    (
      account_type = 'user_wallet'
      and owner_user_id is not null
      and owner_creator_id is null
    )
    or (
      account_type in ('system_test_funding', 'box_sales_clearing', 'platform_fee')
      and owner_user_id is null
      and owner_creator_id is null
    )
    or (
      account_type = 'creator_pending_earnings'
      and owner_user_id is null
      and owner_creator_id is not null
    )
  );

create unique index ledger_accounts_box_sales_clearing_unique
  on app.ledger_accounts (currency)
  where account_type = 'box_sales_clearing';

create unique index ledger_accounts_platform_fee_unique
  on app.ledger_accounts (currency)
  where account_type = 'platform_fee';

create unique index ledger_accounts_creator_pending_unique
  on app.ledger_accounts (owner_creator_id, currency)
  where account_type = 'creator_pending_earnings';

alter table app.ledger_transactions
  drop constraint ledger_transactions_kind_check,
  add constraint ledger_transactions_kind_check check (
    kind in (
      'test_credit_grant',
      'wallet_credit',
      'wallet_debit',
      'reversal',
      'box_open_sale',
      'box_open_allocation'
    )
  );

create table app.box_opens (
  id uuid primary key,
  public_id uuid not null unique,
  user_id uuid not null references app.users (id) on delete restrict,
  creator_id uuid not null references app.creators (id) on delete restrict,
  box_id uuid not null,
  box_version_id uuid not null,
  selected_box_version_reward_id uuid not null,
  reward_version_id uuid not null references app.reward_versions (id) on delete restrict,
  inventory_pool_id uuid references app.inventory_pools (id) on delete restrict,
  rng_seed_set_id uuid not null,
  nonce bigint not null,
  client_seed text not null,
  server_seed_commitment bytea not null,
  rng_algorithm_version text not null,
  rng_digest bytea not null,
  rng_selection numeric(78, 0) not null,
  rng_selection_round bigint not null,
  configuration_hash bytea not null,
  gross_price_minor bigint not null,
  currency character(3) not null,
  platform_fee_bps integer not null,
  platform_fee_minor bigint not null,
  creator_share_minor bigint not null,
  earnings_available_at timestamptz not null,
  points_policy_version text not null,
  base_points integer not null,
  bonus_points integer not null,
  points_awarded integer not null,
  sale_ledger_transaction_id uuid not null unique references app.ledger_transactions (id) on delete restrict,
  allocation_ledger_transaction_id uuid not null unique references app.ledger_transactions (id) on delete restrict,
  idempotency_record_id uuid not null unique references app.idempotency_records (id) on delete restrict,
  status text not null default 'completed',
  created_at timestamptz not null default statement_timestamp(),
  constraint box_opens_box_creator_scope_fk foreign key (box_id, creator_id)
    references app.boxes (id, creator_id) on delete restrict,
  constraint box_opens_version_box_scope_fk foreign key (box_version_id, box_id)
    references app.box_versions (id, box_id) on delete restrict,
  constraint box_opens_selected_reward_scope_fk foreign key (
    selected_box_version_reward_id,
    box_version_id,
    reward_version_id
  ) references app.box_version_rewards (
    id,
    box_version_id,
    reward_version_id
  ) on delete restrict,
  constraint box_opens_seed_user_scope_fk foreign key (rng_seed_set_id, user_id)
    references app.rng_seed_sets (id, user_id) on delete restrict,
  constraint box_opens_seed_nonce_unique unique (rng_seed_set_id, nonce),
  constraint box_opens_nonce_nonnegative check (nonce >= 0),
  constraint box_opens_client_seed_canonical check (
    client_seed ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  constraint box_opens_crypto_shape check (
    octet_length(server_seed_commitment) = 32
    and octet_length(rng_digest) = 32
    and octet_length(configuration_hash) = 32
    and rng_algorithm_version = 'hmac-sha256-rejection-v1'
    and rng_selection >= 0
    and rng_selection_round >= 0
  ),
  constraint box_opens_money_shape check (
    gross_price_minor > 0
    and currency ~ '^[A-Z]{3}$'
    and platform_fee_bps between 0 and 10000
    and platform_fee_minor >= 0
    and creator_share_minor >= 0
    and platform_fee_minor + creator_share_minor = gross_price_minor
    and platform_fee_minor = floor(gross_price_minor::numeric * platform_fee_bps / 10000)::bigint
  ),
  constraint box_opens_points_shape check (
    points_policy_version = 'leaderboard-v1'
    and base_points = 5
    and bonus_points in (0, 15)
    and points_awarded = base_points + bonus_points
  ),
  constraint box_opens_status_check check (status = 'completed'),
  constraint box_opens_earnings_hold check (earnings_available_at >= created_at)
);

create index box_opens_user_created_idx on app.box_opens (user_id, created_at desc, id);
create index box_opens_creator_created_idx on app.box_opens (creator_id, created_at desc, id);
create index box_opens_box_created_idx on app.box_opens (box_id, created_at desc, id);
create index box_opens_version_idx on app.box_opens (box_version_id, id);
create index box_opens_selected_reward_idx
  on app.box_opens (selected_box_version_reward_id, id);

create table app.reward_wins (
  id uuid primary key,
  opening_id uuid not null unique references app.box_opens (id) on delete restrict,
  user_id uuid not null references app.users (id) on delete restrict,
  creator_id uuid not null references app.creators (id) on delete restrict,
  reward_version_id uuid not null references app.reward_versions (id) on delete restrict,
  status text not null default 'awarded',
  created_at timestamptz not null default statement_timestamp(),
  constraint reward_wins_status_check check (status = 'awarded')
);

create table app.fulfillment_obligations (
  id uuid primary key,
  opening_id uuid not null unique references app.box_opens (id) on delete restrict,
  reward_win_id uuid not null unique references app.reward_wins (id) on delete restrict,
  status text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint fulfillment_obligations_status_check check (
    status in ('pending_fulfillment', 'awaiting_restock')
  )
);

create table app.creator_earnings (
  id uuid primary key,
  opening_id uuid not null unique references app.box_opens (id) on delete restrict,
  creator_id uuid not null references app.creators (id) on delete restrict,
  ledger_transaction_id uuid not null unique references app.ledger_transactions (id) on delete restrict,
  amount_minor bigint not null,
  currency character(3) not null,
  status text not null default 'pending',
  available_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint creator_earnings_amount_nonnegative check (amount_minor >= 0),
  constraint creator_earnings_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint creator_earnings_status_check check (status = 'pending'),
  constraint creator_earnings_hold_check check (available_at >= created_at)
);

create index creator_earnings_creator_available_idx
  on app.creator_earnings (creator_id, available_at, id);

create table app.event_outbox (
  id uuid primary key,
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  audience text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default statement_timestamp(),
  created_at timestamptz not null default statement_timestamp(),
  constraint event_outbox_aggregate_type_check check (aggregate_type = 'box_open'),
  constraint event_outbox_event_type_check check (
    event_type in ('opening.completed.v1', 'drop.created.v1')
  ),
  constraint event_outbox_audience_check check (audience in ('private', 'public')),
  constraint event_outbox_event_audience_check check (
    (event_type = 'opening.completed.v1' and audience = 'private')
    or (event_type = 'drop.created.v1' and audience = 'public')
  ),
  constraint event_outbox_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint event_outbox_secret_fields_absent check (
    not (payload ?| array[
      'serverSeed',
      'server_seed',
      'ciphertext',
      'encryptionKey',
      'encryption_key',
      'authenticationTag',
      'authentication_tag'
    ])
  ),
  constraint event_outbox_occurrence_order check (occurred_at <= created_at),
  constraint event_outbox_aggregate_event_unique unique (aggregate_id, event_type)
);

create index event_outbox_created_idx on app.event_outbox (created_at, id);

create function app_private.reject_phase9_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    constraint = 'phase9_history_immutable',
    message = 'Phase 9 opening history is immutable.';
end
$function$;

create function app_private.protect_box_version_base_reward_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  affected_version_id uuid;
begin
  affected_version_id := case when tg_op = 'INSERT' then new.box_version_id else old.box_version_id end;
  if tg_op = 'UPDATE'
    and (
      new.id is distinct from old.id
      or new.box_version_id is distinct from old.box_version_id
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'box_version_base_reward_identity_immutable',
      message = 'A base reward designation cannot be reassigned.';
  end if;
  if exists (
    select 1 from app.box_versions
    where id = affected_version_id and state <> 'draft'
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_base_reward_immutable',
      message = 'Published box base-reward designations are immutable.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger box_version_base_rewards_mutation_guard
before insert or update or delete on app.box_version_base_rewards
for each row execute function app_private.protect_box_version_base_reward_mutation();

create function app_private.validate_phase9_box_publication()
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
  return new;
end
$function$;

create trigger box_versions_phase9_validate_publication
before insert or update on app.box_versions
for each row execute function app_private.validate_phase9_box_publication();

create function app_private.sync_reward_inventory_pool()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reward_creator_id uuid;
begin
  if new.state <> 'draft' then return new; end if;
  select creator_id into strict reward_creator_id
  from app.rewards where id = new.reward_id;
  if new.inventory_mode = 'finite' then
    insert into app.inventory_pools (
      id, reward_version_id, creator_id, stockout_policy,
      initial_quantity, available_quantity, created_at, updated_at
    ) values (
      new.id, new.id, reward_creator_id,
      coalesce(new.inventory_stockout_policy, 'pause_box'),
      new.inventory_quantity, new.inventory_quantity,
      new.created_at, statement_timestamp()
    )
    on conflict (id) do update
      set stockout_policy = excluded.stockout_policy,
          initial_quantity = excluded.initial_quantity,
          available_quantity = excluded.available_quantity,
          updated_at = statement_timestamp();
  else
    delete from app.inventory_pools where id = new.id;
  end if;
  return new;
end
$function$;

create trigger reward_versions_inventory_pool_sync
after insert or update of inventory_mode, inventory_quantity, inventory_stockout_policy
on app.reward_versions
for each row execute function app_private.sync_reward_inventory_pool();

create function app_private.guard_inventory_pool_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1 from app.reward_versions
    where id = old.reward_version_id and state = 'draft'
  ) then
    if new.id is distinct from old.id
      or new.reward_version_id is distinct from old.reward_version_id
      or new.creator_id is distinct from old.creator_id
      or new.initial_quantity <> new.available_quantity
      or new.updated_at < old.updated_at then
      raise exception using
        errcode = '23514',
        constraint = 'inventory_pool_draft_update_invalid',
        message = 'Draft inventory configuration is invalid.';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
    or new.reward_version_id is distinct from old.reward_version_id
    or new.creator_id is distinct from old.creator_id
    or new.stockout_policy is distinct from old.stockout_policy
    or new.initial_quantity is distinct from old.initial_quantity
    or new.created_at is distinct from old.created_at
    or new.available_quantity > old.available_quantity
    or new.available_quantity < old.available_quantity - 1
    or new.updated_at < old.updated_at then
    raise exception using
      errcode = '23514',
      constraint = 'inventory_pool_update_invalid',
      message = 'Published inventory can only consume one available unit at a time.';
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
    where id = old.reward_version_id and state = 'draft'
  ) then
    return old;
  end if;
  raise exception using
    errcode = '23514',
    constraint = 'inventory_pool_history_immutable',
    message = 'Published inventory history cannot be deleted.';
end
$function$;

create trigger inventory_pools_delete_guard
before delete on app.inventory_pools
for each row execute function app_private.guard_inventory_pool_delete();

create function app.lock_inventory_pool(pool_id uuid)
returns setof app.inventory_pools
language sql
security definer
set search_path = ''
as $function$
  select pool.* from app.inventory_pools as pool
  where pool.id = pool_id
  for update;
$function$;

create function app.consume_inventory_pool(pool_id uuid)
returns setof app.inventory_pools
language sql
security definer
set search_path = ''
as $function$
  update app.inventory_pools
  set available_quantity = available_quantity - 1,
      updated_at = clock_timestamp()
  where id = pool_id and available_quantity > 0
  returning *;
$function$;

create function app.lock_current_box_for_open(target_box_id uuid, target_version_id uuid)
returns setof app.boxes
language sql
security definer
set search_path = ''
as $function$
  select box.* from app.boxes as box
  where box.id = target_box_id
    and box.current_published_version_id = target_version_id
    and box.status = 'active'
  for share;
$function$;

create function app.pause_boxes_for_inventory_pool(pool_id uuid)
returns setof app.boxes
language sql
security definer
set search_path = ''
as $function$
  update app.boxes as box
  set status = 'paused',
      revision = revision + 1,
      updated_at = clock_timestamp()
  where box.id in (
    select affected.id
    from app.boxes as affected
    join app.box_versions as version on version.id = affected.current_published_version_id
    join app.box_version_rewards as entry on entry.box_version_id = version.id
    where entry.reward_version_id = pool_id
      and affected.status = 'active'
    order by affected.id
    for update of affected
  )
  returning box.*;
$function$;

create function app_private.validate_box_open()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  base_entry_id uuid;
  selected_inventory_mode text;
  selected_pool_policy text;
  sale_shape_valid boolean;
  allocation_shape_valid boolean;
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

  select reward_version.inventory_mode, pool.stockout_policy
  into selected_inventory_mode, selected_pool_policy
  from app.reward_versions as reward_version
  left join app.inventory_pools as pool on pool.id = reward_version.id
  where reward_version.id = new.reward_version_id;

  if (selected_inventory_mode = 'finite') <> (new.inventory_pool_id is not null)
    or (new.inventory_pool_id is not null and new.inventory_pool_id <> new.reward_version_id) then
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

  if not exists (
    select 1 from app.reward_wins as win
    join app.fulfillment_obligations as obligation on obligation.reward_win_id = win.id
    where win.opening_id = new.id
      and win.user_id = new.user_id
      and win.creator_id = new.creator_id
      and win.reward_version_id = new.reward_version_id
      and obligation.opening_id = new.id
      and (
        obligation.status = 'pending_fulfillment'
        or (
          obligation.status = 'awaiting_restock'
          and selected_inventory_mode = 'finite'
          and selected_pool_policy = 'backorder'
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'box_opens_win_obligation_invalid',
      message = 'The opening requires one matching win and fulfillment obligation.';
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

create constraint trigger box_opens_completion_guard
after insert on app.box_opens
deferrable initially deferred
for each row execute function app_private.validate_box_open();

create function app_private.validate_phase9_child_scope()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  row_data jsonb := to_jsonb(new);
begin
  if tg_table_name = 'reward_wins' and not exists (
    select 1 from app.box_opens as opening
    where opening.id = (row_data ->> 'opening_id')::uuid
      and opening.user_id = (row_data ->> 'user_id')::uuid
      and opening.creator_id = (row_data ->> 'creator_id')::uuid
      and opening.reward_version_id = (row_data ->> 'reward_version_id')::uuid
  ) then
    raise exception using errcode = '23514', constraint = 'reward_wins_opening_scope_invalid';
  end if;
  if tg_table_name = 'fulfillment_obligations' and not exists (
    select 1 from app.reward_wins as win
    where win.id = (row_data ->> 'reward_win_id')::uuid
      and win.opening_id = (row_data ->> 'opening_id')::uuid
  ) then
    raise exception using errcode = '23514', constraint = 'fulfillment_opening_scope_invalid';
  end if;
  if tg_table_name = 'creator_earnings' and not exists (
    select 1 from app.box_opens as opening
    where opening.id = (row_data ->> 'opening_id')::uuid
      and opening.creator_id = (row_data ->> 'creator_id')::uuid
      and opening.allocation_ledger_transaction_id = (row_data ->> 'ledger_transaction_id')::uuid
      and opening.creator_share_minor = (row_data ->> 'amount_minor')::bigint
      and opening.currency = (row_data ->> 'currency')::character(3)
      and opening.earnings_available_at = (row_data ->> 'available_at')::timestamptz
  ) then
    raise exception using errcode = '23514', constraint = 'creator_earnings_opening_scope_invalid';
  end if;
  if tg_table_name = 'event_outbox' and not exists (
    select 1 from app.box_opens as opening
    where opening.id = (row_data ->> 'aggregate_id')::uuid
  ) then
    raise exception using errcode = '23514', constraint = 'event_outbox_opening_scope_invalid';
  end if;
  return new;
end
$function$;

create constraint trigger reward_wins_scope_guard
after insert on app.reward_wins
deferrable initially deferred
for each row execute function app_private.validate_phase9_child_scope();
create constraint trigger fulfillment_obligations_scope_guard
after insert on app.fulfillment_obligations
deferrable initially deferred
for each row execute function app_private.validate_phase9_child_scope();
create constraint trigger creator_earnings_scope_guard
after insert on app.creator_earnings
deferrable initially deferred
for each row execute function app_private.validate_phase9_child_scope();
create constraint trigger event_outbox_scope_guard
after insert on app.event_outbox
deferrable initially deferred
for each row execute function app_private.validate_phase9_child_scope();

create trigger box_opens_update_guard before update or delete on app.box_opens
for each row execute function app_private.reject_phase9_history_mutation();
create trigger reward_wins_update_guard before update or delete on app.reward_wins
for each row execute function app_private.reject_phase9_history_mutation();
create trigger fulfillment_obligations_update_guard before update or delete on app.fulfillment_obligations
for each row execute function app_private.reject_phase9_history_mutation();
create trigger creator_earnings_update_guard before update or delete on app.creator_earnings
for each row execute function app_private.reject_phase9_history_mutation();
create trigger event_outbox_update_guard before update or delete on app.event_outbox
for each row execute function app_private.reject_phase9_history_mutation();

create or replace function app.complete_idempotency_record(
  record_id uuid,
  response_status integer,
  response_document jsonb,
  result_resource_type text,
  result_resource_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if result_resource_type = 'ledger_transaction' then
    if not exists (
      select 1
      from app.ledger_transactions as ledger_tx
      join app.idempotency_records as record on record.id = record_id
      where ledger_tx.id = result_resource_id
        and ledger_tx.idempotency_record_id = record.id
        and ledger_tx.actor_user_id = record.actor_user_id
        and ledger_tx.status = 'posted'
    ) then
      raise exception using errcode = '23514', constraint = 'idempotency_records_resource_invalid';
    end if;
  elsif result_resource_type = 'box_open' then
    if not exists (
      select 1
      from app.box_opens as opening
      join app.idempotency_records as record on record.id = record_id
      where opening.id = result_resource_id
        and opening.idempotency_record_id = record.id
        and opening.user_id = record.actor_user_id
    ) then
      raise exception using errcode = '23514', constraint = 'idempotency_records_resource_invalid';
    end if;
  else
    raise exception using errcode = '23514', constraint = 'idempotency_records_resource_invalid';
  end if;

  update app.idempotency_records
  set status = 'completed',
      http_status = response_status,
      response_body = response_document,
      resource_type = result_resource_type,
      resource_id = result_resource_id,
      completed_at = clock_timestamp()
  where id = record_id and status = 'processing';
  if not found then
    raise exception using errcode = '23514', constraint = 'idempotency_records_completion_invalid';
  end if;
end
$function$;

revoke all on table app.box_version_base_rewards from public, creatordrop_app;
revoke all on table app.inventory_pools from public, creatordrop_app;
revoke all on table app.box_opens from public, creatordrop_app;
revoke all on table app.reward_wins from public, creatordrop_app;
revoke all on table app.fulfillment_obligations from public, creatordrop_app;
revoke all on table app.creator_earnings from public, creatordrop_app;
revoke all on table app.event_outbox from public, creatordrop_app;

grant select, insert, update, delete on table app.box_version_base_rewards to creatordrop_app;
grant select on table app.inventory_pools to creatordrop_app;
grant select, insert on table app.box_opens to creatordrop_app;
grant select, insert on table app.reward_wins to creatordrop_app;
grant select, insert on table app.fulfillment_obligations to creatordrop_app;
grant select, insert on table app.creator_earnings to creatordrop_app;
grant select, insert on table app.event_outbox to creatordrop_app;

grant execute on function app.lock_inventory_pool(uuid) to creatordrop_app;
grant execute on function app.consume_inventory_pool(uuid) to creatordrop_app;
grant execute on function app.lock_current_box_for_open(uuid, uuid) to creatordrop_app;
grant execute on function app.pause_boxes_for_inventory_pool(uuid) to creatordrop_app;

comment on column app.box_versions.opening_compatibility_version is
  'Explicit opening protocol marker. NULL legacy published versions remain historical and non-openable.';
comment on table app.box_version_base_rewards is
  'Explicit base-reward designation for opening-v1 drafts and immutable published versions.';
comment on table app.inventory_pools is
  'Mutable finite stock shared by every box referencing the same immutable reward version.';
comment on table app.box_opens is
  'Immutable atomic opening, financial, RNG, and points snapshot.';
comment on table app.reward_wins is
  'Immutable one-per-opening reward award.';
comment on table app.fulfillment_obligations is
  'Immutable Phase 9 fulfillment obligation without shipping behavior.';
comment on table app.creator_earnings is
  'Pending creator earnings snapshot; release/payout is deferred.';
comment on table app.event_outbox is
  'Durable opening integration events inserted transactionally; delivery is deferred.';

reset role;
