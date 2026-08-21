-- Phase 3 identity bootstrap only. Creator roles and all product-domain data remain out of scope.

grant usage on schema extensions to creatordrop_migrator;

set role creatordrop_migrator;

create table app.users (
  id uuid primary key,
  auth_provider text not null,
  auth_subject text not null,
  username extensions.citext not null,
  status text not null default 'active',
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  closed_at timestamptz,
  constraint users_auth_provider_length check (char_length(auth_provider) between 1 and 64),
  constraint users_auth_subject_length check (char_length(auth_subject) between 1 and 255),
  constraint users_username_length check (char_length(username::text) between 1 and 64),
  constraint users_status_check check (status in ('active', 'suspended', 'closed')),
  constraint users_closed_at_check check ((status = 'closed') = (closed_at is not null)),
  constraint users_auth_identity_unique unique (auth_provider, auth_subject),
  constraint users_username_unique unique (username)
);

comment on table app.users is
  'Local identities mapped only from verified authentication-provider subjects.';
comment on column app.users.auth_subject is
  'Trusted provider subject; never populated from request body, query, or path data.';

revoke all on table app.users from public;
grant select, insert, update, delete on table app.users to creatordrop_app;

reset role;
