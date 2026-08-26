-- Better Auth tables are retained as migration source-of-record data. They are
-- not used by the Realmroot-only runtime and must not be dropped by this
-- contract cleanup.

DROP TABLE IF EXISTS gpg_keys;
ALTER TABLE agents DROP COLUMN gpg_subkey_id;
DROP TABLE IF EXISTS realmroot_identity_mappings;

PRAGMA foreign_key_check;
