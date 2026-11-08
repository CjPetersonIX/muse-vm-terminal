// Privileged host contracts for the VM Terminal.
//
// This file is the ONLY part of the Space allowed to touch the host: it
// runs on the Muse VM with host modules available.
// Action code imports only the contract descriptors (via
// `@space/privileged`) and calls `ctx.executePrivileged(...)`; the
// handlers below do the real work — spawning a login bash for each
// command and capturing live system facts.
//
// Execution model: each command runs in a fresh `bash -lc` process, the
// same way a one-shot SSH command would. The working directory is
// threaded through explicitly: the wrapper prints a marker line with the
// shell's final `pwd`, the handler strips it from the visible output and
// returns it as the session's next cwd. Interactive full-screen programs
// (vim, top in live mode, full-screen TUIs) cannot work over this
// request/response path; everything else a shell does, works.
//
// Environment sync: this shell must mirror the agent's own interactive
// shell on the same VM. Some tool directories on the agent shell's PATH
// are missing from the privileged runner's inherited PATH, so the
// terminal could answer "command not found" (exit 127) for a tool the
// agent itself runs fine. `shellEnv()` below rebuilds PATH from the
// canonical tool directories so both shells resolve the same commands.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const execFileAsync = promisify(execFile);

const MAX_STREAM_BYTES = 256 * 1024;
const CWD_MARKER = "__VMTERM_CWD__";

// ---------------------------------------------------------------------------
// Real interactive terminal (PTY)
//
// Each privileged call runs in a fresh host process, so the terminal's
// durable state cannot live in this module. It lives in a tmux server on
// the VM instead: a detached session named "vmterm" holding one real
// interactive login bash on a real PTY. tmux allocates the PTY, keeps the
// shell (and anything running in it — vim, top, installs)
// alive between calls and across page loads, and renders full-screen TUIs
// into its pane grid, which `capture-pane -e` reads back as ANSI text for
// the client to paint. The session runs as the same user, HOME, PATH and
// filesystem as the agent's own shell, so installs and files are shared
// both ways, and `tmux attach -t vmterm` in any shell on this VM joins
// the very same session the Space shows.
// ---------------------------------------------------------------------------

const TMUX_SESSION = "vmterm";
const TMUX_TARGET = "vmterm:"; // active pane of the session's window
const PTY_HISTORY_LINES = 400;

// NOTE: privileged contract schemas must be written inline inside
// definePrivilegedContracts (the generated contract module cannot see
// module-level constants), so the screen shape is repeated per contract
// below; this local copy types the handlers' return values.
const ptyScreen = z.object({
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

export const privileged = definePrivilegedContracts({
  runCommand: {
    request: z.object({
      command: z.string().min(1).max(4000),
      cwd: z.string().min(1).max(1000),
      timeoutMs: z.number().int().min(1000).max(30000).default(20000),
    }),
    response: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().nullable(),
      timedOut: z.boolean(),
      truncated: z.boolean(),
      durationMs: z.number(),
      cwd: z.string(),
    }),
    capabilities: ["process.exec", "filesystem.read", "filesystem.write"],
    timeoutMs: 45000,
  },
  getSystemInfo: {
    request: z.object({}),
    response: z.object({
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
    }),
    capabilities: ["system.health", "filesystem.read"],
    timeoutMs: 30000,
  },
  ptyCapture: {
    request: z.object({
      cols: z.number().int().min(20).max(300).default(100),
      rows: z.number().int().min(5).max(80).default(30),
    }),
    response: z.object({
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
    }),
    capabilities: ["process.exec", "filesystem.read", "filesystem.write"],
    timeoutMs: 20000,
  },
  ptySend: {
    request: z.object({
      literal: z.string().max(8000).optional(),
      keys: z
        .array(
          z.enum([
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
          ]),
        )
        .max(32)
        .optional(),
    }),
    response: z.object({
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
    }),
    capabilities: ["process.exec", "filesystem.read", "filesystem.write"],
    timeoutMs: 20000,
  },
  ptyResize: {
    request: z.object({
      cols: z.number().int().min(20).max(300),
      rows: z.number().int().min(5).max(80),
    }),
    response: z.object({
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
    }),
    capabilities: ["process.exec", "filesystem.read", "filesystem.write"],
    timeoutMs: 20000,
  },
  ptyRestart: {
    request: z.object({
      cols: z.number().int().min(20).max(300).default(100),
      rows: z.number().int().min(5).max(80).default(30),
    }),
    response: z.object({
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
    }),
    capabilities: ["process.exec", "filesystem.read", "filesystem.write"],
    timeoutMs: 20000,
  },
  ptyClear: {
    request: z.object({}),
    response: z.object({
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
    }),
    capabilities: ["process.exec", "filesystem.read", "filesystem.write"],
    timeoutMs: 20000,
  },
});

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return [d > 0 ? `${d}d` : "", `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

/**
 * The environment every shell this Space spawns runs with: the runner's
 * own environment, but with PATH rebuilt so it matches the agent's
 * interactive shell on this VM — user tool dirs and the platform tool
 * dirs first, in the agent shell's order, then whatever the runner
 * inherited, duplicates removed.
 * Directories that don't exist on this host are skipped.
 */
function shellEnv(): NodeJS.ProcessEnv {
  const home = os.homedir() || "/home/user";
  const toolDirs = [
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    "/opt/hatch/bin",
    "/opt/hatch-image/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].filter((d) => existsSync(d));
  const inherited = (process.env.PATH ?? "").split(":").filter(Boolean);
  const path = [...new Set([...toolDirs, ...inherited])].join(":");
  return { ...process.env, PATH: path, TERM: "xterm" };
}

async function runQuiet(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 6000,
      env: shellEnv(),
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function resolveCwd(requested: string): Promise<string> {
  try {
    const st = await stat(requested);
    if (st.isDirectory()) return requested;
  } catch {
    // fall through to home
  }
  return os.homedir() || "/home/user";
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    env: shellEnv(),
    timeout: 8000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function tmuxOk(args: string[]): Promise<boolean> {
  try {
    await tmux(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure the tmux session exists with a live pane; (re)create it as a
 * real interactive login bash when it doesn't. Returns true when this
 * call created a fresh session.
 */
async function ensurePty(cols: number, rows: number): Promise<boolean> {
  if (await tmuxOk(["has-session", "-t", TMUX_SESSION])) {
    const dead = await tmux([
      "display-message",
      "-t",
      TMUX_TARGET,
      "-p",
      "#{pane_dead}",
    ]).catch(() => "1");
    if (dead.trim() !== "1") return false;
    await tmuxOk(["kill-session", "-t", TMUX_SESSION]);
  }
  const home = os.homedir() || "/home/user";
  const path = shellEnv().PATH ?? "";
  try {
    await tmux([
      "new-session",
      "-d",
      "-s",
      TMUX_SESSION,
      "-x",
      String(cols),
      "-y",
      String(rows),
      "-c",
      home,
      "-e",
      `PATH=${path}`,
      "-e",
      "TERM=xterm-256color",
      "bash -l -i",
    ]);
  } catch {
    // Race: a concurrent call (the page polls from more than one
    // viewport at cold start) created the session between our
    // has-session check and new-session, which fails with "duplicate
    // session". That is not an error — the session we wanted exists.
    if (await tmuxOk(["has-session", "-t", TMUX_SESSION])) return false;
    throw new Error("tmux session could not be created");
  }
  await tmuxOk(["set-option", "-t", TMUX_SESSION, "history-limit", "20000"]);
  await tmuxOk(["set-option", "-t", TMUX_SESSION, "window-size", "manual"]);
  // Let the login shell reach its first prompt before the first capture.
  await sleep(300);
  return true;
}

type PtyScreenOut = z.infer<typeof ptyScreen>;

async function capturePty(restarted: boolean): Promise<PtyScreenOut> {
  const capturedAt = new Date().toISOString();
  try {
    const metaRaw = await tmux([
      "display-message",
      "-t",
      TMUX_TARGET,
      "-p",
      // NB: "|" separators — tmux rewrites literal tabs in format
      // output to "_", which corrupts tab-split parsing.
      "#{pane_current_path}|#{pane_current_command}|#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_flag}",
    ]);
    const parts = metaRaw.replace(/\n$/, "").split("|");
    const ansi = await tmux([
      "capture-pane",
      "-t",
      TMUX_TARGET,
      "-p",
      "-e",
      "-S",
      `-${PTY_HISTORY_LINES}`,
    ]);
    const num = (v: string | undefined, fallback: number): number => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      alive: true,
      session: TMUX_SESSION,
      cwd: parts[0] || os.homedir() || "/home/user",
      currentCommand: parts[1] || "bash",
      cursorX: num(parts[2], 0),
      cursorY: num(parts[3], 0),
      cols: num(parts[4], 80),
      rows: num(parts[5], 24),
      alternate: (parts[6] ?? "0") === "1",
      cursorVisible: (parts[7] ?? "1") === "1",
      ansi,
      capturedAt,
      restarted,
    };
  } catch {
    return {
      alive: false,
      session: TMUX_SESSION,
      cwd: os.homedir() || "/home/user",
      currentCommand: "",
      cols: 80,
      rows: 24,
      cursorX: 0,
      cursorY: 0,
      cursorVisible: false,
      alternate: false,
      ansi: "",
      capturedAt,
      restarted,
    };
  }
}

interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    // The user's command rides in as $1 and is eval'd by the login shell,
    // so quoting, pipes, redirects, `cd`, env assignments and multi-line
    // input all behave as typed. After it finishes we print the final
    // working directory behind a marker, then exit with the command's
    // own status. If the command itself calls `exit`, the shell exits
    // before the marker — the handler then keeps the requested cwd.
    const script = [
      `__vmterm_cmd="$1"`,
      `eval "$__vmterm_cmd"`,
      `__vmterm_rc=$?`,
      `printf '\\n${CWD_MARKER}%s' "$(pwd)"`,
      `exit $__vmterm_rc`,
    ].join("\n");

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn("bash", ["-lc", script, "vm-terminal", command], {
      cwd,
      env: shellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const killGroup = (signal: NodeJS.Signals) => {
      // Kill the whole process group: a timed-out `sleep 30` must not
      // hold the output pipes (and this promise) open after bash dies.
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        if (!settled) {
          settled = true;
          resolve({ stdout, stderr, exitCode: null, timedOut, truncated });
        }
      }, 800);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_STREAM_BYTES) {
        truncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_STREAM_BYTES) {
        stdout = stdout.slice(0, MAX_STREAM_BYTES);
        truncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= MAX_STREAM_BYTES) {
        truncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_STREAM_BYTES) {
        stderr = stderr.slice(0, MAX_STREAM_BYTES);
        truncated = true;
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + String(err),
        exitCode: null,
        timedOut,
        truncated,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut, truncated });
    });
  });
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async runCommand(args) {
    const cwd = await resolveCwd(args.cwd);
    const started = Date.now();
    const outcome = await runShell(args.command, cwd, args.timeoutMs);
    const durationMs = Date.now() - started;

    // Strip the trailing cwd marker (and the newline we printed before
    // it) from the visible output; the final cwd rides back separately.
    let stdout = outcome.stdout;
    let finalCwd = cwd;
    const markerAt = stdout.lastIndexOf(`\n${CWD_MARKER}`);
    if (markerAt !== -1) {
      const reported = stdout.slice(markerAt + CWD_MARKER.length + 1).trim();
      stdout = stdout.slice(0, markerAt);
      if (reported.startsWith("/")) {
        finalCwd = await resolveCwd(reported);
      }
    } else if (stdout.includes(CWD_MARKER)) {
      // Command produced no trailing newline of its own before the
      // marker newline… the marker still starts a fresh segment.
      const at = stdout.lastIndexOf(CWD_MARKER);
      const reported = stdout.slice(at + CWD_MARKER.length).trim();
      stdout = stdout.slice(0, Math.max(0, at - 1));
      if (reported.startsWith("/")) {
        finalCwd = await resolveCwd(reported);
      }
    }

    return {
      stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      truncated: outcome.truncated,
      durationMs,
      cwd: finalCwd,
    };
  },

  async getSystemInfo() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const ramPct = total > 0 ? Math.round((used / total) * 100) : 0;

    let osName = `${os.type()} ${os.release()}`;
    try {
      const release = await readFile("/etc/os-release", "utf8");
      const pretty = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
      if (pretty) osName = pretty;
    } catch {
      // keep the fallback
    }

    let diskTotal = "";
    let diskUsed = "";
    let diskFree = "";
    let diskPct = 0;
    const dfOut = await runQuiet("df", ["-hP", "/"]);
    const dfLine = dfOut.split("\n")[1];
    if (dfLine) {
      const parts = dfLine.trim().split(/\s+/);
      if (parts.length >= 6) {
        diskTotal = parts[1] ?? "";
        diskUsed = parts[2] ?? "";
        diskFree = parts[3] ?? "";
        diskPct = Number.parseInt((parts[4] ?? "0").replace("%", ""), 10) || 0;
      }
    }

    const versions: string[] = [];
    for (const [name, cmd] of [
      ["bun", "bun"],
      ["node", "node"],
      ["python3", "python3"],
      ["git", "git"],
    ] as const) {
      const out = await runQuiet(cmd, ["--version"]);
      if (out) {
        versions.push(
          `${name} ${out.replace(/^git version /, "")}`,
        );
      }
    }

    // os.userInfo() reports "unknown" in the privileged runner's
    // context; the shell's own whoami is the truthful source.
    const whoami = await runQuiet("whoami", []);
    const username =
      whoami && whoami !== "unknown" ? whoami : os.userInfo().username;

    const cpus = os.cpus();
    const load = os.loadavg();
    const capturedAt = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(new Date());

    return {
      hostname: os.hostname(),
      username,
      osName,
      kernel: os.release(),
      arch: os.arch(),
      cpuText: cpus[0]?.model ?? "unknown CPU",
      cores: cpus.length,
      ramTotal: gib(total),
      ramUsed: gib(used),
      ramFree: gib(free),
      ramPct,
      diskTotal,
      diskUsed,
      diskFree,
      diskPct,
      loadText: `1m ${load[0]?.toFixed(2) ?? "—"} · 5m ${load[1]?.toFixed(2) ?? "—"} · 15m ${load[2]?.toFixed(2) ?? "—"}`,
      uptimeText: formatUptime(os.uptime()),
      homeDir: os.homedir() || "/home/user",
      versions: versions.join(" · "),
      capturedAt,
    };
  },

  async ptyCapture(args) {
    const created = await ensurePty(args.cols, args.rows);
    return capturePty(created);
  },

  async ptySend(args) {
    const created = await ensurePty(100, 30);
    // send-keys goes through tmuxOk: if the pane died in the same beat
    // (a concurrent restart, an exited shell), the caller still gets
    // the current screen back instead of a thrown host error.
    if (args.literal) {
      await tmuxOk(["send-keys", "-t", TMUX_TARGET, "-l", "--", args.literal]);
    }
    for (const key of args.keys ?? []) {
      await tmuxOk(["send-keys", "-t", TMUX_TARGET, key]);
    }
    // Give the shell / TUI a beat to react before painting the result;
    // the client's poll keeps painting after that.
    await sleep(180);
    return capturePty(created);
  },

  async ptyResize(args) {
    const created = await ensurePty(args.cols, args.rows);
    if (!created) {
      await tmuxOk(["set-option", "-t", TMUX_SESSION, "window-size", "manual"]);
      await tmuxOk([
        "resize-window",
        "-t",
        TMUX_SESSION,
        "-x",
        String(args.cols),
        "-y",
        String(args.rows),
      ]);
      await sleep(80);
    }
    return capturePty(created);
  },

  async ptyRestart(args) {
    await tmuxOk(["kill-session", "-t", TMUX_SESSION]);
    await ensurePty(args.cols, args.rows);
    return capturePty(true);
  },

  async ptyClear() {
    const created = await ensurePty(100, 30);
    if (!created) {
      await tmuxOk(["send-keys", "-t", TMUX_TARGET, "C-l"]);
      await tmuxOk(["clear-history", "-t", TMUX_TARGET]);
      await sleep(80);
    }
    return capturePty(created);
  },
});
