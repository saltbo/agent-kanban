-- One-way rename of the active Agency integration state. Historical v1 runtime
-- tables remain inert and are not read by the v2 application.
ALTER TABLE ama_owner_integrations RENAME TO agency_owner_integrations;
ALTER TABLE agency_owner_integrations RENAME COLUMN ama_project_id TO agency_project_id;
ALTER TABLE ama_resource_initializations RENAME TO agency_resource_initializations;
DROP INDEX idx_ama_resource_initializations_expiry;
CREATE INDEX idx_agency_resource_initializations_expiry ON agency_resource_initializations(expires_at);

UPDATE tasks
SET metadata = replace(
  replace(
    replace(
      replace(
        replace(
          replace(
            replace(metadata, '"AMA_', '"ENBOR_'),
            '"ama://', '"enbor://'
          ),
          '"ama.dev/', '"enbor.dev/'
        ),
        '"runtime":"ama"', '"runtime":"enbor"'
      ),
      '"ama@', '"enbor@'
    ),
    '"origin":"https://ama.tftt.cc"', '"origin":"https://enbor.realmroot.dev"'
  ),
  '/.ama/', '/.enbor/'
)
WHERE instr(lower(metadata), 'ama') > 0;

UPDATE tasks
SET metadata = json_remove(
  json_set(
    metadata,
    '$.annotations."enbor.sessionId"',
    json_extract(metadata, '$.annotations."ama.sessionId"')
  ),
  '$.annotations."ama.sessionId"'
)
WHERE json_type(metadata, '$.annotations."ama.sessionId"') IS NOT NULL;

UPDATE tasks
SET metadata = json_remove(
  json_set(
    metadata,
    '$.annotations."enbor.dispatch.result"',
    json_extract(metadata, '$.annotations."ama.dispatch.result"')
  ),
  '$.annotations."ama.dispatch.result"'
)
WHERE json_type(metadata, '$.annotations."ama.dispatch.result"') IS NOT NULL;
