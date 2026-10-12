#!/bin/sh
# gateway installer. Read it before you run it; it is short.
#
#   curl -fsSL https://raw.githubusercontent.com/mudroom-ai/gateway/main/install.sh | sh
#
# What it does (no sudo, never deletes anything):
#   1. checks for git, npm and Node.js >= 22.13
#   2. clones the latest tagged release (v*.*.*, else main) into $GATEWAY_DIR
#      (default ~/gateway), or moves an existing checkout of the same repo to it
#      (if that fails it stops; config.json, .env and gateway.sqlite are left as they were)
#   3. npm ci, npm run build, npm prune --omit=dev
#   4. runs the setup wizard (npm run init) if a terminal is available; the
#      wizard introduces Gateway, asks what to set up, shows the booking
#      system's setup guide and prints the next steps. With a config.json
#      already there it asks first: keep it, review it or start over.
#      Without a terminal this script prints the next steps.
#
# Overrides: GATEWAY_REPO (git URL or path), GATEWAY_DIR,
# GATEWAY_REF (tag, branch or sha to install instead of the latest release, e.g. main).
#
# The body is wrapped in main() and called on the last line, so a truncated
# download runs nothing.
set -eu

REPO="${GATEWAY_REPO:-https://github.com/mudroom-ai/gateway}"
DIR="${GATEWAY_DIR:-$HOME/gateway}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# Compare repo URLs loosely: ignore a trailing "/" or ".git".
norm() { printf '%s' "$1" | sed -e 's#/*$##' -e 's#\.git$##'; }

need_node() {
  say "gateway needs Node.js 22.13 or newer ($1)." >&2
  say "Get it from https://nodejs.org/en/download, or with nvm: nvm install 24" >&2
  exit 1
}

# Port the gateway will listen on: the last uncommented PORT= line in .env, else 3000.
env_port() {
  p=""
  if [ -f .env ]; then
    p=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=//p' .env | tail -n 1 | tr -d "\"' \t\r")
  fi
  case "$p" in
    '' | *[!0-9]*) p=3000 ;;
  esac
  printf '%s' "$p"
}

# Next steps for the branches where the wizard did not run.
# Keep in step with the Next steps block in src/cli/init.ts (the wizard prints the canonical version).
trailer() {
  port=$(env_port)
  say ""
  say "Installed in $DIR."
  say ""
  say "Next steps:"
  say ""
  say "  1. Go to your gateway folder"
  say "       cd $DIR"
  [ -f config.json ] || say "       npm run init        # only if config.json is missing: what agents may do, booking system, business"
  say ""
  say "  2. Open a tunnel so Claude.ai or ChatGPT can reach it (skip if you only call it locally)"
  say "       cloudflared tunnel --url http://localhost:$port"
  say "     install: brew install cloudflared, or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"
  say "     It prints https://<tunnel-host>.trycloudflare.com. Add that host to .env:"
  say "       ALLOWED_HOSTS=<tunnel-host>.trycloudflare.com,localhost,127.0.0.1"
  say ""
  say "  3. Start the gateway"
  say "       npm start"
  say "     Check it locally:"
  say "       curl localhost:$port/api/services"
  say ""
  say "  4. Point your agent at the entry page"
  say "       https://<tunnel-host>.trycloudflare.com"
  say ""
  say "Details: $DIR/docs/deploy.md"
}

main() {
  # 1. Prerequisites
  command -v git >/dev/null 2>&1 || die "git not found; install git first"
  command -v node >/dev/null 2>&1 || need_node "node not found"
  command -v npm >/dev/null 2>&1 || die "npm not found; it ships with Node.js"
  ver=$(node -p 'process.versions.node')
  major=${ver%%.*}
  minor=${ver#*.}
  minor=${minor%%.*}
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
    need_node "found $ver"
  fi

  # 2. Fetch or update
  # Ref: GATEWAY_REF if set, else the highest vX.Y.Z tag on the remote, else main.
  # (sort -V is not on every BSD sort, so sort the three numbers by hand;
  # pre-release tags like v1.0.0-rc1 are skipped.)
  if [ -n "${GATEWAY_REF:-}" ]; then
    REF=$GATEWAY_REF
  else
    REF=$(git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null |
      sed -n 's#^.*refs/tags/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' |
      sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
    if [ -n "$REF" ]; then REF="v$REF"; else REF=main; fi
  fi
  say "==> Using ref $REF"

  if [ -e "$DIR" ]; then
    origin=$(git -C "$DIR" remote get-url origin 2>/dev/null || true)
    if [ -d "$DIR/.git" ] && [ -n "$origin" ] && [ "$(norm "$origin")" = "$(norm "$REPO")" ]; then
      say "==> Updating $DIR to $REF"
      {
        git -C "$DIR" fetch --tags origin &&
          { git -C "$DIR" checkout -q "$REF" 2>/dev/null ||
          { git -C "$DIR" fetch -q origin "$REF" && git -C "$DIR" checkout -q FETCH_HEAD; }; } &&
          { ! git -C "$DIR" symbolic-ref -q HEAD >/dev/null || git -C "$DIR" pull --ff-only; }
      } || {
        say "" >&2
        say "Your config.json, .env and gateway.sqlite in $DIR were not touched." >&2
        say "Stop the gateway, then either fix the checkout (git -C $DIR status) or set GATEWAY_DIR to a fresh path," >&2
        say "re-run this script, and copy config.json, .env and gateway.sqlite (plus -wal/-shm if present) into it." >&2
        die "could not update $DIR (could not move to $REF; see the message above)"
      }
    else
      die "$DIR already exists and is not a checkout of $REPO. Move it, or set GATEWAY_DIR to another path."
    fi
  else
    say "==> Cloning $REPO ($REF) into $DIR"
    # --branch takes a tag or branch; a commit sha needs the full clone.
    git clone --depth 1 --branch "$REF" "$REPO" "$DIR" 2>/dev/null || {
      git clone "$REPO" "$DIR" && git -C "$DIR" checkout -q "$REF" ||
        die "could not check out $REF from $REPO"
    }
  fi

  cd "$DIR"

  # 3. Build (dev deps are needed to compile, then dropped)
  say "==> Installing dependencies and building"
  npm ci --include=dev --no-audit --no-fund
  npm run build
  npm prune --omit=dev --no-audit --no-fund

  # 4. Setup wizard. Under `curl | sh` stdin is the script, so read answers from the terminal.
  if (exec </dev/tty) 2>/dev/null; then
    # The wizard prints its own Next steps; only say where the install lives.
    # With a config.json already there it first asks: keep it, review it or start over.
    say "==> Starting the setup wizard"
    npm run --silent init </dev/tty || say "The wizard did not finish. Run it again with: cd $DIR && npm run init"
    say ""
    say "Installed in $DIR."
  elif [ -f config.json ]; then
    say "==> config.json exists and there is no terminal to ask on; keeping it. Re-run the wizard with: cd $DIR && npm run init"
    trailer
  else
    say "==> No terminal available; skipping the setup wizard. Run it with:"
    say "    cd $DIR && npm run init"
    trailer
  fi
}

main "$@"
