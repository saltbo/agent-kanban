-- Add device_id to machines for hardware fingerprint deduplication
ALTER TABLE machines ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_machines_owner_device ON machines(owner_id, device_id);
