#!/usr/bin/env bash
#
# fresh-install.sh — reset Glyphh Desktop to a pristine first-run (macOS).
#
# Wipes (or stashes) all LOCAL user state — session, chats, layouts, panel
# logins, caches — while leaving the app bundle in /Applications untouched.
# Made for demos/training videos: run `backup`, record the fresh install,
# then `restore` to get your real setup back.
#
#   scripts/fresh-install.sh backup    stash state aside (*.bak), app boots fresh
#   scripts/fresh-install.sh restore   bring the stashed state back
#   scripts/fresh-install.sh wipe      delete state permanently (asks first; -y skips)
#
set -euo pipefail

[[ "$(uname)" == "Darwin" ]] || { echo "macOS only."; exit 1; }

DATA_DIR="$HOME/.glyphh"
SUPPORT_DIR="$HOME/Library/Application Support/Glyphh Desktop"
# Pure caches/logs — never worth backing up; deleted in every mode.
EPHEMERAL=(
  "$HOME/Library/Caches/ai.glyphh.desktop"
  "$HOME/Library/Caches/ai.glyphh.desktop.ShipIt"
  "$HOME/Library/Caches/glyphh-apps-updater"
  "$HOME/Library/Logs/Glyphh"
  "$HOME/Library/Preferences/ai.glyphh.desktop.plist"
  "$HOME/Library/Saved Application State/ai.glyphh.desktop.savedState"
)

die() { echo "✗ $1" >&2; exit 1; }

# The app must not be running — it writes these dirs on quit and would
# resurrect (or corrupt) state mid-reset. Background/tray mode counts.
# Match the actual app BINARY, not any command line mentioning the phrase —
# helper processes (e.g. the llama-server embeddings child) carry model paths
# under ".../Glyphh Desktop/..." and would false-positive forever.
require_quit() {
  if pgrep -f "Glyphh Desktop.app/Contents/MacOS" >/dev/null 2>&1; then
    die "Glyphh Desktop is running (check the menu-bar tray too). Quit it, then re-run."
  fi
  # Orphaned helpers holding files under the support dir would survive the app
  # and block a clean move/delete — reap them instead of refusing.
  local strays
  strays=$(pgrep -f "llama-server.*Glyphh Desktop" || true)
  if [[ -n "$strays" ]]; then
    echo "· reaping orphaned helper process(es): $strays"
    kill $strays 2>/dev/null || true
    sleep 1
  fi
}

clear_ephemeral() {
  for p in "${EPHEMERAL[@]}"; do rm -rf "$p"; done
  echo "· caches, logs and window state cleared"
}

case "${1:-}" in
  backup)
    require_quit
    [[ -e "$DATA_DIR.bak" || -e "$SUPPORT_DIR.bak" ]] && die "a backup already exists — run 'restore' (or remove the *.bak dirs) first"
    [[ -e "$DATA_DIR" ]] && mv "$DATA_DIR" "$DATA_DIR.bak" && echo "· stashed $DATA_DIR"
    [[ -e "$SUPPORT_DIR" ]] && mv "$SUPPORT_DIR" "$SUPPORT_DIR.bak" && echo "· stashed $SUPPORT_DIR"
    clear_ephemeral
    echo "✓ fresh state — launch Glyphh Desktop for a first-run. 'restore' brings your setup back."
    ;;
  restore)
    require_quit
    [[ -e "$DATA_DIR.bak" || -e "$SUPPORT_DIR.bak" ]] || die "no backup found (nothing at *.bak)"
    rm -rf "$DATA_DIR" "$SUPPORT_DIR"          # drop whatever the demo created
    [[ -e "$DATA_DIR.bak" ]] && mv "$DATA_DIR.bak" "$DATA_DIR" && echo "· restored $DATA_DIR"
    [[ -e "$SUPPORT_DIR.bak" ]] && mv "$SUPPORT_DIR.bak" "$SUPPORT_DIR" && echo "· restored $SUPPORT_DIR"
    echo "✓ your setup is back."
    ;;
  wipe)
    require_quit
    if [[ "${2:-}" != "-y" ]]; then
      echo "This PERMANENTLY deletes your session, chats, layouts and panel logins."
      read -r -p "Type 'wipe' to confirm: " ans
      [[ "$ans" == "wipe" ]] || die "aborted — nothing touched"
    fi
    rm -rf "$DATA_DIR" "$SUPPORT_DIR"
    echo "· deleted $DATA_DIR"
    echo "· deleted $SUPPORT_DIR"
    clear_ephemeral
    echo "✓ factory-fresh — next launch is a first-run."
    ;;
  *)
    sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
