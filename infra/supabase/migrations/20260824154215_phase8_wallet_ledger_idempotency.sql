-- Phase 8 only: multi-currency wallet projection, immutable double-entry
-- ledger, reusable operation idempotency, and local/test credit foundations.

set role creatordrop_migrator;

create table app.idempotency_records (
  id uuid primary key,
  actor_user_id uuid not null references app.users (id) on delete restrict,
  operation text not null,
  idempotency_key text not null,
  request_fingerprint bytea not null,
  status text not null default 'processing',
  http_status integer,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint idempotency_records_operation_format check (
    operation ~ '^[a-z][a-z0-9_.-]{0,63}$'
  ),
  constraint idempotency_records_key_format check (
    char_length(idempotency_key) between 8 and 128
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint idempotency_records_fingerprint_size check (
    octet_length(request_fingerprint) = 32
  ),
  constraint idempotency_records_status_check check (
    status in ('processing', 'completed')
  ),
  constraint idempotency_records_state_shape check (
    (
      status = 'processing'
      and http_status is null
      and response_body is null
      and resource_type is null
      and resource_id is null
      and completed_at is null
    )
    or
    (
      status = 'completed'
      and http_status between 200 and 299
      and response_body is not null
      and jsonb_typeof(response_body) = 'object'
      and resource_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
      and resource_id is not null
      and completed_at is not null
      and completed_at >= created_at
    )
  ),
  constraint idempotency_records_actor_operation_key_unique unique (
    actor_user_id,
    operation,
    idempotency_key
  )
);

create index idempotency_records_actor_created_idx
  on app.idempotency_records (actor_user_id, created_at desc, id);

create table app.ledger_accounts (
  id uuid primary key,
  account_type text not null,
  owner_user_id uuid references app.users (id) on delete restrict,
  currency character(3) not null,
  status text not null default 'active',
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint ledger_accounts_type_check check (
    account_type in ('user_wallet', 'system_test_funding')
  ),
  constraint ledger_accounts_currency_format check (
    currency ~ '^[A-Z]{3}$'
  ),
  constraint ledger_accounts_status_check check (status = 'active'),
  constraint ledger_accounts_owner_shape check (
    (account_type = 'user_wallet' and owner_user_id is not null)
    or (account_type = 'system_test_funding' and owner_user_id is null)
  ),
  constraint ledger_accounts_timestamp_order check (updated_at >= created_at),
  constraint ledger_accounts_wallet_link_unique unique (
    id,
    owner_user_id,
    currency,
    account_type
  )
);

create unique index ledger_accounts_user_wallet_unique
  on app.ledger_accounts (owner_user_id, currency)
  where account_type = 'user_wallet';

create unique index ledger_accounts_system_test_funding_unique
  on app.ledger_accounts (currency)
  where account_type = 'system_test_funding';

create table app.wallets (
  id uuid primary key,
  user_id uuid not null references app.users (id) on delete restrict,
  currency character(3) not null,
  ledger_account_id uuid not null unique,
  ledger_account_type text generated always as ('user_wallet') stored,
  available_balance_minor bigint not null default 0,
  revision bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint wallets_balance_nonnegative check (available_balance_minor >= 0),
  constraint wallets_revision_positive check (revision > 0),
  constraint wallets_timestamp_order check (updated_at >= created_at),
  constraint wallets_user_currency_unique unique (user_id, currency),
  constraint wallets_ledger_account_scope_fk foreign key (
    ledger_account_id,
    user_id,
    currency,
    ledger_account_type
  ) references app.ledger_accounts (
    id,
    owner_user_id,
    currency,
    account_type
  ) on delete restrict
);

create index wallets_user_created_idx on app.wallets (user_id, created_at, id);

create table app.ledger_transactions (
  id uuid primary key,
  kind text not null,
  actor_user_id uuid not null references app.users (id) on delete restrict,
  currency character(3) not null,
  business_reference_type text not null,
  business_reference_id uuid not null,
  idempotency_record_id uuid unique references app.idempotency_records (id) on delete restrict,
  reverses_ledger_transaction_id uuid unique references app.ledger_transactions (id) on delete restrict,
  status text not null default 'pending',
  description text not null,
  created_at timestamptz not null default statement_timestamp(),
  posted_at timestamptz,
  constraint ledger_transactions_kind_check check (
    kind in ('test_credit_grant', 'wallet_credit', 'wallet_debit', 'reversal')
  ),
  constraint ledger_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint ledger_transactions_business_reference_type_format check (
    business_reference_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
  ),
  constraint ledger_transactions_status_check check (status in ('pending', 'posted')),
  constraint ledger_transactions_description_length check (
    char_length(description) between 1 and 255
  ),
  constraint ledger_transactions_reversal_shape check (
    (kind = 'reversal') = (reverses_ledger_transaction_id is not null)
  ),
  constraint ledger_transactions_test_credit_idempotency check (
    kind <> 'test_credit_grant' or idempotency_record_id is not null
  ),
  constraint ledger_transactions_status_shape check (
    (status = 'pending' and posted_at is null)
    or (status = 'posted' and posted_at is not null and posted_at >= created_at)
  ),
  constraint ledger_transactions_business_reference_unique unique (
    business_reference_type,
    business_reference_id
  )
);

create index ledger_transactions_actor_created_idx
  on app.ledger_transactions (actor_user_id, created_at desc, id);

create table app.ledger_entries (
  id uuid primary key,
  ledger_transaction_id uuid not null references app.ledger_transactions (id) on delete restrict,
  ledger_account_id uuid not null references app.ledger_accounts (id) on delete restrict,
  amount_minor bigint not null,
  currency character(3) not null,
  sequence smallint not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint ledger_entries_amount_nonzero check (amount_minor <> 0),
  constraint ledger_entries_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint ledger_entries_sequence_nonnegative check (sequence >= 0),
  constraint ledger_entries_transaction_sequence_unique unique (
    ledger_transaction_id,
    sequence
  ),
  constraint ledger_entries_transaction_account_unique unique (
    ledger_transaction_id,
    ledger_account_id
  )
);

create index ledger_entries_account_created_idx
  on app.ledger_entries (ledger_account_id, created_at, id);

create function app_private.reject_financial_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    constraint = tg_table_name || '_immutable',
    message = 'Committed financial identity and history are immutable.';
end
$function$;

create function app_private.guard_idempotency_record_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status <> 'processing'
    or new.http_status is not null
    or new.response_body is not null
    or new.resource_type is not null
    or new.resource_id is not null
    or new.completed_at is not null then
    raise exception using
      errcode = '23514',
      constraint = 'idempotency_records_insert_shape_invalid',
      message = 'Idempotency records must begin in canonical processing state.';
  end if;
  return new;
end
$function$;

create function app_private.guard_idempotency_record_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.status <> 'processing'
    or new.status <> 'completed'
    or new.id is distinct from old.id
    or new.actor_user_id is distinct from old.actor_user_id
    or new.operation is distinct from old.operation
    or new.idempotency_key is distinct from old.idempotency_key
    or new.request_fingerprint is distinct from old.request_fingerprint
    or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      constraint = 'idempotency_records_transition_invalid',
      message = 'An idempotency record may only complete once without changing its identity.';
  end if;
  return new;
end
$function$;

create function app_private.guard_ledger_transaction_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status <> 'pending' or new.posted_at is not null then
    raise exception using
      errcode = '23514',
      constraint = 'ledger_transactions_insert_shape_invalid',
      message = 'Ledger transactions must begin pending inside the posting transaction.';
  end if;
  return new;
end
$function$;

create function app_private.guard_ledger_transaction_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.status <> 'pending'
    or new.status <> 'posted'
    or new.id is distinct from old.id
    or new.kind is distinct from old.kind
    or new.actor_user_id is distinct from old.actor_user_id
    or new.currency is distinct from old.currency
    or new.business_reference_type is distinct from old.business_reference_type
    or new.business_reference_id is distinct from old.business_reference_id
    or new.idempotency_record_id is distinct from old.idempotency_record_id
    or new.reverses_ledger_transaction_id is distinct from old.reverses_ledger_transaction_id
    or new.description is distinct from old.description
    or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      constraint = 'ledger_transactions_transition_invalid',
      message = 'A ledger transaction may only transition once from pending to posted.';
  end if;
  return new;
end
$function$;

create function app_private.guard_ledger_entry_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  transaction_status text;
begin
  select status into transaction_status
    from app.ledger_transactions
    where id = new.ledger_transaction_id
    for update;

  if transaction_status is null then
    raise exception using
      errcode = '23503',
      constraint = 'ledger_entries_transaction_missing',
      message = 'Ledger entries require an existing transaction.';
  end if;
  if transaction_status <> 'pending' then
    raise exception using
      errcode = '23514',
      constraint = 'ledger_entries_posted_transaction_immutable',
      message = 'Entries cannot be added to a posted ledger transaction.';
  end if;
  return new;
end
$function$;

create function app_private.guard_wallet_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.available_balance_minor <> 0 or new.revision <> 1 then
    raise exception using
      errcode = '23514',
      constraint = 'wallets_insert_shape_invalid',
      message = 'A wallet must begin with a zero balance and revision one.';
  end if;
  return new;
end
$function$;

create function app_private.guard_wallet_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.currency is distinct from old.currency
    or new.ledger_account_id is distinct from old.ledger_account_id
    or new.created_at is distinct from old.created_at
    or new.available_balance_minor is not distinct from old.available_balance_minor
    or new.revision <> old.revision + 1
    or new.updated_at < old.updated_at then
    raise exception using
      errcode = '23514',
      constraint = 'wallets_update_invalid',
      message = 'Wallet projections may only change through a revisioned balance movement.';
  end if;
  return new;
end
$function$;

create trigger idempotency_records_insert_guard
before insert on app.idempotency_records
for each row execute function app_private.guard_idempotency_record_insert();

create trigger idempotency_records_update_guard
before update on app.idempotency_records
for each row execute function app_private.guard_idempotency_record_update();

create trigger idempotency_records_delete_guard
before delete on app.idempotency_records
for each row execute function app_private.reject_financial_history_mutation();

create trigger ledger_accounts_update_guard
before update on app.ledger_accounts
for each row execute function app_private.reject_financial_history_mutation();

create trigger ledger_accounts_delete_guard
before delete on app.ledger_accounts
for each row execute function app_private.reject_financial_history_mutation();

create trigger wallets_insert_guard
before insert on app.wallets
for each row execute function app_private.guard_wallet_insert();

create trigger wallets_update_guard
before update on app.wallets
for each row execute function app_private.guard_wallet_update();

create trigger wallets_delete_guard
before delete on app.wallets
for each row execute function app_private.reject_financial_history_mutation();

create trigger ledger_transactions_insert_guard
before insert on app.ledger_transactions
for each row execute function app_private.guard_ledger_transaction_insert();

create trigger ledger_transactions_update_guard
before update on app.ledger_transactions
for each row execute function app_private.guard_ledger_transaction_update();

create trigger ledger_transactions_delete_guard
before delete on app.ledger_transactions
for each row execute function app_private.reject_financial_history_mutation();

create trigger ledger_entries_insert_guard
before insert on app.ledger_entries
for each row execute function app_private.guard_ledger_entry_insert();

create trigger ledger_entries_update_guard
before update on app.ledger_entries
for each row execute function app_private.reject_financial_history_mutation();

create trigger ledger_entries_delete_guard
before delete on app.ledger_entries
for each row execute function app_private.reject_financial_history_mutation();

create function app_private.validate_idempotency_completion()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  current_record app.idempotency_records%rowtype;
begin
  select * into current_record
    from app.idempotency_records
    where id = new.id;

  if not found or current_record.status <> 'completed' then
    raise exception using
      errcode = '23514',
      constraint = 'idempotency_records_incomplete_at_commit',
      message = 'An idempotency claim cannot commit before its operation completes.';
  end if;
  return new;
end
$function$;

create constraint trigger idempotency_records_completion_guard
after insert or update on app.idempotency_records
deferrable initially deferred
for each row execute function app_private.validate_idempotency_completion();

create function app_private.validate_ledger_transaction_posting()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  account_currency_mismatch boolean;
  current_transaction app.ledger_transactions%rowtype;
  entry_count bigint;
  entry_total numeric;
  expected_entry_count bigint;
  posting_idempotency_valid boolean;
  test_credit_idempotency_valid boolean;
begin
  select * into current_transaction
    from app.ledger_transactions
    where id = new.id;

  if not found or current_transaction.status <> 'posted' then
    raise exception using
      errcode = '23514',
      constraint = 'ledger_transactions_unposted_at_commit',
      message = 'A ledger transaction cannot commit before posting completes.';
  end if;

  select
    count(*),
    coalesce(sum(entry.amount_minor::numeric), 0),
    coalesce(bool_or(
      entry.currency <> current_transaction.currency
      or account.currency <> current_transaction.currency
    ), false)
  into entry_count, entry_total, account_currency_mismatch
  from app.ledger_entries as entry
  join app.ledger_accounts as account on account.id = entry.ledger_account_id
  where entry.ledger_transaction_id = current_transaction.id;

  if entry_count < 2 then
    raise exception using
      errcode = '23514',
      constraint = 'ledger_transactions_minimum_entries',
      message = 'A posted ledger transaction requires at least two entries.';
  end if;
  if entry_total <> 0 then
    raise exception using
      errcode = '23514',
      constraint = 'ledger_transactions_unbalanced',
      message = 'A posted ledger transaction must balance to zero.';
  end if;
  if account_currency_mismatch then
    raise exception using
      errcode = '23514',
      constraint = 'ledger_transactions_currency_mismatch',
      message = 'All ledger entries and accounts must use the transaction currency.';
  end if;

  if current_transaction.idempotency_record_id is not null then
    select exists (
      select 1
        from app.idempotency_records as record
        where record.id = current_transaction.idempotency_record_id
          and record.actor_user_id = current_transaction.actor_user_id
          and record.status = 'completed'
          and record.resource_type = 'ledger_transaction'
          and record.resource_id = current_transaction.id
    ) into posting_idempotency_valid;
    if not posting_idempotency_valid then
      raise exception using
        errcode = '23514',
        constraint = 'ledger_transactions_idempotency_invalid',
        message = 'A posting idempotency record must match its actor and ledger result.';
    end if;
  end if;

  if current_transaction.kind in ('test_credit_grant', 'wallet_credit', 'wallet_debit') then
    select count(*) into expected_entry_count
      from app.ledger_entries as entry
      join app.ledger_accounts as account on account.id = entry.ledger_account_id
      where entry.ledger_transaction_id = current_transaction.id
        and (
          (
            account.account_type = 'user_wallet'
            and account.owner_user_id = current_transaction.actor_user_id
            and (
              (current_transaction.kind in ('test_credit_grant', 'wallet_credit') and entry.amount_minor > 0)
              or (current_transaction.kind = 'wallet_debit' and entry.amount_minor < 0)
            )
          )
          or
          (
            account.account_type = 'system_test_funding'
            and account.owner_user_id is null
            and (
              (current_transaction.kind in ('test_credit_grant', 'wallet_credit') and entry.amount_minor < 0)
              or (current_transaction.kind = 'wallet_debit' and entry.amount_minor > 0)
            )
          )
        );
    if entry_count <> 2 or expected_entry_count <> 2 then
      raise exception using
        errcode = '23514',
        constraint = 'ledger_transactions_wallet_movement_shape',
        message = 'Wallet credit and debit postings require one user-wallet and one system entry.';
    end if;
  end if;

  if current_transaction.kind = 'test_credit_grant' then
    select exists (
      select 1
        from app.idempotency_records as record
        where record.id = current_transaction.idempotency_record_id
          and record.actor_user_id = current_transaction.actor_user_id
          and record.operation = 'wallet.test_credit'
          and record.status = 'completed'
          and record.resource_type = 'ledger_transaction'
          and record.resource_id = current_transaction.id
    ) into test_credit_idempotency_valid;
    if not test_credit_idempotency_valid then
      raise exception using
        errcode = '23514',
        constraint = 'ledger_transactions_test_credit_idempotency_invalid',
        message = 'A test-credit posting requires its completed matching idempotency record.';
    end if;
  end if;

  if current_transaction.kind = 'reversal' then
    if not exists (
      select 1 from app.ledger_transactions as original
      where original.id = current_transaction.reverses_ledger_transaction_id
        and original.status = 'posted'
        and original.currency = current_transaction.currency
    ) or exists (
      (
        select ledger_account_id, amount_minor::numeric
          from app.ledger_entries
          where ledger_transaction_id = current_transaction.id
        except
        select ledger_account_id, -amount_minor::numeric
          from app.ledger_entries
          where ledger_transaction_id = current_transaction.reverses_ledger_transaction_id
      )
      union all
      (
        select ledger_account_id, -amount_minor::numeric
          from app.ledger_entries
          where ledger_transaction_id = current_transaction.reverses_ledger_transaction_id
        except
        select ledger_account_id, amount_minor::numeric
          from app.ledger_entries
          where ledger_transaction_id = current_transaction.id
      )
    ) then
      raise exception using
        errcode = '23514',
        constraint = 'ledger_transactions_reversal_entries_invalid',
        message = 'A reversal must contain the exact opposite entries of its original transaction.';
    end if;
  end if;

  return new;
end
$function$;

create constraint trigger ledger_transactions_posting_guard
after insert or update on app.ledger_transactions
deferrable initially deferred
for each row execute function app_private.validate_ledger_transaction_posting();

create function app_private.validate_wallet_reconciliation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  derived_balance numeric;
  wallet_record app.wallets%rowtype;
begin
  if tg_table_name = 'wallets' then
    select * into wallet_record from app.wallets where id = new.id;
  else
    select * into wallet_record
      from app.wallets
      where ledger_account_id = new.ledger_account_id;
  end if;

  if not found then
    return new;
  end if;

  select coalesce(sum(amount_minor::numeric), 0) into derived_balance
    from app.ledger_entries
    where ledger_account_id = wallet_record.ledger_account_id;

  if derived_balance <> wallet_record.available_balance_minor::numeric then
    raise exception using
      errcode = '23514',
      constraint = 'wallets_ledger_projection_mismatch',
      message = 'The cached wallet balance must equal its authoritative ledger entries.';
  end if;
  return new;
end
$function$;

create constraint trigger wallets_reconciliation_guard
after insert or update on app.wallets
deferrable initially deferred
for each row execute function app_private.validate_wallet_reconciliation();

create constraint trigger ledger_entries_wallet_reconciliation_guard
after insert on app.ledger_entries
deferrable initially deferred
for each row execute function app_private.validate_wallet_reconciliation();

create function app.apply_wallet_balance(
  wallet_id uuid,
  delta_minor bigint
)
returns setof app.wallets
language sql
security definer
set search_path = ''
as $function$
  update app.wallets
     set available_balance_minor = available_balance_minor + delta_minor,
         revision = revision + 1,
         updated_at = clock_timestamp()
   where id = wallet_id
     and delta_minor <> 0
     and available_balance_minor + delta_minor >= 0
  returning *;
$function$;

create function app.lock_user_wallet(
  owner_id uuid,
  account_currency character(3)
)
returns setof app.wallets
language sql
security definer
set search_path = ''
as $function$
  select wallet.*
    from app.wallets as wallet
    where wallet.user_id = owner_id and wallet.currency = account_currency
    for update;
$function$;

create function app.lock_wallets_for_ledger_accounts(account_ids uuid[])
returns setof app.wallets
language sql
security definer
set search_path = ''
as $function$
  select wallet.*
    from app.wallets as wallet
    where wallet.ledger_account_id = any(account_ids)
    order by wallet.id
    for update;
$function$;

create function app.finalize_ledger_transaction(transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update app.ledger_transactions
     set status = 'posted', posted_at = clock_timestamp()
   where id = transaction_id and status = 'pending';
  if not found then
    raise exception using
      errcode = '23514',
      constraint = 'ledger_transactions_finalize_invalid',
      message = 'The ledger transaction could not be finalized.';
  end if;
end
$function$;

create function app.complete_idempotency_record(
  record_id uuid,
  response_status integer,
  response_document jsonb,
  result_resource_type text,
  result_resource_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if result_resource_type <> 'ledger_transaction'
    or not exists (
      select 1
        from app.ledger_transactions as ledger_tx
        join app.idempotency_records as record on record.id = record_id
        where ledger_tx.id = result_resource_id
          and ledger_tx.idempotency_record_id = record.id
          and ledger_tx.actor_user_id = record.actor_user_id
          and ledger_tx.status = 'posted'
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'idempotency_records_resource_invalid',
      message = 'Idempotency completion requires its matching posted ledger transaction.';
  end if;

  update app.idempotency_records
     set status = 'completed',
         http_status = response_status,
         response_body = response_document,
         resource_type = result_resource_type,
         resource_id = result_resource_id,
         completed_at = clock_timestamp()
   where id = record_id and status = 'processing';
  if not found then
    raise exception using
      errcode = '23514',
      constraint = 'idempotency_records_completion_invalid',
      message = 'The idempotency record could not be completed.';
  end if;
end
$function$;

revoke all on table app.idempotency_records from public, creatordrop_app;
revoke all on table app.ledger_accounts from public, creatordrop_app;
revoke all on table app.wallets from public, creatordrop_app;
revoke all on table app.ledger_transactions from public, creatordrop_app;
revoke all on table app.ledger_entries from public, creatordrop_app;

grant select, insert on table app.idempotency_records to creatordrop_app;
grant select, insert on table app.ledger_accounts to creatordrop_app;
grant select, insert on table app.wallets to creatordrop_app;
grant select, insert on table app.ledger_transactions to creatordrop_app;
grant select, insert on table app.ledger_entries to creatordrop_app;

grant execute on function app.apply_wallet_balance(uuid, bigint) to creatordrop_app;
grant execute on function app.lock_user_wallet(uuid, character) to creatordrop_app;
grant execute on function app.lock_wallets_for_ledger_accounts(uuid[]) to creatordrop_app;
grant execute on function app.finalize_ledger_transaction(uuid) to creatordrop_app;
grant execute on function app.complete_idempotency_record(
  uuid,
  integer,
  jsonb,
  text,
  uuid
) to creatordrop_app;

comment on table app.idempotency_records is
  'Durable actor-and-operation scoped command replay identity; processing rows cannot commit.';
comment on table app.ledger_accounts is
  'Immutable per-currency accounts participating in double-entry postings.';
comment on table app.wallets is
  'Nonnegative user balance projection reconciled against the linked ledger account.';
comment on table app.ledger_transactions is
  'Immutable posted accounting event; pending is transaction-local and cannot commit.';
comment on table app.ledger_entries is
  'Immutable signed per-account entries whose posted transaction must sum to zero.';

reset role;
