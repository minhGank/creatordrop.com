-- Phase 2 foundation only: roles, schemas, and broadly required extensions.
-- Application-domain tables belong to later roadmap phases.

create schema if not exists extensions;

create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'creatordrop_migrator') then
    create role creatordrop_migrator
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'creatordrop_app') then
    create role creatordrop_app
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit;
  end if;
end
$roles$;

do $role_memberships$
begin
  execute format('grant creatordrop_migrator to %I', current_user);
end
$role_memberships$;

grant creatordrop_app to postgres;

create schema if not exists app authorization creatordrop_migrator;
create schema if not exists app_private authorization creatordrop_migrator;

alter schema app owner to creatordrop_migrator;
alter schema app_private owner to creatordrop_migrator;

revoke create on schema public from public;
revoke all on schema app from public;
revoke all on schema app_private from public;
revoke all on schema app_private from creatordrop_app;

grant usage on schema app to creatordrop_app;
grant usage on schema extensions to creatordrop_app;

do $database_privileges$
begin
  execute format(
    'grant connect, temporary on database %I to creatordrop_app',
    current_database()
  );
end
$database_privileges$;

alter default privileges for role creatordrop_migrator in schema app
  revoke all on tables from public;
alter default privileges for role creatordrop_migrator in schema app
  revoke all on sequences from public;
alter default privileges for role creatordrop_migrator in schema app
  revoke execute on functions from public;

alter default privileges for role creatordrop_migrator in schema app
  grant select, insert, update, delete on tables to creatordrop_app;
alter default privileges for role creatordrop_migrator in schema app
  grant usage, select on sequences to creatordrop_app;

alter default privileges for role creatordrop_migrator in schema app_private
  revoke all on tables from public;
alter default privileges for role creatordrop_migrator in schema app_private
  revoke all on sequences from public;
alter default privileges for role creatordrop_migrator in schema app_private
  revoke execute on functions from public;

comment on schema app is 'CreatorDrop application objects accessible to the restricted server role.';
comment on schema app_private is 'CreatorDrop internal objects with no default application-role access.';
