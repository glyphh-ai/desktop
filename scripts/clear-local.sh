#!/usr/bin/env bash
#
# clear-local.sh — wipe ALL local Glyphh Desktop state. No backup, no prompts.
#
# Deletes the session, chats, layouts, panel logins, preferences, caches and
# logs. The app bundle in /Applications is untouched; next launch is a
# first-run. (Want your setup back afterward? That's fresh-install.sh backup.)
#
set -euo pipefail
[[ "$(uname)" == "Darwin" ]] || { echo "macOS only."; exit 1; }

# The app must be closed — it writes state on quit and would resurrect it.
if pgrep -f "Glyphh Desktop.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "✗ Glyphh Desktop is running (check the menu-bar tray too). Quit it, then re-run." >&2
  exit 1
fi
# Reap orphaned helpers holding files under the support dir.
strays=$(pgrep -f "llama-server.*Glyphh Desktop" || true)
[[ -n "$strays" ]] && { kill $strays 2>/dev/null || true; sleep 1; }

rm -rf \
  "$HOME/.glyphh" \
  "$HOME/Library/Application Support/Glyphh Desktop" \
  "$HOME/Library/Caches/ai.glyphh.desktop" \
  "$HOME/Library/Caches/ai.glyphh.desktop.ShipIt" \
  "$HOME/Library/Caches/glyphh-apps-updater" \
  "$HOME/Library/Logs/Glyphh" \
  "$HOME/Library/Preferences/ai.glyphh.desktop.plist" \
  "$HOME/Library/Saved Application State/ai.glyphh.desktop.savedState"

echo "✓ local state cleared — next launch is a first-run."
