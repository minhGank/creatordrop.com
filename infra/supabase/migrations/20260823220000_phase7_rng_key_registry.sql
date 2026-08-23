-- Phase 7 audit remediation: make encryption-key identities authoritative and
-- enforce compromise-remediation invariants from both seed and rotation writes.
-- Legacy rows are preserved unresolved until an operator registers their key.

set role creatordrop_migrator;

create table app.rng_encryption_key_versions (
  version text primary key,
  key_identity bytea not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint rng_encryption_key_versions_version_format check (
    version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and lower(version) not in ('__proto__', 'constructor', 'prototype')
  ),
  constraint rng_encryption_key_versions_identity_size check (
    octet_length(key_identity) = 32
  ),
  constraint rng_encryption_key_versions_identity_unique unique (key_identity),
  constraint rng_encryption_key_versions_version_identity_unique unique (
    version, key_identity
  )
);

comment on table app.rng_encryption_key_versions is
  'Operator-provisioned immutable mapping from an encryption key version to its SHA-256 key-material identity.';
comment on column app.rng_encryption_key_versions.key_identity is
  'SHA-256 of uniformly random 32-byte key material; an equality identifier, never a decryption key.';

revoke all on table app.rng_encryption_key_versions from public;
revoke all on table app.rng_encryption_key_versions from creatordrop_app;
grant select on table app.rng_encryption_key_versions to creatordrop_app;

create function app_private.prevent_rng_encryption_key_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    constraint = 'rng_encryption_key_version_immutable',
    message = 'RNG encryption-key version mappings are immutable.';
end
$function$;

create trigger rng_encryption_key_versions_mutation_guard
before update or delete on app.rng_encryption_key_versions
for each row execute function app_private.prevent_rng_encryption_key_version_mutation();

alter table app.rng_seed_sets
  add constraint rng_seed_sets_registered_key_foreign_key foreign key (
    encryption_key_version, encryption_key_identity
  ) references app.rng_encryption_key_versions (version, key_identity)
  on update restrict on delete restrict
  not valid;

create function app_private.enforce_rng_seed_set_registered_key()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  registered_identity bytea;
begin
  select key_identity into registered_identity
    from app.rng_encryption_key_versions
    where version = new.encryption_key_version;

  if not found then
    -- A legacy row may still be disabled after a key has become unavailable,
    -- but it cannot remain usable or otherwise advance its lifecycle.
    if tg_op = 'UPDATE'
      and new.encryption_key_identity is not distinct from old.encryption_key_identity
      and new.status = 'compromised'
      and old.status in ('active', 'retired') then
      return new;
    end if;

    raise exception using
      errcode = '23503',
      constraint = 'rng_seed_set_key_version_unregistered',
      message = 'The RNG encryption-key version has not been operator-provisioned.';
  end if;

  if new.encryption_key_identity is null then
    if tg_op = 'INSERT' then
      new.encryption_key_identity := registered_identity;
      return new;
    end if;

    -- A compromised legacy row may remain unresolved for incident review. All
    -- other updates require a deliberate, exact identity backfill first.
    if new.status = 'compromised'
      and old.status in ('active', 'retired', 'compromised') then
      return new;
    end if;

    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_key_identity_unresolved',
      message = 'The legacy RNG seed key identity has not been established.';
  end if;

  if new.encryption_key_identity is distinct from registered_identity then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_set_key_identity_untrusted',
      message = 'The RNG seed key identity does not match the protected key registry.';
  end if;

  return new;
end
$function$;

-- PostgreSQL fires same-kind triggers in name order. This guard must derive or
-- verify the identity before the existing canonical-insert/update guards run.
create trigger rng_seed_sets_00_registered_key_guard
before insert or update on app.rng_seed_sets
for each row execute function app_private.enforce_rng_seed_set_registered_key();

create or replace function app_private.validate_rng_compromise_rotation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  predecessor app.rng_seed_sets%rowtype;
  predecessor_registered_identity bytea;
  successor app.rng_seed_sets%rowtype;
  successor_registered_identity bytea;
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

  select key_identity into predecessor_registered_identity
    from app.rng_encryption_key_versions
    where version = predecessor.encryption_key_version;
  if not found
    or predecessor.encryption_key_identity is distinct from predecessor_registered_identity then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_key_identity_unavailable',
      message = 'Compromise remediation requires an authoritative predecessor key identity.';
  end if;

  select key_identity into successor_registered_identity
    from app.rng_encryption_key_versions
    where version = successor.encryption_key_version;
  if not found
    or successor.encryption_key_identity is distinct from successor_registered_identity then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_key_identity_unavailable',
      message = 'Compromise remediation requires an authoritative successor key identity.';
  end if;

  if new.transition_reason = 'key_compromise'
    and (
      successor.encryption_key_version = predecessor.encryption_key_version
      or successor_registered_identity = predecessor_registered_identity
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_replacement_key_unsafe',
      message = 'A compromised key cannot protect its successor seed.';
  end if;

  return new;
end
$function$;

create function app_private.validate_rng_seed_set_remediation_state()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1
      from app.rng_seed_rotations as rotation
      join app.rng_seed_sets as active_seed
        on active_seed.user_id = rotation.user_id
       and active_seed.status = 'active'
     where rotation.user_id = new.user_id
       and rotation.operation_type = 'compromise_replacement'
       and rotation.new_seed_set_id is null
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_pending_active_seed_invalid',
      message = 'Pending compromise remediation prohibits a standalone active seed.';
  end if;

  if exists (
    select 1
      from app.rng_seed_rotations as rotation
      join app.rng_seed_sets as predecessor
        on predecessor.id = rotation.previous_seed_set_id
       and predecessor.user_id = rotation.user_id
      join app.rng_seed_sets as successor
        on successor.id = rotation.new_seed_set_id
       and successor.user_id = rotation.user_id
       and successor.rotated_from_seed_set_id = predecessor.id
     where rotation.user_id = new.user_id
       and rotation.operation_type = 'compromise_replacement'
       and rotation.transition_reason = 'key_compromise'
       and rotation.new_seed_set_id is not null
       and (
         predecessor.encryption_key_version = successor.encryption_key_version
         or (
           predecessor.encryption_key_identity is not null
           and predecessor.encryption_key_identity = successor.encryption_key_identity
         )
       )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_replacement_key_unsafe',
      message = 'A compromised key cannot protect its successor seed.';
  end if;

  return new;
end
$function$;

create constraint trigger rng_seed_sets_remediation_semantic_guard
after insert or update on app.rng_seed_sets
deferrable initially deferred
for each row execute function app_private.validate_rng_seed_set_remediation_state();

create function app_private.validate_rng_key_version_registration()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1 from app.rng_seed_sets
    where encryption_key_version = new.version
      and encryption_key_identity is not null
      and encryption_key_identity <> new.key_identity
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_encryption_key_version_legacy_identity_mismatch',
      message = 'The registered key identity conflicts with preserved RNG history.';
  end if;

  if exists (
    select 1
      from app.rng_seed_rotations as rotation
      join app.rng_seed_sets as predecessor on predecessor.id = rotation.previous_seed_set_id
      join app.rng_seed_sets as successor on successor.id = rotation.new_seed_set_id
     where rotation.operation_type = 'compromise_replacement'
       and rotation.transition_reason = 'key_compromise'
       and (
         predecessor.encryption_key_version = successor.encryption_key_version
         or (
           predecessor.encryption_key_identity is not null
           and predecessor.encryption_key_identity = successor.encryption_key_identity
         )
       )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_replacement_key_unsafe',
      message = 'The key registry exposes an unsafe completed compromise replacement.';
  end if;

  return new;
end
$function$;

create constraint trigger rng_encryption_key_versions_registration_guard
after insert on app.rng_encryption_key_versions
deferrable initially deferred
for each row execute function app_private.validate_rng_key_version_registration();

-- This is the fingerprint of the documented all-zero local-development key.
-- Production and other test key versions must be explicitly operator-provisioned.
-- It is inserted after the registration guard exists so conflicting preserved
-- local history makes the migration fail closed like every operator provision.
insert into app.rng_encryption_key_versions (version, key_identity)
values (
  'local-dev-v1',
  decode('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925', 'hex')
);

do $validate_legacy_rng_key_history$
begin
  if exists (
    select 1
      from app.rng_seed_rotations as rotation
      join app.rng_seed_sets as predecessor on predecessor.id = rotation.previous_seed_set_id
      left join app.rng_seed_sets as successor on successor.id = rotation.new_seed_set_id
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
         or (
           rotation.new_seed_set_id is not null
           and (
             successor.id is null
             or successor.user_id <> rotation.user_id
             or successor.rotated_from_seed_set_id <> predecessor.id
             or successor.status <> 'active'
           )
         )
         or (
           rotation.new_seed_set_id is not null
           and rotation.transition_reason = 'key_compromise'
           and (
             predecessor.encryption_key_version = successor.encryption_key_version
             or (
               predecessor.encryption_key_identity is not null
               and predecessor.encryption_key_identity = successor.encryption_key_identity
             )
           )
         )
       )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'rng_seed_rotation_legacy_key_history_unsafe',
      message = 'Existing RNG compromise-remediation history requires operator review.';
  end if;
end
$validate_legacy_rng_key_history$;

reset role;
