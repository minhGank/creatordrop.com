-- R1B only: make opening-v2 executable through one atomic, non-financial
-- entitlement consumption. Paid opening-v1 history and behavior stay intact.

set role creatordrop_migrator;

alter table app.box_opens
  add column opening_compatibility_version text not null default 'opening-v1',
  alter column gross_price_minor drop not null,
  alter column currency drop not null,
  alter column platform_fee_bps drop not null,
  alter column platform_fee_minor drop not null,
  alter column creator_share_minor drop not null,
  alter column earnings_available_at drop not null,
  alter column points_policy_version drop not null,
  alter column base_points drop not null,
  alter column bonus_points drop not null,
  alter column points_awarded drop not null,
  alter column sale_ledger_transaction_id drop not null,
  alter column allocation_ledger_transaction_id drop not null,
  drop constraint box_opens_money_shape,
  drop constraint box_opens_points_shape,
  drop constraint box_opens_earnings_hold,
  add constraint box_opens_opening_compatibility_check check (
    opening_compatibility_version in ('opening-v1', 'opening-v2')
  ),
  add constraint box_opens_model_shape check (
    (
      opening_compatibility_version = 'opening-v1'
      and gross_price_minor is not null
      and gross_price_minor > 0
      and currency is not null
      and currency ~ '^[A-Z]{3}$'
      and platform_fee_bps is not null
      and platform_fee_bps between 0 and 10000
      and platform_fee_minor is not null
      and platform_fee_minor >= 0
      and creator_share_minor is not null
      and creator_share_minor >= 0
      and platform_fee_minor + creator_share_minor = gross_price_minor
      and platform_fee_minor =
        floor(gross_price_minor::numeric * platform_fee_bps / 10000)::bigint
      and earnings_available_at is not null
      and earnings_available_at >= created_at
      and points_policy_version is not null
      and points_policy_version = 'leaderboard-v1'
      and base_points is not null
      and base_points = 5
      and bonus_points is not null
      and bonus_points in (0, 15)
      and points_awarded is not null
      and points_awarded = base_points + bonus_points
      and sale_ledger_transaction_id is not null
      and allocation_ledger_transaction_id is not null
    ) or (
      opening_compatibility_version = 'opening-v2'
      and gross_price_minor is null
      and currency is null
      and platform_fee_bps is null
      and platform_fee_minor is null
      and creator_share_minor is null
      and earnings_available_at is null
      and points_policy_version is null
      and base_points is null
      and bonus_points is null
      and points_awarded is null
      and sale_ledger_transaction_id is null
      and allocation_ledger_transaction_id is null
    )
  ),
  add constraint box_opens_entitlement_scope_unique unique (
    id,
    user_id,
    creator_id,
    box_id,
    opening_compatibility_version
  );

alter table app.opening_entitlement_consumptions
  add column opening_compatibility_version text not null default 'opening-v2',
  add constraint opening_entitlement_consumptions_model_check check (
    opening_compatibility_version = 'opening-v2'
  ),
  add constraint opening_entitlement_consumptions_opening_scope_fk foreign key (
    opening_id,
    user_id,
    creator_id,
    box_id,
    opening_compatibility_version
  ) references app.box_opens (
    id,
    user_id,
    creator_id,
    box_id,
    opening_compatibility_version
  ) on delete restrict deferrable initially deferred;

create table app_private.opening_v2_user_box_guards (
  user_id uuid not null references app.users (id) on delete restrict,
  creator_id uuid not null references app.creators (id) on delete restrict,
  box_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (user_id, box_id),
  constraint opening_v2_user_box_guards_box_scope_fk foreign key (box_id, creator_id)
    references app.boxes (id, creator_id) on delete restrict
);

create function app_private.lock_opening_v2_user_box_guard(
  target_user_id uuid,
  target_creator_id uuid,
  target_box_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  locked_creator_id uuid;
begin
  if target_user_id is null or target_creator_id is null or target_box_id is null then
    raise exception using errcode = '22023', constraint = 'opening_v2_guard_scope_invalid';
  end if;

  insert into app_private.opening_v2_user_box_guards (user_id, creator_id, box_id)
  values (target_user_id, target_creator_id, target_box_id)
  on conflict (user_id, box_id) do nothing;

  select creator_id into strict locked_creator_id
    from app_private.opening_v2_user_box_guards
   where user_id = target_user_id and box_id = target_box_id
   for update;

  if locked_creator_id is distinct from target_creator_id then
    raise exception using
      errcode = '23514',
      constraint = 'opening_v2_guard_scope_invalid',
      message = 'The opening-v2 user/box guard does not match the creator scope.';
  end if;
end
$function$;

create function app_private.lock_and_validate_opening_v2_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  maximum bigint;
  completed numeric;
begin
  if new.opening_compatibility_version <> 'opening-v2' then return new; end if;

  perform app_private.lock_opening_v2_user_box_guard(new.user_id, new.creator_id, new.box_id);

  select version.max_openings_per_user into strict maximum
    from app.box_versions as version
   where version.id = new.box_version_id
     and version.box_id = new.box_id
     and version.state = 'published'
     and version.opening_compatibility_version = 'opening-v2'
     and version.configuration_hash = new.configuration_hash;

  select count(*)::numeric into completed
    from app.box_opens as opening
   where opening.user_id = new.user_id
     and opening.box_id = new.box_id
     and opening.opening_compatibility_version = 'opening-v2';

  if completed >= maximum::numeric then
    raise exception using
      errcode = '23514',
      constraint = 'opening_v2_user_limit_reached',
      message = 'The opening-v2 per-user stable-box limit has been reached.';
  end if;
  return new;
exception
  when no_data_found then
    raise exception using
      errcode = '23514',
      constraint = 'opening_v2_catalog_snapshot_invalid',
      message = 'The opening-v2 catalog snapshot is invalid.';
end
$function$;

create trigger box_opens_001_opening_v2_limit_lock
before insert on app.box_opens
for each row execute function app_private.lock_and_validate_opening_v2_limit();

create function app.consume_opening_v2_entitlement(
  target_consumption_id uuid,
  target_opening_id uuid,
  target_user_id uuid,
  target_creator_id uuid,
  target_box_id uuid,
  target_box_version_id uuid,
  target_configuration_hash bytea
)
returns table (
  outcome text,
  max_openings_per_user text,
  successful_openings text,
  remaining_entitlements text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  maximum bigint;
  completed numeric;
  selected_grant app.opening_entitlement_grants%rowtype;
  total_granted numeric;
  total_consumed numeric;
begin
  if target_consumption_id is null or target_opening_id is null
    or target_user_id is null or target_creator_id is null or target_box_id is null
    or target_box_version_id is null
    or target_configuration_hash is null
    or octet_length(target_configuration_hash) <> 32 then
    raise exception using errcode = '22023', constraint = 'opening_v2_consumption_input_invalid';
  end if;

  perform app_private.lock_opening_v2_user_box_guard(
    target_user_id,
    target_creator_id,
    target_box_id
  );

  select version.max_openings_per_user into strict maximum
    from app.box_versions as version
    join app.boxes as box
      on box.id = version.box_id and box.creator_id = target_creator_id
   where version.id = target_box_version_id
     and version.box_id = target_box_id
     and version.state = 'published'
     and version.opening_compatibility_version = 'opening-v2'
     and version.configuration_hash = target_configuration_hash
     and box.status = 'active'
     and box.current_published_version_id = version.id;

  select count(*)::numeric into completed
    from app.box_opens as opening
   where opening.user_id = target_user_id
     and opening.box_id = target_box_id
     and opening.opening_compatibility_version = 'opening-v2';

  if completed >= maximum::numeric then
    return query select 'max_reached', maximum::text, completed::text, '0';
    return;
  end if;

  select grant_row.* into selected_grant
    from app.opening_entitlement_grants as grant_row
   where grant_row.user_id = target_user_id
     and grant_row.creator_id = target_creator_id
     and grant_row.box_id = target_box_id
     and (
       select count(*)::numeric
         from app.opening_entitlement_consumptions as consumption
        where consumption.grant_id = grant_row.id
     ) < grant_row.quantity_granted::numeric
   order by grant_row.created_at, grant_row.id
   for update of grant_row
   limit 1;

  if not found then
    return query select 'entitlement_required', maximum::text, completed::text, '0';
    return;
  end if;

  insert into app.opening_entitlement_consumptions (
    id,
    grant_id,
    user_id,
    creator_id,
    box_id,
    opening_id,
    opening_compatibility_version
  ) values (
    target_consumption_id,
    selected_grant.id,
    target_user_id,
    target_creator_id,
    target_box_id,
    target_opening_id,
    'opening-v2'
  );

  select coalesce(sum(grant_row.quantity_granted::numeric), 0) into total_granted
    from app.opening_entitlement_grants as grant_row
   where grant_row.user_id = target_user_id and grant_row.box_id = target_box_id;
  select count(*)::numeric into total_consumed
    from app.opening_entitlement_consumptions as consumption
   where consumption.user_id = target_user_id and consumption.box_id = target_box_id;

  return query select
    'consumed',
    maximum::text,
    (completed + 1)::text,
    greatest(total_granted - total_consumed, 0)::text;
exception
  when no_data_found then
    raise exception using
      errcode = '23514',
      constraint = 'opening_v2_catalog_snapshot_invalid',
      message = 'The opening-v2 catalog snapshot is invalid.';
end
$function$;

create function app.read_opening_v2_entitlement_state(
  target_user_id uuid,
  target_box_id uuid
)
returns table (
  box_id uuid,
  max_openings_per_user text,
  successful_openings text,
  granted text,
  consumed text,
  remaining text,
  available boolean,
  limit_reached boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  with catalog as (
    select version.max_openings_per_user::numeric as maximum
      from app.boxes as box
      join app.box_versions as version on version.id = box.current_published_version_id
     where box.id = target_box_id
       and box.status = 'active'
       and version.state = 'published'
       and version.opening_compatibility_version = 'opening-v2'
  ), totals as (
    select
      coalesce((select sum(grant_row.quantity_granted::numeric)
                  from app.opening_entitlement_grants as grant_row
                 where grant_row.user_id = target_user_id
                   and grant_row.box_id = target_box_id), 0) as granted,
      (select count(*)::numeric
         from app.opening_entitlement_consumptions as consumption
        where consumption.user_id = target_user_id
          and consumption.box_id = target_box_id) as consumed,
      (select count(*)::numeric
         from app.box_opens as opening
        where opening.user_id = target_user_id
          and opening.box_id = target_box_id
          and opening.opening_compatibility_version = 'opening-v2') as successful
  )
  select target_box_id, catalog.maximum::text, totals.successful::text,
         totals.granted::text, totals.consumed::text,
         greatest(totals.granted - totals.consumed, 0)::text,
         totals.granted > totals.consumed and totals.successful < catalog.maximum,
         totals.successful >= catalog.maximum
    from catalog cross join totals
$function$;

drop function app_private.read_opening_entitlement_state(uuid, uuid);
create function app_private.read_opening_entitlement_state(
  target_user_id uuid,
  target_box_id uuid
)
returns table (box_id uuid, granted numeric, consumed numeric, remaining numeric)
language sql
stable
security definer
set search_path = ''
as $function$
  with grant_totals as (
    select coalesce(sum(grant_row.quantity_granted::numeric), 0) as granted
      from app.opening_entitlement_grants as grant_row
     where grant_row.user_id = target_user_id and grant_row.box_id = target_box_id
  ), consumption_totals as (
    select count(*)::numeric as consumed
      from app.opening_entitlement_consumptions as consumption
     where consumption.user_id = target_user_id and consumption.box_id = target_box_id
  )
  select target_box_id, grant_totals.granted, consumption_totals.consumed,
         grant_totals.granted - consumption_totals.consumed
    from grant_totals cross join consumption_totals
$function$;

alter function app_private.validate_box_open() rename to validate_box_open_v1;
drop trigger box_opens_completion_guard on app.box_opens;
create constraint trigger box_opens_v1_completion_guard
after insert on app.box_opens
deferrable initially deferred
for each row
when (new.opening_compatibility_version = 'opening-v1')
execute function app_private.validate_box_open_v1();

create function app_private.validate_box_open_v2()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  selected_inventory_mode text;
  selected_pool_id uuid;
  selected_pool_policy text;
  obligation_status text;
  consumption_count bigint;
begin
  if not exists (
    select 1 from app.box_versions as version
    where version.id = new.box_version_id
      and version.box_id = new.box_id
      and version.state = 'published'
      and version.opening_compatibility_version = 'opening-v2'
      and version.max_openings_per_user is not null
      and version.configuration_hash = new.configuration_hash
      and version.rng_algorithm_version = new.rng_algorithm_version
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'opening_v2_catalog_snapshot_invalid',
      message = 'The opening catalog snapshot is invalid or not opening-v2 compatible.';
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
   where opening_id = new.id and inventory_pool_id = new.inventory_pool_id;

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

  if exists (select 1 from app.creator_earnings where opening_id = new.id) then
    raise exception using
      errcode = '23514',
      constraint = 'opening_v2_creator_earning_forbidden',
      message = 'An opening-v2 result cannot create creator earnings.';
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

create constraint trigger box_opens_v2_completion_guard
after insert on app.box_opens
deferrable initially deferred
for each row
when (new.opening_compatibility_version = 'opening-v2')
execute function app_private.validate_box_open_v2();

create function app_private.validate_opening_entitlement_linkage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  linked bigint;
begin
  select count(*) into linked
    from app.opening_entitlement_consumptions as consumption
   where consumption.opening_id = new.id;

  if (new.opening_compatibility_version = 'opening-v2' and linked <> 1)
    or (new.opening_compatibility_version = 'opening-v1' and linked <> 0) then
    raise exception using
      errcode = '23514',
      constraint = 'box_open_entitlement_link_invalid',
      message = 'Opening entitlement consumption does not match the opening model.';
  end if;
  return new;
end
$function$;

create constraint trigger box_opens_entitlement_link_guard
after insert on app.box_opens
deferrable initially deferred
for each row execute function app_private.validate_opening_entitlement_linkage();

-- R1B openings are deliberately excluded from the paid leaderboard-v1 model.
create or replace view app_private.leaderboard_authoritative_rows as
with aggregates as (
  select 'global'::text as scope_type, 'all_time'::text as period_type,
         null::uuid as creator_id, null::uuid as season_id,
         opening.user_id, sum(opening.points_awarded)::bigint as points,
         count(*)::bigint as total_openings,
         count(*) filter (where opening.bonus_points > 0)::bigint as base_reward_wins,
         max(opening.created_at) as score_reached_at
    from app.box_opens as opening
   where opening.opening_compatibility_version = 'opening-v1'
   group by opening.user_id
  union all
  select 'creator', 'all_time', opening.creator_id, null::uuid,
         opening.user_id, sum(opening.points_awarded)::bigint,
         count(*)::bigint,
         count(*) filter (where opening.bonus_points > 0)::bigint,
         max(opening.created_at)
    from app.box_opens as opening
   where opening.opening_compatibility_version = 'opening-v1'
   group by opening.creator_id, opening.user_id
  union all
  select 'global', 'season', null::uuid, season.id,
         opening.user_id, sum(opening.points_awarded)::bigint,
         count(*)::bigint,
         count(*) filter (where opening.bonus_points > 0)::bigint,
         max(opening.created_at)
    from app.leaderboard_seasons as season
    join app.box_opens as opening
      on opening.created_at >= season.starts_at and opening.created_at < season.ends_at
     and opening.opening_compatibility_version = 'opening-v1'
   group by season.id, opening.user_id
  union all
  select 'creator', 'season', opening.creator_id, season.id,
         opening.user_id, sum(opening.points_awarded)::bigint,
         count(*)::bigint,
         count(*) filter (where opening.bonus_points > 0)::bigint,
         max(opening.created_at)
    from app.leaderboard_seasons as season
    join app.box_opens as opening
      on opening.created_at >= season.starts_at and opening.created_at < season.ends_at
     and opening.opening_compatibility_version = 'opening-v1'
   group by season.id, opening.creator_id, opening.user_id
)
select aggregate.scope_type, aggregate.period_type, aggregate.creator_id, aggregate.season_id,
       aggregate.user_id, users.username::text as username, aggregate.points,
       aggregate.total_openings, aggregate.base_reward_wins, aggregate.score_reached_at,
       floor(extract(epoch from aggregate.score_reached_at) * 1000000)::numeric(78,0)::text
         as score_reached_at_micros,
       max(aggregate.score_reached_at) over (
         partition by aggregate.scope_type, aggregate.period_type,
                      aggregate.creator_id, aggregate.season_id
       ) as as_of
  from aggregates as aggregate
  join app.users as users on users.id = aggregate.user_id;

create or replace function app_private.lock_box_open_leaderboard_season()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.opening_compatibility_version = 'opening-v1' then
    perform app.lock_leaderboard_season_for_opening(new.created_at);
  end if;
  return new;
end
$function$;

create or replace function app_private.enqueue_leaderboard_projection_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.event_type = 'opening.completed.v1' and exists (
    select 1 from app.box_opens as opening
     where opening.id = new.aggregate_id
       and opening.opening_compatibility_version = 'opening-v1'
  ) then
    insert into app.leaderboard_projection_events (outbox_event_id, available_at, created_at)
    values (new.id, new.created_at, new.created_at);
  end if;
  return null;
end
$function$;

create or replace function app.read_leaderboard_projection_event_ids()
returns table (event_id uuid, opening_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  select event.id, event.aggregate_id
    from app.event_outbox as event
    join app.box_opens as opening on opening.id = event.aggregate_id
   where event.event_type = 'opening.completed.v1'
     and opening.opening_compatibility_version = 'opening-v1'
   order by event.created_at, event.id
$function$;

revoke all on table app_private.opening_v2_user_box_guards from public, creatordrop_app, creatordrop_worker;
revoke all on function app_private.lock_opening_v2_user_box_guard(uuid, uuid, uuid)
  from public, creatordrop_app, creatordrop_worker;
revoke all on function app_private.lock_and_validate_opening_v2_limit()
  from public, creatordrop_app, creatordrop_worker;
revoke all on function app_private.validate_box_open_v1()
  from public, creatordrop_app, creatordrop_worker;
revoke all on function app_private.validate_box_open_v2()
  from public, creatordrop_app, creatordrop_worker;
revoke all on function app_private.validate_opening_entitlement_linkage()
  from public, creatordrop_app, creatordrop_worker;
revoke all on function app_private.read_opening_entitlement_state(uuid, uuid)
  from public, creatordrop_app, creatordrop_worker;
revoke all on function app.consume_opening_v2_entitlement(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea
) from public, creatordrop_worker;
grant execute on function app.consume_opening_v2_entitlement(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea
) to creatordrop_app;
revoke all on function app.read_opening_v2_entitlement_state(uuid, uuid)
  from public, creatordrop_worker;
grant execute on function app.read_opening_v2_entitlement_state(uuid, uuid)
  to creatordrop_app;

comment on column app.box_opens.opening_compatibility_version is
  'Immutable opening model snapshot. opening-v2 rows are non-financial and consume one entitlement.';
comment on function app.consume_opening_v2_entitlement(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea
) is 'Transaction-owned deterministic opening-v2 entitlement consumption primitive.';

reset role;
