-- Phase 11 remediation: monotonic provider state, null-safe financial linkage,
-- exact deficit lineage, and scoped provider-compensation wallet recovery.

set role creatordrop_migrator;

alter table app.funding_intents
  drop constraint funding_intents_provider_binding_shape,
  add constraint funding_intents_provider_binding_shape check (
    (status = 'provider_pending' and provider_payment_intent_id is null)
    or status = 'reconciliation_required'
    or (
      status not in ('provider_pending', 'reconciliation_required')
      and provider_payment_intent_id is not null
    )
  );

do $migration_validation$
begin
  if exists (
    select 1
      from app.funding_settlements as settlement
      join app.funding_intents as intent on intent.id = settlement.funding_intent_id
      join app.provider_events as funding_event on funding_event.id = settlement.provider_event_id
     where funding_event.funding_intent_id is distinct from intent.id
        or funding_event.provider_object_id is distinct from settlement.provider_payment_intent_id
        or settlement.provider_payment_intent_id is distinct from intent.provider_payment_intent_id
        or settlement.currency is distinct from intent.currency
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'provider_funding_legacy_settlement_link_invalid',
      message = 'Existing provider funding settlement linkage must be repaired before migration.';
  end if;

  if exists (
    select 1
      from app.funding_adjustments as adjustment
      join app.funding_settlements as settlement on settlement.id = adjustment.funding_settlement_id
      join app.funding_intents as intent on intent.id = settlement.funding_intent_id
      join app.provider_events as funding_event on funding_event.id = adjustment.provider_event_id
     where adjustment.currency is distinct from settlement.currency
        or settlement.currency is distinct from intent.currency
        or funding_event.funding_intent_id is distinct from intent.id
        or funding_event.provider_object_id is distinct from adjustment.provider_adjustment_id
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'provider_funding_legacy_adjustment_link_invalid',
      message = 'Existing provider funding adjustment linkage must be repaired before migration.';
  end if;

  if exists (
    select 1
      from app.funding_adjustments as adjustment
      join app.funding_settlements as settlement on settlement.id = adjustment.funding_settlement_id
      join app.funding_intents as intent on intent.id = settlement.funding_intent_id
     where (
       adjustment.deficit_minor = 0
       and exists (
         select 1 from app.funding_deficits as deficit
          where deficit.funding_adjustment_id = adjustment.id
       )
     ) or (
       adjustment.deficit_minor > 0
       and not exists (
         select 1
           from app.funding_deficits as deficit
           join app.ledger_accounts as deficit_account
             on deficit_account.id = deficit.ledger_account_id
          where deficit.funding_adjustment_id = adjustment.id
            and deficit.user_id = intent.user_id
            and deficit.currency = adjustment.currency
            and deficit.amount_minor = adjustment.deficit_minor
            and deficit.status = 'unresolved'
            and deficit_account.account_type = 'user_funding_deficit'
            and deficit_account.owner_user_id = intent.user_id
            and deficit_account.currency = adjustment.currency
            and exists (
              select 1
                from app.ledger_entries as entry
               where entry.ledger_transaction_id = adjustment.ledger_transaction_id
                 and entry.ledger_account_id = deficit.ledger_account_id
                 and entry.currency = adjustment.currency
                 and entry.amount_minor = -adjustment.deficit_minor
            )
       )
     )
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'provider_funding_legacy_deficit_link_invalid',
      message = 'Existing provider funding deficit linkage must be repaired before migration.';
  end if;
end
$migration_validation$;

with adjustment_state as (
  select settlement.funding_intent_id,
         settlement.settled_amount_minor::numeric as settled_amount,
         coalesce(sum(adjustment.amount_minor::numeric), 0) as adjusted_amount,
         coalesce(bool_or(adjustment.adjustment_type = 'dispute'), false) as has_dispute
    from app.funding_settlements as settlement
    left join app.funding_adjustments as adjustment
      on adjustment.funding_settlement_id = settlement.id
   group by settlement.funding_intent_id, settlement.settled_amount_minor
), derived_state as (
  select funding_intent_id,
         case
           when adjusted_amount = 0 then 'settled'
           when adjusted_amount >= settled_amount then 'reversed'
           when has_dispute then 'disputed'
           else 'partially_reversed'
         end as status
    from adjustment_state
)
update app.funding_intents as intent
   set status = state.status,
       updated_at = clock_timestamp()
  from derived_state as state
 where intent.id = state.funding_intent_id
   and intent.status <> 'reconciliation_required'
   and intent.status is distinct from state.status;

create or replace function app_private.validate_provider_funding_posting()
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
    if not found then
      raise exception using errcode = '23514', constraint = 'provider_funding_settlement_link_invalid';
    end if;
    select * into funding_event from app.provider_events where id = settlement.provider_event_id;
    if not found then
      raise exception using errcode = '23514', constraint = 'provider_funding_settlement_link_invalid';
    end if;
    select count(*) into total_entries from app.ledger_entries
      where ledger_transaction_id = current_transaction.id;
    select count(*) into matched_entries
      from app.ledger_entries as entry
      join app.ledger_accounts as account on account.id = entry.ledger_account_id
      where entry.ledger_transaction_id = current_transaction.id
        and entry.currency = settlement.currency
        and account.currency = settlement.currency
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
    if current_transaction.status is distinct from 'posted'
      or current_transaction.actor_user_id is distinct from intent.user_id
      or current_transaction.currency is distinct from settlement.currency
      or current_transaction.business_reference_type is distinct from 'funding_settlement'
      or current_transaction.business_reference_id is distinct from settlement.id
      or settlement.provider is distinct from intent.provider
      or settlement.provider_payment_intent_id is distinct from intent.provider_payment_intent_id
      or settlement.settled_amount_minor is distinct from intent.requested_amount_minor
      or settlement.currency is distinct from intent.currency
      or funding_event.provider is distinct from settlement.provider
      or funding_event.funding_intent_id is distinct from intent.id
      or funding_event.event_type is distinct from 'payment_intent.succeeded'
      or funding_event.provider_object_id is distinct from settlement.provider_payment_intent_id
      or funding_event.status is distinct from 'processed'
      or funding_event.result_code is distinct from 'SETTLED'
      or intent.status not in (
        'settled', 'partially_reversed', 'reversed', 'disputed', 'reconciliation_required'
      )
      or total_entries is distinct from 2::bigint
      or matched_entries is distinct from 2::bigint then
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
    if not found then
      raise exception using errcode = '23514', constraint = 'provider_funding_adjustment_link_invalid';
    end if;
    select * into intent from app.funding_intents where id = settlement.funding_intent_id;
    if not found then
      raise exception using errcode = '23514', constraint = 'provider_funding_adjustment_link_invalid';
    end if;
    select * into funding_event from app.provider_events where id = adjustment.provider_event_id;
    if not found then
      raise exception using errcode = '23514', constraint = 'provider_funding_adjustment_link_invalid';
    end if;
    select count(*) into total_entries from app.ledger_entries
      where ledger_transaction_id = current_transaction.id;
    select count(*) into matched_entries
      from app.ledger_entries as entry
      join app.ledger_accounts as account on account.id = entry.ledger_account_id
      where entry.ledger_transaction_id = current_transaction.id
        and entry.currency = adjustment.currency
        and account.currency = adjustment.currency
        and (
          (
            account.account_type = 'provider_funding_clearing'
            and account.owner_user_id is null
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
    if current_transaction.status is distinct from 'posted'
      or current_transaction.actor_user_id is distinct from intent.user_id
      or current_transaction.currency is distinct from adjustment.currency
      or current_transaction.business_reference_type is distinct from 'funding_adjustment'
      or current_transaction.business_reference_id is distinct from adjustment.id
      or adjustment.provider is distinct from settlement.provider
      or adjustment.currency is distinct from settlement.currency
      or settlement.currency is distinct from intent.currency
      or (current_transaction.kind = 'provider_funding_refund')
        is distinct from (adjustment.adjustment_type = 'refund')
      or funding_event.provider is distinct from adjustment.provider
      or funding_event.funding_intent_id is distinct from intent.id
      or funding_event.provider_object_id is distinct from adjustment.provider_adjustment_id
      or funding_event.status is distinct from 'processed'
      or funding_event.result_code is distinct from 'ADJUSTMENT_RECORDED'
      or (
        adjustment.adjustment_type = 'refund'
        and funding_event.event_type not in ('refund.created', 'refund.updated')
      )
      or (
        adjustment.adjustment_type = 'dispute'
        and funding_event.event_type is distinct from 'charge.dispute.created'
      )
      or total_entries is distinct from (
        2 + case
          when adjustment.wallet_recovered_minor > 0 and adjustment.deficit_minor > 0 then 1
          else 0
        end
      )::bigint
      or matched_entries is distinct from total_entries then
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

create function app_private.validate_funding_deficit_linkage()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  adjustment app.funding_adjustments%rowtype;
  deficit_account app.ledger_accounts%rowtype;
  intent app.funding_intents%rowtype;
  settlement app.funding_settlements%rowtype;
begin
  select * into adjustment from app.funding_adjustments where id = new.funding_adjustment_id;
  if not found then
    raise exception using errcode = '23514', constraint = 'provider_funding_deficit_link_invalid';
  end if;
  select * into settlement from app.funding_settlements where id = adjustment.funding_settlement_id;
  if not found then
    raise exception using errcode = '23514', constraint = 'provider_funding_deficit_link_invalid';
  end if;
  select * into intent from app.funding_intents where id = settlement.funding_intent_id;
  if not found then
    raise exception using errcode = '23514', constraint = 'provider_funding_deficit_link_invalid';
  end if;
  select * into deficit_account from app.ledger_accounts where id = new.ledger_account_id;
  if not found then
    raise exception using errcode = '23514', constraint = 'provider_funding_deficit_link_invalid';
  end if;
  if adjustment.deficit_minor <= 0
    or new.user_id is distinct from intent.user_id
    or new.currency is distinct from adjustment.currency
    or adjustment.currency is distinct from settlement.currency
    or settlement.currency is distinct from intent.currency
    or new.amount_minor is distinct from adjustment.deficit_minor
    or new.status is distinct from 'unresolved'
    or deficit_account.account_type is distinct from 'user_funding_deficit'
    or deficit_account.owner_user_id is distinct from intent.user_id
    or deficit_account.currency is distinct from adjustment.currency
    or not exists (
      select 1 from app.ledger_entries as entry
       where entry.ledger_transaction_id = adjustment.ledger_transaction_id
         and entry.ledger_account_id = new.ledger_account_id
         and entry.currency = adjustment.currency
         and entry.amount_minor = -adjustment.deficit_minor
    ) then
    raise exception using errcode = '23514', constraint = 'provider_funding_deficit_link_invalid';
  end if;
  return new;
end
$function$;

create constraint trigger funding_deficits_adjustment_guard
after insert on app.funding_deficits
deferrable initially deferred
for each row execute function app_private.validate_funding_deficit_linkage();

revoke all on function app.apply_provider_adjustment_wallet_balance(uuid, bigint)
  from public, creatordrop_app;
drop function app.apply_provider_adjustment_wallet_balance(uuid, bigint);

create function app.apply_provider_adjustment_wallet_balance(
  target_wallet_id uuid,
  target_ledger_transaction_id uuid,
  target_funding_adjustment_id uuid,
  wallet_delta_minor bigint
)
returns setof app.wallets
language sql
security definer
set search_path = ''
as $function$
  update app.wallets as wallet
     set available_balance_minor = wallet.available_balance_minor + wallet_delta_minor,
         revision = wallet.revision + 1,
         updated_at = clock_timestamp()
   where wallet.id = target_wallet_id
     and wallet_delta_minor < 0
     and wallet.available_balance_minor + wallet_delta_minor >= 0
     and exists (
       select 1
         from app.ledger_transactions as ledger_transaction
         join app.ledger_entries as wallet_entry
           on wallet_entry.ledger_transaction_id = ledger_transaction.id
          and wallet_entry.ledger_account_id = wallet.ledger_account_id
        where ledger_transaction.id = target_ledger_transaction_id
          and ledger_transaction.status = 'pending'
          and ledger_transaction.kind in ('provider_funding_refund', 'provider_funding_dispute')
          and ledger_transaction.actor_user_id = wallet.user_id
          and ledger_transaction.currency = wallet.currency
          and ledger_transaction.business_reference_type = 'funding_adjustment'
          and ledger_transaction.business_reference_id = target_funding_adjustment_id
          and wallet_entry.currency = wallet.currency
          and wallet_entry.amount_minor = wallet_delta_minor
     )
  returning wallet.*;
$function$;

revoke all on function app.apply_provider_adjustment_wallet_balance(uuid, uuid, uuid, bigint)
  from public;
grant execute on function app.apply_provider_adjustment_wallet_balance(uuid, uuid, uuid, bigint)
  to creatordrop_app;

comment on function app.apply_provider_adjustment_wallet_balance(uuid, uuid, uuid, bigint) is
  'Applies only the exact pending wallet entry of a provider refund/dispute adjustment transaction.';

reset role;
