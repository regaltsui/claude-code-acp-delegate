#!/bin/sh
# claude-code-acp-delegate: statusLine script
#
# Add to ~/.claude/settings.json to show in-flight ACP delegations:
#   {
#     "statusLine": {
#       "type": "command",
#       "command": "/absolute/path/to/claude-code-acp-delegate/scripts/status-line.sh"
#     }
#   }
#
# Prints a single line like "acp: 2 inflight (gemini 12s, claude 4s)"
# when delegations are in flight. Prints nothing when idle.
#
# State file path resolution:
#   1. $CLAUDE_ACP_DELEGATE_STATE_DIR/state.json
#   2. $XDG_STATE_HOME/claude/acp-delegate/state.json
#   3. $HOME/.local/state/claude/acp-delegate/state.json

# Resolve state file path
if [ -n "${CLAUDE_ACP_DELEGATE_STATE_DIR:-}" ]; then
  STATE_FILE="${CLAUDE_ACP_DELEGATE_STATE_DIR}/state.json"
elif [ -n "${XDG_STATE_HOME:-}" ]; then
  STATE_FILE="${XDG_STATE_HOME}/claude/acp-delegate/state.json"
else
  STATE_FILE="${HOME}/.local/state/claude/acp-delegate/state.json"
fi

[ -r "$STATE_FILE" ] || exit 0

NOW_S=$(date +%s)

if command -v jq >/dev/null 2>&1; then
  COUNT=$(jq '.inflight | length' "$STATE_FILE" 2>/dev/null) || exit 0
  [ "${COUNT:-0}" -gt 0 ] || exit 0
  SUMMARY=$(jq -r --argjson now "${NOW_S}000" '
    .inflight[0:3] | map(
      .agentId + " " + (($now - .startedAt) / 1000 | floor | tostring) + "s"
    ) | join(", ")
  ' "$STATE_FILE" 2>/dev/null) || exit 0
  printf 'acp: %s inflight (%s)\n' "$COUNT" "$SUMMARY"

elif command -v node >/dev/null 2>&1; then
  node - "$STATE_FILE" "$NOW_S" 2>/dev/null <<'JSEOF'
const fs = require('fs');
let state;
try { state = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); } catch { process.exit(0); }
const inflight = state.inflight || [];
if (!inflight.length) process.exit(0);
const nowMs = parseInt(process.argv[2], 10) * 1000;
const top3 = inflight.slice(0, 3).map(e => e.agentId + ' ' + Math.floor((nowMs - e.startedAt) / 1000) + 's').join(', ');
process.stdout.write('acp: ' + inflight.length + ' inflight (' + top3 + ')\n');
JSEOF

elif command -v python3 >/dev/null 2>&1; then
  python3 - "$STATE_FILE" "$NOW_S" 2>/dev/null <<'PYEOF'
import sys, json, math
try:
    with open(sys.argv[1]) as f:
        state = json.load(f)
except Exception:
    sys.exit(0)
inflight = state.get('inflight', [])
if not inflight:
    sys.exit(0)
now_ms = int(sys.argv[2]) * 1000
top3 = [e['agentId'] + ' ' + str(math.floor((now_ms - e['startedAt']) / 1000)) + 's' for e in inflight[:3]]
print('acp: ' + str(len(inflight)) + ' inflight (' + ', '.join(top3) + ')')
PYEOF

fi

exit 0
