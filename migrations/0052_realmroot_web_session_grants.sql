-- AK stores only its own browser grant. Downstream AMA authority is minted on
-- demand through Realmroot token exchange and is never persisted by AK. The
-- obsolete v1 grant table and its rows remain untouched for the separate v1 to
-- v2 upgrade deliverable.

CREATE TABLE realmroot_web_session_grants (
  session_id TEXT PRIMARY KEY REFERENCES realmroot_web_sessions(id) ON DELETE CASCADE,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_nonce TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_nonce TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
