-- Phase 5 catalog only: mutable identities, draft versions, and immutable publication snapshots.

set role creatordrop_migrator;

create table app.boxes (
  id uuid primary key,
  creator_id uuid not null,
  current_published_version_id uuid,
  status text not null default 'draft',
  revision integer not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint boxes_creator_foreign_key foreign key (creator_id)
    references app.creators (id) on delete restrict,
  constraint boxes_status_check check (status in ('draft', 'active', 'paused', 'archived')),
  constraint boxes_revision_positive check (revision >= 1)
);

create table app.rewards (
  id uuid primary key,
  creator_id uuid not null,
  status text not null default 'active',
  revision integer not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint rewards_creator_foreign_key foreign key (creator_id)
    references app.creators (id) on delete restrict,
  constraint rewards_status_check check (status in ('active', 'archived')),
  constraint rewards_revision_positive check (revision >= 1)
);

create table app.box_versions (
  id uuid primary key,
  box_id uuid not null,
  version_number integer not null,
  state text not null default 'draft',
  name text not null,
  description text not null,
  image_url text,
  price_minor bigint not null,
  currency character(3) not null,
  total_weight bigint,
  configuration_hash bytea,
  rng_algorithm_version text,
  published_at timestamptz,
  created_by_user_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint box_versions_box_foreign_key foreign key (box_id)
    references app.boxes (id) on delete restrict,
  constraint box_versions_created_by_user_foreign_key foreign key (created_by_user_id)
    references app.users (id) on delete restrict,
  constraint box_versions_box_version_unique unique (box_id, version_number),
  constraint box_versions_version_number_positive check (version_number >= 1),
  constraint box_versions_state_check check (state in ('draft', 'published', 'retired')),
  constraint box_versions_name_length check (char_length(name) between 1 and 120),
  constraint box_versions_description_length check (char_length(description) <= 5000),
  constraint box_versions_image_url_length check (
    image_url is null or char_length(image_url) between 1 and 2048
  ),
  constraint box_versions_price_positive check (price_minor > 0),
  constraint box_versions_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint box_versions_publication_shape check (
    (
      state = 'draft'
      and total_weight is null
      and configuration_hash is null
      and rng_algorithm_version is null
      and published_at is null
    ) or (
      state in ('published', 'retired')
      and total_weight > 0
      and octet_length(configuration_hash) = 32
      and char_length(rng_algorithm_version) between 1 and 64
      and published_at is not null
    )
  )
);

create table app.reward_versions (
  id uuid primary key,
  reward_id uuid not null,
  version_number integer not null,
  state text not null default 'draft',
  name text not null,
  description text not null,
  image_url text,
  reward_type text not null,
  inventory_mode text not null,
  inventory_quantity bigint,
  declared_value_minor bigint,
  declared_value_currency character(3),
  fulfillment_definition jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_by_user_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint reward_versions_reward_foreign_key foreign key (reward_id)
    references app.rewards (id) on delete restrict,
  constraint reward_versions_created_by_user_foreign_key foreign key (created_by_user_id)
    references app.users (id) on delete restrict,
  constraint reward_versions_reward_version_unique unique (reward_id, version_number),
  constraint reward_versions_version_number_positive check (version_number >= 1),
  constraint reward_versions_state_check check (state in ('draft', 'published', 'retired')),
  constraint reward_versions_name_length check (char_length(name) between 1 and 120),
  constraint reward_versions_description_length check (char_length(description) <= 5000),
  constraint reward_versions_image_url_length check (
    image_url is null or char_length(image_url) between 1 and 2048
  ),
  constraint reward_versions_reward_type_check check (
    reward_type in ('digital', 'physical', 'experience')
  ),
  constraint reward_versions_inventory_check check (
    (inventory_mode = 'unlimited' and inventory_quantity is null)
    or (inventory_mode = 'finite' and inventory_quantity >= 0)
  ),
  constraint reward_versions_declared_value_check check (
    (declared_value_minor is null and declared_value_currency is null)
    or (
      declared_value_minor >= 0
      and declared_value_currency ~ '^[A-Z]{3}$'
    )
  ),
  constraint reward_versions_fulfillment_object_check check (
    jsonb_typeof(fulfillment_definition) = 'object'
  ),
  constraint reward_versions_publication_shape check (
    (state = 'draft' and published_at is null)
    or (state in ('published', 'retired') and published_at is not null)
  )
);

create table app.box_version_rewards (
  id uuid primary key,
  box_version_id uuid not null,
  reward_version_id uuid not null,
  position integer not null,
  weight bigint not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint box_version_rewards_box_version_foreign_key foreign key (box_version_id)
    references app.box_versions (id) on delete restrict,
  constraint box_version_rewards_reward_version_foreign_key foreign key (reward_version_id)
    references app.reward_versions (id) on delete restrict,
  constraint box_version_rewards_position_unique unique (box_version_id, position),
  constraint box_version_rewards_reward_unique unique (box_version_id, reward_version_id),
  constraint box_version_rewards_position_nonnegative check (position >= 0),
  constraint box_version_rewards_weight_positive check (weight > 0)
);

alter table app.boxes
  add constraint boxes_current_published_version_foreign_key
  foreign key (current_published_version_id)
  references app.box_versions (id)
  on delete restrict;

create unique index box_versions_one_draft_index
  on app.box_versions (box_id)
  where state = 'draft';
create index box_versions_history_index
  on app.box_versions (box_id, version_number desc);
create index boxes_creator_status_created_index
  on app.boxes (creator_id, status, created_at desc, id);
create unique index reward_versions_one_draft_index
  on app.reward_versions (reward_id)
  where state = 'draft';
create index reward_versions_history_index
  on app.reward_versions (reward_id, version_number desc);
create index rewards_creator_status_created_index
  on app.rewards (creator_id, status, created_at desc, id);
create index box_version_rewards_order_index
  on app.box_version_rewards (box_version_id, position);
create index box_version_rewards_reward_index
  on app.box_version_rewards (reward_version_id, box_version_id);

create function app_private.prevent_catalog_creator_reassignment()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.creator_id <> old.creator_id then
    raise exception using
      errcode = '23514',
      constraint = 'catalog_creator_immutable',
      message = 'Catalog resources cannot be reassigned to another creator.';
  end if;
  return new;
end
$function$;

create trigger boxes_creator_immutable
before update on app.boxes
for each row execute function app_private.prevent_catalog_creator_reassignment();
create trigger rewards_creator_immutable
before update on app.rewards
for each row execute function app_private.prevent_catalog_creator_reassignment();

create function app_private.prevent_box_version_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id <> old.id or new.box_id <> old.box_id or new.version_number <> old.version_number then
    raise exception using
      errcode = '23514',
      constraint = 'box_version_identity_immutable',
      message = 'Box version identity is immutable.';
  end if;
  return new;
end
$function$;

create function app_private.prevent_reward_version_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id <> old.id or new.reward_id <> old.reward_id or new.version_number <> old.version_number then
    raise exception using
      errcode = '23514',
      constraint = 'reward_version_identity_immutable',
      message = 'Reward version identity is immutable.';
  end if;
  return new;
end
$function$;

create trigger box_versions_identity_immutable
before update on app.box_versions
for each row execute function app_private.prevent_box_version_identity_change();
create trigger reward_versions_identity_immutable
before update on app.reward_versions
for each row execute function app_private.prevent_reward_version_identity_change();

create function app_private.prevent_published_catalog_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.state = 'published' then
    raise exception using
      errcode = '23514',
      constraint = 'published_catalog_version_immutable',
      message = 'Published catalog versions are immutable.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

create trigger box_versions_published_immutable
before update or delete on app.box_versions
for each row execute function app_private.prevent_published_catalog_version_mutation();
create trigger reward_versions_published_immutable
before update or delete on app.reward_versions
for each row execute function app_private.prevent_published_catalog_version_mutation();

create function app_private.protect_box_version_reward_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  affected_box_version_id uuid;
begin
  affected_box_version_id := case when tg_op = 'INSERT' then new.box_version_id else old.box_version_id end;

  if tg_op = 'UPDATE'
    and (new.id <> old.id or new.box_version_id <> old.box_version_id) then
    raise exception using
      errcode = '23514',
      constraint = 'box_version_reward_identity_immutable',
      message = 'Box version reward identity is immutable.';
  end if;

  if exists (
    select 1 from app.box_versions where id = affected_box_version_id and state = 'published'
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_version_rewards_immutable',
      message = 'Published box reward configurations are immutable.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

create trigger box_version_rewards_immutable_after_publish
before insert or update or delete on app.box_version_rewards
for each row execute function app_private.protect_box_version_reward_mutation();

create function app_private.enforce_box_reward_creator_scope()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  box_creator_id uuid;
  reward_creator_id uuid;
begin
  select b.creator_id
    into box_creator_id
    from app.box_versions bv
    join app.boxes b on b.id = bv.box_id
   where bv.id = new.box_version_id;

  select r.creator_id
    into reward_creator_id
    from app.reward_versions rv
    join app.rewards r on r.id = rv.reward_id
   where rv.id = new.reward_version_id;

  if box_creator_id is distinct from reward_creator_id then
    raise exception using
      errcode = '23514',
      constraint = 'box_reward_creator_scope',
      message = 'Box and reward versions must belong to the same creator.';
  end if;
  return new;
end
$function$;

create trigger box_version_rewards_creator_scope
before insert or update on app.box_version_rewards
for each row execute function app_private.enforce_box_reward_creator_scope();

create function app_private.prevent_referenced_reward_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1
      from app.box_version_rewards bvr
      join app.box_versions bv on bv.id = bvr.box_version_id
     where bvr.reward_version_id = old.id and bv.state = 'published'
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'published_reward_reference_immutable',
      message = 'Reward versions referenced by published boxes are immutable.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

create trigger reward_versions_referenced_immutable
before update or delete on app.reward_versions
for each row execute function app_private.prevent_referenced_reward_version_mutation();

create function app_private.validate_current_published_box_version()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.current_published_version_id is not null
    and not exists (
      select 1
        from app.box_versions
       where id = new.current_published_version_id
         and box_id = new.id
         and state = 'published'
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'box_current_published_version_scope',
      message = 'The current published version must be published and belong to its box.';
  end if;
  return new;
end
$function$;

create trigger boxes_current_published_version_valid
before insert or update on app.boxes
for each row execute function app_private.validate_current_published_box_version();

create function app_private.validate_box_version_publication()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  entry_count bigint;
  computed_total numeric;
  minimum_position integer;
  maximum_position integer;
begin
  if new.state <> 'published' or (tg_op = 'UPDATE' and old.state = 'published') then
    return new;
  end if;

  select count(*), coalesce(sum(bvr.weight::numeric), 0), min(bvr.position), max(bvr.position)
    into entry_count, computed_total, minimum_position, maximum_position
    from app.box_version_rewards bvr
   where bvr.box_version_id = new.id;

  if entry_count = 0 or computed_total <= 0 then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_requires_rewards',
      message = 'A published box version requires at least one weighted reward.';
  end if;
  if computed_total > 9223372036854775807::numeric then
    raise exception using
      errcode = '22003',
      constraint = 'published_box_weight_overflow',
      message = 'Published box total weight exceeds signed bigint.';
  end if;
  if computed_total <> new.total_weight::numeric then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_total_weight_mismatch',
      message = 'Published box total weight does not match its entries.';
  end if;
  if minimum_position <> 0 or maximum_position <> entry_count - 1 then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_positions_contiguous',
      message = 'Published box reward positions must be contiguous from zero.';
  end if;
  if exists (
    select 1
      from app.box_version_rewards bvr
      join app.reward_versions rv on rv.id = bvr.reward_version_id
      join app.rewards r on r.id = rv.reward_id
     where bvr.box_version_id = new.id
       and (
         rv.state <> 'published'
         or r.status <> 'active'
         or (rv.inventory_mode = 'finite' and rv.inventory_quantity <= 0)
       )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_reward_not_eligible',
      message = 'Published box rewards must be active, published, and inventory-eligible.';
  end if;
  return new;
end
$function$;

create trigger box_versions_validate_publication
before insert or update on app.box_versions
for each row execute function app_private.validate_box_version_publication();

comment on table app.boxes is 'Creator-owned box identities with optimistic revisions.';
comment on table app.box_versions is 'Draft and immutable published box configuration snapshots.';
comment on table app.rewards is 'Creator-owned reward identities.';
comment on table app.reward_versions is 'Draft and immutable published reward snapshots.';
comment on table app.box_version_rewards is 'Exact ordered integer-weight configuration for a box version.';

revoke all on table app.boxes from public;
revoke all on table app.box_versions from public;
revoke all on table app.rewards from public;
revoke all on table app.reward_versions from public;
revoke all on table app.box_version_rewards from public;
grant select, insert, update, delete on table app.boxes to creatordrop_app;
grant select, insert, update, delete on table app.box_versions to creatordrop_app;
grant select, insert, update, delete on table app.rewards to creatordrop_app;
grant select, insert, update, delete on table app.reward_versions to creatordrop_app;
grant select, insert, update, delete on table app.box_version_rewards to creatordrop_app;

reset role;
