-- Phase 12 actor-binding key lifecycle: make signing-key identities part of the
-- authoritative cross-domain registry and allow only one active verifier key.

set role creatordrop_migrator;

drop trigger fulfillment_actor_binding_keys_mutation_guard
  on app_private.fulfillment_actor_binding_keys;

alter table app_private.encryption_key_domain_identities
  drop constraint encryption_key_domain_identity_domain_check,
  add constraint encryption_key_domain_identity_domain_check check (
    encryption_domain in ('rng', 'address', 'digital_secret', 'actor_binding')
  );

do $block$
begin
  if exists (
    select 1
      from app_private.fulfillment_actor_binding_keys as actor_key
      join app_private.encryption_key_domain_identities as registered
        on registered.key_identity = extensions.digest(actor_key.key_material, 'sha256')
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'encryption_key_domain_material_reuse';
  end if;
end
$block$;

alter table app_private.fulfillment_actor_binding_keys
  add column key_identity bytea,
  add column status text,
  add column activated_at timestamptz,
  add column retired_at timestamptz;

update app_private.fulfillment_actor_binding_keys
   set key_identity = extensions.digest(key_material, 'sha256'),
       status = 'active',
       activated_at = created_at;

alter table app_private.fulfillment_actor_binding_keys
  alter column key_identity set not null,
  alter column status set not null,
  alter column status set default 'active',
  alter column activated_at set not null,
  alter column activated_at set default statement_timestamp(),
  add constraint fulfillment_actor_binding_key_identity_size check (
    octet_length(key_identity) = 32
  ),
  add constraint fulfillment_actor_binding_key_identity_unique unique (key_identity),
  add constraint fulfillment_actor_binding_key_version_identity_unique unique (
    version, key_identity
  ),
  add constraint fulfillment_actor_binding_key_status_check check (
    status in ('active', 'retired')
  ),
  add constraint fulfillment_actor_binding_key_lifecycle_shape check (
    (status = 'active' and retired_at is null)
    or
    (status = 'retired' and retired_at is not null and retired_at >= activated_at)
  );

create unique index fulfillment_actor_binding_keys_one_active_idx
  on app_private.fulfillment_actor_binding_keys ((true))
  where status = 'active';

insert into app_private.encryption_key_domain_identities (key_identity, encryption_domain)
select key_identity, 'actor_binding'
  from app_private.fulfillment_actor_binding_keys;

create function app_private.prepare_fulfillment_actor_binding_key_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  derived_identity bytea;
begin
  derived_identity := extensions.digest(new.key_material, 'sha256');
  if new.key_identity is not null and new.key_identity is distinct from derived_identity then
    raise exception using
      errcode = '23514',
      constraint = 'fulfillment_actor_binding_key_identity_untrusted';
  end if;
  new.key_identity := derived_identity;
  return new;
end
$function$;

create or replace function app_private.reject_cross_domain_encryption_key_reuse()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target_domain text;
begin
  if tg_table_name = 'rng_encryption_key_versions' then
    if exists (
      select 1 from app.rng_encryption_key_versions
       where version = new.version and key_identity = new.key_identity
    ) then
      return new;
    end if;
    target_domain := 'rng';
  elsif tg_table_name = 'fulfillment_encryption_key_versions' then
    if exists (
      select 1 from app.fulfillment_encryption_key_versions
       where encryption_domain = new.encryption_domain
         and version = new.version and key_identity = new.key_identity
    ) then
      return new;
    end if;
    target_domain := new.encryption_domain;
  else
    if exists (
      select 1 from app_private.fulfillment_actor_binding_keys
       where version = new.version and key_identity = new.key_identity
    ) then
      return new;
    end if;
    target_domain := 'actor_binding';
  end if;

  begin
    insert into app_private.encryption_key_domain_identities (
      key_identity, encryption_domain
    ) values (new.key_identity, target_domain);
  exception when unique_violation then
    raise exception using
      errcode = '23514',
      constraint = 'encryption_key_domain_material_reuse';
  end;
  return new;
end
$function$;

create trigger fulfillment_actor_binding_keys_000_identity_guard
before insert on app_private.fulfillment_actor_binding_keys
for each row execute function app_private.prepare_fulfillment_actor_binding_key_insert();

create trigger fulfillment_actor_binding_keys_010_domain_separation_guard
before insert on app_private.fulfillment_actor_binding_keys
for each row execute function app_private.reject_cross_domain_encryption_key_reuse();

create or replace function app_private.reject_fulfillment_actor_binding_key_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE'
    or old.version is distinct from new.version
    or old.key_material is distinct from new.key_material
    or old.key_identity is distinct from new.key_identity
    or old.created_at is distinct from new.created_at
    or old.activated_at is distinct from new.activated_at
    or old.status is distinct from 'active'
    or new.status is distinct from 'retired'
    or old.retired_at is not null
    or new.retired_at is null then
    raise exception using
      errcode = '23514',
      constraint = 'fulfillment_actor_binding_key_immutable';
  end if;
  return new;
end
$function$;

create trigger fulfillment_actor_binding_keys_mutation_guard
before update or delete on app_private.fulfillment_actor_binding_keys
for each row execute function app_private.reject_fulfillment_actor_binding_key_mutation();

create function app_private.validate_fulfillment_actor_binding_active_key()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if (select count(*) from app_private.fulfillment_actor_binding_keys where status = 'active') <> 1
  then
    raise exception using
      errcode = '23514',
      constraint = 'fulfillment_actor_binding_active_key_invalid';
  end if;
  return null;
end
$function$;

create constraint trigger fulfillment_actor_binding_keys_active_guard
after insert or update on app_private.fulfillment_actor_binding_keys
deferrable initially deferred
for each row execute function app_private.validate_fulfillment_actor_binding_active_key();

create table app_private.fulfillment_actor_binding_key_rotations (
  id uuid primary key default extensions.gen_random_uuid(),
  previous_version text not null,
  previous_key_identity bytea not null,
  new_version text not null,
  new_key_identity bytea not null,
  reason text not null,
  rotated_at timestamptz not null default statement_timestamp(),
  constraint fulfillment_actor_binding_rotation_previous_fk foreign key (
    previous_version, previous_key_identity
  ) references app_private.fulfillment_actor_binding_keys (version, key_identity) on delete restrict,
  constraint fulfillment_actor_binding_rotation_new_fk foreign key (
    new_version, new_key_identity
  ) references app_private.fulfillment_actor_binding_keys (version, key_identity) on delete restrict,
  constraint fulfillment_actor_binding_rotation_new_unique unique (new_version),
  constraint fulfillment_actor_binding_rotation_distinct_versions check (
    previous_version <> new_version
  ),
  constraint fulfillment_actor_binding_rotation_distinct_material check (
    previous_key_identity <> new_key_identity
  ),
  constraint fulfillment_actor_binding_rotation_reason_format check (
    reason ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  )
);

create trigger fulfillment_actor_binding_key_rotations_history_guard
before update or delete on app_private.fulfillment_actor_binding_key_rotations
for each row execute function app_private.reject_fulfillment_history_mutation();

revoke all on table app_private.fulfillment_actor_binding_key_rotations
  from public, creatordrop_app;

create function app_private.rotate_fulfillment_actor_binding_key(
  new_version text,
  new_key_material bytea,
  rotation_reason text
)
returns table (
  previous_key_version text,
  active_key_version text,
  rotation_id uuid,
  rotated_at timestamptz
)
language plpgsql
set search_path = ''
as $function$
declare
  previous_key app_private.fulfillment_actor_binding_keys%rowtype;
  new_key app_private.fulfillment_actor_binding_keys%rowtype;
  rotation app_private.fulfillment_actor_binding_key_rotations%rowtype;
  transition_time timestamptz := statement_timestamp();
begin
  if new_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    or lower(new_version) in ('__proto__', 'constructor', 'prototype')
    or octet_length(new_key_material) <> 32
    or rotation_reason !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception using
      errcode = '23514',
      constraint = 'fulfillment_actor_binding_rotation_invalid';
  end if;

  select * into previous_key
    from app_private.fulfillment_actor_binding_keys
   where status = 'active'
   for update;
  if not found then
    raise exception using
      errcode = '23514',
      constraint = 'fulfillment_actor_binding_active_key_invalid';
  end if;

  update app_private.fulfillment_actor_binding_keys
     set status = 'retired', retired_at = transition_time
   where version = previous_key.version;

  insert into app_private.fulfillment_actor_binding_keys (
    version, key_material, status, activated_at
  ) values (
    new_version, new_key_material, 'active', transition_time
  ) returning * into new_key;

  insert into app_private.fulfillment_actor_binding_key_rotations (
    previous_version, previous_key_identity, new_version, new_key_identity,
    reason, rotated_at
  ) values (
    previous_key.version, previous_key.key_identity, new_key.version,
    new_key.key_identity, rotation_reason, transition_time
  ) returning * into rotation;

  return query select previous_key.version, new_key.version, rotation.id, rotation.rotated_at;
end
$function$;

revoke all on function app_private.rotate_fulfillment_actor_binding_key(text, bytea, text)
  from public, creatordrop_app;

create function app.get_active_fulfillment_actor_binding_key()
returns table (
  version text,
  key_identity bytea
)
language sql
stable
security definer
set search_path = ''
as $function$
  select actor_key.version, actor_key.key_identity
    from app_private.fulfillment_actor_binding_keys as actor_key
   where actor_key.status = 'active'
$function$;

revoke all on function app.get_active_fulfillment_actor_binding_key() from public;
grant execute on function app.get_active_fulfillment_actor_binding_key() to creatordrop_app;

create or replace function app_private.verify_fulfillment_actor_binding(
  actor_id uuid,
  operation_name text,
  creator_scope_id uuid,
  resource_id uuid,
  nonce_id uuid,
  expected_revision_value bigint,
  action_key_value text,
  command_name_value text,
  fingerprint bytea,
  quantity_value bigint,
  binding_key_version text,
  binding_expires_at_ms bigint,
  binding_signature bytea
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  expected_signature bytea;
  key_material_value bytea;
  message_value text;
  now_ms bigint;
begin
  if operation_name not in (
      'fulfillment.submit_address',
      'fulfillment.creator_action',
      'fulfillment.deliver_digital',
      'fulfillment.redact_user',
      'fulfillment.redact_creator',
      'fulfillment.read_user',
      'fulfillment.read_creator',
      'inventory.restock'
    )
    or command_name_value !~ '^[A-Za-z0-9._:-]{1,128}$'
    or (action_key_value is not null and action_key_value !~ '^[A-Za-z0-9._:-]{1,128}$')
    or (fingerprint is not null and octet_length(fingerprint) <> 32)
    or (quantity_value is not null and quantity_value <= 0)
    or octet_length(binding_signature) <> 32 then
    raise exception using errcode = '42501', constraint = 'fulfillment_actor_binding_invalid';
  end if;

  select binding_key.key_material into key_material_value
    from app_private.fulfillment_actor_binding_keys as binding_key
   where binding_key.version = binding_key_version
     and binding_key.status = 'active';
  if not found then
    raise exception using errcode = '42501', constraint = 'fulfillment_actor_binding_invalid';
  end if;

  now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  if binding_expires_at_ms < now_ms or binding_expires_at_ms > now_ms + 60000 then
    raise exception using errcode = '42501', constraint = 'fulfillment_actor_binding_invalid';
  end if;

  message_value := concat_ws('|',
    'creatordrop:fulfillment-actor-binding:v1',
    binding_key_version,
    actor_id::text,
    operation_name,
    coalesce(creator_scope_id::text, '-'),
    resource_id::text,
    nonce_id::text,
    coalesce(expected_revision_value::text, '-'),
    coalesce(action_key_value, '-'),
    command_name_value,
    coalesce(encode(fingerprint, 'hex'), '-'),
    coalesce(quantity_value::text, '-'),
    binding_expires_at_ms::text
  );
  expected_signature := extensions.hmac(
    convert_to(message_value, 'UTF8'),
    key_material_value,
    'sha256'
  );
  if expected_signature is distinct from binding_signature then
    raise exception using errcode = '42501', constraint = 'fulfillment_actor_binding_invalid';
  end if;
end
$function$;

comment on table app_private.encryption_key_domain_identities is
  'Immutable SHA-256 identities for RNG, address, digital-secret, and actor-binding key separation.';
comment on table app_private.fulfillment_actor_binding_keys is
  'Private active/retired HMAC verifier keys; raw material never enters the shared identity registry.';
comment on table app_private.fulfillment_actor_binding_key_rotations is
  'Immutable operator audit history for explicit actor-binding key rotation.';

reset role;
