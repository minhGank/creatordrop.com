-- R3: global progression, immutable XP rewards, and Universal Entry fallback.
-- Historical catalog/opening/leaderboard rows are never rewritten.
set role creatordrop_migrator;

alter table app.reward_versions
  add column xp_amount bigint,
  add column xp_policy_version text,
  drop constraint reward_versions_reward_type_check,
  add constraint reward_versions_reward_type_check check (reward_type in ('digital','physical','experience','xp')),
  add constraint reward_versions_xp_policy check (
    (reward_type = 'xp' and xp_amount is not null and xp_amount between 1 and 500
      and xp_policy_version is not null and xp_policy_version = 'xp-v1'
      and inventory_mode = 'unlimited' and declared_value_minor is null
      and declared_value_currency is null)
    or (reward_type <> 'xp' and xp_amount is null and xp_policy_version is null)
  );

create function app_private.validate_xp_publication() returns trigger
language plpgsql set search_path = '' as $function$
begin
  if new.state = 'published' and old.state <> 'published'
    and new.opening_compatibility_version is distinct from 'opening-v2'
    and exists (select 1 from app.box_version_rewards e join app.reward_versions r
      on r.id = e.reward_version_id where e.box_version_id = new.id and r.reward_type = 'xp') then
    raise exception using errcode = '23514', constraint = 'xp_requires_opening_v2';
  end if;
  return new;
end
$function$;
create trigger box_versions_xp_publication before update on app.box_versions
for each row execute function app_private.validate_xp_publication();

create table app_private.progression_accounts (
  user_id uuid primary key references app.users(id) on delete restrict,
  lifetime_xp bigint not null default 0 check (lifetime_xp >= 0)
);
alter table app.box_opens add constraint box_opens_progression_scope unique(id, user_id);
create table app_private.xp_awards (
  opening_id uuid primary key,
  user_id uuid not null,
  amount bigint not null check (amount between 1 and 500),
  lifetime_xp_after bigint not null check (lifetime_xp_after >= amount),
  level_before bigint not null check (level_before >= 1),
  level_after bigint not null check (level_after >= level_before),
  created_at timestamptz not null default statement_timestamp(),
  unique(opening_id, user_id),
  foreign key(opening_id, user_id) references app.box_opens(id, user_id) on delete restrict
);
create index xp_awards_user on app_private.xp_awards(user_id);
create table app_private.universal_entry_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users(id) on delete restrict,
  source_level bigint not null check (source_level >= 2),
  source_opening_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  unique(user_id, source_level), unique(id, user_id),
  foreign key(source_opening_id, user_id) references app_private.xp_awards(opening_id, user_id)
);
create table app_private.universal_entry_consumptions (
  opening_id uuid primary key,
  grant_id uuid not null unique,
  user_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  foreign key(grant_id, user_id) references app_private.universal_entry_grants(id, user_id),
  foreign key(opening_id, user_id) references app.box_opens(id, user_id)
    on delete restrict deferrable initially deferred
);
create index universal_entry_consumptions_user on app_private.universal_entry_consumptions(user_id);

create function app_private.level_for_xp(xp bigint) returns bigint
language plpgsql immutable strict set search_path = '' as $function$
declare lo bigint := 1; hi bigint := 1; mid bigint;
begin
  if xp < 0 then raise exception using errcode = '22023'; end if;
  while 50::numeric * hi * (hi - 1) <= xp loop hi := hi * 2; end loop;
  while hi - lo > 1 loop
    mid := (lo + hi) / 2;
    if 50::numeric * mid * (mid - 1) <= xp then lo := mid; else hi := mid; end if;
  end loop;
  return lo;
end
$function$;

create function app_private.lock_progression(target_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $function$
begin
  if not exists(select 1 from app.users where id = target_user_id and status = 'active') then
    raise exception using errcode = '42501', constraint = 'progression_actor_inactive';
  end if;
  -- Domain-separated account lock is always first, before box/grant/fairness locks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('r3:progression:' || target_user_id::text, 0));
  insert into app_private.progression_accounts(user_id) values(target_user_id) on conflict do nothing;
  perform 1 from app_private.progression_accounts where user_id = target_user_id for update;
end
$function$;

create or replace function app_private.lock_and_validate_opening_v2_limit()
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
  -- Raw opening inserts must not wait for the global lock while holding later R1 locks.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('r3:progression:' || new.user_id::text, 0)) then
    raise exception using errcode = '40001', constraint = 'progression_lock_order';
  end if;
  perform app_private.lock_progression(new.user_id);


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

create function app_private.award_opening_xp() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare amount bigint; before_xp bigint; after_xp bigint; before_level bigint; after_level bigint;
begin
  if new.opening_compatibility_version <> 'opening-v2' then return new; end if;
  select xp_amount into amount from app.reward_versions where id = new.reward_version_id;
  if amount is null then return new; end if;
  -- Raw inserts arriving in reverse lock order fail retryably, never wait while holding RNG locks.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('r3:progression:' || new.user_id::text, 0)) then
    raise exception using errcode = '40001', constraint = 'progression_lock_order';
  end if;
  perform app_private.lock_progression(new.user_id);
  select lifetime_xp into strict before_xp from app_private.progression_accounts where user_id = new.user_id;
  after_xp := before_xp + amount;
  before_level := app_private.level_for_xp(before_xp);
  after_level := app_private.level_for_xp(after_xp);
  insert into app_private.xp_awards(opening_id,user_id,amount,lifetime_xp_after,level_before,level_after)
    values(new.id,new.user_id,amount,after_xp,before_level,after_level);
  update app_private.progression_accounts set lifetime_xp = after_xp where user_id = new.user_id;
  insert into app_private.universal_entry_grants(user_id,source_level,source_opening_id)
    select new.user_id, level, new.id from generate_series(before_level+1,after_level) as level;
  return new;
end
$function$;
create trigger box_opens_award_xp after insert on app.box_opens
for each row execute function app_private.award_opening_xp();

create function app_private.validate_progression_account() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare total bigint; earned bigint;
begin
  select lifetime_xp into total from app_private.progression_accounts where user_id = new.user_id;
  select count(*) into earned from app_private.universal_entry_grants where user_id = new.user_id;
  if total::numeric <> (select coalesce(sum(amount),0) from app_private.xp_awards where user_id = new.user_id)
    or earned <> app_private.level_for_xp(total)-1 then
    raise exception using errcode = '23514', constraint = 'progression_projection_invalid';
  end if;
  return new;
end
$function$;
create constraint trigger progression_account_consistency after insert or update on app_private.progression_accounts
 deferrable initially deferred for each row execute function app_private.validate_progression_account();

-- Preserve the existing creator entitlement primitive and its lock/limit checks.
alter function app.consume_opening_v2_entitlement(uuid,uuid,uuid,uuid,uuid,uuid,bytea) rename to consume_creator_entitlement;
alter function app.consume_creator_entitlement(uuid,uuid,uuid,uuid,uuid,uuid,bytea) set schema app_private;
revoke all on function app_private.consume_creator_entitlement(uuid,uuid,uuid,uuid,uuid,uuid,bytea) from public,creatordrop_app,creatordrop_worker;

create function app.consume_opening_v2_entitlement(
  target_consumption_id uuid,target_opening_id uuid,target_user_id uuid,target_creator_id uuid,
  target_box_id uuid,target_box_version_id uuid,target_configuration_hash bytea
) returns table(outcome text,max_openings_per_user text,successful_openings text,remaining_entitlements text,
  source text, universal_entries_remaining text)
language plpgsql security definer set search_path = '' as $function$
declare result record; selected_id uuid; remaining_count bigint;
begin
  perform app_private.lock_progression(target_user_id);
  if not exists(select 1 from app.creators where id=target_creator_id and status='active') then
    raise exception using errcode='23514',constraint='opening_v2_catalog_snapshot_invalid';
  end if;
  select * into strict result from app_private.consume_creator_entitlement(target_consumption_id,
    target_opening_id,target_user_id,target_creator_id,target_box_id,target_box_version_id,target_configuration_hash);
  if result.outcome = 'entitlement_required' then
    select g.id into selected_id from app_private.universal_entry_grants g
      where g.user_id = target_user_id and not exists
        (select 1 from app_private.universal_entry_consumptions c where c.grant_id = g.id)
      order by g.source_level,g.id for update of g limit 1;
    if selected_id is not null then
      insert into app_private.universal_entry_consumptions(opening_id,grant_id,user_id)
        values(target_opening_id,selected_id,target_user_id);
    end if;
  end if;
  select count(*) into remaining_count from app_private.universal_entry_grants g
    where g.user_id = target_user_id and not exists
      (select 1 from app_private.universal_entry_consumptions c where c.grant_id = g.id);
  return query select case when selected_id is not null then 'consumed' else result.outcome end,
    result.max_openings_per_user,
    case when selected_id is not null then (result.successful_openings::numeric+1)::text else result.successful_openings end,
    result.remaining_entitlements,
    case when selected_id is not null then 'universal' when result.outcome='consumed' then 'creator' else null end,
    remaining_count::text;
end
$function$;

create function app.read_progression(target_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $function$
  with account as (
    select coalesce((select lifetime_xp from app_private.progression_accounts where user_id = target_user_id),0) as xp
    where exists(select 1 from app.users where id = target_user_id and status = 'active')
  ), state as(select xp,app_private.level_for_xp(xp) as level from account)
  select jsonb_build_object('lifetimeXp',xp::text,'level',level::text,
    'xpInLevel',(xp::numeric - 50::numeric*level*(level-1))::text,'xpForNextLevel',(level*100)::text,
    'universalEntriesEarned',(level-1)::text,
    'universalEntriesAvailable',(select count(*)::text from app_private.universal_entry_grants g
       where g.user_id = target_user_id and not exists
       (select 1 from app_private.universal_entry_consumptions c where c.grant_id=g.id))) from state
$function$;

create function app.read_opening_progression(target_user_id uuid,target_opening_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $function$
  select app.read_progression(target_user_id) || jsonb_build_object(
    'xpAwarded',coalesce(a.amount,0)::text,'levelsGained',(coalesce(a.level_after-a.level_before,0))::text,
    'universalEntriesGranted',(coalesce(a.level_after-a.level_before,0))::text)
  from app.box_opens o left join app_private.xp_awards a on a.opening_id=o.id
  where o.id=target_opening_id and o.user_id=target_user_id and o.opening_compatibility_version='opening-v2'
$function$;

alter function app.read_opening_v2_entitlement_state(uuid,uuid) rename to read_creator_entitlement_state;
alter function app.read_creator_entitlement_state(uuid,uuid) set schema app_private;
revoke all on function app_private.read_creator_entitlement_state(uuid,uuid) from public,creatordrop_app,creatordrop_worker;
create function app.read_opening_v2_entitlement_state(target_user_id uuid,target_box_id uuid)
returns table(box_id uuid,max_openings_per_user text,successful_openings text,granted text,consumed text,
  remaining text,available boolean,limit_reached boolean,universal_entries_available text,source text)
language sql stable security definer set search_path = '' as $function$
  select s.box_id,s.max_openings_per_user,s.successful_openings,s.granted,s.consumed,s.remaining,
    not s.limit_reached and (s.remaining::numeric>0 or (p.state->>'universalEntriesAvailable')::numeric>0),
    s.limit_reached,p.state->>'universalEntriesAvailable',
    case when s.remaining::numeric>0 then 'creator'
      when (p.state->>'universalEntriesAvailable')::numeric>0 then 'universal' else null end
  from app_private.read_creator_entitlement_state(target_user_id,target_box_id) s
  cross join lateral (select app.read_progression(target_user_id) as state) p where p.state is not null
    and exists(select 1 from app.boxes b join app.creators c on c.id=b.creator_id
      where b.id=target_box_id and c.status='active')
$function$;

create or replace function app_private.validate_opening_entitlement_linkage() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare linked bigint;
begin
  select (select count(*) from app.opening_entitlement_consumptions where opening_id=new.id)
       + (select count(*) from app_private.universal_entry_consumptions where opening_id=new.id) into linked;
  if (new.opening_compatibility_version='opening-v2' and linked<>1)
    or (new.opening_compatibility_version='opening-v1' and linked<>0) then
    raise exception using errcode='23514',constraint='box_open_entitlement_link_invalid';
  end if;
  return new;
end
$function$;

create or replace function app_private.validate_box_open_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  selected_reward_type text;
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

  select reward_version.reward_type, reward_version.inventory_mode, reward_version.inventory_pool_id, pool.stockout_policy
    into selected_reward_type, selected_inventory_mode, selected_pool_id, selected_pool_policy
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

  if selected_reward_type = 'xp' then
    if not exists(select 1 from app.reward_wins w join app_private.xp_awards a on a.opening_id=w.opening_id
      join app.reward_versions r on r.id=w.reward_version_id
      where w.opening_id=new.id and w.user_id=new.user_id and w.creator_id=new.creator_id
        and w.reward_version_id=new.reward_version_id and a.amount=r.xp_amount)
      or exists(select 1 from app.fulfillment_obligations where opening_id=new.id) then
      raise exception using errcode='23514',constraint='xp_opening_result_invalid';
    end if;
    obligation_status := 'not_required';
  else
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

-- History is retained; normal runtime no longer processes leaderboard queues or seasons.
-- The historical v1 test/tooling path remains explicitly isolated from active startup.
create trigger xp_awards_immutable before update or delete on app_private.xp_awards
for each row execute function app_private.prevent_opening_entitlement_history_mutation();
create trigger universal_entry_grants_immutable before update or delete on app_private.universal_entry_grants
for each row execute function app_private.prevent_opening_entitlement_history_mutation();
create trigger universal_entry_consumptions_immutable before update or delete on app_private.universal_entry_consumptions
for each row execute function app_private.prevent_opening_entitlement_history_mutation();
alter table app_private.progression_accounts enable row level security;
revoke all on app_private.progression_accounts from public,anon,authenticated,creatordrop_app,creatordrop_worker;
alter table app_private.xp_awards enable row level security;
revoke all on app_private.xp_awards from public,anon,authenticated,creatordrop_app,creatordrop_worker;
alter table app_private.universal_entry_grants enable row level security;
revoke all on app_private.universal_entry_grants from public,anon,authenticated,creatordrop_app,creatordrop_worker;
alter table app_private.universal_entry_consumptions enable row level security;
revoke all on app_private.universal_entry_consumptions from public,anon,authenticated,creatordrop_app,creatordrop_worker;
revoke all on function app_private.validate_xp_publication() from public,anon,authenticated,creatordrop_app,creatordrop_worker;
revoke all on function app_private.level_for_xp(bigint) from public,anon,authenticated,creatordrop_app,creatordrop_worker;
revoke all on function app_private.lock_progression(uuid) from public,anon,authenticated,creatordrop_app,creatordrop_worker;
revoke all on function app_private.award_opening_xp() from public,anon,authenticated,creatordrop_app,creatordrop_worker;
revoke all on function app_private.validate_progression_account() from public,anon,authenticated,creatordrop_app,creatordrop_worker;
revoke all on function app.consume_opening_v2_entitlement(uuid,uuid,uuid,uuid,uuid,uuid,bytea) from public,anon,authenticated,creatordrop_worker;
grant execute on function app.consume_opening_v2_entitlement(uuid,uuid,uuid,uuid,uuid,uuid,bytea) to creatordrop_app;
revoke all on function app.read_progression(uuid) from public,anon,authenticated,creatordrop_worker;
grant execute on function app.read_progression(uuid) to creatordrop_app;
revoke all on function app.read_opening_progression(uuid,uuid) from public,anon,authenticated,creatordrop_worker;
grant execute on function app.read_opening_progression(uuid,uuid) to creatordrop_app;
revoke all on function app.read_opening_v2_entitlement_state(uuid,uuid) from public,anon,authenticated,creatordrop_worker;
grant execute on function app.read_opening_v2_entitlement_state(uuid,uuid) to creatordrop_app;
comment on column app.reward_versions.xp_amount is 'xp-v1 platform policy: integer 1–500, unlimited non-financial reward; frozen on publication.';
comment on table app_private.xp_awards is 'Opening-derived immutable XP history. No point conversion or public grant command.';
reset role;
