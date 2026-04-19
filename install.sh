#!/usr/bin/env bash
# Install the copilot-second-opinion skill + copilot-review-mcp server.
#
# - Installs skill to the first existing of:
#     ~/.config/opencode/skills/   (upstream canonical)
#     ~/.opencode/skill/           (anomalyco fork / legacy)
#   If neither exists, creates ~/.config/opencode/skills/.
# - Installs MCP server deps via npm.
# - Prints the opencode.json snippet to add.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skill/copilot-second-opinion"
MCP_SRC="$SCRIPT_DIR/mcp/copilot-review-server"

# --- skill install ---

CANDIDATES=(
  "$HOME/.config/opencode/skills"
  "$HOME/.opencode/skill"
)

SKILL_DEST=""
for dir in "${CANDIDATES[@]}"; do
  # Accept real directories or symlinks that resolve to directories.
  if [[ -d "$dir" ]]; then
    SKILL_DEST="$dir"
    break
  fi
done

if [[ -z "$SKILL_DEST" ]]; then
  SKILL_DEST="$HOME/.config/opencode/skills"
  mkdir -p "$SKILL_DEST"
  echo "Created $SKILL_DEST"
fi

DEST="$SKILL_DEST/copilot-second-opinion"
if [[ -e "$DEST" ]]; then
  echo "Skill already exists at $DEST - replacing."
  rm -rf "$DEST"
fi
cp -r "$SKILL_SRC" "$DEST"
echo "Installed skill -> $DEST"

# --- MCP server install ---

if ! command -v node >/dev/null 2>&1; then
  echo "WARN: 'node' not found. Install Node 18+ before using the MCP server." >&2
fi

if command -v npm >/dev/null 2>&1; then
  echo "Installing MCP server dependencies..."
  (cd "$MCP_SRC" && npm install --silent --no-audit --no-fund)
else
  echo "WARN: 'npm' not found. Run 'npm install' in $MCP_SRC manually." >&2
fi

# --- gh check ---

if ! command -v gh >/dev/null 2>&1; then
  echo "WARN: 'gh' CLI not found. The MCP server shells out to gh for GitHub API calls." >&2
elif ! gh auth status >/dev/null 2>&1; then
  echo "WARN: 'gh' is not authenticated. Run 'gh auth login' before using the skill." >&2
fi

# --- print config snippet ---

cat <<EOF

================================================================
Installation complete.

Add this to your opencode.json under the top-level "mcp" key:

  "mcp": {
    "copilot-review": {
      "type": "local",
      "command": ["node", "$MCP_SRC/src/index.js"],
      "enabled": true
    }
  }

Then restart opencode. The skill will appear as
"copilot-second-opinion" in available_skills and the MCP tools
(request_copilot_review, check_copilot_review_status,
wait_for_copilot_review, get_copilot_threads,
reply_to_review_comment, resolve_review_thread,
enable_copilot_auto_review) will be available to the agent.

Usage from within opencode:
  "get a second opinion from Copilot on PR <number>"
================================================================
EOF
