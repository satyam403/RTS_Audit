#!/usr/bin/env bash
#
# Removes the RTS Audit LaunchAgent. Leaves logs/ and auth-*.json alone.
#
set -euo pipefail

LABEL="com.handatransportation.rtsaudit"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "Removed $LABEL. The daily job will no longer run."
