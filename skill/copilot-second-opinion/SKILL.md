---
name: copilot-second-opinion
description: Orchestrates the full GitHub Copilot PR review loop - request a Copilot review, wait for it to finish, triage every comment (agree/disagree/needs-clarification), push fixes, reply to each thread, resolve threads, and repeat until Copilot has nothing more to say. Load this skill BEFORE any interaction with a Copilot PR review, including - asking Copilot for a "second opinion" or initial review on a PR; pushing fixes to a PR that Copilot has reviewed and needing to re-request review; checking whether Copilot has finished re-reviewing after a push; responding to or resolving Copilot review comments; situations where "Copilot didn't re-review", "Copilot review is stuck", or `gh api .../requested_reviewers` POSTs appear to succeed but Copilot never engages. Also load when the user says "get Copilot's review", "run the Copilot review loop", "address Copilot comments", "request another Copilot review", or any equivalent. The skill provides a dedicated MCP server (`copilot-review`) whose tools verify that requests actually took effect - the built-in `github_request_copilot_review` silently no-ops when Copilot isn't enabled, which is the root cause of most "re-review never works" reports.
license: MIT
---

# Copilot Second Opinion

You are running an iterative review loop with GitHub Copilot as the reviewer. Your job is to get Copilot's feedback, act on every comment with sound engineering judgment, respond to Copilot explaining what you did and why, and repeat until Copilot has no more actionable feedback.

## Required tools (provided by the `copilot-review` MCP server)

**IMPORTANT:** All MCP tools are prefixed with `copilot-review_` by OpenCode. You MUST use the prefixed names below — NOT the built-in `github_request_copilot_review` or other `github_*` tools, which lack verification logic and will silently fail.

- `copilot-review_request_copilot_review(owner, repo, pr, mark_ready?)` — request Copilot as reviewer; flips draft PRs to ready; **verifies the request took effect** and returns `{requested:false, hint:...}` with guidance if Copilot wasn't actually added (most common cause: Copilot code review not enabled on the repo). Tries 3 paths automatically: REST `reviewers[]=Copilot`, then `gh pr edit --add-reviewer`, then GraphQL `requestReviews(botIds:["BOT_kgDOCnlnWA"])` — the last one is the documented workaround for the `review_on_push` ruleset glitch and reliably re-requests Copilot even after a previous review. Response includes `method` showing which path succeeded.
- `copilot-review_enable_copilot_auto_review(owner, repo, include_drafts?, review_on_push?, ruleset_name?)` — creates (or updates) a repository ruleset with the `copilot_code_review` rule so Copilot is auto-requested on every new PR. Idempotent. Use this when `copilot-review_request_copilot_review` returned `{requested:false}` and the user wants the fix applied for them. **Note:** rulesets only apply to PRs opened *after* creation — existing PRs still need manual request (which will now succeed on the next push/new PR).
- `copilot-review_check_copilot_review_status(owner, repo, pr, since_iso?)` — **non-blocking** snapshot. Returns `{status:'done'|'pending'|'absent', ...}`. Prefer this over `copilot-review_wait_for_copilot_review` — call it in a short loop with `bash: sleep 20` between calls.
- `copilot-review_wait_for_copilot_review(owner, repo, pr, timeout_sec?, poll_interval_sec?, since_iso?, prefer_run_watch?)` — blocks until done/absent/timeout. **Deterministic** on modern repos: discovers the Copilot `Running Copilot Code Review` Actions workflow run for the head SHA and `gh run watch`es it instead of polling. Falls back to REST polling on older repos. Only use if the MCP server is configured with a long `"timeout"` in opencode.json (e.g. `900000` ms). Otherwise the MCP client will cut it off.
- `copilot-review_get_copilot_threads(owner, repo, pr, include_resolved?, include_outdated?)` — list Copilot's review threads with `thread_id` (for resolving) and `root_comment_id` (for replying).
- `copilot-review_reply_to_review_comment(owner, repo, pr, comment_id, body)` — post a reply. `comment_id` = `root_comment_id`.
- `copilot-review_resolve_review_thread(thread_id)` — resolve a thread. `thread_id` = `thread_id` from `copilot-review_get_copilot_threads` (the `PRRT_...` GraphQL node id).
- `copilot-review_safe_merge_pr(owner, repo, pr, merge_method?, ...)` — **the only correct way to merge a Copilot-reviewed PR.** Always-on gates: PR is open + not draft, and Copilot review is **NOT mid-flight** (refuses to merge while Copilot is still working, even if `require_copilot_review=false`). Optional gates (on by default): Copilot review for current HEAD, zero unresolved Copilot threads (with GraphQL→REST propagation-lag retry), all checks green. The built-in `github_merge_pull_request` is disabled in this user's opencode config precisely because it bypasses these gates — do not look for or attempt to re-enable it.

Supporting tools you already have:
- `github_pull_request_read` method `get_reviews` / `get_diff` / `get_files` — review summary body and diff context
- `github_get_file_contents` — surrounding file context
- `bash` / `git` — push fixes

If the `copilot-review_*` MCP tools aren't available, stop and tell the user to install the `copilot-review-mcp` server.

## The loop

Repeat until the exit condition at the end is met. Each pass is one Copilot review cycle.

### Phase 1 - Request review

1. Identify `owner`, `repo`, and `pr`. If ambiguous, infer from the current branch (`gh pr view --json number,headRepositoryOwner,headRepository`) and confirm with the user.
2. Record `cycle_started_at = $(date -u +"%Y-%m-%dT%H:%M:%SZ")`. Pass this as `since_iso` so you don't match a stale prior review.
3. Call `copilot-review_request_copilot_review`. If `requested:false`:
   - Relay the `hint` to the user — most likely Copilot code review is not enabled on the repo even if their subscription is active.
   - **Offer to fix it for them** by calling `copilot-review_enable_copilot_auto_review(owner, repo)`, which creates a ruleset that auto-requests Copilot on every new PR. Confirm before running — it modifies repo settings and requires admin permission on the repo.
   - After enabling, note that the ruleset only applies to **new** PRs. For the current PR, retry `copilot-review_request_copilot_review` — it may now succeed, or the user may need to push a new commit / re-open the PR. If it still fails, the user's Copilot subscription or org policy is the blocker; point them at `https://github.com/settings/copilot` or `https://github.com/organizations/<org>/settings/copilot/features`.
   - Otherwise note the returned `head_sha` and proceed.

### Phase 2 - Wait

Two options. **Default to the deterministic blocking call** unless your MCP client timeout is short:

**Option A — `copilot-review_wait_for_copilot_review` (preferred).** Modern Copilot review runs as a GitHub Actions workflow (`Running Copilot Code Review` under workflow `Copilot`), and this tool watches that run via `gh run watch` — no blind sleep, exits the moment the run completes. Falls back to REST polling on repos where the workflow doesn't appear within 60s. Use this when the MCP server has a long `timeout` configured (≥600 000 ms) in opencode.json.

**Option B — caller-side poll.** If your MCP client cuts off long calls:

1. Call `copilot-review_check_copilot_review_status(owner, repo, pr, since_iso=cycle_started_at)`.
2. If `status == "pending"`: `bash: sleep 20`, call again. Cap at ~15 iterations (~5 min); if still pending, ask the user whether to keep waiting. Copilot typically takes 30s–3min.
3. If `status == "absent"`: Copilot is gone from reviewers without posting a review. Likely causes: Copilot code review not enabled, or premium-request quota exhausted. Stop and tell the user.
4. If `status == "done"` and `comment_count == 0`: Copilot had nothing to flag. Check `body_preview` for "wasn't able to review" — if so, something went wrong. Otherwise exit cleanly.

### Phase 3 - Fetch and triage threads

1. Call `copilot-review_get_copilot_threads` (defaults: unresolved + non-outdated only).
2. Also fetch the review summary body: `github_pull_request_read` method `get_reviews` — find the latest Copilot review; note any PR-level commentary in the summary (some feedback lives only there, not inline).
3. For each thread, do **not** reply or resolve yet. Build a plan:
   - Read the code at `path:line` with `github_get_file_contents` (at minimum the enclosing function).
   - Classify into one of four buckets:
     - **Agree + actionable** — real bug, correctness, security, clear improvement. You will fix it.
     - **Agree + trivial** — valid nit (typo, minor rename, missing comment). Fix if cheap. Err toward fixing.
     - **Disagree** — Copilot is wrong, missed context, would regress behavior, or contradicts repo conventions. Push back with reasoning.
     - **Needs clarification** — ambiguous or references something you can't locate. Ask the user or ask Copilot.
4. Present the plan to the user as a short table (`path:line | bucket | one-line rationale`) before mutating the PR. Skip this confirmation only if the user said "just do it" for this session.

### Phase 4 - Act

Do fixes first as a batch, then replies/resolves after the push so "fixed in `<sha>`" references are accurate.

**For each "agree + actionable" or "agree + trivial" thread:**
1. Make the code change. Group related fixes into one commit; otherwise one commit per logical fix.
2. After pushing, `git rev-parse --short HEAD`.
3. Call `copilot-review_reply_to_review_comment(owner, repo, pr, comment_id=root_comment_id, body=...)`. Body template:
   > Fixed in `<sha>`. <one sentence describing the change.>
4. Call `copilot-review_resolve_review_thread(thread_id=thread_id)`.

**For each "disagree" thread:**
1. Do NOT push a code change.
2. Call `copilot-review_reply_to_review_comment`. Body template:
   > Declining this suggestion. <2-4 sentences — cite file:line evidence, repo conventions, or behavior that would break.>
3. Call `copilot-review_resolve_review_thread`. (If the user asked to keep disagreements unresolved, skip and list them at the end.)

**For each "needs clarification" thread:**
1. Call `copilot-review_reply_to_review_comment` asking the specific question. Do NOT resolve.
2. Add to a "pending clarifications" list for the user.

### Phase 5 - Decide whether to loop

- If you pushed fix commits, the PR has a new HEAD. **Copilot does NOT auto re-review new pushes.** You MUST explicitly trigger the next cycle:
  1. Set a fresh `cycle_started_at = $(date -u +"%Y-%m-%dT%H:%M:%SZ")`.
   2. **Call `copilot-review_request_copilot_review` again.** This is not optional. Without it, Copilot stays away and `copilot-review_check_copilot_review_status` will return `status:"absent"` forever.
   3. If `copilot-review_request_copilot_review` returns `{requested:true}`, go to Phase 2.
   4. If it returns `{requested:false}` with a not-a-collaborator hint, exit per exit condition #5 — do NOT proceed to Phase 2 and wait, Copilot is never coming.
- If you pushed no fixes (all threads were disagreements or clarifications), do NOT loop — same commit yields the same comments. Exit.

**Hard rule:** NEVER call `copilot-review_check_copilot_review_status` or `copilot-review_wait_for_copilot_review` in a new cycle before calling `copilot-review_request_copilot_review` in that cycle. If you find yourself waiting and `copilot-review_check_copilot_review_status` returns `absent`, that means you skipped the request — stop waiting, call `copilot-review_request_copilot_review`, then retry the check.

## Exit condition

Stop looping and proceed to **Phase 6 (Merge)** when any of these is true:

1. A fresh review on the current HEAD produced zero new inline comments.
2. Two consecutive cycles produced only "disagree" comments (Copilot is stuck).
3. You've run 5 cycles — ask the user before continuing (each cycle burns a Copilot premium request).
4. `copilot-review_check_copilot_review_status` returned `absent` with Copilot removed from reviewers (likely quota or config issue) — do **not** merge automatically in this case; report to the user.
5. After cycle 1, `copilot-review_request_copilot_review` returns `{requested:false}` with a not-a-collaborator error — the repo requires the ruleset auto-open trigger and won't accept manual re-requests. Report cycle 1 results and stop.

### Phase 6 - Merge

Use **`copilot-review_safe_merge_pr`** — never the built-in `github_merge_pull_request` (it is disabled in this opencode config, and bypasses every safety gate).

1. Call `copilot-review_safe_merge_pr({owner, repo, pr, merge_method: "squash" /* or merge/rebase per repo convention */, delete_branch: true})`.
2. If `merged: true` → done.
3. If `merged: false` → inspect the `gates` object. Each failed gate has its own `hint` explaining what to do:
   - `review_not_pending.ok = false` → **always-on gate.** Copilot is mid-review; inline comments are about to land. Wait via `wait_for_copilot_review` or poll `check_copilot_review_status` until `status: "done"`, then retry the merge. **Never pass `force: true` to bypass this** — it's the exact bug that lets merges race ahead of Copilot's inline comments.
   - `copilot_review.ok = false` → re-run Phases 1–2 to get a review for the current HEAD.
   - `threads_resolved.ok = false` → reply + resolve the listed threads, then retry. If `propagation_retries` is present in the response, the tool waited for GraphQL to catch up to REST — trust the final count.
   - `checks_pass.ok = false` → if `pending > 0` wait for CI; if there are real failures, fix them, push, and restart the loop.
   - `pr_state.ok = false` → the PR is closed, draft, or has a merge conflict; surface to user.
4. **Never pass `force: true` without explicit user authorization for that specific PR.** A forced merge while gates fail is the exact scenario this tool exists to prevent. In particular, never use `force: true` to bypass `review_not_pending` — wait for Copilot instead.

## Final report

- Cycles run
- Threads: total / fixed / disagreed / clarifications pending
- Commits pushed (short SHA + subject)
- Any threads left unresolved
- Final PR URL

## Important rules and gotchas

- **`thread_id` vs `root_comment_id` are different things.** `thread_id` (`PRRT_kwDO...`) is a GraphQL node id — only for `copilot-review_resolve_review_thread`. `root_comment_id` is a numeric REST id — only for `copilot-review_reply_to_review_comment`. `copilot-review_get_copilot_threads` returns both correctly labeled.
- **Never use `github_merge_pull_request` or `gh pr merge` directly.** The built-in performs no gating — it will merge a PR with failing checks, an outdated Copilot review, or unresolved threads. The built-in is disabled in this opencode config; merging is `copilot-review_safe_merge_pr` only. If you find yourself reaching for `bash: gh pr merge ...`, stop and use the MCP tool.
- **Copilot doesn't auto re-review new pushes.** Always re-request via `copilot-review_request_copilot_review` after pushing fixes, always pass a fresh `since_iso`.
- **Ruleset-triggered auto-review fires only on `pull_request.opened`.** Even with `copilot-review_enable_copilot_auto_review` and `review_on_push: true`, the ruleset typically does NOT re-trigger Copilot on pushes to an *existing* PR, nor on close+reopen. In practice, on repos where Copilot isn't a collaborator (the default), **the loop only works for the first review cycle** unless the user has Copilot enabled at the account/org level. After cycle 1, `copilot-review_request_copilot_review` will return `{requested:false}` with a 422 not-a-collaborator error. If that happens, report what was fixed in cycle 1, list remaining threads (if any), and stop — don't push empty commits trying to coax Copilot back.
- **Always pass `since_iso`** after the first cycle, otherwise `copilot-review_check_copilot_review_status` matches the prior review.
- **Don't resolve "needs clarification" threads** — leaving them open is the signal for human/Copilot follow-up.
- **Don't batch disagreements with fixes in the same commit.** Reply text should describe exactly what's in the referenced SHA.
- **Don't reply to outdated threads.** They refer to code that no longer exists; filtered out by default.
- **Security, correctness, and data-loss concerns are never trivial.** Investigate fully before classifying as disagree.
- **Never push `--force` to resolve Copilot feedback.** Normal commits only.
- **Respect `.github/copilot-instructions.md`** on the base branch if present — Copilot reads it.

## Example invocation

User: "get a second opinion from Copilot on PR 42 in acme/widgets"

1. `cycle_started_at = "2026-04-19T04:08:07Z"`
2. `copilot-review_request_copilot_review({owner:"acme", repo:"widgets", pr:42})` → `{requested:true, head_sha:"abc1234"}`
3. Loop: `copilot-review_check_copilot_review_status({owner, repo, pr:42, since_iso:"2026-04-19T04:08:07Z"})` → `{status:"pending"}` → `sleep 20` → repeat → `{status:"done", review_id:999, comment_count:3}`
4. `copilot-review_get_copilot_threads({owner, repo, pr:42})` → `{count:3, threads:[...]}`
5. Read code for each, classify, confirm plan.
6. Fix two → push one commit → `copilot-review_reply_to_review_comment(..., body:"Fixed in \`def5678\`. ...")` + `copilot-review_resolve_review_thread(thread_id:...)` per fix. Disagree with the third → reply with reasoning → resolve.
7. Loop: new `cycle_started_at`, back to step 2.
8. Next review returns `comment_count:0` → exit, summarize.
