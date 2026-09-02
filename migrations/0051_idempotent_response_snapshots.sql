ALTER TABLE resource_idempotency_records ADD COLUMN response_status INTEGER NOT NULL DEFAULT 201;
ALTER TABLE resource_idempotency_records ADD COLUMN response_body TEXT NOT NULL DEFAULT '{}';
ALTER TABLE resource_idempotency_records ADD COLUMN response_content_type TEXT NOT NULL DEFAULT 'application/json; charset=UTF-8';
ALTER TABLE resource_idempotency_records ADD COLUMN response_location TEXT NOT NULL DEFAULT '';
ALTER TABLE resource_idempotency_records ADD COLUMN response_etag TEXT NOT NULL DEFAULT '""';

-- Pre-snapshot rows cannot reproduce their original HTTP response safely.
DELETE FROM resource_idempotency_records;
