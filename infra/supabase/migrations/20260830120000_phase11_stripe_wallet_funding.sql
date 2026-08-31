-- Phase 11: Stripe test-mode wallet funding, compensating provider adjustments,
-- nonnegative-wallet deficits, and provider/ledger reconciliation foundations.

set role creatordrop_migrator;

alter table app.ledger_accounts
  drop constraint ledger_accounts_type_check,
  drop constraint ledger_accounts_owner_shape,
  add constraint ledger_accounts_type_check check (
    account_type in (
      'user_wallet',
      'system_test_funding',
      'box_sales_clearing',
      'creator_pending_earnings',
      'platform_fee',
      'provider_funding_clearing',
      'user_funding_deficit'
    )
  ),
  add constraint ledger_accounts_owner_shape check (
    (
      account_type in ('user_wallet', 'user_funding_deficit')
      and owner_user_id is not null
      and owner_creator_id is null
    )
    or (
      account_type in (
        'system_test_funding',
        'box_sales_clearing',
        'platform_fee',
        'provider_funding_clearing'
      )
      and owner_user_id is null
      and owner_creator_id is null
    )
    or (
      account_type = 'creator_pending_earnings'
      and owner_user_id is null
      and owner_creator_id is not null
    )
  );

create unique index ledger_accounts_provider_funding_unique
  on app.ledger_accounts (currency)
  where account_type = 'provider_funding_clearing';

create unique index ledger_accounts_user_funding_deficit_unique
  on app.ledger_accounts (owner_user_id, currency)
  where account_type = 'user_funding_deficit';

alter table app.ledger_transactions
  drop constraint ledger_transactions_kind_check,
  add constraint ledger_transactions_kind_check check (
    kind in (
      'test_credit_grant',
      'wallet_credit',
      'wallet_debit',
      'reversal',
      'box_open_sale',
      'box_open_allocation',
      'provider_funding_credit',
      'provider_funding_refund',
      'provider_funding_dispute'
    )
  );

create table app.funding_intents (
  id uuid primary key,
  public_id uuid not null unique,
  user_id uuid not null references app.users (id) on delete restrict,
  wallet_id uuid not null references app.wallets (id) on delete restrict,
  provider text not null,
  provider_payment_intent_id text unique,
  client_idempotency_key text not null,
  request_fingerprint bytea not null,
  requested_amount_minor bigint not null,
  currency character(3) not null,
  status text not null default 'provider_pending',
  last_provider_event_created_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint funding_intents_provider_check check (provider = 'stripe'),
  constraint funding_intents_provider_id_format check (
    provider_payment_intent_id is null
    or provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]{3,251}$'
  ),
  constraint funding_intents_idempotency_key_format check (
    char_length(client_idempotency_key) between 8 and 128
    and client_idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint funding_intents_fingerprint_size check (octet_length(request_fingerprint) = 32),
  constraint funding_intents_amount_policy check (
    currency = 'USD' and requested_amount_minor between 500 and 50000
  ),
  constraint funding_intents_status_check check (
    status in (
      'provider_pending',
      'requires_payment',
      'failed',
      'canceled',
      'settled',
      'partially_reversed',
      'reversed',
      'disputed',
      'reconciliation_required'
    )
  ),
  constraint funding_intents_provider_binding_shape check (
    (status = 'provider_pending' and provider_payment_intent_id is null)
    or (status <> 'provider_pending' and provider_payment_intent_id is not null)
  ),
  constraint funding_intents_timestamp_order check (updated_at >= created_at),
  constraint funding_intents_user_key_unique unique (user_id, client_idempotency_key),
  constraint funding_intents_wallet_scope_unique unique (id, user_id, wallet_id, currency)
);

create index funding_intents_user_created_idx
  on app.funding_intents (user_id, created_at desc, id);

create table app.provider_events (
  id uuid primary key,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  provider_object_id text,
  funding_intent_id uuid references app.funding_intents (id) on delete restrict,
  payload_sha256 bytea not null,
  provider_created_at timestamptz not null,
  received_at timestamptz not null default statement_timestamp(),
  signature_verified_at timestamptz not null default statement_timestamp(),
  status text not null default 'processing',
  attempt_count integer not null default 1,
  result_code text,
  processed_at timestamptz,
  constraint provider_events_provider_check check (provider = 'stripe'),
  constraint provider_events_provider_event_id_format check (
    provider_event_id ~ '^evt_[A-Za-z0-9_]{3,251}$'
  ),
  constraint provider_events_event_type_format check (
    event_type ~ '^[a-z][a-z0-9_.]{0,127}$'
  ),
  constraint provider_events_object_id_format check (
    provider_object_id is null or char_length(provider_object_id) between 4 and 255
  ),
  constraint provider_events_payload_hash_size check (octet_length(payload_sha256) = 32),
  constraint provider_events_status_check check (
    status in ('processing', 'processed', 'retryable')
  ),
  constraint provider_events_attempt_positive check (attempt_count > 0),
  constraint provider_events_result_code_format check (
    result_code is null or result_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint provider_events_state_shape check (
    (
      status = 'processing'
      and result_code is null
      and processed_at is null
    )
    or (
      status in ('processed', 'retryable')
      and result_code is not null
      and processed_at is not null
      and processed_at >= received_at
    )
  ),
  constraint provider_events_provider_id_unique unique (provider, provider_event_id)
);

create index provider_events_status_received_idx
  on app.provider_events (status, received_at, id);

create table app.funding_settlements (
  id uuid primary key,
  funding_intent_id uuid not null unique references app.funding_intents (id) on delete restrict,
  provider_event_id uuid not null references app.provider_events (id) on delete restrict,
  provider text not null,
  provider_payment_intent_id text not null unique,
  ledger_transaction_id uuid not null unique references app.ledger_transactions (id) on delete restrict,
  settled_amount_minor bigint not null,
  currency character(3) not null,
  settled_at timestamptz not null default statement_timestamp(),
  constraint funding_settlements_provider_check check (provider = 'stripe'),
  constraint funding_settlements_provider_id_format check (
    provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]{3,251}$'
  ),
  constraint funding_settlements_amount_positive check (settled_amount_minor > 0),
  constraint funding_settlements_currency_format check (currency ~ '^[A-Z]{3}$')
);

create table app.funding_adjustments (
  id uuid primary key,
  funding_settlement_id uuid not null references app.funding_settlements (id) on delete restrict,
  provider_event_id uuid not null unique references app.provider_events (id) on delete restrict,
  provider text not null,
  provider_adjustment_id text not null,
  adjustment_type text not null,
  ledger_transaction_id uuid not null unique references app.ledger_transactions (id) on delete restrict,
  amount_minor bigint not null,
  wallet_recovered_minor bigint not null,
  deficit_minor bigint not null,
  currency character(3) not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint funding_adjustments_provider_check check (provider = 'stripe'),
  constraint funding_adjustments_provider_id_format check (
    char_length(provider_adjustment_id) between 4 and 255
  ),
  constraint funding_adjustments_type_check check (
    adjustment_type in ('refund', 'dispute')
  ),
  constraint funding_adjustments_amount_positive check (amount_minor > 0),
  constraint funding_adjustments_recovery_nonnegative check (
    wallet_recovered_minor >= 0 and deficit_minor >= 0
  ),
  constraint funding_adjustments_recovery_total check (
    wallet_recovered_minor + deficit_minor = amount_minor
  ),
  constraint funding_adjustments_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint funding_adjustments_provider_object_unique unique (
    provider,
    adjustment_type,
    provider_adjustment_id
  )
);

create index funding_adjustments_settlement_created_idx
  on app.funding_adjustments (funding_settlement_id, created_at, id);

create table app.funding_deficits (
  id uuid primary key,
  funding_adjustment_id uuid not null unique references app.funding_adjustments (id) on delete restrict,
  user_id uuid not null references app.users (id) on delete restrict,
  ledger_account_id uuid not null references app.ledger_accounts (id) on delete restrict,
  currency character(3) not null,
  amount_minor bigint not null,
  status text not null default 'unresolved',
  created_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  constraint funding_deficits_amount_positive check (amount_minor > 0),
  constraint funding_deficits_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint funding_deficits_status_check check (status in ('unresolved', 'resolved')),
  constraint funding_deficits_state_shape check (
    (status = 'unresolved' and resolved_at is null)
    or (status = 'resolved' and resolved_at is not null and resolved_at >= created_at)
  )
);

create index funding_deficits_user_status_idx
  on app.funding_deficits (user_id, currency, status, created_at, id);

create function app_private.guard_funding_intent_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status <> 'provider_pending'
    or new.provider_payment_intent_id is not null
    or new.last_provider_event_created_at is not null then
    raise exception using errcode = '23514', constraint = 'funding_intents_insert_shape_invalid';
  end if;
  if not exists (
    select 1 from app.wallets as wallet
    where wallet.id = new.wallet_id
      and wallet.user_id = new.user_id
      and wallet.currency = new.currency
  ) then
    raise exception using errcode = '23514', constraint = 'funding_intents_wallet_scope_invalid';
  end if;
  return new;
end
$function$;

create function app_private.guard_funding_intent_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
    or new.public_id is distinct from old.public_id
    or new.user_id is distinct from old.user_id
    or new.wallet_id is distinct from old.wallet_id
    or new.provider is distinct from old.provider
    or new.client_idempotency_key is distinct from old.client_idempotency_key
    or new.request_fingerprint is distinct from old.request_fingerprint
    or new.requested_amount_minor is distinct from old.requested_amount_minor
    or new.currency is distinct from old.currency
    or new.created_at is distinct from old.created_at
    or new.updated_at < old.updated_at
    or (
      old.provider_payment_intent_id is not null
      and new.provider_payment_intent_id is distinct from old.provider_payment_intent_id
    ) then
    raise exception using errcode = '23514', constraint = 'funding_intents_history_immutable';
  end if;
  if not (
    (old.status = 'provider_pending' and new.status in ('requires_payment', 'reconciliation_required'))
    or (old.status = 'requires_payment' and new.status in (
      'requires_payment', 'failed', 'canceled', 'settled', 'reconciliation_required'
    ))
    or (old.status = 'failed' and new.status in ('failed', 'settled', 'reconciliation_required'))
    or (old.status = 'canceled' and new.status in ('canceled', 'reconciliation_required'))
    or (old.status = 'settled' and new.status in (
      'settled', 'partially_reversed', 'reversed', 'disputed', 'reconciliation_required'
    ))
    or (old.status = 'partially_reversed' and new.status in (
      'partially_reversed', 'reversed', 'disputed', 'reconciliation_required'
    ))
    or (old.status = 'disputed' and new.status in ('disputed', 'reversed', 'reconciliation_required'))
    or (old.status = 'reversed' and new.status in ('reversed', 'reconciliation_required'))
    or (old.status = 'reconciliation_required' and new.status = 'reconciliation_required')
  ) then
    raise exception using errcode = '23514', constraint = 'funding_intents_transition_invalid';
  end if;
  return new;
end
$function$;

create function app_private.guard_provider_event_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status <> 'processing'
    or new.attempt_count <> 1
    or new.result_code is not null
    or new.processed_at is not null then
    raise exception using errcode = '23514', constraint = 'provider_events_insert_shape_invalid';
  end if;
  return new;
end
$function$;

create function app_private.guard_provider_event_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
    or new.provider is distinct from old.provider
    or new.provider_event_id is distinct from old.provider_event_id
    or new.event_type is distinct from old.event_type
    or new.provider_object_id is distinct from old.provider_object_id
    or new.funding_intent_id is distinct from old.funding_intent_id
    or new.payload_sha256 is distinct from old.payload_sha256
    or new.provider_created_at is distinct from old.provider_created_at
    or new.received_at is distinct from old.received_at
    or new.signature_verified_at is distinct from old.signature_verified_at then
    raise exception using errcode = '23514', constraint = 'provider_events_history_immutable';
  end if;
  if not (
    (
      old.status = 'processing'
      and new.status in ('processed', 'retryable')
      and new.attempt_count = old.attempt_count
    )
    or (
      old.status = 'retryable'
      and new.status = 'processing'
      and new.attempt_count = old.attempt_count + 1
    )
  ) then
    raise exception using errcode = '23514', constraint = 'provider_events_transition_invalid';
  end if;
  return new;
end
$function$;

create trigger funding_intents_insert_guard
before insert on app.funding_intents
for each row execute function app_private.guard_funding_intent_insert();
create trigger funding_intents_update_guard
before update on app.funding_intents
for each row execute function app_private.guard_funding_intent_update();
create trigger funding_intents_delete_guard
before delete on app.funding_intents
for each row execute function app_private.reject_financial_history_mutation();

create trigger provider_events_insert_guard
before insert on app.provider_events
for each row execute function app_private.guard_provider_event_insert();
create trigger provider_events_update_guard
before update on app.provider_events
for each row execute function app_private.guard_provider_event_update();
create trigger provider_events_delete_guard
before delete on app.provider_events
for each row execute function app_private.reject_financial_history_mutation();

create trigger funding_settlements_history_guard
before update or delete on app.funding_settlements
for each row execute function app_private.reject_financial_history_mutation();
create trigger funding_adjustments_history_guard
before update or delete on app.funding_adjustments
for each row execute function app_private.reject_financial_history_mutation();
create trigger funding_deficits_history_guard
before update or delete on app.funding_deficits
for each row execute function app_private.reject_financial_history_mutation();

create function app_private.validate_provider_funding_posting()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  current_transaction app.ledger_transactions%rowtype;
  adjustment app.funding_adjustments%rowtype;
  intent app.funding_intents%rowtype;
  funding_event app.provider_events%rowtype;
  settlement app.funding_settlements%rowtype;
  matched_entries bigint;
  total_entries bigint;
begin
  if tg_table_name = 'ledger_transactions' then
    select * into current_transaction
      from app.ledger_transactions
      where id = new.id;
  else
    select * into current_transaction
      from app.ledger_transactions
      where id = new.ledger_transaction_id;
  end if;

  if current_transaction.kind = 'provider_funding_credit' then
    select * into settlement
      from app.funding_settlements
      where ledger_transaction_id = current_transaction.id;
    if not found then
      raise exception using errcode = '23514', constraint = 'provider_funding_settlement_link_invalid';
    end if;
    select * into intent from app.funding_intents where id = settlement.funding_intent_id;
    select * into funding_event from app.provider_events where id = settlement.provider_event_id;
    select count(*) into total_entries from app.ledger_entries
      where ledger_transaction_id = current_transaction.id;
    select count(*) into matched_entries
      from app.ledger_entries as entry
      join app.ledger_accounts as account on account.id = entry.ledger_account_id
      where entry.ledger_transaction_id = current_transaction.id
        and (
          (
            account.account_type = 'user_wallet'
            and account.owner_user_id = intent.user_id
            and entry.amount_minor = settlement.settled_amount_minor
          )
          or (
            account.account_type = 'provider_funding_clearing'
            and account.owner_user_id is null
            and entry.amount_minor = -settlement.settled_amount_minor
          )
        );
    if current_transaction.status <> 'posted'
      or current_transaction.actor_user_id <> intent.user_id
      or current_transaction.currency <> settlement.currency
      or current_transaction.business_reference_type <> 'funding_settlement'
      or current_transaction.business_reference_id <> settlement.id
      or settlement.provider_payment_intent_id <> intent.provider_payment_intent_id
      or settlement.settled_amount_minor <> intent.requested_amount_minor
      or settlement.currency <> intent.currency
      or funding_event.funding_intent_id <> intent.id
      or funding_event.event_type <> 'payment_intent.succeeded'
      or funding_event.provider_object_id <> settlement.provider_payment_intent_id
      or funding_event.status <> 'processed'
      or funding_event.result_code <> 'SETTLED'
      or intent.status not in ('settled', 'partially_reversed', 'reversed', 'disputed')
      or total_entries <> 2
      or matched_entries <> 2 then
      raise exception using errcode = '23514', constraint = 'provider_funding_settlement_link_invalid';
    end if;
  elsif current_transaction.kind in ('provider_funding_refund', 'provider_funding_dispute') then
    select * into adjustment
      from app.funding_adjustments
      where ledger_transaction_id = current_transaction.id;
    if not found then
      raise exception using errcode = '23514', constraint = 'provider_funding_adjustment_link_invalid';
    end if;
    select * into settlement from app.funding_settlements where id = adjustment.funding_settlement_id;
    select * into intent from app.funding_intents where id = settlement.funding_intent_id;
    select * into funding_event from app.provider_events where id = adjustment.provider_event_id;
    select count(*) into total_entries from app.ledger_entries
      where ledger_transaction_id = current_transaction.id;
    select count(*) into matched_entries
      from app.ledger_entries as entry
      join app.ledger_accounts as account on account.id = entry.ledger_account_id
      where entry.ledger_transaction_id = current_transaction.id
        and (
          (
            account.account_type = 'provider_funding_clearing'
            and entry.amount_minor = adjustment.amount_minor
          )
          or (
            adjustment.wallet_recovered_minor > 0
            and account.account_type = 'user_wallet'
            and account.owner_user_id = intent.user_id
            and entry.amount_minor = -adjustment.wallet_recovered_minor
          )
          or (
            adjustment.deficit_minor > 0
            and account.account_type = 'user_funding_deficit'
            and account.owner_user_id = intent.user_id
            and entry.amount_minor = -adjustment.deficit_minor
          )
        );
    if current_transaction.status <> 'posted'
      or current_transaction.actor_user_id <> intent.user_id
      or current_transaction.currency <> adjustment.currency
      or current_transaction.business_reference_type <> 'funding_adjustment'
      or current_transaction.business_reference_id <> adjustment.id
      or (current_transaction.kind = 'provider_funding_refund') <> (adjustment.adjustment_type = 'refund')
      or funding_event.funding_intent_id <> intent.id
      or funding_event.provider_object_id <> adjustment.provider_adjustment_id
      or funding_event.status <> 'processed'
      or funding_event.result_code <> 'ADJUSTMENT_RECORDED'
      or (
        adjustment.adjustment_type = 'refund'
        and funding_event.event_type not in ('refund.created', 'refund.updated')
      )
      or (
        adjustment.adjustment_type = 'dispute'
        and funding_event.event_type <> 'charge.dispute.created'
      )
      or total_entries <> 2 + (
        case
          when adjustment.wallet_recovered_minor > 0 and adjustment.deficit_minor > 0 then 1
          else 0
        end
      )
      or matched_entries <> total_entries then
      raise exception using errcode = '23514', constraint = 'provider_funding_adjustment_link_invalid';
    end if;
    if adjustment.deficit_minor > 0 and not exists (
      select 1 from app.funding_deficits as deficit
      where deficit.funding_adjustment_id = adjustment.id
        and deficit.user_id = intent.user_id
        and deficit.currency = adjustment.currency
        and deficit.amount_minor = adjustment.deficit_minor
        and deficit.status = 'unresolved'
        and exists (
          select 1 from app.ledger_accounts as deficit_account
          where deficit_account.id = deficit.ledger_account_id
            and deficit_account.account_type = 'user_funding_deficit'
            and deficit_account.owner_user_id = intent.user_id
            and deficit_account.currency = adjustment.currency
        )
    ) then
      raise exception using errcode = '23514', constraint = 'provider_funding_deficit_link_invalid';
    end if;
    if adjustment.deficit_minor = 0 and exists (
      select 1 from app.funding_deficits where funding_adjustment_id = adjustment.id
    ) then
      raise exception using errcode = '23514', constraint = 'provider_funding_deficit_link_invalid';
    end if;
    if (
      select coalesce(sum(existing.amount_minor::numeric), 0)
      from app.funding_adjustments as existing
      where existing.funding_settlement_id = settlement.id
    ) > settlement.settled_amount_minor::numeric then
      raise exception using errcode = '23514', constraint = 'provider_funding_adjustment_total_invalid';
    end if;
  end if;
  return new;
end
$function$;

create constraint trigger provider_funding_ledger_guard
after insert or update on app.ledger_transactions
deferrable initially deferred
for each row execute function app_private.validate_provider_funding_posting();
create constraint trigger funding_settlements_ledger_guard
after insert on app.funding_settlements
deferrable initially deferred
for each row execute function app_private.validate_provider_funding_posting();
create constraint trigger funding_adjustments_ledger_guard
after insert on app.funding_adjustments
deferrable initially deferred
for each row execute function app_private.validate_provider_funding_posting();

create function app_private.reject_provider_funding_reversal()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.kind = 'reversal' and exists (
    select 1 from app.ledger_transactions as original
    where original.id = new.reverses_ledger_transaction_id
      and original.kind in (
        'provider_funding_credit',
        'provider_funding_refund',
        'provider_funding_dispute'
      )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'controlled_financial_reversal_required',
      message = 'Provider funding postings require their controlled compensation workflow.';
  end if;
  return new;
end
$function$;

create trigger provider_funding_reversal_guard
before insert or update on app.ledger_transactions
for each row execute function app_private.reject_provider_funding_reversal();

create function app.has_unresolved_funding_deficit(owner_id uuid, account_currency character(3))
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from app.funding_deficits as deficit
    where deficit.user_id = owner_id
      and deficit.currency = account_currency
      and deficit.status = 'unresolved'
  )
$function$;

create or replace function app.apply_wallet_balance(wallet_id uuid, delta_minor bigint)
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
     and (
       delta_minor > 0
       or not app.has_unresolved_funding_deficit(user_id, currency)
     )
  returning *;
$function$;

create function app.apply_provider_adjustment_wallet_balance(wallet_id uuid, delta_minor bigint)
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
     and delta_minor < 0
     and available_balance_minor + delta_minor >= 0
  returning *;
$function$;

revoke all on table app.funding_intents from public, creatordrop_app;
revoke all on table app.provider_events from public, creatordrop_app;
revoke all on table app.funding_settlements from public, creatordrop_app;
revoke all on table app.funding_adjustments from public, creatordrop_app;
revoke all on table app.funding_deficits from public, creatordrop_app;
revoke all on function app.has_unresolved_funding_deficit(uuid, character) from public;
revoke all on function app.apply_provider_adjustment_wallet_balance(uuid, bigint) from public;

grant select, insert, update on table app.funding_intents to creatordrop_app;
grant select, insert, update on table app.provider_events to creatordrop_app;
grant select, insert on table app.funding_settlements to creatordrop_app;
grant select, insert on table app.funding_adjustments to creatordrop_app;
grant select, insert on table app.funding_deficits to creatordrop_app;
grant execute on function app.has_unresolved_funding_deficit(uuid, character) to creatordrop_app;
grant execute on function app.apply_provider_adjustment_wallet_balance(uuid, bigint)
  to creatordrop_app;

comment on table app.funding_intents is
  'Actor-owned Stripe test-mode funding commands; browser state is never settlement authority.';
comment on table app.provider_events is
  'Signature-verified provider event identities and processing outcomes; raw payloads are not retained.';
comment on table app.funding_settlements is
  'Immutable one-to-one Stripe PaymentIntent to balanced wallet-credit linkage.';
comment on table app.funding_adjustments is
  'Immutable provider-driven refund/dispute compensating postings.';
comment on table app.funding_deficits is
  'Immutable unresolved external-payment shortfall separate from nonnegative wallet spendable balance.';

reset role;
