-- Phase 7 audit hardening: persist non-secret encryption-key identity and enforce
-- compromise-remediation semantics at transaction commit. Existing rows remain
-- NULL until a keyring-backed application/operator backfill establishes the true
-- SHA-256 key fingerprint; key-compromise completion fails closed until then.

set role creatordrop_migrator;

alter table app.rng_seed_sets
  add column encryption_key_identity bytea,
  add constraint rng_seed_sets_key_identity_size check (
    encryption_key_identity is null or octet_length(encryption_key_identity) = 32
  );

create unique index rng_seed_sets_key_identity_iv_unique_index
  on app.rng_seed_sets (encryption_key_identity, encryption_iv)
  where encryption_key_identity is not null;

create or replace function app_private.protect_rng_seed_set_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status <> 'active'
    or new.next_nonce <> 0
    or new.encryption_key_identity is null
    or new.retired_at is not null
    or new.revealed_at is not null
    or new.compromised_at is not null
    or new.revealed_server_seed is not null
    or new.retirement_reason is not null
    or new.compromise_reason is not null then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_initial_state_invalid',
      message = 'RNG seed sets must be inserted in the canonical active state with key identity.';
  end if;
  return new;
end
$function$;

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
      old.encryption_key_identity is not null
      and new.encryption_key_identity is distinct from old.encryption_key_identity
    )
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

  if old.encryption_key_identity is null and new.encryption_key_identity is not null then
    if new.status is distinct from old.status
      or new.next_nonce is distinct from old.next_nonce
      or new.retirement_reason is distinct from old.retirement_reason
      or new.compromise_reason is distinct from old.compromise_reason
      or new.retired_at is distinct from old.retired_at
      or new.revealed_at is distinct from old.revealed_at
      or new.compromised_at is distinct from old.compromised_at
      or new.revealed_server_seed is distinct from old.revealed_server_seed then
      raise exception using
        errcode = '23514',
        constraint = 'rng_seed_set_key_identity_backfill_invalid',
        message = 'Legacy RNG key identity must be established without other changes.';
    end if;
    return new;
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

create function app_private.validate_rng_compromise_rotation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  predecessor app.rng_seed_sets%rowtype;
  successor app.rng_seed_sets%rowtype;
begin
  if new.operation_type <> 'compromise_replacement' then
    return new;
  end if;

  select * into predecessor
    from app.rng_seed_sets
    where id = new.previous_seed_set_id and user_id = new.user_id;
  if not found
    or predecessor.status <> 'compromised'
    or predecessor.compromise_reason is distinct from new.transition_reason then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_compromised_predecessor_invalid',
      message = 'Compromise remediation requires the matching compromised predecessor.';
  end if;

  if new.new_seed_set_id is null then
    if exists (
      select 1 from app.rng_seed_sets
      where user_id = new.user_id and status = 'active'
    ) then
      raise exception using
        errcode = '23514',
        constraint = 'rng_seed_rotation_pending_active_seed_invalid',
        message = 'Pending compromise remediation requires zero active seed sets.';
    end if;
    return new;
  end if;

  select * into successor
    from app.rng_seed_sets
    where id = new.new_seed_set_id
      and user_id = new.user_id
      and rotated_from_seed_set_id = new.previous_seed_set_id;
  if not found or successor.status <> 'active' then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_active_successor_invalid',
      message = 'Completed compromise remediation requires the active lineage successor.';
  end if;

  if predecessor.encryption_key_identity is null
    or successor.encryption_key_identity is null then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_key_identity_unavailable',
      message = 'Compromise remediation requires established key identities.';
  end if;

  if new.transition_reason = 'key_compromise'
    and (
      successor.encryption_key_version = predecessor.encryption_key_version
      or successor.encryption_key_identity = predecessor.encryption_key_identity
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_replacement_key_unsafe',
      message = 'A compromised key cannot protect its successor seed.';
  end if;

  return new;
end
$function$;

create constraint trigger rng_seed_rotations_compromise_semantic_guard
after insert or update on app.rng_seed_rotations
deferrable initially deferred
for each row execute function app_private.validate_rng_compromise_rotation();

do $validate_existing_compromise_rotations$
begin
  if exists (
    select 1
    from app.rng_seed_rotations as rotation
    join app.rng_seed_sets as predecessor on predecessor.id = rotation.previous_seed_set_id
    where rotation.operation_type = 'compromise_replacement'
      and (
        predecessor.user_id <> rotation.user_id
        or predecessor.status <> 'compromised'
        or predecessor.compromise_reason is distinct from rotation.transition_reason
        or (
          rotation.new_seed_set_id is null
          and exists (
            select 1 from app.rng_seed_sets as active_seed
            where active_seed.user_id = rotation.user_id and active_seed.status = 'active'
          )
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_legacy_remediation_invalid',
      message = 'Existing RNG compromise-remediation history requires operator review.';
  end if;
end
$validate_existing_compromise_rotations$;

comment on column app.rng_seed_sets.encryption_key_identity is
  'SHA-256 key-material fingerprint for equality only; NULL marks a pre-hardening row requiring keyring-backed backfill.';

reset role;
