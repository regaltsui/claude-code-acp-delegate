#!/bin/sh
# claude-code-acp-delegate: SessionStart hook
# Injects <acp-delegate-routing> block as session context if injectSystemGuidance=true.
# Stdout -> Claude Code session context. Silent on any error (exit 0).
#
# Config file resolution (first readable file wins):
#   1. $CLAUDE_ACP_DELEGATE_CONFIG
#   2. $HOME/.config/claude/acp-delegate.json
#   3. $HOME/.claude/acp-delegate.json

# Resolve config path
CONFIG_PATH=""
if [ -n "${CLAUDE_ACP_DELEGATE_CONFIG:-}" ] && [ -r "${CLAUDE_ACP_DELEGATE_CONFIG}" ]; then
  CONFIG_PATH="${CLAUDE_ACP_DELEGATE_CONFIG}"
elif [ -r "${HOME}/.config/claude/acp-delegate.json" ]; then
  CONFIG_PATH="${HOME}/.config/claude/acp-delegate.json"
elif [ -r "${HOME}/.claude/acp-delegate.json" ]; then
  CONFIG_PATH="${HOME}/.claude/acp-delegate.json"
fi

[ -z "$CONFIG_PATH" ] && exit 0

# Detect available JSON parser and emit routing block
if command -v jq >/dev/null 2>&1; then
  # Check injectSystemGuidance
  INJECT=$(jq -r '.injectSystemGuidance // false' "$CONFIG_PATH" 2>/dev/null) || exit 0
  [ "$INJECT" = "true" ] || exit 0

  # Verify agents exist
  COUNT=$(jq '.agents | length' "$CONFIG_PATH" 2>/dev/null) || exit 0
  [ "${COUNT:-0}" -gt 0 ] || exit 0

  # Build routing block
  printf '<acp-delegate-routing>\n'
  printf 'You can delegate self-contained tasks to one of these external coding agents:\n\n'
  jq -r '
    .agents[] |
    (
      (.whenToUse // "") as $wu |
      (.description // "") as $desc |
      (.label // .id) as $label |
      (.id | gsub("[^a-zA-Z0-9_]"; "_")) as $safeid |
      (
        if $wu != "" then $wu
        elif $desc != "" then ($desc | split(". ") | .[0])
        else "Delegate to \u0027" + $label + "\u0027 for a second opinion or bulk read-only analysis."
        end
      ) as $summary |
      "- `delegate_to_" + $safeid + "` \u2014 " + $summary
    )
  ' "$CONFIG_PATH" 2>/dev/null || exit 0
  printf '\nEach call spawns a fresh subprocess \342\200\224 the prompt must be self-contained, no session memory. Pass file/directory paths via `includeContext` to attach contents inline. Reach for delegation when offloading bulk read-only analysis (5+ files), getting an independent second opinion, or fanning out 3+ subtasks in parallel.\n\n'
  printf 'Skip when: simple grep/search, single-file edits with exact path, multi-turn chains.\n'
  printf '</acp-delegate-routing>\n'

elif command -v node >/dev/null 2>&1; then
  node - "$CONFIG_PATH" 2>/dev/null <<'JSEOF'
const fs = require('fs');
let config;
try { config = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); } catch { process.exit(0); }
if (config.injectSystemGuidance !== true) process.exit(0);
const agents = Array.isArray(config.agents) ? config.agents : [];
if (!agents.length) process.exit(0);
const lines = agents.map(a => {
  const safeid = String(a.id || '').replace(/[^a-zA-Z0-9_]/g, '_');
  const label = a.label || a.id || '';
  let summary = a.whenToUse || '';
  if (!summary && a.description) {
    const m = String(a.description).match(/^[^.!?]+[.!?]?/);
    summary = m ? m[0].trim() : String(a.description);
  }
  if (!summary) summary = "Delegate to '" + label + "' for a second opinion or bulk read-only analysis.";
  return '- `delegate_to_' + safeid + '` \u2014 ' + summary;
});
process.stdout.write(
  '<acp-delegate-routing>\n' +
  'You can delegate self-contained tasks to one of these external coding agents:\n\n' +
  lines.join('\n') +
  '\n\nEach call spawns a fresh subprocess \u2014 the prompt must be self-contained, no session memory. ' +
  'Pass file/directory paths via `includeContext` to attach contents inline. ' +
  'Reach for delegation when offloading bulk read-only analysis (5+ files), getting an independent second opinion, or fanning out 3+ subtasks in parallel.\n\n' +
  'Skip when: simple grep/search, single-file edits with exact path, multi-turn chains.\n' +
  '</acp-delegate-routing>\n'
);
JSEOF

elif command -v python3 >/dev/null 2>&1; then
  python3 - "$CONFIG_PATH" 2>/dev/null <<'PYEOF'
import sys, json, re
try:
    with open(sys.argv[1]) as f:
        config = json.load(f)
except Exception:
    sys.exit(0)
if config.get('injectSystemGuidance') is not True:
    sys.exit(0)
agents = config.get('agents', [])
if not agents:
    sys.exit(0)
lines = []
for a in agents:
    safeid = re.sub(r'[^a-zA-Z0-9_]', '_', str(a.get('id', '')))
    label = a.get('label', a.get('id', ''))
    summary = a.get('whenToUse', '')
    if not summary and a.get('description'):
        m = re.split(r'(?<=[.!?])\s+', str(a['description']), maxsplit=1)
        summary = m[0].strip() if m else str(a['description'])
    if not summary:
        summary = "Delegate to '" + str(label) + "' for a second opinion or bulk read-only analysis."
    lines.append('- `delegate_to_' + safeid + '` \u2014 ' + summary)
print('<acp-delegate-routing>')
print('You can delegate self-contained tasks to one of these external coding agents:\n')
for l in lines:
    print(l)
print('\nEach call spawns a fresh subprocess \u2014 the prompt must be self-contained, no session memory. Pass file/directory paths via `includeContext` to attach contents inline. Reach for delegation when offloading bulk read-only analysis (5+ files), getting an independent second opinion, or fanning out 3+ subtasks in parallel.\n')
print('Skip when: simple grep/search, single-file edits with exact path, multi-turn chains.')
print('</acp-delegate-routing>')
PYEOF

fi

exit 0
