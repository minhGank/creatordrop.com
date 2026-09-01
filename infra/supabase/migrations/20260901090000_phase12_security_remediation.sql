-- Phase 12 security remediation: bind privileged fulfillment commands to a
-- short-lived authenticated-actor capability, audit only successful protected
-- reads, and prevent encryption-key reuse across RNG/fulfillment domains.

set role creatordrop_migrator;

do $block$
begin
  if exists (
    select 1
      from app.rng_encryption_key_versions as rng_key
      join app.fulfillment_encryption_key_versions as fulfillment_key
        on fulfillment_key.key_identity = rng_key.key_identity
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'encryption_key_domain_material_reuse';
  end if;
end
$block$;

create table app_private.encryption_key_domain_identities (
  key_identity bytea primary key,
  encryption_domain text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint encryption_key_domain_identity_size check (octet_length(key_identity) = 32),
  constraint encryption_key_domain_identity_domain_check check (
    encryption_domain in ('rng', 'address', 'digital_secret')
  )
);

insert into app_private.encryption_key_domain_identities (key_identity, encryption_domain)
select key_identity, 'rng' from app.rng_encryption_key_versions
union all
select key_identity, encryption_domain from app.fulfillment_encryption_key_versions;

revoke all on table app_private.encryption_key_domain_identities from public, creatordrop_app;

create function app_private.reject_encryption_key_domain_identity_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    constraint = 'encryption_key_domain_identity_immutable';
end
$function$;

create trigger encryption_key_domain_identities_mutation_guard
before update or delete on app_private.encryption_key_domain_identities
for each row execute function app_private.reject_encryption_key_domain_identity_mutation();

create function app_private.reject_cross_domain_encryption_key_reuse()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_table_name = 'rng_encryption_key_versions' then
    if exists (
      select 1 from app.rng_encryption_key_versions
       where version = new.version and key_identity = new.key_identity
    ) then
      return new;
    end if;
  elsif exists (
    select 1 from app.fulfillment_encryption_key_versions
     where encryption_domain = new.encryption_domain
       and version = new.version and key_identity = new.key_identity
  ) then
    return new;
  end if;
  begin
    if tg_table_name = 'rng_encryption_key_versions' then
      insert into app_private.encryption_key_domain_identities (
        key_identity, encryption_domain
      ) values (new.key_identity, 'rng');
    else
      insert into app_private.encryption_key_domain_identities (
        key_identity, encryption_domain
      ) values (new.key_identity, new.encryption_domain);
    end if;
  exception when unique_violation then
    raise exception using
      errcode = '23514',
      constraint = 'encryption_key_domain_material_reuse';
  end;
  return new;
end
$function$;

create trigger rng_encryption_key_versions_domain_separation_guard
before insert on app.rng_encryption_key_versions
for each row execute function app_private.reject_cross_domain_encryption_key_reuse();

create trigger fulfillment_encryption_key_versions_domain_separation_guard
before insert on app.fulfillment_encryption_key_versions
for each row execute function app_private.reject_cross_domain_encryption_key_reuse();

create table app_private.fulfillment_actor_binding_keys (
  version text primary key,
  key_material bytea not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint fulfillment_actor_binding_key_version_format check (
    version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and lower(version) not in ('__proto__', 'constructor', 'prototype')
  ),
  constraint fulfillment_actor_binding_key_size check (octet_length(key_material) = 32)
);

insert into app_private.fulfillment_actor_binding_keys (version, key_material)
values ('local-fulfillment-actor-v1', decode(repeat('33', 32), 'hex'));

create function app_private.reject_fulfillment_actor_binding_key_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    constraint = 'fulfillment_actor_binding_key_immutable';
end
$function$;

create trigger fulfillment_actor_binding_keys_mutation_guard
before update or delete on app_private.fulfillment_actor_binding_keys
for each row execute function app_private.reject_fulfillment_actor_binding_key_mutation();

revoke all on table app_private.fulfillment_actor_binding_keys from public, creatordrop_app;

create function app_private.verify_fulfillment_actor_binding(
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
   where binding_key.version = binding_key_version;
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

revoke all on function app_private.verify_fulfillment_actor_binding(
  uuid, text, uuid, uuid, uuid, bigint, text, text, bytea, bigint, text, bigint, bytea
) from public, creatordrop_app;

create function app.restock_inventory_pool_bound(
  target_pool_id uuid,
  target_creator_id uuid,
  actor_id uuid,
  restock_event_id uuid,
  quantity_to_add bigint,
  action_key_value text,
  fingerprint bytea,
  binding_key_version text,
  binding_expires_at_ms bigint,
  binding_signature bytea
)
returns table (
  inventory_pool_id uuid,
  initial_quantity bigint,
  available_quantity bigint,
  event_id uuid,
  replayed boolean,
  event_created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform app_private.verify_fulfillment_actor_binding(
    actor_id, 'inventory.restock', target_creator_id, target_pool_id,
    restock_event_id, null, action_key_value, 'inventory_restock', fingerprint,
    quantity_to_add, binding_key_version, binding_expires_at_ms, binding_signature
  );
  return query select * from app.restock_inventory_pool(
    target_pool_id, target_creator_id, actor_id, restock_event_id,
    quantity_to_add, action_key_value, fingerprint
  );
end
$function$;

create function app.submit_fulfillment_address_bound(
  target_fulfillment_id uuid,
  actor_id uuid,
  expected_revision bigint,
  event_id uuid,
  action_key_value text,
  fingerprint bytea,
  fingerprint_key_version_value text,
  encrypted_value bytea,
  iv bytea,
  auth_tag bytea,
  key_version text,
  key_identity bytea,
  expiry timestamptz,
  binding_key_version text,
  binding_expires_at_ms bigint,
  binding_signature bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform app_private.verify_fulfillment_actor_binding(
    actor_id, 'fulfillment.submit_address', null, target_fulfillment_id,
    event_id, expected_revision, action_key_value, 'submit_address', fingerprint,
    null, binding_key_version, binding_expires_at_ms, binding_signature
  );
  return app.submit_fulfillment_address(
    target_fulfillment_id, actor_id, expected_revision, event_id, action_key_value,
    fingerprint, fingerprint_key_version_value, encrypted_value, iv, auth_tag,
    key_version, key_identity, expiry
  );
end
$function$;

create function app.apply_creator_fulfillment_action_bound(
  target_fulfillment_id uuid,
  target_creator_id uuid,
  actor_id uuid,
  expected_revision bigint,
  event_id uuid,
  action_name text,
  action_key_value text,
  fingerprint bytea,
  binding_key_version text,
  binding_expires_at_ms bigint,
  binding_signature bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform app_private.verify_fulfillment_actor_binding(
    actor_id, 'fulfillment.creator_action', target_creator_id, target_fulfillment_id,
    event_id, expected_revision, action_key_value, action_name, fingerprint,
    null, binding_key_version, binding_expires_at_ms, binding_signature
  );
  return app.apply_creator_fulfillment_action(
    target_fulfillment_id, target_creator_id, actor_id, expected_revision,
    event_id, action_name, action_key_value, fingerprint
  );
end
$function$;

create function app.deliver_digital_fulfillment_bound(
  target_fulfillment_id uuid,
  target_creator_id uuid,
  actor_id uuid,
  expected_revision bigint,
  event_id uuid,
  action_key_value text,
  fingerprint bytea,
  fingerprint_key_version_value text,
  encrypted_value bytea,
  iv bytea,
  auth_tag bytea,
  key_version text,
  key_identity bytea,
  expiry timestamptz,
  binding_key_version text,
  binding_expires_at_ms bigint,
  binding_signature bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform app_private.verify_fulfillment_actor_binding(
    actor_id, 'fulfillment.deliver_digital', target_creator_id, target_fulfillment_id,
    event_id, expected_revision, action_key_value, 'deliver_digital', fingerprint,
    null, binding_key_version, binding_expires_at_ms, binding_signature
  );
  return app.deliver_digital_fulfillment(
    target_fulfillment_id, target_creator_id, actor_id, expected_revision, event_id,
    action_key_value, fingerprint, fingerprint_key_version_value, encrypted_value,
    iv, auth_tag, key_version, key_identity, expiry
  );
end
$function$;

create function app.redact_fulfillment_delivery_data_bound(
  target_fulfillment_id uuid,
  actor_id uuid,
  creator_scope_id uuid,
  expected_revision bigint,
  event_id uuid,
  action_key_value text,
  fingerprint bytea,
  binding_key_version text,
  binding_expires_at_ms bigint,
  binding_signature bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform app_private.verify_fulfillment_actor_binding(
    actor_id,
    case when creator_scope_id is null
      then 'fulfillment.redact_user' else 'fulfillment.redact_creator' end,
    creator_scope_id, target_fulfillment_id, event_id, expected_revision,
    action_key_value, 'redact_delivery_data', fingerprint, null,
    binding_key_version, binding_expires_at_ms, binding_signature
  );
  return app.redact_fulfillment_delivery_data(
    target_fulfillment_id, actor_id, creator_scope_id, expected_revision,
    event_id, action_key_value, fingerprint
  );
end
$function$;

create function app.read_fulfillment_delivery_data_bound(
  target_fulfillment_id uuid,
  actor_id uuid,
  creator_scope_id uuid,
  access_event_id uuid,
  access_purpose text,
  binding_key_version text,
  binding_expires_at_ms bigint,
  binding_signature bytea
)
returns table (
  fulfillment_id uuid,
  encryption_domain text,
  ciphertext bytea,
  encryption_iv bytea,
  encryption_auth_tag bytea,
  encryption_key_version text,
  encryption_key_identity bytea,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  data app.fulfillment_delivery_data%rowtype;
  obligation app.fulfillment_obligations%rowtype;
begin
  perform app_private.verify_fulfillment_actor_binding(
    actor_id,
    case when creator_scope_id is null
      then 'fulfillment.read_user' else 'fulfillment.read_creator' end,
    creator_scope_id, target_fulfillment_id, access_event_id, null, null,
    access_purpose, null, null,
    binding_key_version, binding_expires_at_ms, binding_signature
  );
  select * into obligation from app.fulfillment_obligations
   where id = target_fulfillment_id;
  if not found then return; end if;
  if creator_scope_id is null then
    if obligation.user_id is distinct from actor_id
      or access_purpose is distinct from 'self_service' then return; end if;
  else
    if access_purpose is distinct from 'fulfillment_execution'
      or obligation.creator_id is distinct from creator_scope_id
      or not exists (
        select 1 from app.creator_memberships
         where creator_id = creator_scope_id and user_id = actor_id
           and role in ('owner', 'manager')
      ) then return; end if;
  end if;
  select stored.* into data from app.fulfillment_delivery_data as stored
   where stored.id = target_fulfillment_id and stored.redacted_at is null
     and (stored.expires_at is null or stored.expires_at > clock_timestamp());
  if not found then return; end if;
  return query select data.fulfillment_id, data.encryption_domain, data.ciphertext,
    data.encryption_iv, data.encryption_auth_tag, data.encryption_key_version,
    data.encryption_key_identity, data.expires_at;
end
$function$;

create function app.record_fulfillment_data_access_bound(
  target_fulfillment_id uuid,
  actor_id uuid,
  creator_scope_id uuid,
  access_event_id uuid,
  access_purpose text,
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
  data app.fulfillment_delivery_data%rowtype;
  obligation app.fulfillment_obligations%rowtype;
begin
  if creator_scope_id is null then return; end if;
  perform app_private.verify_fulfillment_actor_binding(
    actor_id, 'fulfillment.read_creator', creator_scope_id,
    target_fulfillment_id, access_event_id, null, null, access_purpose, null, null,
    binding_key_version, binding_expires_at_ms, binding_signature
  );
  select * into obligation from app.fulfillment_obligations
   where id = target_fulfillment_id and creator_id = creator_scope_id;
  if not found or access_purpose is distinct from 'fulfillment_execution'
    or not exists (
      select 1 from app.creator_memberships
       where creator_id = creator_scope_id and user_id = actor_id
         and role in ('owner', 'manager')
    ) then
    raise exception using errcode = '42501', constraint = 'fulfillment_creator_permission_denied';
  end if;
  select stored.* into data from app.fulfillment_delivery_data as stored
   where stored.id = target_fulfillment_id and stored.redacted_at is null
     and (stored.expires_at is null or stored.expires_at > clock_timestamp());
  if not found then
    raise exception using errcode = '23514', constraint = 'fulfillment_delivery_data_unavailable';
  end if;
  insert into app.fulfillment_data_access_events (
    id, fulfillment_id, delivery_data_id, creator_id,
    actor_user_id, access_type, purpose
  ) values (
    access_event_id, obligation.id, data.id, obligation.creator_id, actor_id,
    case data.encryption_domain when 'address' then 'address_read' else 'digital_secret_read' end,
    access_purpose
  );
end
$function$;

revoke execute on function app.restock_inventory_pool(uuid, uuid, uuid, uuid, bigint, text, bytea)
  from creatordrop_app;
revoke execute on function app.submit_fulfillment_address(
  uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea, text, bytea, timestamptz
) from creatordrop_app;
revoke execute on function app.apply_creator_fulfillment_action(
  uuid, uuid, uuid, bigint, uuid, text, text, bytea
) from creatordrop_app;
revoke execute on function app.deliver_digital_fulfillment(
  uuid, uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea, text, bytea, timestamptz
) from creatordrop_app;
revoke execute on function app.redact_fulfillment_delivery_data(
  uuid, uuid, uuid, bigint, uuid, text, bytea
) from creatordrop_app;
revoke execute on function app.read_fulfillment_delivery_data(uuid, uuid, uuid, uuid, text)
  from creatordrop_app;

revoke all on function app.restock_inventory_pool_bound(
  uuid, uuid, uuid, uuid, bigint, text, bytea, text, bigint, bytea
) from public;
grant execute on function app.restock_inventory_pool_bound(
  uuid, uuid, uuid, uuid, bigint, text, bytea, text, bigint, bytea
) to creatordrop_app;
revoke all on function app.submit_fulfillment_address_bound(
  uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea,
  text, bytea, timestamptz, text, bigint, bytea
) from public;
grant execute on function app.submit_fulfillment_address_bound(
  uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea,
  text, bytea, timestamptz, text, bigint, bytea
) to creatordrop_app;
revoke all on function app.apply_creator_fulfillment_action_bound(
  uuid, uuid, uuid, bigint, uuid, text, text, bytea, text, bigint, bytea
) from public;
grant execute on function app.apply_creator_fulfillment_action_bound(
  uuid, uuid, uuid, bigint, uuid, text, text, bytea, text, bigint, bytea
) to creatordrop_app;
revoke all on function app.deliver_digital_fulfillment_bound(
  uuid, uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea,
  text, bytea, timestamptz, text, bigint, bytea
) from public;
grant execute on function app.deliver_digital_fulfillment_bound(
  uuid, uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea,
  text, bytea, timestamptz, text, bigint, bytea
) to creatordrop_app;
revoke all on function app.redact_fulfillment_delivery_data_bound(
  uuid, uuid, uuid, bigint, uuid, text, bytea, text, bigint, bytea
) from public;
grant execute on function app.redact_fulfillment_delivery_data_bound(
  uuid, uuid, uuid, bigint, uuid, text, bytea, text, bigint, bytea
) to creatordrop_app;
revoke all on function app.read_fulfillment_delivery_data_bound(
  uuid, uuid, uuid, uuid, text, text, bigint, bytea
) from public;
grant execute on function app.read_fulfillment_delivery_data_bound(
  uuid, uuid, uuid, uuid, text, text, bigint, bytea
) to creatordrop_app;
revoke all on function app.record_fulfillment_data_access_bound(
  uuid, uuid, uuid, uuid, text, text, bigint, bytea
) from public;
grant execute on function app.record_fulfillment_data_access_bound(
  uuid, uuid, uuid, uuid, text, text, bigint, bytea
) to creatordrop_app;

comment on table app_private.fulfillment_actor_binding_keys is
  'Private HMAC verifier keys for short-lived API-authenticated Phase 12 actor capabilities.';
comment on function app_private.verify_fulfillment_actor_binding(
  uuid, text, uuid, uuid, uuid, bigint, text, text, bytea, bigint, text, bigint, bytea
) is 'Verifies that an immutable command scope was authorized for the authenticated API actor.';

reset role;
