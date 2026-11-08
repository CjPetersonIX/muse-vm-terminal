// Drizzle schema for this space: terminal history and session state.
//
// terminal_history holds one row per executed command (the scrollback,
// persisted server-side so it survives reloads and is identical on every
// device). terminal_state is a single row (id = 1) carrying the session's
// current working directory, so `cd` persists across commands even though
// each command runs in a fresh shell process.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const terminalHistory = sqliteTable("terminal_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  command: text("command").notNull(),
  cwd: text("cwd").notNull(),
  stdout: text("stdout").notNull().default(""),
  stderr: text("stderr").notNull().default(""),
  exitCode: integer("exit_code"),
  timedOut: integer("timed_out").notNull().default(0),
  truncated: integer("truncated").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const terminalState = sqliteTable("terminal_state", {
  id: integer("id").primaryKey(),
  cwd: text("cwd").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
