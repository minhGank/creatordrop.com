-- Phase 7 RNG lifecycle only: encrypted per-user server seeds, client-seed state,
-- concurrency-safe nonce counters, rotation history, and reveal protection.

set role creatordrop_migrator;

create table app.fairness_profiles (
  user_id uuid primary key,
  current_client_seed text not null,
  current_client_seed_hash bytea generated always as (
    extensions.digest(decode(current_client_seed, 'hex'), 'sha256')
  ) stored,
  revision integer not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint fairness_profiles_user_foreign_key foreign key (user_id)
    references app.users (id) on delete restrict,
  constraint fairness_profiles_client_seed_format check (
    current_client_seed ~ '^[0-9a-f]{64}$'
  ),
  constraint fairness_profiles_revision_positive check (revision >= 1)
);

create table app.rng_seed_sets (
  id uuid primary key,
  user_id uuid not null,
  commitment bytea not null,
  server_seed_ciphertext bytea not null,
  encryption_iv bytea not null,
  encryption_auth_tag bytea not null,
  encryption_key_version text not null,
  rng_algorithm_version text not null,
  status text not null default 'active',
  next_nonce bigint not null default 0,
  max_nonce_exclusive bigint not null,
  rotate_after timestamptz not null,
  rotated_from_seed_set_id uuid,
  retirement_reason text,
  compromise_reason text,
  created_at timestamptz not null default statement_timestamp(),
  retired_at timestamptz,
  revealed_at timestamptz,
  compromised_at timestamptz,
  revealed_server_seed bytea,
  constraint rng_seed_sets_user_foreign_key foreign key (user_id)
    references app.users (id) on delete restrict,
  constraint rng_seed_sets_id_user_unique unique (id, user_id),
  constraint rng_seed_sets_id_rotated_from_unique unique (id, rotated_from_seed_set_id),
  constraint rng_seed_sets_rotated_from_user_foreign_key foreign key (
    rotated_from_seed_set_id, user_id
  ) references app.rng_seed_sets (id, user_id) on delete restrict,
  constraint rng_seed_sets_commitment_unique unique (commitment),
  constraint rng_seed_sets_rotated_from_unique unique (rotated_from_seed_set_id),
  constraint rng_seed_sets_commitment_size check (octet_length(commitment) = 32),
  constraint rng_seed_sets_ciphertext_size check (octet_length(server_seed_ciphertext) = 32),
  constraint rng_seed_sets_iv_size check (octet_length(encryption_iv) = 12),
  constraint rng_seed_sets_auth_tag_size check (octet_length(encryption_auth_tag) = 16),
  constraint rng_seed_sets_key_version_length check (
    char_length(encryption_key_version) between 1 and 64
  ),
  constraint rng_seed_sets_algorithm_check check (
    rng_algorithm_version = 'hmac-sha256-rejection-v1'
  ),
  constraint rng_seed_sets_status_check check (
    status in ('active', 'retired', 'revealed', 'compromised')
  ),
  constraint rng_seed_sets_nonce_bounds check (
    next_nonce >= 0
    and max_nonce_exclusive > 0
    and next_nonce <= max_nonce_exclusive
  ),
  constraint rng_seed_sets_rotation_time_check check (rotate_after > created_at),
  constraint rng_seed_sets_lifecycle_time_order_check check (
    (retired_at is null or retired_at >= created_at)
    and (revealed_at is null or (retired_at is not null and revealed_at >= retired_at))
    and (
      compromised_at is null
      or (
        compromised_at >= created_at
        and (retired_at is null or compromised_at >= retired_at)
      )
    )
  ),
  constraint rng_seed_sets_retirement_reason_check check (
    retirement_reason is null
    or retirement_reason in ('user_request', 'operational_request', 'policy_change')
  ),
  constraint rng_seed_sets_compromise_reason_check check (
    compromise_reason is null
    or compromise_reason in (
      'key_compromise', 'operational_compromise', 'integrity_verification_failed'
    )
  ),
  constraint rng_seed_sets_lifecycle_shape check (
    (
      status = 'active'
      and retired_at is null
      and revealed_at is null
      and compromised_at is null
      and revealed_server_seed is null
      and retirement_reason is null
      and compromise_reason is null
    ) or (
      status = 'retired'
      and retired_at is not null
      and revealed_at is null
      and compromised_at is null
      and revealed_server_seed is null
      and retirement_reason is not null
      and compromise_reason is null
    ) or (
      status = 'revealed'
      and retired_at is not null
      and revealed_at is not null
      and compromised_at is null
      and octet_length(revealed_server_seed) = 32
      and retirement_reason is not null
      and compromise_reason is null
    ) or (
      status = 'compromised'
      and revealed_at is null
      and compromised_at is not null
      and revealed_server_seed is null
      and compromise_reason is not null
      and ((retired_at is null) = (retirement_reason is null))
    )
  )
);

create unique index rng_seed_sets_one_active_per_user_index
  on app.rng_seed_sets (user_id)
  where status = 'active';
create index rng_seed_sets_reveal_queue_index
  on app.rng_seed_sets (status, retired_at)
  where status = 'retired';
create index rng_seed_sets_user_history_index
  on app.rng_seed_sets (user_id, created_at desc, id);

create table app.rng_seed_rotations (
  id uuid primary key,
  user_id uuid not null,
  idempotency_key text not null,
  previous_seed_set_id uuid not null,
  new_seed_set_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint rng_seed_rotations_user_foreign_key foreign key (user_id)
    references app.users (id) on delete restrict,
  constraint rng_seed_rotations_previous_user_foreign_key foreign key (
    previous_seed_set_id, user_id
  ) references app.rng_seed_sets (id, user_id) on delete restrict,
  constraint rng_seed_rotations_new_user_foreign_key foreign key (
    new_seed_set_id, user_id
  ) references app.rng_seed_sets (id, user_id) on delete restrict,
  constraint rng_seed_rotations_lineage_foreign_key foreign key (
    new_seed_set_id, previous_seed_set_id
  ) references app.rng_seed_sets (id, rotated_from_seed_set_id) on delete restrict,
  constraint rng_seed_rotations_user_key_unique unique (user_id, idempotency_key),
  constraint rng_seed_rotations_previous_unique unique (previous_seed_set_id),
  constraint rng_seed_rotations_new_unique unique (new_seed_set_id),
  constraint rng_seed_rotations_distinct_seeds check (previous_seed_set_id <> new_seed_set_id),
  constraint rng_seed_rotations_key_format check (
    idempotency_key ~ '^[A-Za-z0-9._~-]{8,128}$'
  )
);

create function app_private.protect_fairness_profile_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.user_id <> old.user_id
    or new.created_at <> old.created_at
    or new.revision <> old.revision + 1
    or new.updated_at < old.updated_at then
    raise exception using
      errcode = '23514',
      constraint = 'fairness_profile_update_invalid',
      message = 'Fairness profile updates must preserve identity and increment revision once.';
  end if;
  return new;
end
$function$;

create trigger fairness_profiles_update_guard
before update on app.fairness_profiles
for each row execute function app_private.protect_fairness_profile_update();

create function app_private.protect_rng_seed_set_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id <> old.id
    or new.user_id <> old.user_id
    or new.commitment <> old.commitment
    or new.server_seed_ciphertext <> old.server_seed_ciphertext
    or new.encryption_iv <> old.encryption_iv
    or new.encryption_auth_tag <> old.encryption_auth_tag
    or new.encryption_key_version <> old.encryption_key_version
    or new.rng_algorithm_version <> old.rng_algorithm_version
    or new.max_nonce_exclusive <> old.max_nonce_exclusive
    or new.rotate_after <> old.rotate_after
    or new.rotated_from_seed_set_id is distinct from old.rotated_from_seed_set_id
    or new.created_at <> old.created_at then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_cryptographic_history_immutable',
      message = 'RNG seed-set cryptographic history is immutable.';
  end if;

  if old.status = 'active' and new.status = 'active' then
    if new.next_nonce <> old.next_nonce + 1 then
      raise exception using
        errcode = '23514',
        constraint = 'rng_seed_set_nonce_increment_invalid',
        message = 'An active RNG nonce must increment exactly once.';
    end if;
  elsif old.status = 'active' and new.status in ('retired', 'compromised') then
    if new.next_nonce <> old.next_nonce then
      raise exception using
        errcode = '23514',
        constraint = 'rng_seed_set_transition_nonce_changed',
        message = 'RNG lifecycle transitions cannot change nonce state.';
    end if;
  elsif old.status = 'retired' and new.status in ('revealed', 'compromised') then
    if new.next_nonce <> old.next_nonce then
      raise exception using
        errcode = '23514',
        constraint = 'rng_seed_set_transition_nonce_changed',
        message = 'RNG lifecycle transitions cannot change nonce state.';
    end if;
  else
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_transition_invalid',
      message = 'The RNG seed-set lifecycle transition is invalid.';
  end if;

  if new.status = 'revealed'
    and extensions.digest(new.revealed_server_seed, 'sha256') <> new.commitment then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_reveal_commitment_mismatch',
      message = 'The revealed RNG seed does not match its commitment.';
  end if;

  return new;
end
$function$;

create trigger rng_seed_sets_update_guard
before update on app.rng_seed_sets
for each row execute function app_private.protect_rng_seed_set_update();

create function app_private.prevent_rng_history_delete()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    constraint = 'rng_history_delete_prohibited',
    message = 'RNG fairness history cannot be deleted.';
end
$function$;

create trigger fairness_profiles_delete_guard
before delete on app.fairness_profiles
for each row execute function app_private.prevent_rng_history_delete();
create trigger rng_seed_sets_delete_guard
before delete on app.rng_seed_sets
for each row execute function app_private.prevent_rng_history_delete();
create trigger rng_seed_rotations_delete_guard
before delete on app.rng_seed_rotations
for each row execute function app_private.prevent_rng_history_delete();

comment on table app.fairness_profiles is
  'Per-user canonical client-seed preference and optimistic revision state.';
comment on table app.rng_seed_sets is
  'Encrypted per-user server-seed commitments, nonce state, and immutable lifecycle history.';
comment on table app.rng_seed_rotations is
  'User-scoped idempotent RNG seed rotation history.';

revoke all on table app.fairness_profiles from public;
revoke all on table app.rng_seed_sets from public;
revoke all on table app.rng_seed_rotations from public;
grant select, insert, update on table app.fairness_profiles to creatordrop_app;
grant select, insert, update on table app.rng_seed_sets to creatordrop_app;
grant select, insert on table app.rng_seed_rotations to creatordrop_app;

reset role;
