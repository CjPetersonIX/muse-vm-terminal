DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE terminal_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE terminal_state (
  id INTEGER PRIMARY KEY,
  cwd TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
