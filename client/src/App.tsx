import {
useCallback,
useEffect,
useMemo,
useRef,
useState,
type KeyboardEvent,
type PointerEvent as ReactPointerEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiRequest, type ApiResponse } from "./api";
import { extractTerminalLinks, renderAnsiScreen } from "./ansi";

type Session = ApiResponse<typeof api, "getSession">;
type Screen = ApiResponse<typeof api, "getScreen">;
type SendArgs = ApiRequest<typeof api, "sendTerminal">;
type TermKey = NonNullable<SendArgs["keys"]>[number];

const QUICK_COMMANDS = [
  "pwd",
  "ls -la",
  "df -h",
  "free -h",
  "uptime",
  "whoami",
  "uname -a",
  "ps aux --sort=-%cpu | head -15",
  "cd ~/workspace",
  "ls ~",
  "which vim top git",
  "git --version",
  "tmux ls",
];

// Terminal zoom levels. 1 = the original 12px font; the default is 0.6
// (60% Mobile-first default), and the pane's
// − / + buttons step through these.
const ZOOM_LEVELS = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const DEFAULT_ZOOM = 0.6;

// ---- skins ---------------------------------------------------------------
// Five skins replace the old Dark/Light toggle. Dark Liquid Glass is
// the default and the original look; Light Liquid Glass is the original
// light look. The terminal pane stays deep dark and nearly opaque in
// every skin (theme.css pins --term-pane per skin).
type SkinId = "dark" | "light" | "midnight" | "aurora" | "crimson";
const SKINS: { id: SkinId; name: string; short: string; swatch: string }[] = [
  {
    id: "dark",
    name: "Dark Liquid Glass",
    short: "Dark",
    swatch: "linear-gradient(135deg,#0b0d12 0%,#1a1030 55%,#e93d82 130%)",
  },
  {
    id: "light",
    name: "Light Liquid Glass",
    short: "Light",
    swatch: "linear-gradient(135deg,#ffffff 0%,#e2eaf4 60%,#b9cbe4 100%)",
  },
  {
    id: "midnight",
    name: "Midnight OLED",
    short: "OLED",
    swatch: "linear-gradient(135deg,#000000 0%,#111417 70%,#00e676 140%)",
  },
  {
    id: "aurora",
    name: "Aurora",
    short: "Aurora",
    swatch: "linear-gradient(135deg,#7c3aed 0%,#4c1d95 45%,#14b8a6 100%)",
  },
  {
    id: "crimson",
    name: "Crimson Vinyl",
    short: "Crimson",
    swatch: "linear-gradient(135deg,#2a060e 0%,#7f1d2d 55%,#f43f7a 130%)",
  },
];
function isSkinId(v: string | null): v is SkinId {
  return v === "dark" || v === "light" || v === "midnight" || v === "aurora" || v === "crimson";
}

// Arrow cluster sits right after esc/tab so all four arrows (↑ ↓ ← →)
// are visible and tappable at phone width without scrolling the row;
// the remaining keys follow and the row still scrolls horizontally to
// reach them. Every button goes through enqueueKeys → tmux send-keys,
// so they send the real arrow escape sequences in line mode and live
// keys mode alike.
const KEY_BAR: { label: string; key: TermKey; aria: string }[] = [
  { label: "esc", key: "Escape", aria: "Send Escape key" },
  { label: "tab", key: "Tab", aria: "Send Tab key" },
  { label: "↑", key: "Up", aria: "Send Arrow Up key" },
  { label: "↓", key: "Down", aria: "Send Arrow Down key" },
  { label: "←", key: "Left", aria: "Send Arrow Left key" },
  { label: "→", key: "Right", aria: "Send Arrow Right key" },
  { label: "^C", key: "C-c", aria: "Send Ctrl-C (interrupt)" },
  { label: "^D", key: "C-d", aria: "Send Ctrl-D (end of input)" },
  { label: "^Z", key: "C-z", aria: "Send Ctrl-Z (suspend)" },
  { label: "^L", key: "C-l", aria: "Send Ctrl-L (redraw)" },
  { label: "⌫", key: "BSpace", aria: "Send Backspace key" },
  { label: "⏎", key: "Enter", aria: "Send Enter key" },
];

// Number row — sits directly under the special-keys (arrow) row, right
// above the typing bar. It exists for terminal multiple-choice prompts:
// when a program lists numbered choices, tapping a digit
// sends that digit as a real keypress the instant it is tapped (via
// enqueueLiteral → tmux send-keys), so the choice registers right away
// in line mode and live-keys mode alike — no type bar, no Send press.
const NUMBER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

const CTRL_KEYS: Record<string, TermKey> = {
  a: "C-a",
  c: "C-c",
  d: "C-d",
  e: "C-e",
  k: "C-k",
  l: "C-l",
  r: "C-r",
  t: "C-t",
  u: "C-u",
  w: "C-w",
  z: "C-z",
};

function shortCwd(cwd: string, homeDir: string): string {
  if (cwd === homeDir) return "~";
  if (cwd.startsWith(homeDir + "/")) return "~" + cwd.slice(homeDir.length);
  return cwd;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function App() {
  const queryClient = useQueryClient();

  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.getSession({}),
    staleTime: 60_000,
  });

  const screen = useQuery({
    queryKey: ["screen"],
    queryFn: () => api.getScreen({}),
    refetchInterval: 1000,
    refetchIntervalInBackground: false,
  });

  const [input, setInput] = useState("");
  const [liveKeys, setLiveKeys] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  // ---- view mode -----------------------------------------------------------
  // Desktop is the full-screen layout (wide sidebar with labels, roomier
  // chrome); Mobile is the compact fitted layout. The switch lives at the
  // top of the sidebar. An explicit tap is persisted and always wins;
  // with no stored choice, the default follows the screen: phone-width
  // viewports get Mobile (the only layout that fits there), larger
  // screens get Desktop.
  const [viewMode, setViewMode] = useState<"desktop" | "mobile">(() => {
    try {
      const stored = window.localStorage.getItem("vmterm-view");
      if (stored === "desktop" || stored === "mobile") return stored;
    } catch {
      // fall through to the viewport-based default
    }
    return window.innerWidth < 640 ? "mobile" : "desktop";
  });
  const wide = viewMode === "desktop";
  // Mobile has no separate typing bar: the pane itself is the input
  // surface, so keystrokes always go live into the PTY there. Desktop
  // keeps the explicit live-keys toggle.
  const effectiveLiveKeys = liveKeys || !wide;
  const chooseViewMode = (mode: "desktop" | "mobile") => {
    setViewMode(mode);
    try {
      window.localStorage.setItem("vmterm-view", mode);
    } catch {
      // Storage unavailable — the mode just won't persist across opens.
    }
  };

  // ---- skin ----------------------------------------------------------------
  // Five skins (see SKINS above). The picker sits in the sidebar directly
  // under the Desktop/Mobile switch; the choice persists per space in
  // localStorage (vmterm-skin) and applies to both view modes. Existing
  // users with a saved Dark/Light choice under the old vmterm-glass key
  // land on that same skin. The data-skin attribute is set on the root
  // element and mirrored onto <html>; theme.css keys every skin off it
  // (data-glass is kept as a light/dark alias for the original CSS).
  // The terminal reading pane stays deep dark and nearly opaque in
  // EVERY skin, so ANSI terminal text keeps full contrast.
  const [skin, setSkin] = useState<SkinId>(() => {
    try {
      const stored = window.localStorage.getItem("vmterm-skin");
      if (isSkinId(stored)) return stored;
      const legacy = window.localStorage.getItem("vmterm-glass");
      if (legacy === "dark" || legacy === "light") return legacy;
    } catch {
      // fall through to the default
    }
    return "dark";
  });
  const chooseSkin = (next: SkinId) => {
    setSkin(next);
    try {
      window.localStorage.setItem("vmterm-skin", next);
      // Keep the legacy key in sync for the two original skins.
      if (next === "dark" || next === "light") {
        window.localStorage.setItem("vmterm-glass", next);
      }
    } catch {
      // Storage unavailable — the skin just won't persist across opens.
    }
  };
  const cycleSkin = () => {
    const idx = SKINS.findIndex((s) => s.id === skin);
    const next = SKINS[(idx + 1) % SKINS.length] ?? SKINS[0];
    if (next) chooseSkin(next.id);
  };
  const currentSkin =
    SKINS.find((s) => s.id === skin) ??
    ({ id: "dark", name: "Dark Liquid Glass", short: "Dark", swatch: "#0b0d12" } as const);
  useEffect(() => {
    document.documentElement.dataset.skin = skin;
    document.documentElement.dataset.glass = skin === "light" ? "light" : "dark";
    return () => {
      delete document.documentElement.dataset.skin;
      delete document.documentElement.dataset.glass;
    };
  }, [skin]);

  // ---- keyboard-aware height ----------------------------------------------
  // Size the app to the *visual* viewport so when the on-screen keyboard
  // opens, the layout shrinks to the area above it instead of the keyboard
  // covering the lower half of the terminal. The pane's ResizeObserver
  // then re-fits the tmux window to what is actually visible.
  const [vpHeight, setVpHeight] = useState<number | null>(null);
  // How much of the layout viewport the keyboard (plus its accessory
  // bar) covers: layout height minus visual height. >80px ≈ keyboard up.
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const h = Math.round(vv.height);
      setVpHeight(h);
      setKbInset(Math.max(0, window.innerHeight - h));
    };
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);
  const keyboardUp = kbInset > 80;

  // ---- terminal zoom --------------------------------------------------------
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const raw = Number(window.localStorage.getItem("vmterm-zoom"));
      if (Number.isFinite(raw) && raw >= 0.4 && raw <= 2.1) {
        // One-time migration: 0.75 was the old persisted default. If a
        // device still carries exactly that value and has never been
        // explicitly stepped away from it via the new default, prefer
        // the new 60% default so Mobile opens at 60% as requested.
        // Any other stored value is a deliberate user choice and wins.
        // We distinguish by checking a marker set only when the user
        // explicitly steps zoom (see stepZoom effect below) — for
        // simplicity, if the stored value is exactly the old default,
        // treat it as the old default and migrate it.
        if (raw === 0.75) {
          const migrated = window.localStorage.getItem("vmterm-zoom-60-migrated");
          if (!migrated) {
            try {
              window.localStorage.setItem("vmterm-zoom-60-migrated", "1");
              window.localStorage.setItem("vmterm-zoom", String(DEFAULT_ZOOM));
            } catch {
              // ignore
            }
            return DEFAULT_ZOOM;
          }
        }
        return raw;
      }
    } catch {
      // fall through to the default
    }
    return DEFAULT_ZOOM;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("vmterm-zoom", String(zoom));
      // Any zoom value that reaches this effect is the live, current
      // choice — mark the 60% migration as done so a deliberate step
      // back to 75% later is respected instead of re-migrated.
      window.localStorage.setItem("vmterm-zoom-60-migrated", "1");
    } catch {
      // Storage unavailable — the zoom just won't persist across opens.
    }
  }, [zoom]);
  const stepZoom = useCallback((dir: 1 | -1) => {
    setZoom((z) => {
      let best = 0;
      for (let i = 0; i < ZOOM_LEVELS.length; i++) {
        const lvl = ZOOM_LEVELS[i] ?? z;
        const bestLvl = ZOOM_LEVELS[best] ?? z;
        if (Math.abs(lvl - z) < Math.abs(bestLvl - z)) best = i;
      }
      const next =
        ZOOM_LEVELS[clamp(best + dir, 0, ZOOM_LEVELS.length - 1)] ?? z;
      return next;
    });
  }, []);
  const fontPx = 12 * zoom;
  const linePx = 16 * zoom;

  const scrollRef = useRef<HTMLDivElement>(null);
  const sbTrackRef = useRef<HTMLDivElement>(null);
  const sbThumbRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pinnedRef = useRef(true);
  const charWidthRef = useRef(5.43);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const data = session.data;
  const scr = screen.data;
  const homeDir = data?.system.homeDir ?? "/home/user";
  const cwd = scr?.cwd ?? data?.cwd ?? homeDir;

  // Links detected in the current screen (full URLs reassembled across
  // wrapped rows) — drives the copy-link bar under the pane.
  const ansiText = scr?.ansi;
  const ansiCols = scr?.cols;
  const screenLinks = useMemo(
    () => (ansiText ? extractTerminalLinks(ansiText, ansiCols) : []),
    [ansiText, ansiCols],
  );

  const [copiedHref, setCopiedHref] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyLink = useCallback(async (href: string) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(href);
      ok = true;
    } catch {
      // Webviews without clipboard permission: fall back to a hidden
      // textarea + execCommand copy.
      const ta = document.createElement("textarea");
      ta.value = href;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    if (ok) {
      setCopiedHref(href);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedHref(null), 2000);
    }
  }, []);

  // ---- ordered send queue -------------------------------------------------
  // Every keystroke path funnels through one queue so a fast burst of
  // input reaches tmux in order even though each send is its own call.
  const queueRef = useRef<{ literal: string; keys: TermKey[] }>({
    literal: "",
    keys: [],
  });
  const sendingRef = useRef(false);

  const sendMutation = useMutation({
    mutationFn: (args: SendArgs) => api.sendTerminal(args),
    onSuccess: (next) => {
      queryClient.setQueryData(["screen"], next);
    },
  });
  const sendMutateRef = useRef(sendMutation.mutate);
  sendMutateRef.current = sendMutation.mutate;

  const flushQueue = useCallback(() => {
    if (sendingRef.current) return;
    const q = queueRef.current;
    if (!q.literal && q.keys.length === 0) return;
    const payload: SendArgs = {
      ...(q.literal ? { literal: q.literal } : {}),
      ...(q.keys.length > 0 ? { keys: [...q.keys] } : {}),
    };
    q.literal = "";
    q.keys = [];
    sendingRef.current = true;
    sendMutateRef.current(payload, {
      onSettled: () => {
        sendingRef.current = false;
        flushQueue();
      },
    });
  }, []);

  const enqueueLiteral = useCallback(
    (text: string) => {
      queueRef.current.literal += text;
      flushQueue();
    },
    [flushQueue],
  );
  const enqueueKeys = useCallback(
    (keys: TermKey[]) => {
      queueRef.current.keys.push(...keys);
      flushQueue();
    },
    [flushQueue],
  );
  const enqueueLine = useCallback(
    (text: string) => {
      if (text) queueRef.current.literal += text;
      queueRef.current.keys.push("Enter");
      flushQueue();
    },
    [flushQueue],
  );

  // ---- other session mutations -------------------------------------------
  const resizeMutation = useMutation({
    mutationFn: (size: { cols: number; rows: number }) =>
      api.resizeTerminal(size),
    onSuccess: (next) => {
      queryClient.setQueryData(["screen"], next);
    },
  });
  const resizeMutateRef = useRef(resizeMutation.mutate);
  resizeMutateRef.current = resizeMutation.mutate;

  const restartMutation = useMutation({
    mutationFn: () => api.restartTerminal(lastSizeRef.current ?? {}),
    onSuccess: (next) => {
      queryClient.setQueryData(["screen"], next);
      setConfirmRestart(false);
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearTerminal({}),
    onSuccess: (next) => {
      queryClient.setQueryData(["screen"], next);
    },
  });

  // ---- measurement + resize ----------------------------------------------
  const measureAndResize = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const cols = clamp(
      Math.floor((el.clientWidth - 34) / charWidthRef.current),
      30,
      200,
    );
    const rows = clamp(
      Math.floor((el.clientHeight - linePx) / linePx),
      12,
      80,
    );
    const last = lastSizeRef.current;
    if (last && last.cols === cols && last.rows === rows) return;
    lastSizeRef.current = { cols, rows };
    const cur = queryClient.getQueryData<Screen>(["screen"]);
    if (cur && Math.abs(cur.cols - cols) < 2 && cur.rows === rows) return;
    resizeMutateRef.current({ cols, rows });
  }, [queryClient, linePx]);

  // On mount and whenever the zoom changes: re-measure the glyph width at
  // the new font size and refit the tmux window to the pane.
  useEffect(() => {
    const probe = document.createElement("span");
    probe.className = "font-term";
    probe.style.cssText = `position:absolute;visibility:hidden;font-size:${fontPx}px;white-space:pre;`;
    probe.textContent = "M".repeat(50);
    document.body.appendChild(probe);
    const w = probe.offsetWidth / 50;
    probe.remove();
    if (w > 0) charWidthRef.current = w;
    lastSizeRef.current = null;
    measureAndResize();
  }, [fontPx, measureAndResize]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(measureAndResize, 350);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [measureAndResize, scr?.alive]);

  // ---- custom scrollbar rail ----------------------------------------------
  // Phone webviews never show a native scrollbar at rest, so the reading
  // pane carries its own rail on the right edge: a track with a thumb
  // whose size/position mirror the pane's scroll state. Dragging the
  // thumb (or tapping the track) scrolls the pane through the tmux
  // scrollback — the previous messages and output. The thumb is styled
  // directly through refs so the ~1s screen polling never re-renders.
  const syncScrollbar = useCallback(() => {
    const el = scrollRef.current;
    const track = sbTrackRef.current;
    const thumb = sbThumbRef.current;
    if (!el || !track || !thumb) return;
    const trackH = track.clientHeight;
    if (trackH <= 0) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const ratio = scrollHeight > 0 ? clientHeight / scrollHeight : 1;
    const thumbH = Math.max(
      44,
      Math.min(trackH, Math.round(trackH * ratio)),
    );
    const maxTop = Math.max(0, trackH - thumbH);
    const frac =
      scrollHeight > clientHeight
        ? scrollTop / (scrollHeight - clientHeight)
        : 0;
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${Math.round(frac * maxTop)}px)`;
    thumb.style.opacity = ratio >= 1 ? "0.35" : "0.6";
  }, []);

  const sbDragRef = useRef<{ startY: number; startTop: number } | null>(
    null,
  );
  const onThumbPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    sbDragRef.current = { startY: e.clientY, startTop: el.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onThumbPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sbDragRef.current;
    const el = scrollRef.current;
    const track = sbTrackRef.current;
    const thumb = sbThumbRef.current;
    if (!drag || !el || !track || !thumb) return;
    const range = el.scrollHeight - el.clientHeight;
    if (range <= 0) return;
    const denom = Math.max(1, track.clientHeight - thumb.offsetHeight);
    el.scrollTop = drag.startTop + ((e.clientY - drag.startY) / denom) * range;
  };
  const endThumbDrag = () => {
    sbDragRef.current = null;
  };
  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Taps on the track (not the thumb) jump the pane toward that
    // point in the scrollback.
    if (e.target !== e.currentTarget) return;
    const el = scrollRef.current;
    const track = sbTrackRef.current;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    const frac = (e.clientY - rect.top) / Math.max(1, rect.height);
    el.scrollTop = frac * Math.max(0, el.scrollHeight - el.clientHeight);
  };

  // ---- scroll pinning ------------------------------------------------------
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    syncScrollbar();
  }, [scr?.ansi, syncScrollbar]);

  // Keyboard opened/closed (visual viewport changed): keep the newest
  // output in view while typing.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    syncScrollbar();
  }, [vpHeight, syncScrollbar]);

  // The rail also tracks pane resizes and zoom changes (both change the
  // scrollable height even when no new output arrives).
  useEffect(() => {
    syncScrollbar();
  }, [fontPx, wide, syncScrollbar]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!confirmRestart) return;
    const t = setTimeout(() => setConfirmRestart(false), 3500);
    return () => clearTimeout(t);
  }, [confirmRestart]);

  // ---- input handling ------------------------------------------------------
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    syncScrollbar();
  };

  const runInputLine = () => {
    if (effectiveLiveKeys) {
      enqueueKeys(["Enter"]);
      return;
    }
    enqueueLine(input);
    setInput("");
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!effectiveLiveKeys) {
      if (e.key === "Enter") {
        e.preventDefault();
        runInputLine();
      }
      return;
    }
    // Live-keys mode: every key goes straight to the session.
    const k = e.key;
    const special: Record<string, TermKey> = {
      Enter: "Enter",
      Backspace: "BSpace",
      Tab: "Tab",
      Escape: "Escape",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Home: "Home",
      End: "End",
      PageUp: "PPage",
      PageDown: "NPage",
      Delete: "DC",
    };
    const mapped = special[k];
    if (mapped) {
      e.preventDefault();
      enqueueKeys([mapped]);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && /^[a-zA-Z]$/.test(k)) {
      const ck = CTRL_KEYS[k.toLowerCase()];
      if (ck) {
        e.preventDefault();
        enqueueKeys([ck]);
      }
      return;
    }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      enqueueLiteral(k);
    }
    // Anything else (mobile keyboards reporting "Unidentified") falls
    // through to onChange, which forwards the inserted text.
  };

  const onInputChange = (value: string) => {
    if (effectiveLiveKeys) {
      if (value) enqueueLiteral(value);
      setInput("");
      return;
    }
    setInput(value);
  };

  const focusInput = () => {
    pinnedRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    inputRef.current?.focus();
  };

  const focusInputUnlessSelecting = () => {
    if (!window.getSelection()?.toString()) inputRef.current?.focus();
  };

  // Cursor placement: capture includes scrollback above the visible
  // pane, so the cursor's line is offset by the lines above the screen.
  const lineCount = scr ? scr.ansi.split("\n").length - 1 : 0;
  const visibleStart = scr ? Math.max(0, lineCount - scr.rows) : 0;
  const cursor =
    scr && scr.alive && scr.cursorVisible
      ? { line: visibleStart + scr.cursorY, col: scr.cursorX }
      : null;

  const sideBtn = `chip flex items-center font-medium text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40 ${
    wide
      ? "justify-start gap-1.5 rounded-xl px-3 py-2 text-[13px]"
      : "justify-center rounded-lg px-0 py-1 text-[11px]"
  }`;

  const toolBtn =
    "glass-soft font-term shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40";

  // Two proportion systems, same Liquid Glass: Desktop keeps the big
  // spacious glass pills above. Mobile uses its own compact phone scale
  // throughout (Termius-like): plain small text-style keys with no pill
  // chrome, ~22px rows, tighter gaps. These classes are Mobile-only.
  const toolBtnCompact =
    "font-term shrink-0 whitespace-nowrap px-1 py-0 text-[10px] leading-5 text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40";
  const keyBtnClass = wide
    ? "glass-soft font-term shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40"
    : "font-term shrink-0 whitespace-nowrap rounded px-1.5 py-0 text-[11px] leading-[22px] text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40";
  const numberBtnClass = wide
    ? "glass-soft font-term min-w-0 flex-1 whitespace-nowrap rounded-full px-1 py-1 text-center text-[11px] text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40"
    : "font-term min-w-0 flex-1 whitespace-nowrap px-0.5 py-0 text-center text-[11px] leading-[22px] text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40";

  // Desktop typing bar: visible input line inside the pane. Mobile has
  // no separate bar — the pane itself is the input surface (see
  // mobileInput below), using the terminal's own prompt inside the PTY.
  const inputRow = (
    <div className="font-term flex items-center gap-2 text-[13px] leading-5">
      <span className="shrink-0" aria-hidden>
        <span className="text-[var(--amber)]">{shortCwd(cwd, homeDir)}</span>
        <span className="text-[var(--cyan)]"> ❯</span>
      </span>
      <input
        ref={inputRef}
        aria-label="Terminal input"
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder={
          scr
            ? effectiveLiveKeys
              ? "live keys — every keystroke goes to the session"
              : "type a command, ⏎ sends it"
            : "connecting…"
        }
        disabled={!scr?.alive}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        className="min-w-0 flex-1 bg-transparent text-base text-[var(--text)] caret-[var(--accent)] outline-none placeholder:text-[var(--dim)] sm:text-[13px]"
      />
      <button
        type="button"
        aria-label="Send Enter"
        onClick={runInputLine}
        disabled={!scr?.alive}
        className="shrink-0 rounded-lg px-3.5 py-1.5 text-[13px] font-semibold transition-opacity disabled:opacity-30"
        style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
      >
        ⏎ send
      </button>
    </div>
  );

  // Mobile-only input: a small visible keyboard chip overlaid on the
  // pane's bottom-left corner (like the zoom pill on the top-right).
  // It is a real, tappable input — tapping it, or tapping anywhere on
  // the pane (which calls focus() on it from a user gesture), raises
  // the phone keyboard; keystrokes are forwarded live into the PTY via
  // effectiveLiveKeys (Enter sends Enter, Backspace sends BSpace,
  // printable keys go via onChange/onKeyDown), so typing lands on the
  // terminal's own prompt line inside the PTY — there is no separate
  // typing bar in Mobile. Font size is 16px so iOS does not auto-zoom.
  const mobileInput = (
    <input
      ref={inputRef}
      aria-label="Terminal input — tap the terminal to type"
      value={input}
      onChange={(e) => onInputChange(e.target.value)}
      onKeyDown={onInputKeyDown}
      disabled={!scr?.alive}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="go"
      placeholder="⌨"
      className="absolute bottom-1.5 left-1.5 z-20 h-7 w-11 rounded-full border border-white/15 bg-black/60 text-center text-[16px] text-[var(--text)] caret-transparent backdrop-blur-sm placeholder:text-[var(--cyan)]"
    />
  );

  return (
    <div
      data-skin={skin}
      data-glass={skin === "light" ? "light" : "dark"}
      className="relative overflow-hidden bg-[var(--bg)] text-[var(--text)]"
      style={{ height: vpHeight != null ? `${vpHeight}px` : "100dvh" }}
    >
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <div className="relative flex h-full w-full">
        {/* ambient glow field — console signature */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div
            className="absolute -left-32 -top-32 h-96 w-96 rounded-full opacity-25 blur-[110px]"
            style={{ background: "var(--glow-1)" }}
          />
          <div
            className="absolute -bottom-40 right-0 h-[28rem] w-[28rem] rounded-full opacity-[0.13] blur-[120px]"
            style={{ background: "var(--glow-2)" }}
          />
          <div
            className="absolute left-1/3 top-1/2 h-72 w-72 rounded-full opacity-[0.07] blur-[100px]"
            style={{ background: "var(--glow-3)" }}
          />
          <div
            className="absolute -right-24 -top-24 h-80 w-80 rounded-full opacity-[0.10] blur-[110px]"
            style={{ background: "var(--glow-4)" }}
          />
        </div>

        {/* ------------------------------ sidebar ------------------------------ */}
        <aside
          className={`glass relative z-10 flex shrink-0 flex-col pt-safe ${
            wide ? "m-2 mr-0 w-[204px] rounded-2xl" : "m-1 mr-0 w-[42px] rounded-xl"
          }`}
        >
          {/* Desktop / Mobile view switch */}
          <div
            role="group"
            aria-label="View mode"
            className={`flex ${
              wide ? "flex-row gap-1 px-2 pt-2" : "flex-col gap-0.5 px-1 pt-1.5"
            }`}
          >
            {(
              [
                { mode: "desktop", label: "Desktop" },
                { mode: "mobile", label: "Mobile" },
              ] as const
            ).map((item) => (
              <button
                key={item.mode}
                type="button"
                aria-label={`${item.label} view`}
                aria-pressed={viewMode === item.mode}
                onClick={() => chooseViewMode(item.mode)}
                className={`font-term flex-1 font-semibold transition-colors ${
                  wide
                    ? "rounded-lg px-1 py-1.5 text-[10px]"
                    : "rounded-md px-0 py-1 text-[8px] leading-3"
                }`}
                style={
                  viewMode === item.mode
                    ? { background: "var(--accent)", color: "var(--accent-fg)" }
                    : {
                        background: "var(--chip-bg)",
                        color: "var(--dim)",
                      }
                }
              >
                {wide
                  ? item.label
                  : item.mode === "desktop"
                    ? "Desk"
                    : "Mob"}
              </button>
            ))}
          </div>

          {/* Skin picker — five skins, right under the view switch so
              it is always reachable at the top of the sidebar. Desktop:
              a swatch row of all five plus the current skin name.
              Mobile (42px rail): one compact cycle button showing the
              current skin's swatch; tapping steps to the next skin. */}
          {wide ? (
            <div className="px-2 pt-1.5">
              <div
                role="group"
                aria-label="Skin"
                className="flex flex-row gap-1"
              >
                {SKINS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={`Skin: ${item.name}`}
                    aria-pressed={skin === item.id}
                    title={item.name}
                    onClick={() => chooseSkin(item.id)}
                    className="flex h-6 flex-1 items-center justify-center rounded-lg transition-transform"
                    style={{
                      background: item.swatch,
                      boxShadow:
                        skin === item.id
                          ? "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)"
                          : "inset 0 0 0 1px rgba(255,255,255,0.25)",
                    }}
                  >
                    <span className="sr-only">{item.name}</span>
                  </button>
                ))}
              </div>
              <div
                aria-live="polite"
                className="font-term truncate px-0.5 pt-1 text-center text-[9px] font-medium leading-3 text-[var(--dim)]"
              >
                {currentSkin.name}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center px-1 pt-1">
              <button
                type="button"
                aria-label={`Skin: ${currentSkin.name} — tap to change skin`}
                title={`Skin: ${currentSkin.name}`}
                onClick={cycleSkin}
                className="flex h-6 w-full items-center justify-center rounded-md transition-transform"
                style={{
                  background: currentSkin.swatch,
                  boxShadow:
                    "0 0 0 1px var(--bg), 0 0 0 2px var(--accent), inset 0 0 0 1px rgba(255,255,255,0.25)",
                }}
              >
                <span className="sr-only">{currentSkin.name}</span>
              </button>
              <div
                aria-hidden="true"
                className="font-term w-full truncate pt-0.5 text-center text-[7px] font-medium leading-3 text-[var(--dim)]"
              >
                {currentSkin.short}
              </div>
            </div>
          )}

          <div
            className={`flex items-center ${
              wide ? "gap-2.5 px-4 pb-2 pt-3" : "justify-center px-0.5 pb-1 pt-2"
            }`}
          >
            <div
              className={`font-term flex shrink-0 items-center justify-center font-bold ${
                wide
                  ? "h-9 w-9 rounded-xl text-sm"
                  : "h-7 w-7 rounded-lg text-[10px]"
              }`}
              style={{ background: "linear-gradient(145deg,var(--accent),var(--accent-deep))", color: "var(--accent-fg)" }}
            >
              VM
            </div>
            {wide ? (
              <div className="min-w-0">
                <div className="truncate text-base font-bold leading-tight">
                  VM Terminal
                </div>
                <div className="truncate text-xs font-medium leading-tight text-[var(--dim)]">
                  Muse VM
                </div>
              </div>
            ) : null}
          </div>

          <nav
            aria-label="Terminal targets"
            className={`thin-scroll flex flex-1 flex-col overflow-y-auto ${
              wide ? "gap-1 px-2 py-2" : "gap-0.5 px-1 py-1"
            }`}
          >
            <button
              type="button"
              onClick={focusInput}
              aria-current="page"
              aria-label="Local shell — this VM"
              className={`chip-active flex items-center font-semibold transition-colors ${
                wide
                  ? "gap-2.5 rounded-xl px-3 py-2.5 text-[15px]"
                  : "justify-center gap-1 rounded-lg px-0 py-1.5 text-[11px]"
              }`}
            >
              <span
                aria-hidden
                className={`font-term font-bold ${wide ? "text-sm" : "text-[11px]"}`}
              >
                &gt;_
              </span>
              {wide ? (
                <span className="flex-1 text-left">Local shell</span>
              ) : null}
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: scr?.alive ? "var(--cyan)" : "#6b7280" }}
              />
            </button>
            {wide ? (
              <p className="font-term px-1 pt-2 text-[11px] font-medium leading-relaxed text-[var(--dim)]">
                {data
                  ? `${data.system.username}@${data.system.hostname} · tmux session "vmterm" — one real PTY on this VM, the same shell the agent works in`
                  : "Connecting to this VM…"}
              </p>
            ) : null}
          </nav>

          <div
            className={`flex flex-col ${
              wide ? "gap-1.5 px-3 pb-3" : "gap-0.5 px-1 pb-1.5"
            }`}
          >
            <button
              type="button"
              aria-label="Refresh system info"
              onClick={() => {
                void session.refetch();
                void screen.refetch();
              }}
              className={sideBtn}
            >
              <span aria-hidden>↻</span>
              {wide ? <span>Refresh</span> : null}
            </button>
            <button
              type="button"
              aria-label="Clear terminal screen and scrollback"
              onClick={() => clearMutation.mutate()}
              disabled={!scr?.alive || clearMutation.isPending}
              className={sideBtn}
            >
              <span aria-hidden>✕</span>
              {wide ? <span>Clear</span> : null}
            </button>
            {wide ? (
              <div className="font-term px-1 pt-1 text-[11px] font-medium leading-relaxed text-[var(--dim)]">
                {data
                  ? `up ${data.system.uptimeText} · RAM ${data.system.ramPct}% · disk ${data.system.diskPct}%`
                  : "Loading host state…"}
              </div>
            ) : null}
          </div>
        </aside>

        {/* -------------------------------- main -------------------------------- */}
        <main className="relative z-10 flex min-w-0 flex-1 flex-col pt-safe">
          {/* Desktop only: the big title heading. Mobile removes it
              entirely so the terminal card pulls up into that space
              and the reading pane gets the height. */}
          {wide ? (
            <header className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
              <h1 className="min-w-0 truncate text-xl font-semibold leading-tight">
                Terminal — Muse VM
              </h1>
              {data ? (
                <span className="glass-soft font-term shrink-0 rounded-full px-2.5 py-1 text-[11px] text-[var(--dim)]">
                  {data.system.username}@{data.system.hostname} ·{" "}
                  {shortCwd(cwd, homeDir)}
                </span>
              ) : null}
            </header>
          ) : null}

          {data && wide ? (
            <p className="font-term truncate px-5 text-[11px] text-[var(--dim)]">
              {data.system.hostname} — {data.system.osName} ·{" "}
              {data.system.cores} cores · RAM {data.system.ramUsed}/
              {data.system.ramTotal} · up {data.system.uptimeText}
              {data.system.versions ? ` · ${data.system.versions}` : ""}
            </p>
          ) : null}

          <div
            className={`flex min-h-0 flex-1 flex-col ${
              wide ? "px-5 pb-4" : "py-1 pl-1 pr-1.5"
            }`}
          >
            {/* terminal pane — the dominant surface. Desktop: a padded
                glass card. Mobile: edge-to-edge, no card frame or
                padding, so the terminal surface itself fills the area
                above the keyboard (Termius proportions). */}
            <section
              aria-label="Terminal"
              className={
                wide
                  ? "glass flex min-h-0 flex-1 flex-col rounded-2xl p-2.5"
                  : "flex min-h-0 flex-1 flex-col"
              }
            >
              {/* session status — Desktop wraps as before; Mobile is
                  ONE slim line: truncated status plus tiny inline
                  interrupt/restart text controls, never two rows. */}
              <div
                className={
                  wide
                    ? "flex flex-wrap items-center gap-1.5 px-1 pb-2"
                    : "flex flex-nowrap items-center gap-1 overflow-hidden px-1 pb-1"
                }
              >
                <span
                  className={`font-term flex min-w-0 items-center text-[var(--dim)] ${
                    wide ? "gap-1.5 text-[11px]" : "gap-1 truncate text-[10px] leading-5"
                  }`}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background: scr?.alive ? "var(--cyan)" : "#6b7280",
                    }}
                  />
                  <span className={wide ? undefined : "truncate"}>
                    {scr
                      ? scr.alive
                        ? wide
                          ? `${scr.session} · ${scr.currentCommand || "shell"} · ${shortCwd(cwd, homeDir)} · ${scr.cols}×${scr.rows}`
                          : `${scr.session} · ${scr.currentCommand || "shell"} · ${scr.cols}×${scr.rows}`
                        : "session down — reopening…"
                      : "connecting…"}
                  </span>
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  aria-label="Interrupt running program (Ctrl-C)"
                  onClick={() => enqueueKeys(["C-c"])}
                  disabled={!scr?.alive}
                  className={wide ? toolBtn : toolBtnCompact}
                >
                  {wide ? "^C interrupt" : "^C"}
                </button>
                <button
                  type="button"
                  aria-label={
                    confirmRestart
                      ? "Confirm restart terminal session"
                      : "Restart terminal session"
                  }
                  onClick={() => {
                    if (confirmRestart) restartMutation.mutate();
                    else setConfirmRestart(true);
                  }}
                  disabled={!scr?.alive || restartMutation.isPending}
                  className={wide ? toolBtn : toolBtnCompact}
                  style={
                    confirmRestart
                      ? { color: "var(--accent-fg)", background: "var(--accent)" }
                      : undefined
                  }
                >
                  {confirmRestart
                    ? wide
                      ? "tap again to restart"
                      : "sure?"
                    : wide
                      ? "restart session"
                      : "restart"}
                </button>
              </div>

              <div
                className={`term-dark-scope relative flex min-h-0 flex-1 flex-col overflow-hidden border-white/[0.06] ${
                  wide ? "rounded-xl border" : "rounded-lg border-x border-t"
                }`}
                style={{ background: "var(--term-pane)" }}
              >
                {/* zoom controls — top-right corner of the reading pane;
                    compact pill on Mobile, full pill on Desktop */}
                {scr ? (
                  <div
                    className={`absolute z-20 flex items-center rounded-full bg-black/50 backdrop-blur-sm ${
                      wide
                        ? "right-2 top-2 gap-1 py-1 pl-1 pr-1.5"
                        : "right-1 top-1 gap-0.5 py-0.5 pl-0.5 pr-1"
                    }`}
                  >
                    <button
                      type="button"
                      aria-label="Zoom out terminal text"
                      onClick={() => stepZoom(-1)}
                      disabled={zoom <= (ZOOM_LEVELS[0] ?? 0.5)}
                      className={`glass-soft font-term flex items-center justify-center rounded-full font-bold leading-none text-[var(--text)] transition-colors hover:bg-white/15 disabled:opacity-35 ${
                        wide ? "h-7 w-7 text-base" : "h-5 w-5 text-[13px]"
                      }`}
                    >
                      −
                    </button>
                    <span
                      aria-label={`Terminal zoom level ${Math.round(zoom * 100)} percent`}
                      className={`font-term min-w-[3.2ch] text-center font-medium text-[var(--dim)] ${
                        wide ? "text-[10px]" : "text-[9px]"
                      }`}
                    >
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      type="button"
                      aria-label="Zoom in terminal text"
                      onClick={() => stepZoom(1)}
                      disabled={
                        zoom >= (ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? 2)
                      }
                      className={`glass-soft font-term flex items-center justify-center rounded-full font-bold leading-none text-[var(--text)] transition-colors hover:bg-white/15 disabled:opacity-35 ${
                        wide ? "h-7 w-7 text-base" : "h-5 w-5 text-[13px]"
                      }`}
                    >
                      +
                    </button>
                  </div>
                ) : null}

                <div className="relative flex min-h-0 flex-1 flex-col">
                  <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    onClick={focusInputUnlessSelecting}
                    className={`font-term term-scroll min-h-0 flex-1 overflow-x-auto overflow-y-scroll ${
                      wide ? "px-2.5 py-2" : "px-1.5 py-1"
                    }`}
                    style={{ fontSize: `${fontPx}px` }}
                  >
                    {screen.isPending ? (
                      <p className="text-[var(--dim)]">
                        opening the terminal session
                        <span className="term-cursor ml-1 inline-block h-3.5 w-2 translate-y-0.5 bg-[var(--accent)]" />
                      </p>
                    ) : screen.isError ? (
                      <div>
                        <p className="text-[var(--term-red)]">
                          Could not reach the terminal host:{" "}
                          {String(screen.error)}
                        </p>
                        <button
                          type="button"
                          aria-label="Retry loading terminal"
                          onClick={() => void screen.refetch()}
                          className="mt-3 rounded-full px-4 py-2 text-sm font-medium"
                          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                        >
                          retry
                        </button>
                      </div>
                    ) : scr ? (
                      renderAnsiScreen(scr.ansi, cursor, scr.cols, linePx)
                    ) : null}
                  </div>

                  {/* scrollbar rail — right edge of the reading pane.
                      Always visible (phone webviews hide native bars):
                      drag the thumb, or tap the track, to move up and
                      down through the terminal's previous messages and
                      output. Starts below the zoom pill. */}
                  {scr ? (
                    <div
                      ref={sbTrackRef}
                      aria-hidden="true"
                      onPointerDown={onTrackPointerDown}
                      className={`absolute bottom-1 right-0 z-10 touch-none rounded-full ${
                        wide ? "top-12 w-[14px]" : "top-8 w-[10px]"
                      }`}
                      style={{ background: "rgba(255, 255, 255, 0.08)" }}
                    >
                      <div
                        ref={sbThumbRef}
                        onPointerDown={onThumbPointerDown}
                        onPointerMove={onThumbPointerMove}
                        onPointerUp={endThumbDrag}
                        onPointerCancel={endThumbDrag}
                        className={`absolute top-0 cursor-grab rounded-full active:cursor-grabbing ${
                          wide ? "left-[2px] w-[10px]" : "left-[1px] w-[8px]"
                        }`}
                        style={{
                          height: 44,
                          background: "rgba(255, 255, 255, 0.6)",
                          boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.35)",
                        }}
                      />
                    </div>
                  ) : null}
                  {/* Mobile: visible keyboard-chip input that makes
                      the pane itself the typing surface — tapping the
                      pane (or the chip) focuses it and raises the
                      keyboard; typing lands on the PTY's own prompt. */}
                  {!wide ? mobileInput : null}
                </div>

                {/* links on screen — tap to open, or copy the full
                    reassembled URL even if part of it is off screen */}
                {scr && screenLinks.length > 0 && (wide || !keyboardUp) ? (
                  <div
                    className={`flex flex-col border-t border-white/[0.07] ${
                      wide ? "gap-1.5 px-3 py-2" : "gap-0 px-1.5 py-0"
                    }`}
                  >
                    {screenLinks.map((href) => (
                      <div
                        key={href}
                        className={`flex items-center ${wide ? "gap-2" : "gap-1"}`}
                      >
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open link: ${href}`}
                          className={`font-term min-w-0 flex-1 truncate text-[#58a6ff] underline ${
                            wide ? "text-[11px]" : "text-[10px] leading-5"
                          }`}
                        >
                          {href}
                        </a>
                        <button
                          type="button"
                          aria-label={`Copy full link: ${href}`}
                          onClick={() => void copyLink(href)}
                          className={wide ? toolBtn : toolBtnCompact}
                        >
                          {copiedHref === href
                            ? "copied ✓"
                            : wide
                              ? "copy link"
                              : "copy"}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* special keys — Desktop: a wrapped pill row. Mobile:
                    ONE slim text-style strip (Termius-like, ~22px) that
                    together with the number row below forms a single
                    compact keypad block directly above the keyboard. */}
                {scr ? (
                  <div
                    className={
                      wide
                        ? "flex flex-wrap gap-1.5 border-t border-white/[0.07] px-3 py-2"
                        : "flex flex-nowrap gap-0.5 overflow-x-auto border-t border-white/[0.07] px-1.5 py-0"
                    }
                  >
                    {KEY_BAR.map((item) => (
                      <button
                        key={item.key + item.label}
                        type="button"
                        aria-label={item.aria}
                        onClick={() => enqueueKeys([item.key])}
                        disabled={!scr.alive}
                        className={keyBtnClass}
                      >
                        {item.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-label="Toggle live keys mode"
                      aria-pressed={effectiveLiveKeys}
                      onClick={() => setLiveKeys((v) => !v)}
                      className={keyBtnClass}
                      style={
                        effectiveLiveKeys
                          ? {
                              background: "var(--accent)",
                              color: "var(--accent-fg)",
                              borderColor: "transparent",
                            }
                          : undefined
                      }
                    >
                      {wide
                        ? effectiveLiveKeys
                          ? "live keys on"
                          : "live keys"
                        : "live"}
                    </button>
                  </div>
                ) : null}

                {/* number row — directly under the special-keys row.
                    Each digit is sent as an immediate keypress
                    (enqueueLiteral) so numbered multiple-choice prompts
                    in TUIs register the tap at once, in
                    both input modes. */}
                {scr ? (
                  <div
                    role="group"
                    aria-label="Number keys"
                    className={
                      wide
                        ? "flex gap-1.5 border-t border-white/[0.07] px-3 py-1.5"
                        : "flex gap-0.5 px-1.5 py-0"
                    }
                  >
                    {NUMBER_KEYS.map((digit) => (
                      <button
                        key={digit}
                        type="button"
                        aria-label={`Send number ${digit} key`}
                        onClick={() => enqueueLiteral(digit)}
                        disabled={!scr.alive}
                        className={numberBtnClass}
                      >
                        {digit}
                      </button>
                    ))}
                  </div>
                ) : null}

                {/* quick commands — Desktop only. Mobile drops the
                    whole row (Termius has no such row) so the reading
                    pane keeps the height. */}
                {scr && wide ? (
                  <div className="flex gap-1.5 overflow-x-auto border-t border-white/[0.07] px-3 py-2">
                    {QUICK_COMMANDS.map((cmd) => (
                      <button
                        key={cmd}
                        type="button"
                        aria-label={`Type and run command: ${cmd}`}
                        onClick={() => enqueueLine(cmd)}
                        disabled={!scr.alive}
                        className={keyBtnClass}
                      >
                        {cmd}
                      </button>
                    ))}
                  </div>
                ) : null}

                {/* input line — Desktop only, inside the pane.
                    Mobile has no separate typing bar: the pane itself
                    is the input surface via the mobileInput chip, and
                    the terminal's own prompt inside the PTY is what
                    the user types at. */}
                {wide ? (
                  <div className="border-t border-white/[0.07] px-3 py-2.5">
                    {inputRow}
                  </div>
                ) : null}
              </div>
            </section>

            {wide ? (
              <p className="font-term px-1 pt-2 text-[10px] leading-relaxed text-[var(--dim)]">
              Real PTY · tmux session &quot;vmterm&quot; on{" "}
              {data?.system.hostname ?? "the VM"} — join the same session
              from any shell on this VM with `tmux attach -t vmterm`.
              Interactive CLIs (vim, top, htop) run live here, installs
              land on the same disk, PATH and HOME the agent uses, and the
              session keeps running when you close this page. Line mode
              sends on ⏎; live keys sends every keystroke for TUIs. Links
                in the output are tappable — a link wrapped across lines
                opens whole.
              </p>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
