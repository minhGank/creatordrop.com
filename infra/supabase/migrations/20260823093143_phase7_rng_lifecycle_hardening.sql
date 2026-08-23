-- Phase 7 audit hardening: lifecycle integrity, resumable compromise remediation,
-- and operation-bound rotation idempotency. No opening or financial state is added.

set role creatordrop_migrator;

alter table app.rng_seed_sets
  drop constraint rng_seed_sets_lifecycle_shape;
alter table app.rng_seed_sets
  add constraint rng_seed_sets_lifecycle_shape check (
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
      and revealed_server_seed is not null
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
  );

alter table app.rng_seed_sets
  add constraint rng_seed_sets_predecessor_not_self check (
    rotated_from_seed_set_id is null or rotated_from_seed_set_id <> id
  ),
  add constraint rng_seed_sets_profile_foreign_key foreign key (user_id)
    references app.fairness_profiles (user_id) on delete restrict,
  add constraint rng_seed_sets_key_iv_unique unique (
    encryption_key_version, encryption_iv
  );

create function app_private.protect_rng_seed_set_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status <> 'active'
    or new.next_nonce <> 0
    or new.retired_at is not null
    or new.revealed_at is not null
    or new.compromised_at is not null
    or new.revealed_server_seed is not null
    or new.retirement_reason is not null
    or new.compromise_reason is not null then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_initial_state_invalid',
      message = 'RNG seed sets must be inserted in the canonical active state.';
  end if;
  return new;
end
$function$;

create trigger rng_seed_sets_insert_guard
before insert on app.rng_seed_sets
for each row execute function app_private.protect_rng_seed_set_insert();

create or replace function app_private.protect_rng_seed_set_update()
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
    or new.created_at <> old.created_at
    or (
      old.retired_at is not null
      and new.retired_at is distinct from old.retired_at
    )
    or (
      old.retirement_reason is not null
      and new.retirement_reason is distinct from old.retirement_reason
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_cryptographic_history_immutable',
      message = 'RNG seed-set cryptographic and retirement history is immutable.';
  end if;

  if old.status = 'active' and new.status = 'active' then
    if new.next_nonce <> old.next_nonce + 1 then
      raise exception using
        errcode = '23514',
        constraint = 'rng_seed_set_nonce_increment_invalid',
        message = 'An active RNG nonce must increment exactly once.';
    end if;
  elsif old.status = 'active' and new.status = 'retired' then
    if new.next_nonce <> old.next_nonce then
      raise exception using
        errcode = '23514',
        constraint = 'rng_seed_set_transition_nonce_changed',
        message = 'RNG lifecycle transitions cannot change nonce state.';
    end if;
  elsif old.status = 'active' and new.status = 'compromised' then
    if new.next_nonce <> old.next_nonce
      or new.retired_at is not null
      or new.retirement_reason is not null then
      raise exception using
        errcode = '23514',
        constraint = 'rng_seed_set_transition_invalid',
        message = 'An active compromised seed cannot fabricate retirement history.';
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
    and (
      new.revealed_server_seed is null
      or extensions.digest(new.revealed_server_seed, 'sha256')
        is distinct from new.commitment
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_reveal_commitment_mismatch',
      message = 'The revealed RNG seed does not match its commitment.';
  end if;

  return new;
end
$function$;

alter table app.rng_seed_rotations
  add column operation_fingerprint bytea,
  add column operation_type text,
  add column transition_reason text,
  add column completed_at timestamptz;

update app.rng_seed_rotations as rotation
set operation_type = case
      when predecessor.retirement_reason is null then 'compromise_replacement'
      else 'rotation'
    end,
    transition_reason = coalesce(
      predecessor.retirement_reason,
      predecessor.compromise_reason,
      'user_request'
    ),
    completed_at = rotation.created_at
from app.rng_seed_sets as predecessor
where predecessor.id = rotation.previous_seed_set_id;

update app.rng_seed_rotations
set operation_fingerprint = extensions.digest(
  convert_to(
    'creatordrop:rng-rotation:v1|'
      || operation_type
      || '|'
      || transition_reason,
    'UTF8'
  ),
  'sha256'
);

alter table app.rng_seed_rotations
  alter column new_seed_set_id drop not null,
  alter column operation_fingerprint set not null,
  alter column operation_type set not null,
  alter column transition_reason set not null;

alter table app.rng_seed_rotations
  add constraint rng_seed_rotations_fingerprint_size check (
    octet_length(operation_fingerprint) = 32
  ),
  add constraint rng_seed_rotations_operation_check check (
    (
      operation_type = 'rotation'
      and transition_reason in ('user_request', 'operational_request', 'policy_change')
    ) or (
      operation_type = 'compromise_replacement'
      and transition_reason in ('key_compromise', 'operational_compromise')
    )
  ),
  add constraint rng_seed_rotations_completion_shape check (
    (
      operation_type = 'compromise_replacement'
      and new_seed_set_id is null
      and completed_at is null
    ) or (
      new_seed_set_id is not null
      and completed_at is not null
      and completed_at >= created_at
    )
  );

create function app_private.protect_rng_seed_rotation_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.new_seed_set_id is not null
    or new.id <> old.id
    or new.user_id <> old.user_id
    or new.idempotency_key <> old.idempotency_key
    or new.previous_seed_set_id <> old.previous_seed_set_id
    or new.operation_fingerprint <> old.operation_fingerprint
    or new.operation_type <> old.operation_type
    or new.transition_reason <> old.transition_reason
    or new.created_at <> old.created_at
    or new.new_seed_set_id is null
    or new.completed_at is null then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_update_invalid',
      message = 'Only one pending RNG seed remediation completion is allowed.';
  end if;
  return new;
end
$function$;

create trigger rng_seed_rotations_update_guard
before update on app.rng_seed_rotations
for each row execute function app_private.protect_rng_seed_rotation_update();

grant update on table app.rng_seed_rotations to creatordrop_app;

comment on column app.rng_seed_rotations.operation_fingerprint is
  'SHA-256 of the versioned transition type and allowlisted reason.';
comment on column app.rng_seed_rotations.completed_at is
  'NULL only while a compromised predecessor safely has no active successor.';

reset role;
