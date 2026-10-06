-- Operator preferences: which model to use, and how much effort to spend.
--
-- Preferences are captured onto the mission at submit time rather than read
-- live during execution, so a mission's record always says what it actually
-- ran on — changing the default later never rewrites history.

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE mission ADD COLUMN model_pref TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE mission ADD COLUMN effort TEXT NOT NULL DEFAULT 'balanced';

INSERT INTO setting (key, value, updated_at) VALUES
  ('model',  'auto',     datetime('now')),
  ('effort', 'balanced', datetime('now'));
