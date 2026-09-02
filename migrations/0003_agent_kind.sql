ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker' CHECK(kind IN ('worker', 'leader'));
