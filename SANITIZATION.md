# Sanitization strip list

Everything removed or generalized before this code left the original environment. Check a fork against this list before publishing.

## Removed outright

1. Hostnames, tailnet names, and IP addresses of the original machines.
2. Account names, email addresses, and OAuth client details.
3. API keys, tokens, session cookies, and credential helper configuration.
4. Personal file paths and home directory names (replaced with generic placeholders).
5. Fleet-specific identifiers: agent names, seat ids, internal URLs, and workspace goal paths.
6. Any terminal scrollback, session logs, or captured output from the original build.

## Generalized

1. The tmux session name is the generic default `vmterm`.
2. Branding reduced to the product name "Muse VM Terminal" only.
3. Example commands use placeholder CLIs, not the original environment's agent tooling.

## Verified before publish

1. Full-text sweep for the original environment's identifiers returns zero hits.
2. The build runs clean from a fresh checkout with no local configuration present.
3. Exactly one clean initial commit in the private repo before any public step.
