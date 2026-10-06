-- Command Centre domain: projects as context boundaries, multi-task missions
-- with a real dependency graph, intentional memory, and permission-aware tool
-- calls. Append-only: never edit an applied migration.

CREATE TABLE project (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  brief        TEXT NOT NULL DEFAULT '',
  accent       TEXT NOT NULL DEFAULT 'blue',
  created_at   TEXT NOT NULL,
  archived_at  TEXT
);

-- Missions belong to a project; the project brief becomes agent context.
ALTER TABLE mission ADD COLUMN project_id TEXT REFERENCES project(id);
ALTER TABLE mission ADD COLUMN plan_json TEXT;

-- Tasks gain identity and ordering within the plan, plus dependency edges.
ALTER TABLE task ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE task ADD COLUMN instruction TEXT NOT NULL DEFAULT '';
ALTER TABLE task ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- Deliberately retained knowledge, scoped to a project, with provenance.
-- Nothing is written here automatically: the operator promotes a finding.
CREATE TABLE memory (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES project(id),
  content           TEXT NOT NULL,
  source_mission_id TEXT REFERENCES mission(id),
  created_at        TEXT NOT NULL,
  pinned            INTEGER NOT NULL DEFAULT 0
);

-- Every tool invocation, with the blast radius it declared.
CREATE TABLE tool_call (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  tool_id      TEXT NOT NULL,
  side_effect  TEXT NOT NULL,
  input_json   TEXT NOT NULL,
  output_json  TEXT,
  error        TEXT,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_mission_project ON mission(project_id);
CREATE INDEX idx_memory_project ON memory(project_id, created_at DESC);
CREATE INDEX idx_tool_call_task ON tool_call(task_id);

-- A default project so the system is usable from first launch without setup.
INSERT INTO project (id, name, brief, accent, created_at)
VALUES (
  'prj_general',
  'General',
  'Unfiled work. Create a project to give missions shared context.',
  'slate',
  datetime('now')
);

UPDATE mission SET project_id = 'prj_general' WHERE project_id IS NULL;
