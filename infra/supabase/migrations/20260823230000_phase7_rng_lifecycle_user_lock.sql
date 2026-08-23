-- Phase 7 concurrency remediation: serialize every seed-set and rotation write
-- for one user through that user's authoritative fairness-profile row.

set role creatordrop_migrator;

create function app_private.lock_rng_lifecycle_user()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  locked_user_id uuid;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception using
        errcode = '23514',
        constraint = 'rng_lifecycle_user_immutable',
        message = 'RNG lifecycle history cannot move between fairness profiles.';
    end if;

    -- PostgreSQL obtains an UPDATE target's tuple lock before firing BEFORE ROW
    -- triggers. Valid application paths already hold the fairness-profile lock
    -- first. NOWAIT makes a raw, reverse-order UPDATE fail retryably instead of
    -- waiting while holding its tuple lock and forming a deadlock cycle.
    begin
      select profile.user_id into locked_user_id
        from app.fairness_profiles as profile
        where profile.user_id = old.user_id
        for update nowait;
    exception
      when lock_not_available then
        raise exception using
          errcode = '40001',
          constraint = 'rng_lifecycle_user_lock_order_conflict',
          message = 'RNG lifecycle writes must lock the fairness profile first.';
    end;
  else
    -- INSERT has no existing target tuple, so it can safely wait here. This is
    -- the serialization point for active-seed creation and pending/completed
    -- compromise-remediation or normal-rotation insertion.
    select profile.user_id into locked_user_id
      from app.fairness_profiles as profile
      where profile.user_id = new.user_id
      for update;
  end if;

  if locked_user_id is null then
    raise exception using
      errcode = '23503',
      constraint = 'rng_lifecycle_fairness_profile_missing',
      message = 'RNG lifecycle writes require an existing fairness profile.';
  end if;

  return new;
end
$function$;

-- Same-kind triggers execute in name order. These early triggers establish or
-- verify the per-user lifecycle lock before the existing row guards execute.
create trigger rng_seed_sets_000_lifecycle_user_lock
before insert or update on app.rng_seed_sets
for each row execute function app_private.lock_rng_lifecycle_user();

create trigger rng_seed_rotations_000_lifecycle_user_lock
before insert or update on app.rng_seed_rotations
for each row execute function app_private.lock_rng_lifecycle_user();

comment on function app_private.lock_rng_lifecycle_user() is
  'Serializes RNG seed-set and rotation writes through the matching fairness-profile row.';

reset role;
