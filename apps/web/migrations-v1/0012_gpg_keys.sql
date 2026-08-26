-- GPG root key per owner — trust anchor for agent subkey signing.
CREATE TABLE gpg_keys (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  armored_private_key TEXT NOT NULL,
  armored_public_key  TEXT NOT NULL,
  fingerprint         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (owner_id)
);
