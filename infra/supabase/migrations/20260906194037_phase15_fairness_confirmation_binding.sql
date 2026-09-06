-- Phase 15 fairness confirmation hardening: establish the server commitment before the
-- opening client seed and preserve that ordering through revision-checked configuration.

set role creatordrop_migrator;

alter table app.fairness_profiles
  drop constraint fairness_profiles_client_seed_format;

alter table app.fairness_profiles
  alter column current_client_seed drop not null;

alter table app.fairness_profiles
  add constraint fairness_profiles_client_seed_format check (
    current_client_seed is null
    or current_client_seed ~ '^[0-9a-f]{64}$'
  );

create or replace function app_private.protect_fairness_profile_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.user_id <> old.user_id
    or new.created_at <> old.created_at
    or new.revision <> old.revision + 1
    or new.updated_at < old.updated_at
    or (old.current_client_seed is not null and new.current_client_seed is null) then
    raise exception using
      errcode = '23514',
      constraint = 'fairness_profile_update_invalid',
      message = 'Fairness profile updates must preserve identity and increment revision once.';
  end if;
  return new;
end
$function$;

comment on column app.fairness_profiles.current_client_seed is
  'Nullable only between initial server-seed commitment creation and the first revision-checked client-seed choice; once set it cannot return to null.';

reset role;
