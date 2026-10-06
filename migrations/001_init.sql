-- M1: the walking skeleton.
-- Only the tables M1 actually needs. Later milestones add their own numbered
-- migration; never edit an applied one.

CREATE TABLE mission (
  id            TEXT PRIMARY KEY,
  objective     TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  result_json   TEXT,
  error         TEXT
);

CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL REFERENCES mission(id),
  agent_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  input_json    TEXT NOT NULL,
  output_json   TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT
);

CREATE TABLE model_call (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id),
  provider_id   TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- Append-only activity log. Written in the same transaction as the state
-- change it describes, and published to the UI only after that commit.
CREATE TABLE run_event (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  mission_id    TEXT NOT NULL REFERENCES mission(id),
  task_id       TEXT,
  type          TEXT NOT NULL,
  message       TEXT NOT NULL,
  payload_json  TEXT,
  at            TEXT NOT NULL
);

CREATE INDEX idx_task_mission ON task(mission_id);
CREATE INDEX idx_model_call_task ON model_call(task_id);
CREATE INDEX idx_run_event_mission ON run_event(mission_id, seq);
CREATE INDEX idx_mission_created ON mission(created_at DESC);
