-- A machine is either a local computer (the daemon/ama-runner registers a
-- self_hosted environment) or a cloud sandbox (a cloud AMA environment, no
-- device, no daemon). Existing rows are local machines.
ALTER TABLE machines ADD COLUMN hosting TEXT NOT NULL DEFAULT 'local' CHECK(hosting IN ('local', 'cloud'));
