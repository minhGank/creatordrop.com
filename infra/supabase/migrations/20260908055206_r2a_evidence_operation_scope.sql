-- Storage SELECT also authorizes signing and listing unless the operation is
-- constrained. Evidence supports authenticated downloads only, never bearer URLs.
-- These policies belong to provider-owned storage.objects: run as migration runner.
alter policy entry_evidence_read on storage.objects
  using (bucket_id = 'entry-evidence'
    and storage.allow_only_operation('object.get_authenticated')
    and app_private.entry_storage_allowed(name, false));
alter policy entry_evidence_insert on storage.objects
  with check (bucket_id = 'entry-evidence'
    and storage.allow_only_operation('object.upload')
    and app_private.entry_storage_allowed(name, true));
