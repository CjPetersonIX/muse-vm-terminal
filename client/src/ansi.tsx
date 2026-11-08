// Minimal ANSI (SGR) renderer for `tmux capture-pane -e` output.
//
// tmux has already done the hard terminal emulation server-side — the
// capture is the pane grid as styled text lines with SGR escape
// sequences. This walks the text once, tracks SGR state (which tmux may
// carry across line boundaries), groups runs of identical style, and
// emits React spans. Non-SGR sequences (cursor moves, erases, OSC) don't
// apply to an already-rendered grid and are dropped.

import type { CSSProperties, ReactNode } from "react";

interface Sgr {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  reverse?: boolean;
}

const PALETTE = [
  "#545d68", // black
  "#ff7b72", // red
  "#3fb950", // green
  "#e3b341", // yellow
  "#58a6ff", // blue
  "#bc8cff", // magenta
  "#39c5cf", // cyan
  "#e6edf3", // white
  "#6e7681", // bright black
  "#ffa198", // bright red
  "#56d364", // bright green
  "#f0c75e", // bright yellow
  "#79c0ff", // bright blue
  "#d2a8ff", // bright magenta
  "#56d4dd", // bright cyan
  "#ffffff", // bright white
] as const;

const DEFAULT_FG = "#f2f3f7";
const DEFAULT_BG = "#10131a";

function color256(n: number): string {
  if (n < 16) return PALETTE[n] ?? DEFAULT_FG;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const comp = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
  const r = comp(Math.floor(c / 36));
  const g = comp(Math.floor((c % 36) / 6));
  const b = comp(c % 6);
  return `rgb(${r},${g},${b})`;
}

function applySgr(state: Sgr, params: number[]): void {
  const list = params.length === 0 ? [0] : params;
  for (let i = 0; i < list.length; i++) {
    const p = list[i] ?? 0;
    if (p === 0) {
      state.fg = undefined;
      state.bg = undefined;
      state.bold = undefined;
      state.dim = undefined;
      state.italic = undefined;
      state.underline = undefined;
      state.strike = undefined;
      state.reverse = undefined;
    } else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 9) state.strike = true;
    else if (p === 7) state.reverse = true;
    else if (p === 22) {
      state.bold = undefined;
      state.dim = undefined;
    } else if (p === 23) state.italic = undefined;
    else if (p === 24) state.underline = undefined;
    else if (p === 27) state.reverse = undefined;
    else if (p === 29) state.strike = undefined;
    else if (p >= 30 && p <= 37) state.fg = PALETTE[p - 30];
    else if (p === 38) {
      const mode = list[i + 1];
      if (mode === 5 && list[i + 2] !== undefined) {
        state.fg = color256(list[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        state.fg = `rgb(${list[i + 2] ?? 0},${list[i + 3] ?? 0},${list[i + 4] ?? 0})`;
        i += 4;
      }
    } else if (p === 39) state.fg = undefined;
    else if (p >= 40 && p <= 47) state.bg = PALETTE[p - 40];
    else if (p === 48) {
      const mode = list[i + 1];
      if (mode === 5 && list[i + 2] !== undefined) {
        state.bg = color256(list[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        state.bg = `rgb(${list[i + 2] ?? 0},${list[i + 3] ?? 0},${list[i + 4] ?? 0})`;
        i += 4;
      }
    } else if (p === 49) state.bg = undefined;
    else if (p >= 90 && p <= 97) state.fg = PALETTE[p - 90 + 8];
    else if (p >= 100 && p <= 107) state.bg = PALETTE[p - 100 + 8];
  }
}

function styleKey(s: Sgr): string {
  return [
    s.fg ?? "",
    s.bg ?? "",
    s.bold ? "b" : "",
    s.dim ? "d" : "",
    s.italic ? "i" : "",
    s.underline ? "u" : "",
    s.strike ? "s" : "",
    s.reverse ? "r" : "",
  ].join("|");
}

function toCss(s: Sgr): CSSProperties {
  let fg = s.fg ?? DEFAULT_FG;
  let bg = s.bg;
  if (s.reverse) {
    const effBg = s.bg ?? DEFAULT_BG;
    bg = fg;
    fg = effBg;
  }
  const css: CSSProperties = { color: fg };
  if (bg) css.backgroundColor = bg;
  if (s.bold) css.fontWeight = 700;
  if (s.dim) css.opacity = 0.62;
  if (s.italic) css.fontStyle = "italic";
  const deco: string[] = [];
  if (s.underline) deco.push("underline");
  if (s.strike) deco.push("line-through");
  if (deco.length > 0) css.textDecoration = deco.join(" ");
  return css;
}

interface Run {
  text: string;
  key: string;
  css: CSSProperties;
  href?: string;
}

interface CursorPos {
  line: number;
  col: number;
}

// ---- link detection -------------------------------------------------------
// URLs in terminal output are plain text, and a long one wraps across
// several screen rows: tmux hands back each row separately, so a wrapped
// URL arrives as one fragment per line. A fragment that runs to the very
// end of a full-width row continues on the next row at the SAME indent
// (some TUIs, for one, indent a sign-in URL by one space on every row) —
// that is the stitch rule used here. Every fragment becomes its own <a>,
// but all fragments share the single reconstructed href, so tapping any
// piece of a wrapped URL opens the complete link.

interface LinkSegment {
  line: number;
  start: number;
  end: number;
}

interface FoundLink {
  href: string;
  segments: LinkSegment[];
}

// Characters a wrapped fragment may start with on the next row. Notably
// excludes "(", "[", "{" and quotes, so a footer or a new parenthetical
// line right after a full-width URL row is not stitched into the link.
const CONTINUATION_FIRST = /[A-Za-z0-9%\-._~/?#@!$&'*+,;=]/;
const TOKEN = /^[^\s<>"'`]+/;

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function finishLink(rawHref: string, segments: LinkSegment[]): FoundLink | null {
  let href = rawHref;
  const segs = segments.map((s) => ({ ...s }));
  // Drop trailing sentence punctuation and unmatched closing brackets
  // from the final fragment only (never from a mid-link wrap point,
  // because finishLink runs only once the link is known to be over).
  while (href.length > 0) {
    const last = href[href.length - 1] ?? "";
    const drop =
      last === "." ||
      last === "," ||
      last === ";" ||
      last === ":" ||
      last === "!" ||
      last === "?" ||
      (last === ")" && countChar(href, "(") < countChar(href, ")")) ||
      (last === "]" && countChar(href, "[") < countChar(href, "]")) ||
      (last === "}" && countChar(href, "{") < countChar(href, "}"));
    if (!drop) break;
    href = href.slice(0, -1);
    const seg = segs[segs.length - 1];
    if (!seg) break;
    seg.end -= 1;
    if (seg.end <= seg.start) segs.pop();
  }
  if (segs.length === 0) return null;
  const full = href.startsWith("www.") ? `https://${href}` : href;
  try {
    const u = new URL(full);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
  } catch {
    return null;
  }
  return { href: full, segments: segs };
}

function findLinks(plain: string[], cols: number | undefined): FoundLink[] {
  const wrapWidth =
    cols && cols > 0 ? cols : Math.max(1, ...plain.map((l) => l.length));
  const isFull = (line: string) =>
    line.length > 0 && line.length >= wrapWidth - 1;
  const links: FoundLink[] = [];
  let active: {
    href: string;
    segments: LinkSegment[];
    indent: number;
  } | null = null;

  const finishActive = () => {
    if (!active) return;
    const done = finishLink(active.href, active.segments);
    if (done) links.push(done);
    active = null;
  };

  for (let li = 0; li < plain.length; li++) {
    const line = plain[li] ?? "";
    let scanFrom = 0;

    if (active) {
      const indent = line.match(/^ */)?.[0].length ?? 0;
      const restLine = line.slice(indent);
      const token =
        indent === active.indent && CONTINUATION_FIRST.test(restLine[0] ?? "")
          ? (restLine.match(TOKEN)?.[0] ?? "")
          : "";
      if (token) {
        active.href += token;
        active.segments.push({
          line: li,
          start: indent,
          end: indent + token.length,
        });
        active.indent = indent;
        scanFrom = indent + token.length;
        // The link ends here unless this row is also filled edge to edge
        // by the fragment, in which case it wraps again.
        if (scanFrom < line.length || !isFull(line)) finishActive();
      } else {
        finishActive();
      }
    }

    const rest = line.slice(scanFrom);
    const re = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      const start = scanFrom + m.index;
      const token = m[0];
      const end = start + token.length;
      const candidate = {
        href: token,
        segments: [{ line: li, start, end }],
        indent: line.match(/^ */)?.[0].length ?? 0,
      };
      if (end >= line.length && isFull(line)) {
        // Runs off the right edge of a full row: probably wrapped.
        active = candidate;
      } else {
        const done = finishLink(candidate.href, candidate.segments);
        if (done) links.push(done);
      }
    }
  }
  finishActive();
  return links;
}

const ANSI_STRIP =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b./g;

/**
 * The links visible in a captured screen, deduplicated, in order of
 * appearance — each one the full URL reassembled across wrapped rows.
 * Used for the copy-link bar under the terminal pane.
 */
export function extractTerminalLinks(
  text: string,
  cols?: number,
): string[] {
  const plain = text
    .split("\n")
    .map((l) => l.replace(ANSI_STRIP, "").replace(/\r/g, ""));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of findLinks(plain, cols)) {
    if (!seen.has(link.href)) {
      seen.add(link.href);
      out.push(link.href);
    }
  }
  return out;
}

function linkCss(css: CSSProperties): CSSProperties {
  const deco =
    typeof css.textDecoration === "string" ? css.textDecoration : "";
  return {
    ...css,
    textDecoration: deco.includes("underline")
      ? deco
      : `${deco} underline`.trim(),
  };
}

function applyLinks(lines: Run[][], links: FoundLink[]): Run[][] {
  if (links.length === 0) return lines;
  const byLine = new Map<number, { start: number; end: number; href: string }[]>();
  for (const link of links) {
    for (const seg of link.segments) {
      const arr = byLine.get(seg.line) ?? [];
      arr.push({ start: seg.start, end: seg.end, href: link.href });
      byLine.set(seg.line, arr);
    }
  }
  return lines.map((runs, li) => {
    const spans = byLine.get(li);
    if (!spans) return runs;
    const out: Run[] = [];
    let col = 0;
    for (const run of runs) {
      const runEnd = col + run.text.length;
      let offset = 0;
      while (offset < run.text.length) {
        const at = col + offset;
        const containing = spans.find((s) => at >= s.start && at < s.end);
        let segEnd: number;
        if (containing) {
          segEnd = Math.min(runEnd, containing.end);
        } else {
          const nextStart = spans
            .filter((s) => s.start > at)
            .map((s) => s.start)
            .sort((a, b) => a - b)[0];
          segEnd = nextStart !== undefined ? Math.min(runEnd, nextStart) : runEnd;
        }
        const text = run.text.slice(offset, segEnd - col);
        if (text) {
          out.push(
            containing
              ? { text, key: run.key, css: linkCss(run.css), href: containing.href }
              : { text, key: run.key, css: run.css },
          );
        }
        offset = segEnd - col;
      }
      col = runEnd;
    }
    return out;
  });
}

/**
 * Render captured ANSI text as React lines. `cursor` is the 0-based
 * line/column within the rendered lines; the character there (or a fresh
 * cell past end-of-line) is painted as the terminal cursor.
 */
export function renderAnsiScreen(
  text: string,
  cursor: CursorPos | null,
  cols?: number,
  linePx: number = 12,
): ReactNode {
  const rawLines = text.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const state: Sgr = {};
  const lines: Run[][] = [];
  let current: Run[] = [];
  let currentKey = styleKey(state);
  let currentCss = toCss(state);
  let buf = "";

  const flush = () => {
    if (buf.length > 0) {
      current.push({ text: buf, key: currentKey, css: currentCss });
      buf = "";
    }
  };
  const refreshStyle = () => {
    currentKey = styleKey(state);
    currentCss = toCss(state);
  };

  for (const rawLine of rawLines) {
    let i = 0;
    while (i < rawLine.length) {
      const ch = rawLine[i] ?? "";
      if (ch === "\x1b") {
        const next = rawLine[i + 1] ?? "";
        if (next === "[") {
          let j = i + 2;
          while (j < rawLine.length && !/[A-Za-z@`]/.test(rawLine[j] ?? "")) {
            j++;
          }
          const finalChar = rawLine[j] ?? "";
          if (finalChar === "m") {
            flush();
            const paramStr = rawLine.slice(i + 2, j);
            const params =
              paramStr === ""
                ? []
                : paramStr
                    .split(";")
                    .map((v) => Number.parseInt(v, 10) || 0);
            applySgr(state, params);
            refreshStyle();
          }
          i = j + 1;
          continue;
        }
        if (next === "]") {
          // OSC: skip to BEL or ST.
          let j = i + 2;
          while (
            j < rawLine.length &&
            rawLine[j] !== "\x07" &&
            !(rawLine[j] === "\x1b" && rawLine[j + 1] === "\\")
          ) {
            j++;
          }
          i = rawLine[j] === "\x1b" ? j + 2 : j + 1;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === "\r") {
        i++;
        continue;
      }
      buf += ch;
      i++;
    }
    flush();
    lines.push(current);
    current = [];
  }

  // Linkify: stitch URLs across wrapped rows and mark every fragment
  // with the full reconstructed href.
  const plainLines = lines.map((runs) => runs.map((r) => r.text).join(""));
  const linkedLines = applyLinks(lines, findLinks(plainLines, cols));

  // Inject the cursor by splitting the run that contains its column.
  if (cursor && cursor.line >= 0 && cursor.line < linkedLines.length) {
    const line = linkedLines[cursor.line] ?? [];
    let col = 0;
    let done = false;
    for (let r = 0; r < line.length && !done; r++) {
      const run = line[r];
      if (!run) continue;
      const runEnd = col + run.text.length;
      if (cursor.col < runEnd) {
        const at = cursor.col - col;
        const before = run.text.slice(0, at);
        const charAt = run.text.slice(at, at + 1);
        const after = run.text.slice(at + 1);
        const cursorRun: Run = {
          text: charAt,
          key: "cursor",
          css: {
            backgroundColor: "rgba(242,243,247,0.92)",
            color: "#0b0d12",
          },
        };
        const replacement: Run[] = [];
        if (before) replacement.push({ ...run, text: before });
        replacement.push(cursorRun);
        if (after) replacement.push({ ...run, text: after });
        line.splice(r, 1, ...replacement);
        done = true;
      }
      col = runEnd;
    }
    if (!done) {
      line.push({
        text: " ",
        key: "cursor",
        css: {
          backgroundColor: "rgba(242,243,247,0.92)",
          color: "#0b0d12",
        },
      });
    }
  }

  return (
    <>
      {linkedLines.map((runs, li) => (
        <div
          key={li}
          className="whitespace-pre"
          style={{ minHeight: linePx, lineHeight: `${linePx}px` }}
        >
          {runs.length === 0
            ? "\u00a0"
            : runs.map((run, ri) =>
                run.key === "cursor" ? (
                  <span key={ri} className="term-cursor-cell" style={run.css}>
                    {run.text}
                  </span>
                ) : run.href ? (
                  <a
                    key={ri}
                    href={run.href}
                    target="_blank"
                    rel="noreferrer"
                    title={run.href}
                    aria-label={`Open link: ${run.href}`}
                    onClick={(e) => e.stopPropagation()}
                    style={run.css}
                  >
                    {run.text}
                  </a>
                ) : (
                  <span key={ri} style={run.css}>
                    {run.text}
                  </span>
                ),
              )}
        </div>
      ))}
    </>
  );
}
