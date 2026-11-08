# Muse VM Terminal

A real interactive terminal into your Muse VM, built as a Muse Space.

Not a one-shot command runner. The terminal is a persistent tmux session holding a real PTY with an interactive login shell: same user, same home directory, same PATH, same filesystem your Muse agent works in. Close the page and the session keeps running. Come back and it is exactly where you left it. Interactive TUIs (agents, editors, REPLs) work because the TTY is real.

## Why

Muse agents live in a Linux VM, but the chat surface is not a shell. This Space gives the human a first-class terminal into that same VM, sized for a phone first, with the controls a touch keyboard is missing.

## Features

1. Real PTY terminal backed by a persistent tmux session (default session name `vmterm`), joinable from any shell with `tmux attach`.
2. Desktop and Mobile views with two separate proportion systems wearing the same Liquid Glass skin. Desktop is spacious, drawn for desktop screens and in-car browsers. Mobile is compact and Termius-like: the terminal surface is edge to edge, typing goes straight into the terminal's own input line, and the key controls collapse into one slim strip.
3. Five skins: Dark Liquid Glass, Light Liquid Glass, Midnight OLED, Aurora, Crimson Vinyl. The reading pane stays deep dark in every skin so terminal text and ANSI colors stay crisp.
4. Per-view zoom with on-pane controls (Mobile defaults to 60 percent, Desktop to 75 percent), remembered per view.
5. Always-visible scrollbar rail on the terminal pane for moving through scrollback on touch devices, where native scrollbars hide.
6. Clickable links in terminal output, reassembled across wrapped lines, with a copy-link bar for URLs that run off screen (OAuth flows, long tokens).
7. Full special-keys strip: esc, tab, all four arrows, ^C ^D ^Z ^L, backspace, enter, plus a live-keys mode that sends every keystroke straight into the PTY.
8. Number row (1 to 0) for one-tap answers to multiple-choice prompts inside terminal apps.
9. Keyboard-fitted Mobile layout: the terminal flexes to the visible viewport above the phone keyboard; nothing important is ever covered.

## How it works

The Space is a fullstack Muse artifact. Its server actions bridge the web client to a tmux session on the VM:

1. The client renders terminal output polled from the session and sends keystrokes, literal strings, and control sequences back.
2. The server runs `tmux` commands against the named session (`capture-pane` for output, `send-keys` for input), so the web terminal and a local `tmux attach` are two windows onto the same shell.

## Requirements

1. A Muse Space (fullstack artifact) running on the Muse VM.
2. `tmux` available on the VM.
3. Whatever CLIs you want to drive from the terminal (the terminal itself is shell-agnostic).

## Install

1. Copy the source into a new fullstack Space in your Muse workspace.
2. Point the session name in the server actions at your tmux session, or let it create the default.
3. Open the Space, pick Desktop or Mobile, and type.

## Security notes

1. This terminal is a shell on the VM with the VM user's full permissions. Treat access to the Space like SSH access, because it is.
2. The public repo is sanitized: no hostnames, accounts, tokens, personal paths, or environment-specific identifiers from the original build. Review `SANITIZATION.md` for the strip list before publishing your own fork.
3. Never commit your local session configuration, environment files, or credential helpers.

## License

MIT. See `LICENSE`.
