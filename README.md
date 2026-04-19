# copilot-second-opinion

An OpenCode skill + stdio MCP server that runs an automated GitHub Copilot PR review loop: request a review, wait for Copilot to finish, triage every comment, push fixes, reply/resolve threads, repeat until Copilot has nothing more to say.

## What's in the box

- **`skill/copilot-second-opinion/SKILL.md`** — the choreography and judgment rules the agent follows. Markdown only; OpenCode loads it lazily via the `skill` tool.
- **`mcp/copilot-review-server/`** — a tiny stdio MCP server (Node, `@modelcontextprotocol/sdk`) that encapsulates the three operations that don't belong in a markdown skill:
  - `request_copilot_review` — request (or re-request) Copilot as reviewer, flipping draft PRs to ready.
  - `wait_for_copilot_review` — blocks until Copilot submits a review whose `commit_id` matches the PR's current HEAD SHA, or times out. This is the hard part — Copilot has no webhook or check run, only a late-arriving review record.
  - `get_copilot_threads` — returns review threads with both the GraphQL thread node id (for `resolveReviewThread`) and the REST comment id (for posting a reply), pre-joined so the agent doesn't have to do the REST↔GraphQL id dance.

Everything else (posting replies, resolving threads, reading diffs, pushing fixes) uses OpenCode's existing `github_*` tools and `bash`.

## Why both a skill and an MCP server?

The wait-for-review step is a stateful polling loop with non-trivial termination logic (match on HEAD SHA, ignore prior reviews via `since_iso`, distinguish quota exhaustion from slow review). Putting that in an MCP tool means one deterministic call instead of the LLM running its own polling loop and wasting context. The skill provides the judgment glue — when to request, when to loop, when to disagree, how to reply — which is exactly what markdown-in-context is best at.

## Install

```bash
./install.sh
```

This will:
1. Copy the skill to `~/.config/opencode/skills/copilot-second-opinion/` (or `~/.opencode/skill/` if only that exists).
2. `npm install` the MCP server's dependencies.
3. Print the `opencode.json` snippet you need to add.

Then edit `~/.config/opencode/opencode.json` and add under the top-level `mcp` key:

```jsonc
{
  "mcp": {
    "copilot-review": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcp/copilot-review-server/src/index.js"],
      "enabled": true
    }
  }
}
```

Restart OpenCode.

### Requirements

- Node 18+
- `gh` CLI, authenticated (`gh auth login`) — the MCP server shells out to `gh api` and `gh pr ready`. The authenticated user must have write access on PRs you want to review.
- GitHub Copilot code review enabled on the repo and available in your Copilot plan. Each review consumes one premium request.

## Usage

From within OpenCode:

> get a second opinion from Copilot on PR 42

The agent will load the skill and run the loop. It will show you a triage plan before pushing any changes unless you say "just do it".

## Notes and caveats

- **Copilot does not re-review new pushes automatically.** Every cycle re-requests explicitly.
- **Copilot always submits `state: COMMENTED`.** It never approves or requests changes. Exit is decided by comment count, not by review state.
- **Copilot's quota is consumed per review.** The skill caps at 5 cycles by default and checks in with the user.
- **Draft PRs get marked ready** before requesting review (Copilot skips drafts). Pass `mark_ready: false` to `request_copilot_review` to opt out.
- **`.github/copilot-instructions.md`** on the base branch is read by Copilot (first 4000 chars). Keep it accurate.

## Development

```bash
# run the MCP server standalone to sanity-check stdio plumbing
node mcp/copilot-review-server/src/index.js
# (it will wait on stdin for MCP frames; ctrl-C to exit)
```

Tools are defined in `mcp/copilot-review-server/src/index.js`. They are thin wrappers around `gh api` / `gh api graphql` — no GitHub SDK dependency, which keeps the install trivial.

## Prior art

- [`mlflow/mlflow/.claude/skills/copilot`](https://github.com/mlflow/mlflow/tree/master/.claude/skills/copilot) — the best reference for completion-detection polling against both `gh agent-task` and the reviewer bot.
- [`aslamdoctor/fix-bot-reviews`](https://github.com/aslamdoctor/fix-bot-reviews) — fetch/reply/resolve pipeline covering Copilot, Cursor Bugbot, Sentry, Gemini.
- [`VygantasHumble/claude-setup`](https://github.com/VygantasHumble/claude-setup) (`copilot-check`) — GraphQL thread-resolution details.

## License

MIT.
