-- R1A only: opening-v2 catalog/manifests and the non-financial opening
-- entitlement foundation. The paid opening-v1 transaction remains unchanged.

set role creatordrop_migrator;

alter table app.box_versions
  add column max_openings_per_user bigint,
  alter column price_minor drop not null,
  alter column currency drop not null,
  drop constraint box_versions_price_positive,
  drop constraint box_versions_currency_format,
  drop constraint box_versions_opening_compatibility_check,
  add constraint box_versions_opening_compatibility_check check (
    opening_compatibility_version is null
    or opening_compatibility_version in ('opening-v1', 'opening-v2')
  ),
  add constraint box_versions_opening_model_shape check (
    (
      opening_compatibility_version = 'opening-v2'
      and price_minor is null
      and currency is null
      and max_openings_per_user is not null
      and max_openings_per_user > 0
    ) or (
      opening_compatibility_version is distinct from 'opening-v2'
      and price_minor is not null
      and price_minor > 0
      and currency is not null
      and currency ~ '^[A-Z]{3}$'
      and max_openings_per_user is null
    )
  );

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

  if new.opening_compatibility_version is null
    or new.opening_compatibility_version not in ('opening-v1', 'opening-v2') then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_opening_compatibility_required',
      message = 'New published versions must explicitly select an opening compatibility model.';
  end if;

  select count(*) into base_reward_count
  from app.box_version_base_rewards
  where box_version_id = new.id;

  if new.opening_compatibility_version = 'opening-v1' and base_reward_count <> 1 then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_exactly_one_base_reward',
      message = 'An opening-v1 published box requires exactly one base reward.';
  end if;

  if new.opening_compatibility_version = 'opening-v2' and base_reward_count <> 0 then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_v2_base_reward_forbidden',
      message = 'An opening-v2 published box must not use legacy base-reward semantics.';
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
      message = 'Publication requires available creator-scoped pause inventory.';
  end if;
  return new;
end
$function$;

create table app.opening_entitlement_grants (
  id uuid primary key,
  user_id uuid not null references app.users (id) on delete restrict,
  creator_id uuid not null references app.creators (id) on delete restrict,
  box_id uuid not null,
  quantity_granted bigint not null,
  source_type text not null,
  source_identity text not null,
  source_fingerprint bytea not null,
  granted_by_user_id uuid references app.users (id) on delete restrict,
  grant_reason text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint opening_entitlement_grants_box_scope_fk foreign key (box_id, creator_id)
    references app.boxes (id, creator_id) on delete restrict,
  constraint opening_entitlement_grants_scope_unique unique (id, user_id, creator_id, box_id),
  constraint opening_entitlement_grants_source_unique unique (source_type, source_identity),
  constraint opening_entitlement_grants_source_fingerprint_unique unique (source_fingerprint),
  constraint opening_entitlement_grants_quantity_positive check (quantity_granted > 0),
  constraint opening_entitlement_grants_source_type_check check (
    source_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
  ),
  constraint opening_entitlement_grants_source_identity_length check (
    char_length(source_identity) between 1 and 255
  ),
  constraint opening_entitlement_grants_source_fingerprint_length check (
    octet_length(source_fingerprint) = 32
  ),
  constraint opening_entitlement_grants_reason_length check (
    char_length(grant_reason) between 1 and 500
  )
);

create index opening_entitlement_grants_user_box_idx
  on app.opening_entitlement_grants (user_id, box_id, created_at, id);

create table app.opening_entitlement_consumptions (
  id uuid primary key,
  grant_id uuid not null,
  user_id uuid not null,
  creator_id uuid not null,
  box_id uuid not null,
  opening_id uuid not null unique,
  created_at timestamptz not null default statement_timestamp(),
  constraint opening_entitlement_consumptions_grant_scope_fk foreign key (
    grant_id,
    user_id,
    creator_id,
    box_id
  ) references app.opening_entitlement_grants (
    id,
    user_id,
    creator_id,
    box_id
  ) on delete restrict,
  constraint opening_entitlement_consumptions_grant_unique unique (grant_id, id)
);

create index opening_entitlement_consumptions_user_box_idx
  on app.opening_entitlement_consumptions (user_id, box_id, created_at, id);

create function app_private.prevent_opening_entitlement_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    constraint = 'opening_entitlement_history_immutable',
    message = 'Opening entitlement history is immutable.';
end
$function$;

create trigger opening_entitlement_grants_immutable
before update or delete on app.opening_entitlement_grants
for each row execute function app_private.prevent_opening_entitlement_history_mutation();

create trigger opening_entitlement_consumptions_immutable
before update or delete on app.opening_entitlement_consumptions
for each row execute function app_private.prevent_opening_entitlement_history_mutation();

create function app_private.validate_opening_entitlement_consumption()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  grant_quantity bigint;
  consumed_quantity bigint;
begin
  select quantity_granted into strict grant_quantity
  from app.opening_entitlement_grants
  where id = new.grant_id
    and user_id = new.user_id
    and creator_id = new.creator_id
    and box_id = new.box_id
  for update;

  select count(*) into consumed_quantity
  from app.opening_entitlement_consumptions
  where grant_id = new.grant_id;

  if consumed_quantity >= grant_quantity then
    raise exception using
      errcode = '23514',
      constraint = 'opening_entitlement_remaining_nonnegative',
      message = 'An opening entitlement grant cannot be over-consumed.';
  end if;
  return new;
exception
  when no_data_found then
    raise exception using
      errcode = '23514',
      constraint = 'opening_entitlement_consumption_scope_invalid',
      message = 'Opening entitlement consumption must match its grant scope.';
end
$function$;

create trigger opening_entitlement_consumptions_validate
before insert on app.opening_entitlement_consumptions
for each row execute function app_private.validate_opening_entitlement_consumption();

create function app_private.grant_opening_entitlement(
  grant_id uuid,
  target_user_id uuid,
  target_creator_id uuid,
  target_box_id uuid,
  quantity bigint,
  grant_source_type text,
  grant_source_identity text,
  grant_actor_user_id uuid,
  reason text
)
returns table (id uuid, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  identity_fingerprint bytea;
  inserted_id uuid;
  existing app.opening_entitlement_grants%rowtype;
begin
  if quantity <= 0 then
    raise exception using errcode = '22023', message = 'Grant quantity must be positive.';
  end if;

  identity_fingerprint := extensions.digest(
    convert_to(
      jsonb_build_array(grant_source_type, grant_source_identity)::text,
      'utf8'
    ),
    'sha256'
  );

  insert into app.opening_entitlement_grants (
    id,
    user_id,
    creator_id,
    box_id,
    quantity_granted,
    source_type,
    source_identity,
    source_fingerprint,
    granted_by_user_id,
    grant_reason
  ) values (
    grant_id,
    target_user_id,
    target_creator_id,
    target_box_id,
    quantity,
    grant_source_type,
    grant_source_identity,
    identity_fingerprint,
    grant_actor_user_id,
    reason
  )
  on conflict do nothing
  returning opening_entitlement_grants.id into inserted_id;

  if inserted_id is not null then
    return query select inserted_id, false;
    return;
  end if;

  select * into existing
  from app.opening_entitlement_grants
  where source_type = grant_source_type and source_identity = grant_source_identity
  for update;

  if not found then
    raise exception using
      errcode = '23514',
      constraint = 'opening_entitlement_grant_identity_conflict',
      message = 'The opening entitlement grant identity conflicts with existing history.';
  end if;

  if existing.user_id is distinct from target_user_id
    or existing.creator_id is distinct from target_creator_id
    or existing.box_id is distinct from target_box_id
    or existing.quantity_granted is distinct from quantity
    or existing.source_fingerprint is distinct from identity_fingerprint
    or existing.granted_by_user_id is distinct from grant_actor_user_id
    or existing.grant_reason is distinct from reason then
    raise exception using
      errcode = '23514',
      constraint = 'opening_entitlement_source_reused',
      message = 'The opening entitlement source identity was reused with different semantics.';
  end if;

  return query select existing.id, true;
end
$function$;

create function app_private.read_opening_entitlement_state(target_user_id uuid, target_box_id uuid)
returns table (
  box_id uuid,
  granted bigint,
  consumed bigint,
  remaining bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  with grant_totals as (
    select coalesce(sum(grant_row.quantity_granted), 0)::bigint as granted
    from app.opening_entitlement_grants as grant_row
    where grant_row.user_id = target_user_id and grant_row.box_id = target_box_id
  ), consumption_totals as (
    select count(*)::bigint as consumed
    from app.opening_entitlement_consumptions as consumption
    where consumption.user_id = target_user_id and consumption.box_id = target_box_id
  )
  select
    target_box_id,
    grant_totals.granted,
    consumption_totals.consumed,
    grant_totals.granted - consumption_totals.consumed
  from grant_totals cross join consumption_totals;
$function$;

revoke all on table app.opening_entitlement_grants from public, creatordrop_app, creatordrop_worker;
revoke all on table app.opening_entitlement_consumptions from public, creatordrop_app, creatordrop_worker;
revoke all on function app_private.prevent_opening_entitlement_history_mutation() from public;
revoke all on function app_private.validate_opening_entitlement_consumption() from public;
revoke all on function app_private.grant_opening_entitlement(
  uuid, uuid, uuid, uuid, bigint, text, text, uuid, text
) from public, creatordrop_app, creatordrop_worker;
revoke all on function app_private.read_opening_entitlement_state(uuid, uuid)
  from public, creatordrop_app, creatordrop_worker;

comment on column app.box_versions.max_openings_per_user is
  'Immutable opening-v2 per-user successful-opening ceiling; null for opening-v1 history.';
comment on table app.opening_entitlement_grants is
  'Immutable non-financial permission grants scoped to a stable box identity.';
comment on table app.opening_entitlement_consumptions is
  'R1B-ready immutable one-opening consumption history; not wired into opening-v1.';
comment on function app_private.grant_opening_entitlement(
  uuid, uuid, uuid, uuid, bigint, text, text, uuid, text
) is 'Trusted idempotent manual/development grant primitive. Never executable by the application role.';

reset role;
