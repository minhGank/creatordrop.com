-- Phase 13: authoritative seasons/champions plus a durable, independent queue
-- for rebuilding disposable Redis leaderboard projections.

set role creatordrop_migrator;

create table app.leaderboard_seasons (
  id uuid primary key default extensions.gen_random_uuid(),
  ordinal integer not null unique,
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled',
  created_at timestamptz not null default statement_timestamp(),
  finalized_at timestamptz,
  constraint leaderboard_seasons_ordinal_positive check (ordinal > 0),
  constraint leaderboard_seasons_name_format check (
    char_length(name) between 1 and 100 and name = btrim(name)
  ),
  constraint leaderboard_seasons_boundary_order check (starts_at < ends_at),
  constraint leaderboard_seasons_status_check check (
    status in ('scheduled', 'active', 'finalized')
  ),
  constraint leaderboard_seasons_lifecycle_shape check (
    (status in ('scheduled', 'active') and finalized_at is null)
    or (status = 'finalized' and finalized_at is not null and finalized_at >= ends_at)
  )
);

alter table app.leaderboard_seasons
  add constraint leaderboard_seasons_boundaries_exclude
  exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&);

create unique index leaderboard_seasons_one_active_idx
  on app.leaderboard_seasons ((true)) where status = 'active';
create index leaderboard_seasons_boundaries_idx
  on app.leaderboard_seasons (starts_at, ends_at, id);

create function app_private.protect_leaderboard_season_history()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE'
    or old.id is distinct from new.id
    or old.ordinal is distinct from new.ordinal
    or old.name is distinct from new.name
    or old.starts_at is distinct from new.starts_at
    or old.ends_at is distinct from new.ends_at
    or old.created_at is distinct from new.created_at
    or old.status = 'finalized'
    or not (
      (old.status = 'scheduled' and new.status = 'active' and new.finalized_at is null)
      or
      (old.status = 'active' and new.status = 'finalized' and new.finalized_at is not null)
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'leaderboard_season_history_immutable';
  end if;
  return new;
end
$function$;

create trigger leaderboard_seasons_history_guard
before update or delete on app.leaderboard_seasons
for each row execute function app_private.protect_leaderboard_season_history();

create table app.leaderboard_season_results (
  id uuid primary key default extensions.gen_random_uuid(),
  season_id uuid not null references app.leaderboard_seasons (id) on delete restrict,
  scope_type text not null,
  creator_id uuid references app.creators (id) on delete restrict,
  winner_user_id uuid not null references app.users (id) on delete restrict,
  points bigint not null,
  total_openings bigint not null,
  base_reward_wins bigint not null,
  score_reached_at timestamptz not null,
  finalized_at timestamptz not null,
  constraint leaderboard_season_results_scope_check check (
    (scope_type = 'global' and creator_id is null)
    or (scope_type = 'creator' and creator_id is not null)
  ),
  constraint leaderboard_season_results_stats_check check (
    points > 0 and total_openings > 0
    and base_reward_wins >= 0 and base_reward_wins <= total_openings
  )
);

create unique index leaderboard_season_results_global_unique_idx
  on app.leaderboard_season_results (season_id) where scope_type = 'global';
create unique index leaderboard_season_results_creator_unique_idx
  on app.leaderboard_season_results (season_id, creator_id) where scope_type = 'creator';
create index leaderboard_season_results_winner_idx
  on app.leaderboard_season_results (winner_user_id, season_id, id);

create table app.user_achievements (
  id uuid primary key default extensions.gen_random_uuid(),
  season_result_id uuid not null unique
    references app.leaderboard_season_results (id) on delete restrict,
  user_id uuid not null references app.users (id) on delete restrict,
  achievement_type text not null,
  season_id uuid not null references app.leaderboard_seasons (id) on delete restrict,
  creator_id uuid references app.creators (id) on delete restrict,
  awarded_at timestamptz not null,
  constraint user_achievements_scope_check check (
    (achievement_type = 'global_season_champion' and creator_id is null)
    or (achievement_type = 'creator_season_champion' and creator_id is not null)
  )
);

create unique index user_achievements_global_unique_idx
  on app.user_achievements (user_id, season_id, achievement_type)
  where creator_id is null;
create unique index user_achievements_creator_unique_idx
  on app.user_achievements (user_id, season_id, achievement_type, creator_id)
  where creator_id is not null;
create index user_achievements_user_awarded_idx
  on app.user_achievements (user_id, awarded_at desc, id);

create function app_private.reject_leaderboard_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514', constraint = 'leaderboard_history_immutable';
end
$function$;

create trigger leaderboard_season_results_history_guard
before update or delete on app.leaderboard_season_results
for each row execute function app_private.reject_leaderboard_history_mutation();
create trigger user_achievements_history_guard
before update or delete on app.user_achievements
for each row execute function app_private.reject_leaderboard_history_mutation();

create view app_private.leaderboard_authoritative_rows as
with aggregates as (
  select 'global'::text as scope_type, 'all_time'::text as period_type,
         null::uuid as creator_id, null::uuid as season_id,
         opening.user_id, sum(opening.points_awarded)::bigint as points,
         count(*)::bigint as total_openings,
         count(*) filter (where opening.bonus_points > 0)::bigint as base_reward_wins,
         max(opening.created_at) as score_reached_at
    from app.box_opens as opening
   group by opening.user_id
  union all
  select 'creator', 'all_time', opening.creator_id, null::uuid,
         opening.user_id, sum(opening.points_awarded)::bigint,
         count(*)::bigint,
         count(*) filter (where opening.bonus_points > 0)::bigint,
         max(opening.created_at)
    from app.box_opens as opening
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

create function app_private.validate_leaderboard_season_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  expected app_private.leaderboard_authoritative_rows%rowtype;
  season app.leaderboard_seasons%rowtype;
begin
  select * into season from app.leaderboard_seasons where id = new.season_id;
  if not found or season.status <> 'finalized' or new.finalized_at is distinct from season.finalized_at then
    raise exception using errcode = '23514', constraint = 'leaderboard_season_result_invalid';
  end if;

  select * into expected
    from app_private.leaderboard_authoritative_rows as row
   where row.period_type = 'season'
     and row.season_id = new.season_id
     and row.scope_type = new.scope_type
     and row.creator_id is not distinct from new.creator_id
   order by row.points desc, row.score_reached_at asc, row.user_id asc
   limit 1;

  if not found
    or new.winner_user_id is distinct from expected.user_id
    or new.points is distinct from expected.points
    or new.total_openings is distinct from expected.total_openings
    or new.base_reward_wins is distinct from expected.base_reward_wins
    or new.score_reached_at is distinct from expected.score_reached_at then
    raise exception using errcode = '23514', constraint = 'leaderboard_season_result_invalid';
  end if;
  return new;
end
$function$;

create trigger leaderboard_season_results_validation_guard
before insert on app.leaderboard_season_results
for each row execute function app_private.validate_leaderboard_season_result();

create function app_private.validate_user_achievement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result app.leaderboard_season_results%rowtype;
  season app.leaderboard_seasons%rowtype;
begin
  select * into result from app.leaderboard_season_results where id = new.season_result_id;
  select * into season from app.leaderboard_seasons where id = new.season_id;
  if not found
    or season.status <> 'finalized'
    or result.season_id is distinct from new.season_id
    or result.winner_user_id is distinct from new.user_id
    or result.creator_id is distinct from new.creator_id
    or new.achievement_type is distinct from (
      case result.scope_type
        when 'global' then 'global_season_champion' else 'creator_season_champion'
      end
    )
    or new.awarded_at is distinct from season.finalized_at then
    raise exception using errcode = '23514', constraint = 'user_achievement_winner_invalid';
  end if;
  return new;
end
$function$;

create trigger user_achievements_validation_guard
before insert on app.user_achievements
for each row execute function app_private.validate_user_achievement();

create function app_private.validate_finalized_leaderboard_season()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  expected_global integer;
  expected_creators integer;
  actual_global integer;
  actual_creators integer;
  result_count integer;
  achievement_count integer;
begin
  if new.status <> 'finalized' then return null; end if;
  select case when exists (
           select 1 from app_private.leaderboard_authoritative_rows
            where period_type = 'season' and season_id = new.id and scope_type = 'global'
         ) then 1 else 0 end,
         (select count(distinct creator_id)::integer
            from app_private.leaderboard_authoritative_rows
           where period_type = 'season' and season_id = new.id and scope_type = 'creator')
    into expected_global, expected_creators;
  select count(*) filter (where scope_type = 'global')::integer,
         count(*) filter (where scope_type = 'creator')::integer,
         count(*)::integer
    into actual_global, actual_creators, result_count
    from app.leaderboard_season_results where season_id = new.id;
  select count(*)::integer into achievement_count
    from app.user_achievements where season_id = new.id;
  if actual_global <> expected_global or actual_creators <> expected_creators
     or achievement_count <> result_count then
    raise exception using errcode = '23514', constraint = 'leaderboard_season_finalization_incomplete';
  end if;
  return null;
end
$function$;

create constraint trigger leaderboard_seasons_finalization_guard
after insert or update on app.leaderboard_seasons
deferrable initially deferred
for each row execute function app_private.validate_finalized_leaderboard_season();

create function app.finalize_leaderboard_season(target_season_id uuid)
returns table (
  season_id uuid,
  global_champions integer,
  creator_champions integer,
  achievements_awarded integer,
  finalized_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  season app.leaderboard_seasons%rowtype;
  transition_time timestamptz := clock_timestamp();
begin
  select * into season from app.leaderboard_seasons
   where id = target_season_id for update;
  if not found then
    raise exception using errcode = '22023', constraint = 'leaderboard_season_not_found';
  end if;
  if season.status = 'finalized' then
    return query
      select season.id,
             count(*) filter (where result.scope_type = 'global')::integer,
             count(*) filter (where result.scope_type = 'creator')::integer,
             (select count(*)::integer from app.user_achievements as achievement
               where achievement.season_id = season.id),
             season.finalized_at
        from app.leaderboard_season_results as result
       where result.season_id = season.id
       group by season.id, season.finalized_at;
    if not found then
      return query select season.id, 0, 0, 0, season.finalized_at;
    end if;
    return;
  end if;
  if season.status <> 'active' or season.ends_at > transition_time then
    raise exception using errcode = '23514', constraint = 'leaderboard_season_not_finalizable';
  end if;

  update app.leaderboard_seasons
     set status = 'finalized', finalized_at = transition_time
   where id = season.id
   returning * into season;

  insert into app.leaderboard_season_results (
    season_id, scope_type, creator_id, winner_user_id, points, total_openings,
    base_reward_wins, score_reached_at, finalized_at
  )
  select season.id, 'global', null, row.user_id, row.points, row.total_openings,
         row.base_reward_wins, row.score_reached_at, transition_time
    from app_private.leaderboard_authoritative_rows as row
   where row.period_type = 'season' and row.scope_type = 'global' and row.season_id = season.id
   order by row.points desc, row.score_reached_at asc, row.user_id asc
   limit 1;

  insert into app.leaderboard_season_results (
    season_id, scope_type, creator_id, winner_user_id, points, total_openings,
    base_reward_wins, score_reached_at, finalized_at
  )
  select season.id, 'creator', ranked.creator_id, ranked.user_id, ranked.points,
         ranked.total_openings, ranked.base_reward_wins, ranked.score_reached_at,
         transition_time
    from (
      select row.*,
             row_number() over (
               partition by row.creator_id
               order by row.points desc, row.score_reached_at asc, row.user_id asc
             ) as rank
        from app_private.leaderboard_authoritative_rows as row
       where row.period_type = 'season' and row.scope_type = 'creator'
         and row.season_id = season.id
    ) as ranked
   where ranked.rank = 1;

  insert into app.user_achievements (
    season_result_id, user_id, achievement_type, season_id, creator_id, awarded_at
  )
  select result.id, result.winner_user_id,
         case result.scope_type when 'global' then 'global_season_champion'
                                else 'creator_season_champion' end,
         result.season_id, result.creator_id, transition_time
    from app.leaderboard_season_results as result
   where result.season_id = season.id;

  return query
    select season.id,
           count(*) filter (where result.scope_type = 'global')::integer,
           count(*) filter (where result.scope_type = 'creator')::integer,
           (select count(*)::integer from app.user_achievements as achievement
             where achievement.season_id = season.id),
           transition_time
      from app.leaderboard_season_results as result
     where result.season_id = season.id
     group by season.id;
  if not found then return query select season.id, 0, 0, 0, transition_time; end if;
end
$function$;

create table app.leaderboard_projection_events (
  outbox_event_id uuid primary key references app.event_outbox (id) on delete restrict,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  available_at timestamptz not null,
  claimed_by text,
  claim_token uuid,
  lease_expires_at timestamptz,
  applied_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  constraint leaderboard_projection_status_check check (
    status in ('pending', 'processing', 'applied', 'dead')
  ),
  constraint leaderboard_projection_attempt_check check (attempt_count >= 0),
  constraint leaderboard_projection_error_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint leaderboard_projection_shape_check check (
    (status = 'pending' and claim_token is null and claimed_by is null
      and lease_expires_at is null and applied_at is null)
    or (status = 'processing' and claim_token is not null and claimed_by is not null
      and lease_expires_at is not null and applied_at is null)
    or (status = 'applied' and claim_token is null and claimed_by is null
      and lease_expires_at is null and applied_at is not null and last_error_code is null)
    or (status = 'dead' and claim_token is null and claimed_by is null
      and lease_expires_at is null and applied_at is null and last_error_code is not null)
  )
);

create index leaderboard_projection_claim_idx
  on app.leaderboard_projection_events
  (status, available_at, lease_expires_at, created_at, outbox_event_id);

create function app_private.enqueue_leaderboard_projection_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.event_type = 'opening.completed.v1' then
    insert into app.leaderboard_projection_events (outbox_event_id, available_at, created_at)
    values (new.id, new.created_at, new.created_at);
  end if;
  return null;
end
$function$;

create trigger event_outbox_leaderboard_projection_enqueue
after insert on app.event_outbox
for each row execute function app_private.enqueue_leaderboard_projection_event();

insert into app.leaderboard_projection_events (outbox_event_id, available_at, created_at)
select id, created_at, created_at from app.event_outbox
 where event_type = 'opening.completed.v1'
on conflict (outbox_event_id) do nothing;

create function app.claim_leaderboard_projection_events(
  worker_id text,
  batch_size integer,
  lease_ms integer,
  maximum_attempts integer
)
returns table (outbox_event_id uuid, claim_token uuid, attempt_count integer)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' or batch_size not between 1 and 100
     or lease_ms not between 5000 and 300000 or maximum_attempts not between 1 and 100 then
    raise exception using errcode = '22023', constraint = 'leaderboard_projection_claim_invalid';
  end if;
  return query
  with candidates as (
    select projection.outbox_event_id
      from app.leaderboard_projection_events as projection
     where projection.attempt_count < maximum_attempts
       and (
         (projection.status = 'pending' and projection.available_at <= clock_timestamp())
         or (projection.status = 'processing' and projection.lease_expires_at <= clock_timestamp())
       )
     order by projection.created_at, projection.outbox_event_id
     for update skip locked
     limit batch_size
  )
  update app.leaderboard_projection_events as projection
     set status = 'processing', attempt_count = projection.attempt_count + 1,
         claimed_by = worker_id, claim_token = extensions.gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => lease_ms::double precision / 1000),
         last_error_code = null
    from candidates
   where projection.outbox_event_id = candidates.outbox_event_id
  returning projection.outbox_event_id, projection.claim_token, projection.attempt_count;
end
$function$;

create function app.complete_leaderboard_projection_event(
  target_event_id uuid,
  target_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update app.leaderboard_projection_events
     set status = 'applied', claimed_by = null, claim_token = null,
         lease_expires_at = null, applied_at = clock_timestamp(), last_error_code = null
   where outbox_event_id = target_event_id and status = 'processing'
     and claim_token = target_claim_token;
  if not found then
    raise exception using errcode = '55000', constraint = 'leaderboard_projection_claim_not_owned';
  end if;
end
$function$;

create function app.fail_leaderboard_projection_event(
  target_event_id uuid,
  target_claim_token uuid,
  failure_code text,
  retry_at timestamptz,
  terminal boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if failure_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or retry_at < clock_timestamp() then
    raise exception using errcode = '22023', constraint = 'leaderboard_projection_failure_invalid';
  end if;
  update app.leaderboard_projection_events
     set status = case when terminal then 'dead' else 'pending' end,
         claimed_by = null, claim_token = null, lease_expires_at = null,
         available_at = retry_at, last_error_code = failure_code
   where outbox_event_id = target_event_id and status = 'processing'
     and claim_token = target_claim_token;
  if not found then
    raise exception using errcode = '55000', constraint = 'leaderboard_projection_claim_not_owned';
  end if;
end
$function$;

create function app.read_leaderboard_projection_snapshot(target_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with target as (
    select event.id as event_id, event.aggregate_id as opening_id,
           opening.user_id, opening.creator_id, opening.created_at
      from app.event_outbox as event
      join app.box_opens as opening on opening.id = event.aggregate_id
     where event.id = target_event_id and event.event_type = 'opening.completed.v1'
  ), rows as (
    select row.* from app_private.leaderboard_authoritative_rows as row, target
     where row.user_id = target.user_id and (
       (row.period_type = 'all_time' and row.scope_type = 'global')
       or (row.period_type = 'all_time' and row.scope_type = 'creator'
           and row.creator_id = target.creator_id)
       or (row.period_type = 'season' and row.season_id in (
             select season.id from app.leaderboard_seasons as season, target
              where target.created_at >= season.starts_at and target.created_at < season.ends_at
           ) and (row.scope_type = 'global' or row.creator_id = target.creator_id))
     )
  )
  select case when target.event_id is null then null else jsonb_build_object(
    'eventId', target.event_id,
    'openingId', target.opening_id,
    'boards', coalesce((select jsonb_agg(jsonb_build_object(
      'scopeType', rows.scope_type, 'periodType', rows.period_type,
      'creatorId', rows.creator_id, 'seasonId', rows.season_id,
      'userId', rows.user_id, 'username', rows.username,
      'points', rows.points::text, 'totalOpenings', rows.total_openings::text,
      'baseRewardWins', rows.base_reward_wins::text,
      'scoreReachedAt', rows.score_reached_at,
      'scoreReachedAtMicros', rows.score_reached_at_micros,
      'asOf', rows.as_of
    ) order by rows.period_type, rows.scope_type, rows.creator_id, rows.season_id) from rows), '[]'::jsonb)
  ) end
    from target
$function$;

create function app.read_leaderboard_rebuild_rows()
returns table (
  scope_type text, period_type text, creator_id uuid, season_id uuid,
  user_id uuid, username text, points text, total_openings text,
  base_reward_wins text, score_reached_at timestamptz,
  score_reached_at_micros text, as_of timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select row.scope_type, row.period_type, row.creator_id, row.season_id,
         row.user_id, row.username, row.points::text, row.total_openings::text,
         row.base_reward_wins::text, row.score_reached_at,
         row.score_reached_at_micros, row.as_of
    from app_private.leaderboard_authoritative_rows as row
   order by row.period_type, row.scope_type, row.creator_id, row.season_id,
            row.points desc, row.score_reached_at, row.user_id
$function$;

create function app.read_leaderboard_projection_event_ids()
returns table (event_id uuid, opening_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  select event.id, event.aggregate_id from app.event_outbox as event
   where event.event_type = 'opening.completed.v1'
   order by event.created_at, event.id
$function$;

create function app.read_ended_active_leaderboard_seasons()
returns table (season_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  select season.id from app.leaderboard_seasons as season
   where season.status = 'active' and season.ends_at <= clock_timestamp()
   order by season.ends_at, season.id
$function$;

create function app.read_public_leaderboard(
  requested_scope text,
  requested_creator_id uuid,
  requested_season_id uuid,
  maximum_rows integer default 100
)
returns table (
  rank bigint, username text, points text, total_openings text,
  base_reward_wins text, score_reached_at timestamptz, as_of timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if requested_scope not in ('global_all_time', 'creator_all_time', 'global_season', 'creator_season')
     or maximum_rows not between 1 and 100
     or (requested_scope like 'creator_%' and requested_creator_id is null)
     or (requested_scope like 'global_%' and requested_creator_id is not null)
     or (requested_scope like '%_season' and requested_season_id is null)
     or (requested_scope like '%_all_time' and requested_season_id is not null) then
    raise exception using errcode = '22023', constraint = 'leaderboard_scope_invalid';
  end if;
  return query
  select ranked.rank, ranked.username, ranked.points::text,
         ranked.total_openings::text, ranked.base_reward_wins::text,
         ranked.score_reached_at, ranked.as_of
    from (
      select row.*, row_number() over (
        order by row.points desc, row.score_reached_at asc, row.user_id asc
      ) as rank
        from app_private.leaderboard_authoritative_rows as row
       where row.scope_type = case when requested_scope like 'global_%' then 'global' else 'creator' end
         and row.period_type = case when requested_scope like '%_season' then 'season' else 'all_time' end
         and row.creator_id is not distinct from requested_creator_id
         and row.season_id is not distinct from requested_season_id
    ) as ranked
   order by ranked.rank
   limit maximum_rows;
end
$function$;

create function app.read_public_leaderboard_season(target_season_id uuid)
returns table (
  id uuid, ordinal integer, name text, starts_at timestamptz,
  ends_at timestamptz, status text, finalized_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select season.id, season.ordinal, season.name, season.starts_at,
         season.ends_at, season.status, season.finalized_at
    from app.leaderboard_seasons as season where season.id = target_season_id
$function$;

create function app.read_public_user_achievements(target_username text)
returns table (
  achievement_type text, season_id uuid, season_name text,
  creator_id uuid, awarded_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select achievement.achievement_type, achievement.season_id, season.name,
         achievement.creator_id, achievement.awarded_at
    from app.user_achievements as achievement
    join app.users as users on users.id = achievement.user_id
    join app.leaderboard_seasons as season on season.id = achievement.season_id
   where users.username = target_username::extensions.citext
   order by achievement.awarded_at desc, achievement.id
$function$;

create function app_private.activate_leaderboard_season(target_season_id uuid)
returns app.leaderboard_seasons
language plpgsql
set search_path = ''
as $function$
declare result app.leaderboard_seasons%rowtype;
begin
  update app.leaderboard_seasons set status = 'active'
   where id = target_season_id and status = 'scheduled'
   returning * into result;
  if not found then
    raise exception using errcode = '23514', constraint = 'leaderboard_season_activation_invalid';
  end if;
  return result;
end
$function$;

revoke all on table app.leaderboard_seasons, app.leaderboard_season_results,
  app.user_achievements, app.leaderboard_projection_events from public;
revoke all on function app.finalize_leaderboard_season(uuid),
  app.claim_leaderboard_projection_events(text, integer, integer, integer),
  app.complete_leaderboard_projection_event(uuid, uuid),
  app.fail_leaderboard_projection_event(uuid, uuid, text, timestamptz, boolean),
  app.read_leaderboard_projection_snapshot(uuid), app.read_leaderboard_rebuild_rows(),
  app.read_leaderboard_projection_event_ids(), app.read_ended_active_leaderboard_seasons()
  from public, creatordrop_app;
revoke all on function app.read_public_leaderboard(text, uuid, uuid, integer),
  app.read_public_leaderboard_season(uuid), app.read_public_user_achievements(text) from public;
revoke all on function app_private.activate_leaderboard_season(uuid) from public, creatordrop_app,
  creatordrop_worker;

grant execute on function app.finalize_leaderboard_season(uuid),
  app.claim_leaderboard_projection_events(text, integer, integer, integer),
  app.complete_leaderboard_projection_event(uuid, uuid),
  app.fail_leaderboard_projection_event(uuid, uuid, text, timestamptz, boolean),
  app.read_leaderboard_projection_snapshot(uuid), app.read_leaderboard_rebuild_rows(),
  app.read_leaderboard_projection_event_ids(), app.read_ended_active_leaderboard_seasons()
  to creatordrop_worker;
grant execute on function app.read_public_leaderboard(text, uuid, uuid, integer),
  app.read_public_leaderboard_season(uuid), app.read_public_user_achievements(text)
  to creatordrop_app;

create index box_opens_leaderboard_global_idx on app.box_opens (created_at, user_id, id);
create index box_opens_leaderboard_creator_idx
  on app.box_opens (creator_id, created_at, user_id, id);

comment on table app.leaderboard_seasons is
  'Authoritative explicit non-overlapping global season windows; at most one is active.';
comment on table app.leaderboard_season_results is
  'Immutable PostgreSQL-authoritative global and creator champion results.';
comment on table app.user_achievements is
  'Permanent immutable season-champion badges derived from finalized results.';
comment on table app.leaderboard_projection_events is
  'Independent durable delivery state for the disposable Redis opening projection.';

reset role;
