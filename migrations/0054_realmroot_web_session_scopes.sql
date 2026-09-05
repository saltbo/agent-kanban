ALTER TABLE realmroot_web_sessions
ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["board:read","board:write","repository:read","repository:write","agent:read","agent:write","machine:read","machine:write","task:read","task:write"]';
