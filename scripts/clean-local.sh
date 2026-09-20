#!/usr/bin/env bash
#
# clean-local.sh — wipe every trace of a local Glyphh install so you can test a
# fresh DEV (`npm run dev`) or packaged/PROD build from a clean slate. Both run
# under the same productName ("Glyphh Desktop") and the same data dir
# (~/.glyphh), so one script covers both.
#
# Safe to run repeatedly; a missing item is fine. Covers every naming era the
# app has shipped under (yosup -> glyphh-apps -> Glyphh Desktop) and the legacy
# ~/yo data dir, so old installs can't leak state into a new build.
#
# Usage:
#   npm run clean:local              # delete everything below
#   npm run clean:local -- --dry-run # print what WOULD be deleted, delete nothing
#   scripts/clean-local.sh [-n|--dry-run]
#
# macOS only (uses ~/Library and the `security` keychain tool).

set -uo pipefail

DRY_RUN=0
case "${1:-}" in
  -n|--dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "unknown argument: $1 (use --dry-run)"; exit 2 ;;
esac

APP_SUPPORT="$HOME/Library/Application Support"
CACHES="$HOME/Library/Caches"
LOGS="$HOME/Library/Logs"
SAVED_STATE="$HOME/Library/Saved Application State"
PREFS="$HOME/Library/Preferences"
HTTP_STORAGES="$HOME/Library/HTTPStorages"

# Home data dirs the client has used (current first).
DATA_DIRS=(
  "$HOME/.glyphh"   # current
  "$HOME/yo"        # legacy (pre-Glyphh branding)
)

# Electron app-name-based dirs (userData / caches / logs), across every productName.
APP_NAMES=(
  "Glyphh Desktop"
  "Glyphh"
  "glyphh-apps"
  "glyphh"
  "yosup"
  "Yo"
)

# Bundle IDs the app has shipped under (Saved State, Preferences, HTTP storage).
BUNDLE_IDS=(
  "ai.glyphh.desktop"
  "dev.yosup.client"
)

# safeStorage keychain item labels, across every era.
KEYCHAIN_LABELS=(
  "Glyphh Desktop Safe Storage"
  "Glyphh Safe Storage"
  "glyphh-apps Safe Storage"
  "glyphh Safe Storage"
  "yosup Safe Storage"
)

# ── helpers ──────────────────────────────────────────────────
rm_path() {
  local p="$1"
  [[ -e "$p" ]] || return 0
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  would remove   $p"
  else
    rm -rf "$p" && echo "  removed        $p"
  fi
}

# ── 0. quit any running instance ─────────────────────────────
echo "▸ Quitting Glyphh (if running)…"
if [[ $DRY_RUN -eq 0 ]]; then
  osascript -e 'quit app "Glyphh Desktop"' >/dev/null 2>&1 || true
  sleep 1
  # Force any stragglers: the packaged .app helpers and the dev `electron .`
  # process. Both patterns are specific enough not to match this script.
  pkill -f "Glyphh Desktop.app" 2>/dev/null || true
  pkill -f "glyphh-apps/node_modules/electron" 2>/dev/null || true
else
  echo "  (dry run — not quitting)"
fi

# ── 1. home data dirs ────────────────────────────────────────
echo "▸ App data dirs (session, custom apps, layouts, local DBs, model cache)…"
for d in "${DATA_DIRS[@]}"; do rm_path "$d"; done

# ── 2. Electron userData / caches / logs / plists ────────────
echo "▸ Electron userData, caches, logs, prefs…"
for name in "${APP_NAMES[@]}"; do
  rm_path "$APP_SUPPORT/$name"
  rm_path "$CACHES/$name"
  rm_path "$LOGS/$name"
  rm_path "$PREFS/$name.plist"
done

echo "▸ Bundle-ID artifacts (saved window state, prefs, HTTP storage)…"
for id in "${BUNDLE_IDS[@]}"; do
  rm_path "$SAVED_STATE/$id.savedState"
  rm_path "$PREFS/$id.plist"
  rm_path "$HTTP_STORAGES/$id"
done

# ── 3. safeStorage keychain keys ─────────────────────────────
echo "▸ Keychain (safeStorage) keys…"
for label in "${KEYCHAIN_LABELS[@]}"; do
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  would delete   keychain item \"$label\""
  elif security delete-generic-password -l "$label" >/dev/null 2>&1; then
    echo "  deleted        keychain item \"$label\""
  fi
done

# ── 4. the CLI Installer's done flag (lives on the SERVER, per user) ───────
# Preferences are server-side, so a wiped machine still skips the installer
# on its next launch (2026-09-20). On a dev box the server is the local child;
# clear the flag there for every user so the next launch is a first run.
echo "▸ CLI Installer first-run flag (local child server)…"
DB_CONTAINER="glyphh-child-child-db-1"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
  for schema in $(docker exec "$DB_CONTAINER" psql -U litellm -d litellm -Atc "select nspname from pg_namespace where nspname like 'org\_%'" 2>/dev/null); do
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "  would clear    cliSetupDoneAt in $schema.glyphh_user_prefs"
    else
      n=$(docker exec "$DB_CONTAINER" psql -U litellm -d litellm -Atc "with u as (update $schema.glyphh_user_prefs set prefs = prefs - 'cliSetupDoneAt' where prefs ? 'cliSetupDoneAt' returning 1) select count(*) from u" 2>/dev/null || echo 0)
      echo "  cleared        cliSetupDoneAt for $n user(s) in $schema"
    fi
  done
else
  echo "  (local child DB not running — the flag on the server stays; clear it from the console or run the child first)"
fi

echo ""
if [[ $DRY_RUN -eq 1 ]]; then
  echo "✓ Dry run complete — nothing was deleted."
else
  echo "✓ Local Glyphh state cleaned. Next launch starts fresh (re-login + re-enter config vars)."
fi
