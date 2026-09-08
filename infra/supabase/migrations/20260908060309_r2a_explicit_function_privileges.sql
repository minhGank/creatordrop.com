-- Schema-scoped ALTER DEFAULT PRIVILEGES cannot subtract PostgreSQL's global
-- PUBLIC function EXECUTE default. Explicitly revoke it for every R2A function.
set role creatordrop_migrator;

revoke all on function
  app_private.entry_immutable_history(),
  app_private.entry_claim_transition_guard(),
  app_private.entry_evidence_guard(),
  app_private.entry_review_consistency(),
  app_private.entry_require_creator(uuid,uuid,text[]),
  app_private.entry_policy_dto(app.entry_policy_versions),
  app_private.entry_method_dto(app.entry_methods),
  app_private.entry_claim_dto(app.entry_claims),
  app_private.entry_public_policies(uuid),
  app_private.entry_verify_actor(uuid,text,text,text,bigint,bytea),
  app_private.entry_method_command(uuid,text,text,text,bigint,bytea),
  app_private.entry_claim_command(uuid,text,text,text,bigint,bytea),
  app_private.entry_evidence_command(uuid,text,text,text,bigint,bytea),
  app_private.entry_storage_allowed(text,boolean),
  app_private.entry_grant_consistency(),
  app_private.entry_method_identity_guard(),
  app.entry_method_command(uuid,text,text,text,bigint,bytea),
  app.entry_claim_command(uuid,text,text,text,bigint,bytea),
  app.entry_evidence_command(uuid,text,text,text,bigint,bytea),
  app.entry_public_policies(uuid)
from public;

-- Policy expressions already resolve their helper OID at creation. Storage needs
-- only its explicit helper EXECUTE grant, not permission to resolve arbitrary
-- names in app_private (which also contains historical functions).
revoke usage on schema app_private from authenticated;

reset role;
