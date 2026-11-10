#!/usr/bin/env bash
# cli-routes.sh: make every installed CLI callable by its plain name.
#
# The wall this removes: agent CLIs often install under a different
# on-disk shape than the name you type. The real binary lands as
# <name>-real behind a hand-made wrapper, or in a directory the login
# shell never puts on PATH (~/.bun/bin, ~/.cargo/bin, an npm prefix).
# Type the plain name in the terminal and the shell says "command not
# found", even though the tool is installed and works. First-time
# users hit that wall and give up.
#
# The fix is a shim directory that sits first on PATH. For every tool
# the installer finds, it writes a tiny shim named by the plain name
# that execs the real binary, prepending any flags the registry sets
# for that tool. Plain name in, real binary out, for any CLI.
#
# Usage:
#   cli-routes.sh install   write shims + PATH blocks (default)
#   cli-routes.sh refresh   regenerate shims only (after installing a CLI)
#   cli-routes.sh doctor    report how each known name resolves
#
# Everything is idempotent and reversible: delete the shim directory
# and the two marked blocks in ~/.bashrc and ~/.profile to undo.

set -u

STATE_HOME="${CLI_ROUTES_HOME:-$HOME/.local/share/muse-vm-terminal}"
SHIM_DIR="$STATE_HOME/shims"
MARK="# muse-vm-terminal cli-route shim v1"
BLOCK_BEGIN="# >>> muse-vm-terminal cli-routes >>>"
BLOCK_END="# <<< muse-vm-terminal cli-routes <<<"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${CLI_ROUTES_CONF:-}" ]; then
  CONF="$CLI_ROUTES_CONF"
elif [ -f "$SCRIPT_DIR/cli-routes.conf" ]; then
  CONF="$SCRIPT_DIR/cli-routes.conf"
else
  CONF="$SCRIPT_DIR/cli-routes.conf.example"
fi

# The caller's own PATH dirs (minus the shim dir). A plain name only
# counts as already callable when it resolves in one of these.
path_dirs() {
  printf '%s\n' "$PATH" | tr ':' '\n' | awk 'NF && !seen[$0]++' \
    | grep -v "^$SHIM_DIR\$" || true
}

# Directories searched for real binaries: the caller's PATH plus the
# usual per-user install dirs a login shell often misses.
search_dirs() {
  {
    path_dirs
    printf '%s\n' \
      "$HOME/.local/bin" "$HOME/.bun/bin" "$HOME/.cargo/bin" \
      "$HOME/go/bin" "$HOME/.npm-global/bin" "/usr/local/bin"
  } | awk 'NF && !seen[$0]++'
}

is_our_shim() {
  [ -f "$1" ] && grep -q "$MARK" "$1" 2>/dev/null
}

# Echo the real binary for a plain name: <name>-real anywhere wins,
# then a direct <name> that is not one of our shims.
resolve_real() {
  local name="$1" dir
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if [ -x "$dir/$name-real" ]; then printf '%s\n' "$dir/$name-real"; return 0; fi
  done <<EOF
$(search_dirs)
EOF
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if [ -x "$dir/$name" ] && ! is_our_shim "$dir/$name"; then
      printf '%s\n' "$dir/$name"; return 0
    fi
  done <<EOF
$(search_dirs)
EOF
  return 1
}

flags_for() {
  [ -f "$CONF" ] || return 0
  awk -v n="$1" '$1 == n { $1=""; sub(/^ +/, ""); print }' "$CONF"
}

registry_names() {
  [ -f "$CONF" ] || return 0
  awk 'NF && $1 !~ /^#/ { print $1 }' "$CONF"
}

# Candidate names: the registry plus every <name>-real on disk.
candidate_names() {
  {
    registry_names
    local dir base
    while IFS= read -r dir; do
      [ -d "$dir" ] || continue
      for f in "$dir"/*-real; do
        [ -e "$f" ] || continue
        base="$(basename "$f")"
        printf '%s\n' "${base%-real}"
      done
    done <<EOF
$(search_dirs)
EOF
  } | awk 'NF && !seen[$0]++'
}

write_shim() {
  local name="$1" target="$2" flags="$3"
  mkdir -p "$SHIM_DIR"
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$MARK"
    if [ -n "$flags" ]; then
      printf 'exec "%s" %s "$@"\n' "$target" "$flags"
    else
      printf 'exec "%s" "$@"\n' "$target"
    fi
  } > "$SHIM_DIR/$name"
  chmod +x "$SHIM_DIR/$name"
}

generate_shims() {
  local name target flags existing
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    target="$(resolve_real "$name")" || { printf 'skip   %s (not installed)\n' "$name"; continue; }
    flags="$(flags_for "$name")"
    # "existing" counts only executables under the plain name that a
    # shell would actually find: the caller's PATH, not the wider
    # search dirs. A binary sitting off PATH (an npm prefix, a bun or
    # cargo bin dir) is installed but NOT callable, so it still gets
    # a shim.
    existing=""
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      if [ -x "$dir/$name" ] && ! is_our_shim "$dir/$name"; then existing="$dir/$name"; break; fi
    done <<EOF
$(path_dirs)
EOF
    if [ -z "$flags" ] && [ -n "$existing" ] && [ "$existing" = "$target" ]; then
      printf 'direct %s -> %s (already callable, no shim needed)\n' "$name" "$target"
      continue
    fi
    if [ -z "$flags" ] && [ -n "$existing" ] && [ "$existing" != "$target" ]; then
      printf 'manual %s -> %s exists; leaving it, target is %s\n' "$name" "$existing" "$target"
      continue
    fi
    write_shim "$name" "$target" "$flags"
    printf 'shim   %s -> %s%s\n' "$name" "$target" "${flags:+ $flags}"
  done <<EOF
$(candidate_names)
EOF
}

ensure_path_block() {
  local file="$1"
  [ -f "$file" ] || : > "$file"
  if grep -qF "$BLOCK_BEGIN" "$file"; then
    printf 'path   %s already carries the cli-routes block\n' "$file"
    return 0
  fi
  {
    printf '\n%s\n' "$BLOCK_BEGIN"
    printf 'export PATH="%s:$PATH"\n' "$SHIM_DIR"
    printf '%s\n' "$BLOCK_END"
  } >> "$file"
  printf 'path   %s updated (shims first on PATH)\n' "$file"
}

doctor() {
  local name target
  printf 'shim dir: %s\n' "$SHIM_DIR"
  printf 'registry: %s\n\n' "$CONF"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [ -x "$SHIM_DIR/$name" ]; then
      target="$(grep '^exec' "$SHIM_DIR/$name" | sed 's/^exec //')"
      printf '%-12s shim -> %s\n' "$name" "$target"
      continue
    fi
    target=""
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      if [ -x "$dir/$name" ] && ! is_our_shim "$dir/$name"; then target="$dir/$name"; break; fi
    done <<EOF2
$(path_dirs)
EOF2
    if [ -n "$target" ]; then
      printf '%-12s direct -> %s (callable, no shim)\n' "$name" "$target"
    elif target="$(resolve_real "$name")"; then
      printf '%-12s OFF PATH -> %s (installed but not callable; run install or refresh)\n' "$name" "$target"
    else
      printf '%-12s NOT FOUND (not installed in any searched dir)\n' "$name"
    fi
  done <<EOF
$(candidate_names)
EOF
}

case "${1:-install}" in
  install)
    ensure_path_block "$HOME/.bashrc"
    ensure_path_block "$HOME/.profile"
    generate_shims
    printf '\nDone. Open a new terminal session (or restart the VM Terminal\n'
    printf 'session) so the login shell picks up the PATH block, then run\n'
    printf '"%s doctor" to verify every name resolves.\n' "$0"
    ;;
  refresh)
    generate_shims
    ;;
  doctor)
    doctor
    ;;
  *)
    printf 'usage: %s [install|refresh|doctor]\n' "$0" >&2
    exit 2
    ;;
esac
