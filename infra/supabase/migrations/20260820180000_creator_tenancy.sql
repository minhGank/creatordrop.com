-- Phase 4 creator tenancy only. Boxes, rewards, and other product domains remain out of scope.

set role creatordrop_migrator;

create table app.creators (
  id uuid primary key,
  handle extensions.citext not null,
  custom_slug extensions.citext not null,
  display_name text not null,
  status text not null default 'active',
  revision integer not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint creators_handle_format check (
    handle::text ~ '^[a-z0-9][a-z0-9_]{2,31}$'
  ),
  constraint creators_custom_slug_format check (
    custom_slug::text ~ '^[a-z0-9][a-z0-9-]{2,62}$'
  ),
  constraint creators_display_name_length check (char_length(display_name) between 1 and 100),
  constraint creators_status_check check (status in ('active', 'suspended', 'closed')),
  constraint creators_revision_positive check (revision >= 1),
  constraint creators_handle_unique unique (handle),
  constraint creators_custom_slug_unique unique (custom_slug)
);

create table app.creator_memberships (
  creator_id uuid not null,
  user_id uuid not null,
  role text not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint creator_memberships_primary_key primary key (creator_id, user_id),
  constraint creator_memberships_creator_foreign_key foreign key (creator_id)
    references app.creators (id) on delete restrict,
  constraint creator_memberships_user_foreign_key foreign key (user_id)
    references app.users (id) on delete restrict,
  constraint creator_memberships_role_check check (role in ('owner', 'manager', 'editor', 'viewer'))
);

create index creator_memberships_user_creator_index
  on app.creator_memberships (user_id, creator_id);
create index creator_memberships_owner_index
  on app.creator_memberships (creator_id)
  where role = 'owner';

create function app_private.lock_creator_membership_parent()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE'
    and (new.creator_id <> old.creator_id or new.user_id <> old.user_id) then
    raise exception using
      errcode = '23514',
      constraint = 'creator_memberships_identity_immutable',
      message = 'Creator membership identity columns are immutable.';
  end if;

  perform 1
    from app.creators
   where id = case when tg_op = 'INSERT' then new.creator_id else old.creator_id end
   for update;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end
$function$;

create trigger creator_memberships_lock_parent
before insert or update or delete on app.creator_memberships
for each row execute function app_private.lock_creator_membership_parent();

create function app_private.assert_creator_has_required_owner()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if (tg_op = 'INSERT' or new.status = 'active')
    and not exists (
      select 1
        from app.creator_memberships
       where creator_id = new.id and role = 'owner'
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'active_creator_owner_required',
      message = 'An active creator must retain at least one owner.';
  end if;

  return null;
end
$function$;

create constraint trigger creators_require_owner
after insert or update on app.creators
deferrable initially deferred
for each row execute function app_private.assert_creator_has_required_owner();

create function app_private.assert_active_creator_has_owner_from_membership()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  affected_creator_id uuid;
begin
  affected_creator_id := case
    when tg_op = 'INSERT' then new.creator_id
    else old.creator_id
  end;

  if exists (
    select 1 from app.creators where id = affected_creator_id and status = 'active'
  ) and not exists (
    select 1
      from app.creator_memberships
     where creator_id = affected_creator_id and role = 'owner'
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'active_creator_owner_required',
      message = 'An active creator must retain at least one owner.';
  end if;

  return null;
end
$function$;

create constraint trigger creator_memberships_require_owner
after insert or update or delete on app.creator_memberships
deferrable initially deferred
for each row execute function app_private.assert_active_creator_has_owner_from_membership();

comment on table app.creators is 'Private creator workspaces with optimistic revisions.';
comment on table app.creator_memberships is
  'Creator-scoped role assignments used as the authorization source of truth.';
comment on trigger creators_require_owner on app.creators is
  'Defers the active-creator owner invariant until transaction commit.';

revoke all on table app.creators from public;
revoke all on table app.creator_memberships from public;
grant select, insert, update, delete on table app.creators to creatordrop_app;
grant select, insert, update, delete on table app.creator_memberships to creatordrop_app;

reset role;
