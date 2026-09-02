-- Phase 13 remediation: serialize season finalization with qualifying openings,
-- restore least-privilege table access, and terminalize exhausted projection leases.

set role creatordrop_migrator;

create function app.lock_leaderboard_season_for_opening(target_opened_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  season app.leaderboard_seasons%rowtype;
begin
  if target_opened_at is null or not isfinite(target_opened_at) then
    raise exception using
      errcode = '22023',
      constraint = 'leaderboard_opening_timestamp_invalid';
  end if;

  select * into season
    from app.leaderboard_seasons
   where target_opened_at >= starts_at and target_opened_at < ends_at
   for key share;

  if not found then return null; end if;
  if season.status = 'finalized' then
    raise exception using
      errcode = '40001',
      constraint = 'leaderboard_season_already_finalized';
  end if;
  return season.id;
end
$function$;

create function app_private.lock_box_open_leaderboard_season()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform app.lock_leaderboard_season_for_opening(new.created_at);
  return new;
end
$function$;

create trigger box_opens_000_leaderboard_season_lock
before insert on app.box_opens
for each row execute function app_private.lock_box_open_leaderboard_season();

create or replace function app.claim_leaderboard_projection_events(
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

  update app.leaderboard_projection_events as projection
     set status = 'dead', claimed_by = null, claim_token = null,
         lease_expires_at = null, applied_at = null,
         last_error_code = 'MAX_ATTEMPTS_EXHAUSTED'
   where projection.attempt_count >= maximum_attempts
     and (
       (projection.status = 'processing'
        and projection.lease_expires_at <= clock_timestamp())
       or (projection.status = 'pending'
           and projection.available_at <= clock_timestamp())
     );

  return query
  with candidates as (
    select projection.outbox_event_id
      from app.leaderboard_projection_events as projection
     where projection.attempt_count < maximum_attempts
       and (
         (projection.status = 'pending' and projection.available_at <= clock_timestamp())
         or (projection.status = 'processing'
             and projection.lease_expires_at <= clock_timestamp())
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

revoke all on table app.leaderboard_seasons, app.leaderboard_season_results,
  app.user_achievements, app.leaderboard_projection_events from creatordrop_app;

revoke all on function app.lock_leaderboard_season_for_opening(timestamptz) from public;
revoke all on function app_private.lock_box_open_leaderboard_season() from public;
grant execute on function app.lock_leaderboard_season_for_opening(timestamptz)
  to creatordrop_app;

comment on function app.lock_leaderboard_season_for_opening(timestamptz) is
  'Acquires the shared season lifecycle barrier for a caller-owned opening transaction.';

reset role;
