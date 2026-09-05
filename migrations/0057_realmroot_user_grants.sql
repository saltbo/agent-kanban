-- Replace the browser-bound grant with one delegated authorization per user
-- and tenant. Browser logout must not discard authorization for assigned work.
CREATE TABLE realmroot_user_grants (
  tenant_id TEXT NOT NULL REFERENCES realmroot_tenants(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_nonce TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_nonce TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  refresh_lease TEXT,
  refresh_lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, subject_id)
);

INSERT INTO realmroot_user_grants
  (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
   access_token_ciphertext, access_token_nonce, access_token_expires_at, created_at, updated_at)
SELECT tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
       access_token_ciphertext, access_token_nonce, access_token_expires_at, grant_created_at, grant_updated_at
FROM (
  SELECT s.tenant_id, s.subject_id, g.*,
         g.created_at AS grant_created_at, g.updated_at AS grant_updated_at,
         ROW_NUMBER() OVER (PARTITION BY s.tenant_id, s.subject_id ORDER BY s.created_at DESC, s.id DESC) AS position
  FROM realmroot_web_session_grants g JOIN realmroot_web_sessions s ON s.id = g.session_id
) WHERE position = 1;

DROP TABLE realmroot_web_session_grants;
