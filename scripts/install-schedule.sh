#!/usr/bin/env bash
#
# Installs the RTS Audit daily job as a macOS LaunchAgent.
#
# launchd (not cron) on purpose: if the Mac is asleep at the scheduled time,
# launchd runs the job as soon as it wakes. cron just silently skips the day.
#
#   npm run schedule:install          # default: every day at 07:00 local time
#   RUN_HOUR=3 RUN_MINUTE=30 npm run schedule:install
#
set -euo pipefail

LABEL="com.handatransportation.rtsaudit"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUN_HOUR="${RUN_HOUR:-7}"
RUN_MINUTE="${RUN_MINUTE:-0}"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH." >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/.env" ]]; then
  echo "error: $REPO_DIR/.env is missing — the job would fail on every run." >&2
  echo "       cp .env.example .env  and fill it in first." >&2
  exit 1
fi

mkdir -p "$REPO_DIR/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO_DIR/daily.js</string>
    </array>

    <!-- index.js resolves paths off its own location, but keep CWD sane anyway -->
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>$RUN_HOUR</integer>
        <key>Minute</key>
        <integer>$RUN_MINUTE</integer>
    </dict>

    <!-- Don't fire the moment this is installed; wait for the scheduled time -->
    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>$REPO_DIR/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO_DIR/logs/launchd.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST_EOF

# Replace any previous copy, then register.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

printf '\nInstalled: %s\n' "$PLIST"
printf 'Schedule:  every day at %02d:%02d (%s)\n' "$RUN_HOUR" "$RUN_MINUTE" "$(date +%Z)"
printf 'Node:      %s\n' "$NODE_BIN"
printf 'Logs:      %s/logs/\n\n' "$REPO_DIR"
printf 'Verify:    npm run schedule:status\n'
printf 'Run now:   launchctl kickstart -k gui/%s/%s\n' "$UID" "$LABEL"
printf 'Remove:    npm run schedule:uninstall\n'
