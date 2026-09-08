-- R2A reviewer separation: a claimant cannot decide their own entry claim.

set role creatordrop_migrator;

create function app_private.enforce_entry_review_claimant_separation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from app.entry_claims as claim
    where claim.id = new.claim_id
      and claim.user_id = new.reviewer_user_id
  ) then
    raise exception using
      errcode = 'P2002',
      constraint = 'entry_review_claimant_separation',
      message = 'A claimant cannot review their own entry claim.';
  end if;

  return new;
end
$function$;

create trigger entry_review_claimant_separation
before insert on app.entry_claim_reviews
for each row
execute function app_private.enforce_entry_review_claimant_separation();

create or replace function app_private.entry_review_consistency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target uuid;
  claim app.entry_claims%rowtype;
  review app.entry_claim_reviews%rowtype;
  policy app.entry_policy_versions%rowtype;
begin
  if tg_table_name = 'entry_claims' then
    target := new.id;
  else
    target := new.claim_id;
  end if;

  select * into claim from app.entry_claims where id = target;
  select * into review from app.entry_claim_reviews where claim_id = claim.id;

  if (claim.status = 'pending' and review.claim_id is not null)
    or (claim.status <> 'pending' and (review.claim_id is null or review.decision <> claim.status))
    or (review.claim_id is not null and review.reviewer_user_id = claim.user_id)
  then
    raise exception using errcode = '23514', constraint = 'entry_review_state_mismatch';
  end if;

  if claim.status = 'approved' then
    select * into policy from app.entry_policy_versions where id = claim.policy_id;
    if not exists (
      select 1
      from app.opening_entitlement_grants as grant_record
      where grant_record.id = review.grant_id
        and grant_record.user_id = claim.user_id
        and grant_record.creator_id = claim.creator_id
        and grant_record.box_id = claim.box_id
        and grant_record.quantity_granted = policy.openings_granted
        and grant_record.source_type = 'entry_claim'
        and grant_record.source_identity = 'entry_claim:' || claim.id::text
        and grant_record.granted_by_user_id = review.reviewer_user_id
    ) then
      raise exception using errcode = '23514', constraint = 'entry_approval_grant_mismatch';
    end if;
  end if;

  return null;
end
$function$;

revoke all on function app_private.enforce_entry_review_claimant_separation() from public;

reset role;
