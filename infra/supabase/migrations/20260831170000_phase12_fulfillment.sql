-- Phase 12: typed fulfillment state, protected delivery data, audited access,
-- and creator-scoped immutable inventory restocking.

set role creatordrop_migrator;

create table app.fulfillment_encryption_key_versions (
  encryption_domain text not null,
  version text not null,
  key_identity bytea not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (encryption_domain, version),
  constraint fulfillment_encryption_key_domain_check check (
    encryption_domain in ('address', 'digital_secret')
  ),
  constraint fulfillment_encryption_key_version_format check (
    version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and lower(version) not in ('__proto__', 'constructor', 'prototype')
  ),
  constraint fulfillment_encryption_key_identity_size check (octet_length(key_identity) = 32),
  constraint fulfillment_encryption_key_identity_unique unique (key_identity),
  constraint fulfillment_encryption_key_domain_version_identity_unique unique (
    encryption_domain, version, key_identity
  )
);

insert into app.fulfillment_encryption_key_versions (
  encryption_domain, version, key_identity
) values
  (
    'address',
    'local-fulfillment-address-v1',
    extensions.digest(decode(repeat('11', 32), 'hex'), 'sha256')
  ),
  (
    'digital_secret',
    'local-digital-delivery-v1',
    extensions.digest(decode(repeat('22', 32), 'hex'), 'sha256')
  );

create function app_private.reject_fulfillment_key_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    constraint = 'fulfillment_encryption_key_version_immutable';
end
$function$;

create trigger fulfillment_encryption_key_versions_mutation_guard
before update or delete on app.fulfillment_encryption_key_versions
for each row execute function app_private.reject_fulfillment_key_version_mutation();

drop trigger fulfillment_obligations_update_guard on app.fulfillment_obligations;

alter table app.reward_wins
  add constraint reward_wins_fulfillment_scope_unique unique (
    id, opening_id, user_id, creator_id, reward_version_id
  );

alter table app.fulfillment_obligations
  add column user_id uuid,
  add column creator_id uuid,
  add column reward_version_id uuid,
  add column fulfillment_type text,
  add column current_state text,
  add column revision bigint not null default 1,
  add column updated_at timestamptz,
  add column shipped_at timestamptz,
  add column delivered_at timestamptz,
  add column fulfilled_at timestamptz;

update app.fulfillment_obligations as obligation
set user_id = win.user_id,
    creator_id = win.creator_id,
    reward_version_id = win.reward_version_id,
    fulfillment_type = reward_version.reward_type,
    current_state = case
      when obligation.status = 'awaiting_restock' then 'awaiting_restock'
      when reward_version.reward_type = 'physical' then 'awaiting_address'
      when reward_version.reward_type = 'digital' then 'ready_for_delivery'
      else 'coordination_required'
    end,
    updated_at = obligation.created_at
from app.reward_wins as win
join app.reward_versions as reward_version on reward_version.id = win.reward_version_id
where win.id = obligation.reward_win_id;

alter table app.fulfillment_obligations
  alter column user_id set not null,
  alter column creator_id set not null,
  alter column reward_version_id set not null,
  alter column fulfillment_type set not null,
  alter column current_state set not null,
  alter column updated_at set not null,
  add constraint fulfillment_obligations_user_fk
    foreign key (user_id) references app.users (id) on delete restrict,
  add constraint fulfillment_obligations_creator_fk
    foreign key (creator_id) references app.creators (id) on delete restrict,
  add constraint fulfillment_obligations_reward_version_fk
    foreign key (reward_version_id) references app.reward_versions (id) on delete restrict,
  add constraint fulfillment_obligations_win_scope_fk foreign key (
    reward_win_id, opening_id, user_id, creator_id, reward_version_id
  ) references app.reward_wins (
    id, opening_id, user_id, creator_id, reward_version_id
  ) on delete restrict,
  add constraint fulfillment_obligations_scope_unique unique (
    id, user_id, creator_id, fulfillment_type
  ),
  add constraint fulfillment_obligations_actor_scope_unique unique (
    id, user_id, creator_id
  ),
  add constraint fulfillment_obligations_type_check check (
    fulfillment_type in ('physical', 'digital', 'experience')
  ),
  add constraint fulfillment_obligations_revision_positive check (revision > 0),
  add constraint fulfillment_obligations_timestamp_order check (
    updated_at >= created_at
    and (shipped_at is null or shipped_at >= created_at)
    and (delivered_at is null or delivered_at >= created_at)
    and (fulfilled_at is null or fulfilled_at >= created_at)
  ),
  add constraint fulfillment_obligations_type_state_shape check (
    (
      fulfillment_type = 'physical'
      and current_state in (
        'awaiting_restock', 'awaiting_address', 'ready_to_ship', 'shipped', 'delivered'
      )
    )
    or (
      fulfillment_type = 'digital'
      and current_state in ('awaiting_restock', 'ready_for_delivery', 'delivered')
    )
    or (
      fulfillment_type = 'experience'
      and current_state in ('awaiting_restock', 'coordination_required', 'fulfilled')
    )
  ),
  add constraint fulfillment_obligations_lifecycle_timestamp_shape check (
    (
      fulfillment_type = 'physical'
      and (
        (
          current_state in ('awaiting_restock', 'awaiting_address', 'ready_to_ship')
          and shipped_at is null and delivered_at is null and fulfilled_at is null
        )
        or (
          current_state = 'shipped'
          and shipped_at is not null and delivered_at is null and fulfilled_at is null
        )
        or (
          current_state = 'delivered'
          and shipped_at is not null and delivered_at is not null and fulfilled_at is null
        )
      )
    )
    or (
      fulfillment_type = 'digital'
      and shipped_at is null and fulfilled_at is null
      and (
        (current_state in ('awaiting_restock', 'ready_for_delivery') and delivered_at is null)
        or (current_state = 'delivered' and delivered_at is not null)
      )
    )
    or (
      fulfillment_type = 'experience'
      and shipped_at is null and delivered_at is null
      and (
        (current_state in ('awaiting_restock', 'coordination_required') and fulfilled_at is null)
        or (current_state = 'fulfilled' and fulfilled_at is not null)
      )
    )
  );

create index fulfillment_obligations_user_created_idx
  on app.fulfillment_obligations (user_id, created_at desc, id);
create index fulfillment_obligations_creator_state_created_idx
  on app.fulfillment_obligations (creator_id, current_state, created_at, id);

create table app.fulfillment_events (
  id uuid primary key,
  fulfillment_id uuid not null references app.fulfillment_obligations (id) on delete restrict,
  from_state text,
  to_state text not null,
  actor_type text not null,
  actor_user_id uuid references app.users (id) on delete restrict,
  action text not null,
  action_key text not null,
  command_fingerprint bytea not null,
  fingerprint_key_domain text,
  fingerprint_key_version text,
  result_revision bigint not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint fulfillment_events_actor_type_check check (
    actor_type in ('system', 'user', 'creator')
  ),
  constraint fulfillment_events_actor_shape check (
    (actor_type = 'system' and actor_user_id is null)
    or (actor_type in ('user', 'creator') and actor_user_id is not null)
  ),
  constraint fulfillment_events_action_check check (
    action in (
      'created', 'phase12_migrated', 'submit_address', 'resolve_backorder',
      'mark_shipped', 'mark_delivered', 'deliver_digital',
      'fulfill_experience', 'redact_delivery_data'
    )
  ),
  constraint fulfillment_events_action_key_format check (
    char_length(action_key) between 8 and 128
    and action_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint fulfillment_events_fingerprint_size check (
    octet_length(command_fingerprint) = 32
  ),
  constraint fulfillment_events_fingerprint_key_shape check (
    (fingerprint_key_domain is null and fingerprint_key_version is null)
    or (
      fingerprint_key_domain in ('address', 'digital_secret')
      and fingerprint_key_version is not null
    )
  ),
  constraint fulfillment_events_fingerprint_key_fk foreign key (
    fingerprint_key_domain, fingerprint_key_version
  ) references app.fulfillment_encryption_key_versions (
    encryption_domain, version
  ) on delete restrict,
  constraint fulfillment_events_revision_positive check (result_revision > 0),
  constraint fulfillment_events_metadata_shape check (
    jsonb_typeof(safe_metadata) = 'object'
    and not (safe_metadata ?| array[
      'address', 'addressLine1', 'addressLine2', 'postalCode', 'recipientName',
      'secret', 'token', 'code', 'ciphertext', 'serverSeed'
    ])
  ),
  constraint fulfillment_events_action_key_unique unique (fulfillment_id, action_key),
  constraint fulfillment_events_revision_unique unique (fulfillment_id, result_revision)
);

create index fulfillment_events_fulfillment_created_idx
  on app.fulfillment_events (fulfillment_id, created_at, id);

insert into app.fulfillment_events (
  id, fulfillment_id, from_state, to_state, actor_type, actor_user_id,
  action, action_key, command_fingerprint, result_revision, created_at
)
select
  gen_random_uuid(),
  obligation.id,
  null,
  obligation.current_state,
  'system',
  null,
  'phase12_migrated',
  'system.phase12-migration',
  extensions.digest(
    convert_to('creatordrop:fulfillment-migration:v1|' || obligation.id::text, 'utf8'),
    'sha256'
  ),
  obligation.revision,
  obligation.created_at
from app.fulfillment_obligations as obligation;

create table app.fulfillment_delivery_data (
  id uuid primary key,
  fulfillment_id uuid not null unique,
  user_id uuid not null,
  creator_id uuid not null,
  encryption_domain text not null,
  ciphertext bytea,
  encryption_iv bytea,
  encryption_auth_tag bytea,
  encryption_key_version text not null,
  encryption_key_identity bytea not null,
  expires_at timestamptz,
  redacted_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint fulfillment_delivery_data_id_matches_fulfillment check (id = fulfillment_id),
  constraint fulfillment_delivery_data_domain_check check (
    encryption_domain in ('address', 'digital_secret')
  ),
  constraint fulfillment_delivery_data_key_identity_size check (
    octet_length(encryption_key_identity) = 32
  ),
  constraint fulfillment_delivery_data_scope_fk foreign key (
    fulfillment_id, user_id, creator_id
  ) references app.fulfillment_obligations (
    id, user_id, creator_id
  ) on delete restrict,
  constraint fulfillment_delivery_data_registered_key_fk foreign key (
    encryption_domain, encryption_key_version, encryption_key_identity
  ) references app.fulfillment_encryption_key_versions (
    encryption_domain, version, key_identity
  ) on delete restrict,
  constraint fulfillment_delivery_data_timestamp_order check (
    updated_at >= created_at
    and (expires_at is null or expires_at >= created_at)
    and (redacted_at is null or redacted_at >= created_at)
  ),
  constraint fulfillment_delivery_data_ciphertext_shape check (
    (
      redacted_at is null
      and ciphertext is not null and octet_length(ciphertext) between 1 and 8192
      and encryption_iv is not null and octet_length(encryption_iv) = 12
      and encryption_auth_tag is not null and octet_length(encryption_auth_tag) = 16
    )
    or (
      redacted_at is not null
      and ciphertext is null and encryption_iv is null and encryption_auth_tag is null
    )
  )
);

create index fulfillment_delivery_data_expiry_idx
  on app.fulfillment_delivery_data (expires_at, fulfillment_id)
  where redacted_at is null and expires_at is not null;

create function app_private.validate_fulfillment_delivery_data_scope()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from app.fulfillment_obligations as obligation
    where obligation.id = new.fulfillment_id
      and obligation.user_id = new.user_id
      and obligation.creator_id = new.creator_id
      and (
        (obligation.fulfillment_type = 'physical' and new.encryption_domain = 'address')
        or (
          obligation.fulfillment_type = 'digital'
          and new.encryption_domain = 'digital_secret'
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'fulfillment_delivery_data_scope_invalid';
  end if;
  return new;
end
$function$;

create constraint trigger fulfillment_delivery_data_scope_guard
after insert or update on app.fulfillment_delivery_data
deferrable initially deferred
for each row execute function app_private.validate_fulfillment_delivery_data_scope();

create table app.fulfillment_data_access_events (
  id uuid primary key,
  fulfillment_id uuid not null references app.fulfillment_obligations (id) on delete restrict,
  delivery_data_id uuid not null references app.fulfillment_delivery_data (id) on delete restrict,
  creator_id uuid not null references app.creators (id) on delete restrict,
  actor_user_id uuid not null references app.users (id) on delete restrict,
  access_type text not null,
  purpose text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint fulfillment_data_access_type_check check (
    access_type in ('address_read', 'digital_secret_read')
  ),
  constraint fulfillment_data_access_purpose_check check (purpose = 'fulfillment_execution'),
  constraint fulfillment_data_access_delivery_match check (fulfillment_id = delivery_data_id)
);

create index fulfillment_data_access_events_fulfillment_created_idx
  on app.fulfillment_data_access_events (fulfillment_id, created_at, id);

create table app.inventory_restock_events (
  id uuid primary key,
  inventory_pool_id uuid not null references app.inventory_pools (id) on delete restrict,
  creator_id uuid not null references app.creators (id) on delete restrict,
  actor_user_id uuid not null references app.users (id) on delete restrict,
  quantity_added bigint not null,
  action_key text not null,
  command_fingerprint bytea not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint inventory_restock_events_quantity_positive check (quantity_added > 0),
  constraint inventory_restock_events_action_key_format check (
    char_length(action_key) between 8 and 128
    and action_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint inventory_restock_events_fingerprint_size check (
    octet_length(command_fingerprint) = 32
  ),
  constraint inventory_restock_events_action_unique unique (inventory_pool_id, action_key)
);

create index inventory_restock_events_pool_created_idx
  on app.inventory_restock_events (inventory_pool_id, created_at, id);

create function app_private.reject_fulfillment_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514', constraint = 'fulfillment_history_immutable';
end
$function$;

create trigger fulfillment_events_history_guard
before update or delete on app.fulfillment_events
for each row execute function app_private.reject_fulfillment_history_mutation();
create trigger fulfillment_data_access_events_history_guard
before update or delete on app.fulfillment_data_access_events
for each row execute function app_private.reject_fulfillment_history_mutation();
create trigger inventory_restock_events_history_guard
before update or delete on app.inventory_restock_events
for each row execute function app_private.reject_fulfillment_history_mutation();

create function app_private.guard_fulfillment_delivery_data_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
    or new.fulfillment_id is distinct from old.fulfillment_id
    or new.user_id is distinct from old.user_id
    or new.creator_id is distinct from old.creator_id
    or new.encryption_domain is distinct from old.encryption_domain
    or new.created_at is distinct from old.created_at
    or old.redacted_at is not null
    or new.updated_at <= old.updated_at then
    raise exception using errcode = '23514', constraint = 'fulfillment_delivery_data_update_invalid';
  end if;
  return new;
end
$function$;

create trigger fulfillment_delivery_data_update_guard
before update on app.fulfillment_delivery_data
for each row execute function app_private.guard_fulfillment_delivery_data_update();
create trigger fulfillment_delivery_data_delete_guard
before delete on app.fulfillment_delivery_data
for each row execute function app_private.reject_fulfillment_history_mutation();

create function app_private.guard_fulfillment_obligation_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  reward_type text;
  win app.reward_wins%rowtype;
begin
  select * into win from app.reward_wins where id = new.reward_win_id;
  if not found
    or win.opening_id is distinct from new.opening_id then
    raise exception using errcode = '23514', constraint = 'fulfillment_opening_scope_invalid';
  end if;
  select reward_version.reward_type into reward_type
    from app.reward_versions as reward_version
    where reward_version.id = win.reward_version_id;
  if not found then
    raise exception using errcode = '23514', constraint = 'fulfillment_reward_type_invalid';
  end if;
  new.user_id := win.user_id;
  new.creator_id := win.creator_id;
  new.reward_version_id := win.reward_version_id;
  new.fulfillment_type := reward_type;
  new.current_state := case
    when new.status = 'awaiting_restock' then 'awaiting_restock'
    when reward_type = 'physical' then 'awaiting_address'
    when reward_type = 'digital' then 'ready_for_delivery'
    else 'coordination_required'
  end;
  new.revision := 1;
  new.updated_at := new.created_at;
  new.shipped_at := null;
  new.delivered_at := null;
  new.fulfilled_at := null;
  return new;
end
$function$;

create trigger fulfillment_obligations_00_insert_guard
before insert on app.fulfillment_obligations
for each row execute function app_private.guard_fulfillment_obligation_insert();

create function app_private.insert_initial_fulfillment_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into app.fulfillment_events (
    id, fulfillment_id, from_state, to_state, actor_type, actor_user_id,
    action, action_key, command_fingerprint, result_revision, created_at
  ) values (
    gen_random_uuid(), new.id, null, new.current_state, 'system', null,
    'created', 'system.fulfillment-created',
    extensions.digest(
      convert_to('creatordrop:fulfillment-created:v1|' || new.id::text, 'utf8'),
      'sha256'
    ),
    new.revision, new.created_at
  );
  return new;
end
$function$;

create trigger fulfillment_obligations_initial_event
after insert on app.fulfillment_obligations
for each row execute function app_private.insert_initial_fulfillment_event();

create function app_private.guard_fulfillment_obligation_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
    or new.opening_id is distinct from old.opening_id
    or new.reward_win_id is distinct from old.reward_win_id
    or new.user_id is distinct from old.user_id
    or new.creator_id is distinct from old.creator_id
    or new.reward_version_id is distinct from old.reward_version_id
    or new.fulfillment_type is distinct from old.fulfillment_type
    or new.status is distinct from old.status
    or new.created_at is distinct from old.created_at
    or new.revision is distinct from old.revision + 1
    or new.updated_at <= old.updated_at then
    raise exception using errcode = '23514', constraint = 'fulfillment_obligation_history_invalid';
  end if;
  if not (
    (old.current_state = 'awaiting_restock' and new.current_state in (
      'awaiting_restock', 'awaiting_address', 'ready_to_ship',
      'ready_for_delivery', 'coordination_required'
    ))
    or (old.current_state = 'awaiting_address' and new.current_state = 'ready_to_ship')
    or (old.current_state = 'ready_to_ship' and new.current_state = 'shipped')
    or (old.current_state = 'shipped' and new.current_state = 'delivered')
    or (old.current_state = 'ready_for_delivery' and new.current_state = 'delivered')
    or (old.current_state = 'coordination_required' and new.current_state = 'fulfilled')
    or (old.current_state = new.current_state and old.current_state in ('delivered', 'fulfilled'))
  ) then
    raise exception using errcode = '23514', constraint = 'fulfillment_transition_invalid';
  end if;
  return new;
end
$function$;

create trigger fulfillment_obligations_update_guard
before update on app.fulfillment_obligations
for each row execute function app_private.guard_fulfillment_obligation_update();
create trigger fulfillment_obligations_delete_guard
before delete on app.fulfillment_obligations
for each row execute function app_private.reject_fulfillment_history_mutation();

create function app_private.validate_fulfillment_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  obligation app.fulfillment_obligations%rowtype;
  actor_role text;
begin
  select * into obligation from app.fulfillment_obligations where id = new.fulfillment_id;
  if not found
    or new.to_state is distinct from obligation.current_state
    or new.result_revision is distinct from obligation.revision then
    raise exception using errcode = '23514', constraint = 'fulfillment_event_scope_invalid';
  end if;
  if new.actor_type = 'creator' then
    select membership.role into actor_role
      from app.creator_memberships as membership
      where membership.creator_id = obligation.creator_id
        and membership.user_id = new.actor_user_id;
    if actor_role not in ('owner', 'manager') then
      raise exception using errcode = '42501', constraint = 'fulfillment_creator_permission_denied';
    end if;
  end if;
  if not (
    (
      new.action in ('created', 'phase12_migrated')
      and new.actor_type = 'system' and new.from_state is null
    )
    or (
      new.action = 'submit_address' and new.actor_type = 'user'
      and new.actor_user_id = obligation.user_id
      and obligation.fulfillment_type = 'physical'
      and (
        (new.from_state = 'awaiting_address' and new.to_state = 'ready_to_ship')
        or (new.from_state = 'awaiting_restock' and new.to_state = 'awaiting_restock')
      )
      and exists (
        select 1 from app.fulfillment_delivery_data as data
        where data.fulfillment_id = obligation.id
          and data.encryption_domain = 'address' and data.redacted_at is null
      )
    )
    or (
      new.action = 'resolve_backorder' and new.actor_type = 'creator'
      and new.from_state = 'awaiting_restock'
      and new.to_state <> 'awaiting_restock'
      and exists (
        select 1 from app.inventory_consumptions as consumption
        where consumption.opening_id = obligation.opening_id
      )
    )
    or (
      new.action = 'mark_shipped' and new.actor_type = 'creator'
      and new.from_state = 'ready_to_ship' and new.to_state = 'shipped'
    )
    or (
      new.action = 'mark_delivered' and new.actor_type = 'creator'
      and new.from_state = 'shipped' and new.to_state = 'delivered'
    )
    or (
      new.action = 'deliver_digital' and new.actor_type = 'creator'
      and obligation.fulfillment_type = 'digital'
      and new.from_state = 'ready_for_delivery' and new.to_state = 'delivered'
      and exists (
        select 1 from app.fulfillment_delivery_data as data
        where data.fulfillment_id = obligation.id
          and data.encryption_domain = 'digital_secret' and data.redacted_at is null
      )
    )
    or (
      new.action = 'fulfill_experience' and new.actor_type = 'creator'
      and obligation.fulfillment_type = 'experience'
      and new.from_state = 'coordination_required' and new.to_state = 'fulfilled'
    )
    or (
      new.action = 'redact_delivery_data'
      and new.from_state = new.to_state
      and new.to_state in ('delivered', 'fulfilled')
      and (
        (new.actor_type = 'user' and new.actor_user_id = obligation.user_id)
        or new.actor_type = 'creator'
      )
      and exists (
        select 1 from app.fulfillment_delivery_data as data
        where data.fulfillment_id = obligation.id and data.redacted_at is not null
      )
    )
  ) then
    raise exception using errcode = '23514', constraint = 'fulfillment_event_transition_invalid';
  end if;
  if (
    new.action = 'submit_address'
    and (
      new.fingerprint_key_domain is distinct from 'address'
      or new.fingerprint_key_version is distinct from (
        select data.encryption_key_version
        from app.fulfillment_delivery_data as data
        where data.fulfillment_id = obligation.id
      )
    )
  ) or (
    new.action = 'deliver_digital'
    and (
      new.fingerprint_key_domain is distinct from 'digital_secret'
      or new.fingerprint_key_version is distinct from (
        select data.encryption_key_version
        from app.fulfillment_delivery_data as data
        where data.fulfillment_id = obligation.id
      )
    )
  ) or (
    new.action not in ('submit_address', 'deliver_digital')
    and (
      new.fingerprint_key_domain is not null
      or new.fingerprint_key_version is not null
    )
  ) then
    raise exception using errcode = '23514', constraint = 'fulfillment_event_fingerprint_key_invalid';
  end if;
  return new;
end
$function$;

create constraint trigger fulfillment_events_semantic_guard
after insert on app.fulfillment_events
deferrable initially deferred
for each row execute function app_private.validate_fulfillment_event();

create function app_private.validate_fulfillment_obligation_event()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from app.fulfillment_events as event
    where event.fulfillment_id = new.id
      and event.from_state is not distinct from old.current_state
      and event.to_state = new.current_state
      and event.result_revision = new.revision
  ) then
    raise exception using errcode = '23514', constraint = 'fulfillment_transition_event_required';
  end if;
  return new;
end
$function$;

create constraint trigger fulfillment_obligations_event_guard
after update on app.fulfillment_obligations
deferrable initially deferred
for each row execute function app_private.validate_fulfillment_obligation_event();

create function app_private.validate_inventory_restock_event()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from app.inventory_pools as pool
    join app.creator_memberships as membership
      on membership.creator_id = pool.creator_id
     and membership.user_id = new.actor_user_id
     and membership.role in ('owner', 'manager')
    where pool.id = new.inventory_pool_id
      and pool.creator_id = new.creator_id
  ) then
    raise exception using errcode = '23514', constraint = 'inventory_restock_scope_invalid';
  end if;
  return new;
end
$function$;

create constraint trigger inventory_restock_events_scope_guard
after insert on app.inventory_restock_events
deferrable initially deferred
for each row execute function app_private.validate_inventory_restock_event();

create or replace function app_private.guard_inventory_pool_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  pool_is_protected boolean;
begin
  select
    exists (
      select 1 from app.reward_versions
      where inventory_pool_id = old.id and state <> 'draft'
    ) or exists (
      select 1 from app.inventory_consumptions where inventory_pool_id = old.id
    ) or exists (
      select 1 from app.inventory_restock_events where inventory_pool_id = old.id
    )
  into pool_is_protected;
  if new.id is distinct from old.id
    or new.creator_id is distinct from old.creator_id
    or new.created_at is distinct from old.created_at
    or new.updated_at < old.updated_at then
    raise exception using errcode = '23514', constraint = 'inventory_pool_identity_immutable';
  end if;
  if pool_is_protected then
    if new.stockout_policy is distinct from old.stockout_policy
      or new.initial_quantity is distinct from old.initial_quantity
      or new.available_quantity < old.available_quantity - 1 then
      raise exception using errcode = '23514', constraint = 'inventory_pool_update_invalid';
    end if;
  elsif new.available_quantity <> new.initial_quantity then
    raise exception using errcode = '23514', constraint = 'inventory_pool_draft_update_invalid';
  end if;
  return new;
end
$function$;

create or replace function app_private.validate_inventory_pool_reconciliation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  consumed_quantity numeric;
  restocked_quantity numeric;
  pool app.inventory_pools%rowtype;
begin
  if tg_table_name = 'inventory_restock_events' then
    select stored.* into strict pool
      from app.inventory_pools as stored
      where stored.id = new.inventory_pool_id;
  else
    pool := new;
  end if;
  select coalesce(sum(quantity_consumed::numeric), 0)
    into consumed_quantity
    from app.inventory_consumptions
    where inventory_pool_id = pool.id;
  select coalesce(sum(quantity_added::numeric), 0)
    into restocked_quantity
    from app.inventory_restock_events
    where inventory_pool_id = pool.id;
  if pool.initial_quantity::numeric + restocked_quantity
       - pool.available_quantity::numeric <> consumed_quantity then
    raise exception using errcode = '23514', constraint = 'inventory_pool_reconciliation_invalid';
  end if;
  return new;
end
$function$;

create constraint trigger inventory_restock_events_reconciliation_guard
after insert on app.inventory_restock_events
deferrable initially deferred
for each row execute function app_private.validate_inventory_pool_reconciliation();

create or replace function app_private.validate_inventory_consumption()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from app.box_opens as opening
    join app.reward_versions as reward_version on reward_version.id = opening.reward_version_id
    join app.fulfillment_obligations as obligation on obligation.opening_id = opening.id
    where opening.id = new.opening_id
      and opening.inventory_pool_id = new.inventory_pool_id
      and reward_version.inventory_mode = 'finite'
      and reward_version.inventory_pool_id = new.inventory_pool_id
      and obligation.current_state <> 'awaiting_restock'
  ) then
    raise exception using errcode = '23514', constraint = 'inventory_consumption_opening_invalid';
  end if;
  return new;
end
$function$;

create function app.restock_inventory_pool(
  target_pool_id uuid,
  target_creator_id uuid,
  actor_id uuid,
  restock_event_id uuid,
  quantity_to_add bigint,
  action_key_value text,
  fingerprint bytea
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
declare
  existing app.inventory_restock_events%rowtype;
  pool app.inventory_pools%rowtype;
begin
  select * into pool from app.inventory_pools where id = target_pool_id for update;
  if not found or pool.creator_id is distinct from target_creator_id then
    raise exception using errcode = 'P0002', constraint = 'inventory_pool_not_found';
  end if;
  if not exists (
    select 1 from app.reward_versions as reward_version
    where reward_version.inventory_pool_id = target_pool_id
      and reward_version.state <> 'draft'
  ) then
    raise exception using errcode = '23514', constraint = 'inventory_restock_pool_unpublished';
  end if;
  if not exists (
    select 1 from app.creator_memberships
    where creator_id = target_creator_id and user_id = actor_id
      and role in ('owner', 'manager')
  ) then
    raise exception using errcode = '42501', constraint = 'inventory_restock_permission_denied';
  end if;
  select event.* into existing from app.inventory_restock_events as event
    where event.inventory_pool_id = target_pool_id and event.action_key = action_key_value;
  if found then
    if existing.command_fingerprint is distinct from fingerprint then
      raise exception using errcode = '23505', constraint = 'inventory_restock_action_key_reused';
    end if;
    return query select pool.id, pool.initial_quantity, pool.available_quantity,
      existing.id, true, existing.created_at;
    return;
  end if;
  if quantity_to_add <= 0 then
    raise exception using errcode = '22003', constraint = 'inventory_restock_quantity_invalid';
  end if;
  insert into app.inventory_restock_events (
    id, inventory_pool_id, creator_id, actor_user_id,
    quantity_added, action_key, command_fingerprint
  ) values (
    restock_event_id, target_pool_id, target_creator_id, actor_id,
    quantity_to_add, action_key_value, fingerprint
  ) returning * into existing;
  update app.inventory_pools as target
     set available_quantity = target.available_quantity + quantity_to_add,
         updated_at = clock_timestamp()
   where target.id = target_pool_id
     and target.available_quantity <= 9223372036854775807 - quantity_to_add
   returning target.* into pool;
  if not found then
    raise exception using errcode = '22003', constraint = 'inventory_restock_quantity_overflow';
  end if;
  return query select pool.id, pool.initial_quantity, pool.available_quantity,
    existing.id, false, existing.created_at;
end
$function$;

create function app.submit_fulfillment_address(
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
  expiry timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing app.fulfillment_events%rowtype;
  obligation app.fulfillment_obligations%rowtype;
  previous_state text;
  next_state text;
begin
  select * into obligation from app.fulfillment_obligations
    where id = target_fulfillment_id and user_id = actor_id for update;
  if not found then raise exception using errcode = 'P0002', constraint = 'fulfillment_not_found'; end if;
  select * into existing from app.fulfillment_events
    where fulfillment_id = target_fulfillment_id and action_key = action_key_value;
  if found then
    if existing.command_fingerprint is distinct from fingerprint
      or existing.fingerprint_key_domain is distinct from 'address'
      or existing.fingerprint_key_version is distinct from fingerprint_key_version_value then
      raise exception using errcode = '23505', constraint = 'fulfillment_action_key_reused';
    end if;
    return true;
  end if;
  if obligation.revision is distinct from expected_revision then
    raise exception using errcode = '40001', constraint = 'fulfillment_revision_conflict';
  end if;
  if obligation.fulfillment_type <> 'physical'
    or obligation.current_state not in ('awaiting_address', 'awaiting_restock') then
    raise exception using errcode = '23514', constraint = 'fulfillment_transition_invalid';
  end if;
  insert into app.fulfillment_delivery_data (
    id, fulfillment_id, user_id, creator_id, encryption_domain,
    ciphertext, encryption_iv, encryption_auth_tag,
    encryption_key_version, encryption_key_identity, expires_at
  ) values (
    obligation.id, obligation.id, obligation.user_id, obligation.creator_id, 'address',
    encrypted_value, iv, auth_tag, key_version, key_identity, expiry
  ) on conflict (id) do update
    set ciphertext = excluded.ciphertext,
        encryption_iv = excluded.encryption_iv,
        encryption_auth_tag = excluded.encryption_auth_tag,
        encryption_key_version = excluded.encryption_key_version,
        encryption_key_identity = excluded.encryption_key_identity,
        expires_at = excluded.expires_at,
        updated_at = clock_timestamp()
    where fulfillment_delivery_data.redacted_at is null
      and fulfillment_delivery_data.encryption_domain = 'address';
  if not found then
    raise exception using errcode = '23514', constraint = 'fulfillment_delivery_data_unavailable';
  end if;
  previous_state := obligation.current_state;
  next_state := case when previous_state = 'awaiting_address' then 'ready_to_ship' else previous_state end;
  update app.fulfillment_obligations
     set current_state = next_state, revision = revision + 1, updated_at = clock_timestamp()
   where id = obligation.id;
  insert into app.fulfillment_events (
    id, fulfillment_id, from_state, to_state, actor_type, actor_user_id,
    action, action_key, command_fingerprint,
    fingerprint_key_domain, fingerprint_key_version, result_revision
  ) values (
    event_id, obligation.id, previous_state, next_state, 'user', actor_id,
    'submit_address', action_key_value, fingerprint,
    'address', fingerprint_key_version_value, obligation.revision + 1
  );
  return false;
end
$function$;

create function app.apply_creator_fulfillment_action(
  target_fulfillment_id uuid,
  target_creator_id uuid,
  actor_id uuid,
  expected_revision bigint,
  event_id uuid,
  action_name text,
  action_key_value text,
  fingerprint bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing app.fulfillment_events%rowtype;
  obligation app.fulfillment_obligations%rowtype;
  pool app.inventory_pools%rowtype;
  pool_id uuid;
  previous_state text;
  next_state text;
begin
  if action_name = 'resolve_backorder' then
    select opening.inventory_pool_id into pool_id
      from app.fulfillment_obligations as candidate
      join app.box_opens as opening on opening.id = candidate.opening_id
      where candidate.id = target_fulfillment_id and candidate.creator_id = target_creator_id;
    if pool_id is null then raise exception using errcode = 'P0002', constraint = 'fulfillment_not_found'; end if;
    select * into pool from app.inventory_pools where id = pool_id for update;
  end if;
  select * into obligation from app.fulfillment_obligations
    where id = target_fulfillment_id and creator_id = target_creator_id for update;
  if not found then raise exception using errcode = 'P0002', constraint = 'fulfillment_not_found'; end if;
  if not exists (
    select 1 from app.creator_memberships
    where creator_id = target_creator_id and user_id = actor_id
      and role in ('owner', 'manager')
  ) then
    raise exception using errcode = '42501', constraint = 'fulfillment_creator_permission_denied';
  end if;
  select * into existing from app.fulfillment_events
    where fulfillment_id = target_fulfillment_id and action_key = action_key_value;
  if found then
    if existing.command_fingerprint is distinct from fingerprint then
      raise exception using errcode = '23505', constraint = 'fulfillment_action_key_reused';
    end if;
    return true;
  end if;
  if obligation.revision is distinct from expected_revision then
    raise exception using errcode = '40001', constraint = 'fulfillment_revision_conflict';
  end if;
  previous_state := obligation.current_state;
  if action_name = 'resolve_backorder' then
    if previous_state <> 'awaiting_restock' or pool.available_quantity <= 0 then
      raise exception using errcode = '23514', constraint = 'fulfillment_restock_unavailable';
    end if;
    perform app.consume_inventory_pool(pool.id, obligation.opening_id);
    if not found then
      raise exception using errcode = '23514', constraint = 'fulfillment_restock_unavailable';
    end if;
    next_state := case obligation.fulfillment_type
      when 'physical' then case
        when exists (
          select 1 from app.fulfillment_delivery_data as data
          where data.fulfillment_id = obligation.id
            and data.encryption_domain = 'address' and data.redacted_at is null
            and (data.expires_at is null or data.expires_at > clock_timestamp())
        ) then 'ready_to_ship' else 'awaiting_address' end
      when 'digital' then 'ready_for_delivery'
      else 'coordination_required'
    end;
  elsif action_name = 'mark_shipped' and previous_state = 'ready_to_ship' then
    if not exists (
      select 1 from app.fulfillment_delivery_data as data
      where data.fulfillment_id = obligation.id and data.encryption_domain = 'address'
        and data.redacted_at is null
        and (data.expires_at is null or data.expires_at > clock_timestamp())
    ) then
      raise exception using errcode = '23514', constraint = 'fulfillment_delivery_data_required';
    end if;
    next_state := 'shipped';
  elsif action_name = 'mark_delivered' and previous_state = 'shipped' then
    next_state := 'delivered';
  elsif action_name = 'fulfill_experience'
    and obligation.fulfillment_type = 'experience'
    and previous_state = 'coordination_required' then
    next_state := 'fulfilled';
  else
    raise exception using errcode = '23514', constraint = 'fulfillment_transition_invalid';
  end if;
  update app.fulfillment_obligations
     set current_state = next_state,
         revision = revision + 1,
         updated_at = clock_timestamp(),
         shipped_at = case when next_state = 'shipped' then clock_timestamp() else shipped_at end,
         delivered_at = case when next_state = 'delivered' then clock_timestamp() else delivered_at end,
         fulfilled_at = case when next_state = 'fulfilled' then clock_timestamp() else fulfilled_at end
   where id = obligation.id;
  insert into app.fulfillment_events (
    id, fulfillment_id, from_state, to_state, actor_type, actor_user_id,
    action, action_key, command_fingerprint, result_revision
  ) values (
    event_id, obligation.id, previous_state, next_state, 'creator', actor_id,
    action_name, action_key_value, fingerprint, obligation.revision + 1
  );
  return false;
end
$function$;

create function app.deliver_digital_fulfillment(
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
  expiry timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing app.fulfillment_events%rowtype;
  obligation app.fulfillment_obligations%rowtype;
begin
  select * into obligation from app.fulfillment_obligations
    where id = target_fulfillment_id and creator_id = target_creator_id for update;
  if not found then raise exception using errcode = 'P0002', constraint = 'fulfillment_not_found'; end if;
  if not exists (
    select 1 from app.creator_memberships
    where creator_id = target_creator_id and user_id = actor_id
      and role in ('owner', 'manager')
  ) then
    raise exception using errcode = '42501', constraint = 'fulfillment_creator_permission_denied';
  end if;
  select * into existing from app.fulfillment_events
    where fulfillment_id = target_fulfillment_id and action_key = action_key_value;
  if found then
    if existing.command_fingerprint is distinct from fingerprint
      or existing.fingerprint_key_domain is distinct from 'digital_secret'
      or existing.fingerprint_key_version is distinct from fingerprint_key_version_value then
      raise exception using errcode = '23505', constraint = 'fulfillment_action_key_reused';
    end if;
    return true;
  end if;
  if obligation.revision is distinct from expected_revision then
    raise exception using errcode = '40001', constraint = 'fulfillment_revision_conflict';
  end if;
  if obligation.fulfillment_type <> 'digital' or obligation.current_state <> 'ready_for_delivery' then
    raise exception using errcode = '23514', constraint = 'fulfillment_transition_invalid';
  end if;
  insert into app.fulfillment_delivery_data (
    id, fulfillment_id, user_id, creator_id, encryption_domain,
    ciphertext, encryption_iv, encryption_auth_tag,
    encryption_key_version, encryption_key_identity, expires_at
  ) values (
    obligation.id, obligation.id, obligation.user_id, obligation.creator_id, 'digital_secret',
    encrypted_value, iv, auth_tag, key_version, key_identity, expiry
  );
  update app.fulfillment_obligations
     set current_state = 'delivered', revision = revision + 1,
         updated_at = clock_timestamp(), delivered_at = clock_timestamp()
   where id = obligation.id;
  insert into app.fulfillment_events (
    id, fulfillment_id, from_state, to_state, actor_type, actor_user_id,
    action, action_key, command_fingerprint,
    fingerprint_key_domain, fingerprint_key_version, result_revision
  ) values (
    event_id, obligation.id, 'ready_for_delivery', 'delivered', 'creator', actor_id,
    'deliver_digital', action_key_value, fingerprint,
    'digital_secret', fingerprint_key_version_value, obligation.revision + 1
  );
  return false;
end
$function$;

create function app.redact_fulfillment_delivery_data(
  target_fulfillment_id uuid,
  actor_id uuid,
  creator_scope_id uuid,
  expected_revision bigint,
  event_id uuid,
  action_key_value text,
  fingerprint bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_kind text;
  existing app.fulfillment_events%rowtype;
  obligation app.fulfillment_obligations%rowtype;
begin
  select * into obligation from app.fulfillment_obligations where id = target_fulfillment_id for update;
  if not found then raise exception using errcode = 'P0002', constraint = 'fulfillment_not_found'; end if;
  if creator_scope_id is null then
    if obligation.user_id is distinct from actor_id then
      raise exception using errcode = 'P0002', constraint = 'fulfillment_not_found';
    end if;
    actor_kind := 'user';
  else
    if obligation.creator_id is distinct from creator_scope_id then
      raise exception using errcode = 'P0002', constraint = 'fulfillment_not_found';
    end if;
    if not exists (
      select 1 from app.creator_memberships
      where creator_id = creator_scope_id and user_id = actor_id
        and role in ('owner', 'manager')
    ) then
      raise exception using errcode = '42501', constraint = 'fulfillment_creator_permission_denied';
    end if;
    actor_kind := 'creator';
  end if;
  select * into existing from app.fulfillment_events
    where fulfillment_id = target_fulfillment_id and action_key = action_key_value;
  if found then
    if existing.command_fingerprint is distinct from fingerprint then
      raise exception using errcode = '23505', constraint = 'fulfillment_action_key_reused';
    end if;
    return true;
  end if;
  if obligation.revision is distinct from expected_revision then
    raise exception using errcode = '40001', constraint = 'fulfillment_revision_conflict';
  end if;
  if obligation.current_state not in ('delivered', 'fulfilled') then
    raise exception using errcode = '23514', constraint = 'fulfillment_redaction_not_allowed';
  end if;
  update app.fulfillment_delivery_data
     set ciphertext = null, encryption_iv = null, encryption_auth_tag = null,
         redacted_at = clock_timestamp(), updated_at = clock_timestamp()
   where fulfillment_id = obligation.id and redacted_at is null;
  if not found then
    raise exception using errcode = '23514', constraint = 'fulfillment_delivery_data_unavailable';
  end if;
  update app.fulfillment_obligations
     set revision = revision + 1, updated_at = clock_timestamp()
   where id = obligation.id;
  insert into app.fulfillment_events (
    id, fulfillment_id, from_state, to_state, actor_type, actor_user_id,
    action, action_key, command_fingerprint, result_revision
  ) values (
    event_id, obligation.id, obligation.current_state, obligation.current_state,
    actor_kind, actor_id, 'redact_delivery_data', action_key_value, fingerprint,
    obligation.revision + 1
  );
  return false;
end
$function$;

create function app.read_fulfillment_delivery_data(
  target_fulfillment_id uuid,
  actor_id uuid,
  creator_scope_id uuid,
  access_event_id uuid,
  access_purpose text
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
  select * into obligation from app.fulfillment_obligations where id = target_fulfillment_id;
  if not found then return; end if;
  if creator_scope_id is null then
    if obligation.user_id is distinct from actor_id then return; end if;
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
  if creator_scope_id is not null then
    insert into app.fulfillment_data_access_events (
      id, fulfillment_id, delivery_data_id, creator_id,
      actor_user_id, access_type, purpose
    ) values (
      access_event_id, obligation.id, data.id, obligation.creator_id, actor_id,
      case data.encryption_domain when 'address' then 'address_read' else 'digital_secret_read' end,
      access_purpose
    );
  end if;
  return query select data.fulfillment_id, data.encryption_domain, data.ciphertext,
    data.encryption_iv, data.encryption_auth_tag, data.encryption_key_version,
    data.encryption_key_identity, data.expires_at;
end
$function$;

revoke all on table app.fulfillment_encryption_key_versions from public, creatordrop_app;
grant select on table app.fulfillment_encryption_key_versions to creatordrop_app;

revoke all on table app.fulfillment_obligations from public, creatordrop_app;
grant select, insert on table app.fulfillment_obligations to creatordrop_app;
revoke all on table app.fulfillment_events from public, creatordrop_app;
grant select on table app.fulfillment_events to creatordrop_app;
revoke all on table app.fulfillment_delivery_data from public, creatordrop_app;
grant select (
  id, fulfillment_id, user_id, creator_id, encryption_domain,
  expires_at, redacted_at, created_at, updated_at
) on table app.fulfillment_delivery_data to creatordrop_app;
revoke all on table app.fulfillment_data_access_events from public, creatordrop_app;
revoke all on table app.inventory_restock_events from public, creatordrop_app;

revoke all on function app.restock_inventory_pool(uuid, uuid, uuid, uuid, bigint, text, bytea)
  from public;
grant execute on function app.restock_inventory_pool(uuid, uuid, uuid, uuid, bigint, text, bytea)
  to creatordrop_app;
revoke all on function app.submit_fulfillment_address(
  uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea, text, bytea, timestamptz
) from public;
grant execute on function app.submit_fulfillment_address(
  uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea, text, bytea, timestamptz
) to creatordrop_app;
revoke all on function app.apply_creator_fulfillment_action(
  uuid, uuid, uuid, bigint, uuid, text, text, bytea
) from public;
grant execute on function app.apply_creator_fulfillment_action(
  uuid, uuid, uuid, bigint, uuid, text, text, bytea
) to creatordrop_app;
revoke all on function app.deliver_digital_fulfillment(
  uuid, uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea, text, bytea, timestamptz
) from public;
grant execute on function app.deliver_digital_fulfillment(
  uuid, uuid, uuid, bigint, uuid, text, bytea, text, bytea, bytea, bytea, text, bytea, timestamptz
) to creatordrop_app;
revoke all on function app.redact_fulfillment_delivery_data(
  uuid, uuid, uuid, bigint, uuid, text, bytea
) from public;
grant execute on function app.redact_fulfillment_delivery_data(
  uuid, uuid, uuid, bigint, uuid, text, bytea
) to creatordrop_app;
revoke all on function app.read_fulfillment_delivery_data(uuid, uuid, uuid, uuid, text)
  from public;
grant execute on function app.read_fulfillment_delivery_data(uuid, uuid, uuid, uuid, text)
  to creatordrop_app;

comment on column app.fulfillment_obligations.status is
  'Immutable Phase 9 origin result: pending_fulfillment or awaiting_restock.';
comment on column app.fulfillment_obligations.current_state is
  'Mutable typed Phase 12 state protected by transition history and optimistic revision.';
comment on table app.fulfillment_delivery_data is
  'One purpose-bound encrypted or explicitly redacted address/digital-secret record per fulfillment.';
comment on table app.inventory_restock_events is
  'Immutable creator-authorized supply additions; initial inventory remains immutable.';

reset role;
