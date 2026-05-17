<h1 align="center">copilot-second-opinion</h1>

<p align="center">
  OpenCode plugin + MCP server + agent skill that runs the full GitHub Copilot PR review loop — request review, wait deterministically, triage, fix, reply, resolve, repeat, and merge with safety gates.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/copilot-second-opinion"><img alt="npm version" src="https://img.shields.io/npm/v/copilot-second-opinion.svg"></a>
  <a href="https://www.npmjs.com/package/copilot-second-opinion"><img alt="npm downloads" src="https://img.shields.io/npm/dm/copilot-second-opinion.svg"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/copilot-second-opinion.svg"></a>
</p>

---

## Why

OpenCode (and Claude Code, and friends) ship `github_request_copilot_review` and `github_merge_pull_request` out of the box. Both are footguns:

- **`github_request_copilot_review`** silently no-ops when Copilot code review isn't enabled on the repo. GitHub returns HTTP 200, so the agent thinks the request worked and waits forever for a review that's never coming.
- **`github_merge_pull_request`** does zero gating. It will merge a PR with failed CI, unresolved Copilot threads, or a Copilot review that's for the *previous* HEAD.

This package fixes both, plus packages the full review-loop workflow as a skill the model auto-loads.

## What you get

| Piece | Purpose |
|---|---|
| **MCP server** (`copilot-review`) | 8 tools, all with verification logic. `request_copilot_review` actually verifies Copilot was added. `wait_for_copilot_review` blocks on `gh run watch` of the Copilot Actions workflow (no blind polling). `safe_merge_pr` gates merge on review-on-current-HEAD + zero-unresolved-threads + green checks. |
| **Skill** (`copilot-second-opinion`) | Loaded automatically by the model when you push fixes to a Copilot-reviewed PR, when re-reviews are needed, etc. Documents the full loop, including the exact reason the built-in merge tool is shadowed. |
| **Plugin shim** (this package) | Installs the skill into `~/.config/opencode/skills/`, registers the MCP server in-memory at session start, and shadows `github_merge_pull_request` so the agent can't fall back to it. |

## Install

### OpenCode (recommended)

```bash
opencode plugin copilot-second-opinion -g
```

Installs the npm package globally, adds `"copilot-second-opinion"` to your `opencode.json` plugin array, and on next session start the plugin:

1. Symlinks the skill into `~/.config/opencode/skills/copilot-second-opinion/SKILL.md`.
2. Registers the MCP server **in-memory** (no `opencode.json` mutation — uninstalling the plugin un-registers it automatically).
3. Disables the built-in `github_merge_pull_request` so `safe_merge_pr` is the only merge path.

You'll see a log line on first run summarizing what was added.

#### Opt out of the in-memory config injection

Some users want full control over their `opencode.json`. Set:

```bash
export OPENCODE_COPILOT_REVIEW_NO_AUTOCONFIG=1
```

The plugin will still install the skill file, but will skip MCP registration + the tools filter. Add them manually using the snippet from the manual install path below.

### Manual install (Claude Code, custom MCP hosts, or OpenCode users who prefer file-based config)

```bash
git clone https://github.com/Adamkadaban/copilot-second-opinion
cd copilot-second-opinion
./install.sh
```

Copies the skill into the first existing of `~/.config/opencode/skills/`, `~/.claude/skills/`, or `~/.opencode/skill/`. Runs `npm install` for the MCP server. Prints the exact config snippet to paste into your MCP host's config.

## Requirements

- Node 18+
- `gh` CLI authenticated (`gh auth status` returns a green check)
- Copilot code review enabled on the target repo. If it isn't, the first `request_copilot_review` call will return `{requested: false, hint: "..."}` and the skill will offer to enable it via repository ruleset.

## Usage

Inside an OpenCode session, the skill is auto-discoverable. Any of these will trigger it:

> get a second opinion from Copilot on PR 42
> address the Copilot comments on this PR
> Copilot didn't re-review after my last push
> merge PR 42 if Copilot is happy and checks pass

The agent will load the skill, run the full loop, and use `safe_merge_pr` for the final merge.

## What the MCP server exposes

| Tool | Purpose |
|---|---|
| `request_copilot_review` | POSTs Copilot as a reviewer + **verifies** the request took effect (re-reads `requested_reviewers`) |
| `check_copilot_review_status` | Non-blocking snapshot: `done` / `pending` / `absent` for the current HEAD |
| `wait_for_copilot_review` | Blocking wait via `gh run watch` on the Copilot Actions workflow — deterministic, not poll-based. Falls back to REST polling on older repos. |
| `get_copilot_threads` | Lists unresolved + non-outdated review threads with both `thread_id` (for resolve) and `root_comment_id` (for reply) |
| `reply_to_review_comment` | Post a reply to a specific review comment |
| `resolve_review_thread` | Resolve a review thread via GraphQL `resolveReviewThread` |
| `enable_copilot_auto_review` | Create/update a repo ruleset with the `copilot_code_review` rule (idempotent) |
| `safe_merge_pr` | Gated merge: blocks unless Copilot review is current, all threads resolved, all checks green. `force: true` overrides with audit trail. |

Each tool has its own server-side timeout budget (30s–120s) so a hung `gh` call can't block the whole session.

## Hacking on it

```bash
git clone https://github.com/Adamkadaban/copilot-second-opinion
cd copilot-second-opinion
npm install
npm run check         # smoke-test plugin import
npm run mcp:smoke     # smoke-test MCP server initialize
```

For live development against your OpenCode session:

```bash
cd ~/.config/opencode
npm link /path/to/copilot-second-opinion
```

Then add `"copilot-second-opinion"` to your `plugin` array in `opencode.json`.

## Releasing

```bash
npm version patch && git push --follow-tags
```

The [publish workflow](./.github/workflows/publish.yml) handles npm publish with provenance + GitHub Release.

## License

[MIT](./LICENSE)
