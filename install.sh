#!/usr/bin/env bash
# Install the copilot-second-opinion skill + copilot-review MCP server.
#
# For OpenCode users: prefer `opencode plugin copilot-second-opinion -g` —
# it auto-installs the skill, registers the MCP server in-memory, and
# disables the colliding built-in merge tool, all without touching
# opencode.json.
#
# This script is for everyone else (Claude Code, manual OpenCode setup,
# custom MCP host). It:
#   1. Copies the skill into ~/.config/opencode/skills/ (or ~/.claude/skills/)
#   2. Runs `npm install` for the MCP server's dependencies
#   3. Verifies `gh` is installed and authenticated
#   4. Prints the config snippet for you to paste into your MCP host

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skill/copilot-second-opinion"
MCP_SRC="$SCRIPT_DIR/mcp/copilot-review-server"

# --- skill install ---

CANDIDATES=(
  "$HOME/.config/opencode/skills"
  "$HOME/.claude/skills"
  "$HOME/.opencode/skill"
)

SKILL_DEST=""
for dir in "${CANDIDATES[@]}"; do
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
  echo "Skill already exists at $DEST — replacing."
  rm -rf "$DEST"
fi
cp -r "$SKILL_SRC" "$DEST"
echo "Installed skill -> $DEST"

# --- MCP server install ---

if ! command -v node >/dev/null 2>&1; then
  echo "WARN: 'node' (>=18) not found. Install Node before using the MCP server." >&2
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

Add this to your opencode.json (or equivalent MCP host config),
under the top-level "mcp" key:

  "mcp": {
    "copilot-review": {
      "type": "local",
      "command": ["node", "$MCP_SRC/src/index.js"],
      "timeout": 900000
    }
  }

The 900_000ms (15min) timeout is needed for wait_for_copilot_review
to use the deterministic 'gh run watch' path without the MCP client
cutting it off. Per-tool budgets inside the server (30s-120s) prevent
hung gh calls from blocking the full ceiling.

ALSO add the following so the agent uses our gated safe_merge_pr
instead of the no-gating built-in:

  "tools": {
    "github_merge_pull_request": false
  }

Then restart your session. The skill will appear as
'copilot-second-opinion' in available_skills and the 8 MCP tools
(request_copilot_review, check_copilot_review_status,
 wait_for_copilot_review, get_copilot_threads,
 reply_to_review_comment, resolve_review_thread,
 enable_copilot_auto_review, safe_merge_pr) will be available.

Usage from within a session:
  "get a second opinion from Copilot on PR <number>"
  "address the Copilot comments on this PR"
  "merge PR <number> if Copilot is happy and checks pass"
================================================================
EOF
