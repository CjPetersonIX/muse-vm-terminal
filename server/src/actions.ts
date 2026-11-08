// Actions for the VM Terminal.
//
// The terminal itself lives behind privileged host contracts (see
// `server/src/privileged.ts`): `runCommand` executes a real login-bash
// command on Muse's VM, `getSystemInfo` captures live host facts.
// These actions are the durable layer on top — they persist every
// executed command to `terminal_history` (the scrollback) and the
// session's working directory to `terminal_state`, so the terminal
// survives reloads and follows the user across devices.

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

const systemInfoOut = z.object({
  hostname: z.string(),
  username: z.string(),
  osName: z.string(),
  kernel: z.string(),
  arch: z.string(),
  cpuText: z.string(),
  cores: z.number(),
  ramTotal: z.string(),
  ramUsed: z.string(),
  ramFree: z.string(),
  ramPct: z.number(),
  diskTotal: z.string(),
  diskUsed: z.string(),
  diskFree: z.string(),
  diskPct: z.number(),
  loadText: z.string(),
  uptimeText: z.string(),
  homeDir: z.string(),
  versions: z.string(),
  capturedAt: z.string(),
});

const historyEntryOut = z.object({
  id: z.number(),
  command: z.string(),
  cwd: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number(),
  createdAt: z.string(),
});

type HistoryRow = typeof schema.terminalHistory.$inferSelect;

function toEntryOut(r: HistoryRow): z.infer<typeof historyEntryOut> {
  return {
    id: r.id,
    command: r.command,
    cwd: r.cwd,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    timedOut: r.timedOut === 1,
    truncated: r.truncated === 1,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
  };
}

const sessionResponse = z.object({
  system: systemInfoOut,
  cwd: z.string(),
  history: z.array(historyEntryOut),
});

const execResponse = z.object({
  entry: historyEntryOut,
  cwd: z.string(),
});

const clearResponse = z.object({ cleared: z.literal(true) });

const termKey = z.enum([
  "Enter",
  "Tab",
  "BSpace",
  "Escape",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PPage",
  "NPage",
  "DC",
  "Space",
  "C-a",
  "C-c",
  "C-d",
  "C-e",
  "C-k",
  "C-l",
  "C-r",
  "C-t",
  "C-u",
  "C-w",
  "C-z",
]);

const screenOut = z.object({
  alive: z.boolean(),
  session: z.string(),
  cwd: z.string(),
  currentCommand: z.string(),
  cols: z.number(),
  rows: z.number(),
  cursorX: z.number(),
  cursorY: z.number(),
  cursorVisible: z.boolean(),
  alternate: z.boolean(),
  ansi: z.string(),
  capturedAt: z.string(),
  restarted: z.boolean(),
});

interface RanEntry {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  nextCwd: string;
}

export const Actions = {
  getSession: defineAction({
    description:
      "Returns the VM Terminal session: live system facts captured from Muse's VM right now (hostname, user, OS, uptime, load, memory, disk, runtimes), the session's current working directory, and the persisted command history (scrollback), oldest first.",
    request: z.object({}),
    response: sessionResponse,
    privileged: [privileged.getSystemInfo],
    async handler(ctx): Promise<z.infer<typeof sessionResponse>> {
      const system = await ctx.executePrivileged(privileged.getSystemInfo, {});
      const db = ctx.db<typeof schema>();
      const [stateRows, historyRows] = await Promise.all([
        db
          .select()
          .from(schema.terminalState)
          .where(eq(schema.terminalState.id, 1))
          .limit(1),
        db
          .select()
          .from(schema.terminalHistory)
          .orderBy(desc(schema.terminalHistory.id))
          .limit(200),
      ]);
      return {
        system,
        cwd: stateRows[0]?.cwd ?? system.homeDir,
        history: historyRows.reverse().map(toEntryOut),
      };
    },
  }),

  exec: defineAction({
    description:
      "Runs one command in a login bash on Muse's VM from the session's working directory, captures stdout/stderr/exit code, persists the exchange to terminal history, updates the session cwd (so cd persists), and returns the recorded entry.",
    request: z.object({
      command: z.string().min(1).max(4000),
      cwd: z.string().min(1).max(1000),
      timeoutMs: z.number().int().min(1000).max(30000).optional(),
    }),
    response: execResponse,
    privileged: [privileged.runCommand],
    async handler(ctx, args): Promise<z.infer<typeof execResponse>> {
      let ran: RanEntry;
      try {
        const r = await ctx.executePrivileged(privileged.runCommand, {
          command: args.command,
          cwd: args.cwd,
          timeoutMs: args.timeoutMs ?? 20000,
        });
        ran = {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          truncated: r.truncated,
          durationMs: r.durationMs,
          nextCwd: r.cwd,
        };
      } catch (err) {
        // The host call itself failed (not the command): record exactly
        // that in the scrollback instead of swallowing it.
        ran = {
          stdout: "",
          stderr: `terminal host error: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: null,
          timedOut: false,
          truncated: false,
          durationMs: 0,
          nextCwd: args.cwd,
        };
      }

      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.terminalHistory)
        .values({
          command: args.command,
          cwd: args.cwd,
          stdout: ran.stdout,
          stderr: ran.stderr,
          exitCode: ran.exitCode,
          timedOut: ran.timedOut ? 1 : 0,
          truncated: ran.truncated ? 1 : 0,
          durationMs: ran.durationMs,
        })
        .returning({ id: schema.terminalHistory.id });
      const newId = inserted[0]?.id ?? 0;
      const createdAt = new Date();

      await db
        .insert(schema.terminalState)
        .values({ id: 1, cwd: ran.nextCwd, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.terminalState.id,
          set: { cwd: ran.nextCwd, updatedAt: new Date() },
        });

      ctx.invalidateQueries();
      return {
        entry: {
          id: newId,
          command: args.command,
          cwd: args.cwd,
          stdout: ran.stdout,
          stderr: ran.stderr,
          exitCode: ran.exitCode,
          timedOut: ran.timedOut,
          truncated: ran.truncated,
          durationMs: ran.durationMs,
          createdAt: createdAt.toISOString(),
        },
        cwd: ran.nextCwd,
      };
    },
  }),

  getScreen: defineAction({
    description:
      "Returns the current screen of the VM's real interactive terminal: a persistent tmux session (a real PTY running an interactive login bash on Muse's VM, shared with the agent's own shell environment). The screen text carries ANSI styling and includes scrollback; interactive programs (vim, top, htop) render here and keep running between calls.",
    request: z.object({
      cols: z.number().int().min(20).max(300).optional(),
      rows: z.number().int().min(5).max(80).optional(),
    }),
    response: screenOut,
    privileged: [privileged.ptyCapture],
    async handler(ctx, args): Promise<z.infer<typeof screenOut>> {
      return ctx.executePrivileged(privileged.ptyCapture, {
        cols: args.cols ?? 100,
        rows: args.rows ?? 30,
      });
    },
  }),

  sendTerminal: defineAction({
    description:
      "Sends input to the VM's real interactive terminal session: literal text typed as-is and/or named special keys (Enter, Tab, Ctrl-C, arrows, …), then returns the updated screen. This is how interactive CLIs are driven — typing a program name plus Enter opens its real TUI in the session.",
    request: z.object({
      literal: z.string().max(8000).optional(),
      keys: z.array(termKey).max(32).optional(),
    }),
    response: screenOut,
    privileged: [privileged.ptySend],
    async handler(ctx, args): Promise<z.infer<typeof screenOut>> {
      return ctx.executePrivileged(privileged.ptySend, args);
    },
  }),

  resizeTerminal: defineAction({
    description:
      "Resizes the interactive terminal session's window to the given character columns and rows so TUIs lay out for the viewer's screen, then returns the updated screen.",
    request: z.object({
      cols: z.number().int().min(20).max(300),
      rows: z.number().int().min(5).max(80),
    }),
    response: screenOut,
    privileged: [privileged.ptyResize],
    async handler(ctx, args): Promise<z.infer<typeof screenOut>> {
      return ctx.executePrivileged(privileged.ptyResize, args);
    },
  }),

  restartTerminal: defineAction({
    description:
      "Kills and recreates the interactive terminal session with a fresh login bash (anything running in it ends), then returns the new session's screen.",
    request: z.object({
      cols: z.number().int().min(20).max(300).optional(),
      rows: z.number().int().min(5).max(80).optional(),
    }),
    response: screenOut,
    privileged: [privileged.ptyRestart],
    async handler(ctx, args): Promise<z.infer<typeof screenOut>> {
      return ctx.executePrivileged(privileged.ptyRestart, {
        cols: args.cols ?? 100,
        rows: args.rows ?? 30,
      });
    },
  }),

  clearTerminal: defineAction({
    description:
      "Clears the interactive terminal's screen and its tmux scrollback history, then returns the updated screen.",
    request: z.object({}),
    response: screenOut,
    privileged: [privileged.ptyClear],
    async handler(ctx): Promise<z.infer<typeof screenOut>> {
      return ctx.executePrivileged(privileged.ptyClear, {});
    },
  }),

  clearHistory: defineAction({
    description:
      "Clears the persisted terminal history (the scrollback) for this Space. The session's working directory is kept.",
    request: z.object({}),
    response: clearResponse,
    async handler(ctx): Promise<z.infer<typeof clearResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.terminalHistory);
      ctx.invalidateQueries();
      return { cleared: true as const };
    },
  }),
} satisfies ActionsModule;
