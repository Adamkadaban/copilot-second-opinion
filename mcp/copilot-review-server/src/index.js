#!/usr/bin/env node
/**
 * copilot-review-mcp — stdio MCP server
 *
 * Tools:
 *   - request_copilot_review       : request (or re-request) Copilot as reviewer on a PR.
 *                                    VERIFIES the request actually took effect.
 *   - check_copilot_review_status  : non-blocking snapshot of review state. Returns
 *                                    {status:'pending'|'done'|'absent', ...}.
 *                                    Use this in a loop from the caller if you want to
 *                                    avoid long-blocking MCP calls.
 *   - wait_for_copilot_review      : blocks until Copilot submits a review for current
 *                                    HEAD, with periodic progress notifications to keep
 *                                    the MCP client from timing out.
 *   - get_copilot_threads          : list review threads authored by Copilot (with
 *                                    thread_id for resolving + root_comment_id for replying).
 *   - reply_to_review_comment      : post a reply to a specific review comment.
 *   - resolve_review_thread        : resolve a review thread via GraphQL resolveReviewThread.
 *
 * Auth: uses `gh auth token` via the gh CLI.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const COPILOT_BOT_LOGIN = "copilot-pull-request-reviewer[bot]";
const COPILOT_BOT_LOGIN_GQL = "copilot-pull-request-reviewer";

// ---------- gh helpers ----------

async function gh(args, { input, timeout = 30000 } = {}) {
  // When we need to send stdin (e.g. `gh api --input -`), use spawn directly;
  // execFile's `input` option is silently ignored and the child will hang waiting on stdin.
  if (input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`gh ${args.join(" ")} timed out after ${timeout}ms`));
      }, timeout);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`gh ${args.join(" ")} failed: ${stderr || `exit ${code}`}`));
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }
  try {
    const { stdout } = await execFileP("gh", args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
    return stdout;
  } catch (err) {
    if (err.killed && err.signal === "SIGTERM") {
      throw new Error(`gh ${args.join(" ")} timed out after ${timeout}ms`);
    }
    const msg = err.stderr?.toString() || err.message;
    throw new Error(`gh ${args.join(" ")} failed: ${msg}`);
  }
}

async function ghJson(args, opts) {
  const out = await gh(args, opts);
  if (!out.trim()) return null;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`gh returned non-JSON: ${out.slice(0, 200)}`);
  }
}

async function getPr(owner, repo, pr) {
  return ghJson([
    "api",
    `repos/${owner}/${repo}/pulls/${pr}`,
    "-H",
    "Accept: application/vnd.github+json",
  ]);
}

async function listReviews(owner, repo, pr) {
  return ghJson([
    "api",
    "--paginate",
    `repos/${owner}/${repo}/pulls/${pr}/reviews?per_page=100`,
  ]);
}

function latestCopilotReview(reviews, headSha) {
  const submitted = (reviews || []).filter(
    (r) =>
      r.user &&
      r.user.login === COPILOT_BOT_LOGIN &&
      r.submitted_at &&
      (!headSha || r.commit_id === headSha),
  );
  if (!submitted.length) return null;
  submitted.sort(
    (a, b) => new Date(b.submitted_at) - new Date(a.submitted_at),
  );
  return submitted[0];
}

function isCopilotRequested(prData) {
  const reviewers = (prData.requested_reviewers || []).map((r) => r.login);
  return reviewers.some((l) => /^copilot/i.test(l));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tool implementations ----------

async function requestCopilotReview({ owner, repo, pr, mark_ready = true }) {
  let prData = await getPr(owner, repo, pr);

  const wasDraft = prData.draft === true;
  if (wasDraft && mark_ready) {
    await gh(["pr", "ready", String(pr), "--repo", `${owner}/${repo}`]);
    prData = await getPr(owner, repo, pr);
  }

  if (isCopilotRequested(prData)) {
    return {
      requested: true,
      already_requested: true,
      head_sha: prData.head.sha,
      was_draft: wasDraft && mark_ready,
    };
  }

  // GitHub silently returns HTTP 200 for `reviewers[]=Copilot` even when
  // Copilot code review isn't enabled — must verify by re-reading state.
  let postError = null;
  try {
    await gh([
      "api",
      "-X",
      "POST",
      `repos/${owner}/${repo}/pulls/${pr}/requested_reviewers`,
      "-f",
      "reviewers[]=Copilot",
    ]);
  } catch (err) {
    postError = err.message;
  }

  if (postError) {
    try {
      await gh([
        "pr",
        "edit",
        String(pr),
        "--repo",
        `${owner}/${repo}`,
        "--add-reviewer",
        "Copilot",
      ]);
      postError = null;
    } catch (err2) {
      postError = `${postError}; fallback gh pr edit also failed: ${err2.message}`;
    }
  }

  const verify = await getPr(owner, repo, pr);
  if (isCopilotRequested(verify)) {
    return {
      requested: true,
      head_sha: verify.head.sha,
      was_draft: wasDraft && mark_ready,
    };
  }

  const priorReview = latestCopilotReview(
    await listReviews(owner, repo, pr),
    verify.head.sha,
  );

  return {
    requested: false,
    head_sha: verify.head.sha,
    was_draft: wasDraft && mark_ready,
    post_error: postError,
    prior_review_on_head: priorReview
      ? { review_id: priorReview.id, submitted_at: priorReview.submitted_at }
      : null,
    hint: priorReview
      ? "A Copilot review already exists on the current HEAD. Push a new commit before re-requesting, or treat the existing review as the result."
      : `Could not add Copilot as reviewer on ${owner}/${repo}#${pr}. This almost always means Copilot code review is not enabled for this specific repo — even with a Copilot Pro/Business/Enterprise subscription, Copilot is not a collaborator on new repos by default. TO ENABLE: (1) Per-repo one-off: go to https://github.com/${owner}/${repo}/settings/rules and add a new ruleset targeting the default branch with the rule 'Request pull request review from Copilot', enforcement Active. (2) All your repos: https://github.com/settings/copilot under 'Automatic code review'. (3) For an org: https://github.com/organizations/ORG/settings/copilot/features. DIAGNOSTIC: 'gh api -X POST repos/${owner}/${repo}/pulls/${pr}/requested_reviewers -f reviewers[]=copilot-pull-request-reviewer' returning '422 not a collaborator' confirms Copilot is not enabled here; a 201/200 with Copilot appearing in requested_reviewers confirms it is.`,
  };
}

async function checkCopilotReviewStatus({ owner, repo, pr, since_iso }) {
  const prData = await getPr(owner, repo, pr);
  const headSha = prData.head.sha;
  const requested = isCopilotRequested(prData);
  const sinceMs = since_iso ? Date.parse(since_iso) : 0;

  const reviews = await listReviews(owner, repo, pr);
  const latest = latestCopilotReview(reviews, headSha);

  if (latest && (!sinceMs || Date.parse(latest.submitted_at) >= sinceMs)) {
    let commentCount = 0;
    try {
      const comments = await ghJson([
        "api",
        "--paginate",
        `repos/${owner}/${repo}/pulls/${pr}/reviews/${latest.id}/comments?per_page=100`,
      ]);
      commentCount = (comments || []).length;
    } catch {
      /* non-fatal */
    }
    return {
      status: "done",
      review_id: latest.id,
      review_node_id: latest.node_id,
      state: latest.state,
      submitted_at: latest.submitted_at,
      commit_id: latest.commit_id,
      head_sha: headSha,
      comment_count: commentCount,
      body_preview: (latest.body || "").slice(0, 500),
      copilot_still_requested: requested,
    };
  }

  if (requested) {
    return { status: "pending", head_sha: headSha, copilot_still_requested: true };
  }

  const anyPriorReview = latestCopilotReview(reviews, null);
  return {
    status: "absent",
    head_sha: headSha,
    copilot_still_requested: false,
    any_prior_review: anyPriorReview
      ? {
          review_id: anyPriorReview.id,
          commit_id: anyPriorReview.commit_id,
          submitted_at: anyPriorReview.submitted_at,
          matches_head: anyPriorReview.commit_id === headSha,
        }
      : null,
    hint:
      "Copilot is not in requested_reviewers and has not submitted a review for the current HEAD. Call request_copilot_review first, or verify Copilot code review is enabled on this repo.",
  };
}

async function waitForCopilotReview(
  { owner, repo, pr, timeout_sec = 600, poll_interval_sec = 20, since_iso },
  { sendProgress, progressToken },
) {
  const start = Date.now();
  const deadline = start + timeout_sec * 1000;
  let attempts = 0;
  let lastStatus = null;

  while (Date.now() < deadline) {
    attempts++;
    lastStatus = await checkCopilotReviewStatus({ owner, repo, pr, since_iso });
    if (lastStatus.status === "done") {
      return { ...lastStatus, attempts };
    }
    if (lastStatus.status === "absent") {
      return { ...lastStatus, attempts };
    }

    if (sendProgress && progressToken !== undefined) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      await sendProgress({
        progressToken,
        progress: elapsed,
        total: timeout_sec,
        message: `waiting for Copilot review (attempt ${attempts}, ${elapsed}s elapsed)`,
      }).catch(() => {});
    }

    await sleep(poll_interval_sec * 1000);
  }

  return {
    status: "timeout",
    timeout_sec,
    attempts,
    last_status: lastStatus,
    hint:
      "Copilot did not submit a review in time. Possible causes: Copilot premium-request quota exhausted, PR still processing, or Copilot code review not enabled for this repo.",
  };
}

const THREADS_QUERY = `
query($owner:String!,$repo:String!,$pr:Int!,$cursor:String) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          isCollapsed
          path
          line
          originalLine
          startLine
          diffSide
          comments(first:50) {
            nodes {
              databaseId
              author { login }
              body
              createdAt
              url
              replyTo { databaseId }
            }
          }
        }
      }
    }
  }
}`;

async function getCopilotThreads({
  owner,
  repo,
  pr,
  include_resolved = false,
  include_outdated = false,
}) {
  const all = [];
  let cursor = null;
  while (true) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `pr=${pr}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const resp = await ghJson(args);
    const rt = resp?.data?.repository?.pullRequest?.reviewThreads;
    if (!rt) break;
    all.push(...rt.nodes);
    if (!rt.pageInfo.hasNextPage) break;
    cursor = rt.pageInfo.endCursor;
  }

  const threads = all
    .filter((t) => {
      const first = t.comments.nodes[0];
      if (!first) return false;
      const login = (first.author?.login || "").toLowerCase();
      return (
        login === COPILOT_BOT_LOGIN_GQL ||
        login === COPILOT_BOT_LOGIN ||
        login.startsWith("copilot")
      );
    })
    .filter((t) => (include_resolved ? true : !t.isResolved))
    .filter((t) => (include_outdated ? true : !t.isOutdated))
    .map((t) => {
      const first = t.comments.nodes[0];
      return {
        thread_id: t.id,
        is_resolved: t.isResolved,
        is_outdated: t.isOutdated,
        path: t.path,
        line: t.line ?? t.originalLine,
        side: t.diffSide,
        root_comment_id: first.databaseId,
        author: first.author?.login,
        body: first.body,
        url: first.url,
        reply_count: t.comments.nodes.length - 1,
      };
    });

  return { count: threads.length, threads };
}

async function replyToReviewComment({ owner, repo, pr, comment_id, body }) {
  const resp = await ghJson([
    "api",
    "-X",
    "POST",
    `repos/${owner}/${repo}/pulls/${pr}/comments/${comment_id}/replies`,
    "-f",
    `body=${body}`,
  ]);
  return {
    ok: true,
    reply_id: resp?.id,
    url: resp?.html_url,
    in_reply_to_id: resp?.in_reply_to_id,
  };
}

async function resolveReviewThread({ thread_id }) {
  const resp = await ghJson([
    "api",
    "graphql",
    "-f",
    "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}",
    "-f",
    `t=${thread_id}`,
  ]);
  const thread = resp?.data?.resolveReviewThread?.thread;
  return {
    ok: !!thread,
    thread_id: thread?.id,
    is_resolved: thread?.isResolved === true,
  };
}

async function enableCopilotAutoReview({
  owner,
  repo,
  review_draft_pull_requests = false,
  review_on_push = false,
  branches,
}) {
  // Check for an existing Copilot code-review ruleset so we don't create duplicates.
  // The list endpoint returns only summaries without a `rules` field, so we must
  // GET each ruleset individually to inspect its rule types.
  const summaries = await ghJson([
    "api",
    `repos/${owner}/${repo}/rulesets`,
    "-q",
    ".",
  ]);
  let existing = null;
  for (const rs of summaries || []) {
    const detail = await ghJson([
      "api",
      `repos/${owner}/${repo}/rulesets/${rs.id}`,
    ]);
    if ((detail?.rules || []).some((r) => r.type === "copilot_code_review")) {
      existing = detail;
      break;
    }
  }

  const include =
    Array.isArray(branches) && branches.length
      ? branches.map((b) => (b.startsWith("refs/") || b.startsWith("~") ? b : `refs/heads/${b}`))
      : ["~DEFAULT_BRANCH"];

  const payload = {
    name: "Automatic Copilot code review",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include, exclude: [] } },
    rules: [
      {
        type: "copilot_code_review",
        parameters: {
          review_draft_pull_requests,
          review_on_push,
        },
      },
    ],
  };

  if (existing) {
    // Update in place so users can re-run to change parameters.
    const updated = await ghJson([
      "api",
      "-X",
      "PUT",
      `repos/${owner}/${repo}/rulesets/${existing.id}`,
      "--input",
      "-",
    ], { input: JSON.stringify(payload) });
    return {
      ok: true,
      action: "updated",
      ruleset_id: updated?.id ?? existing.id,
      html_url: updated?._links?.html?.href,
      branches: include,
      review_draft_pull_requests,
      review_on_push,
    };
  }

  const created = await ghJson([
    "api",
    "-X",
    "POST",
    `repos/${owner}/${repo}/rulesets`,
    "--input",
    "-",
  ], { input: JSON.stringify(payload) });
  return {
    ok: true,
    action: "created",
    ruleset_id: created?.id,
    html_url: created?._links?.html?.href,
    branches: include,
    review_draft_pull_requests,
    review_on_push,
    note: "Ruleset applies to NEW PRs opened after creation. Existing open PRs will not retroactively get Copilot as a reviewer — you must still call request_copilot_review on those, or push a new commit/branch to trigger the ruleset on a new PR.",
  };
}

// ---------- MCP wiring ----------

const server = new Server(
  { name: "copilot-review-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "request_copilot_review",
    description:
      "Request GitHub Copilot as a reviewer on a PR. Marks draft PRs as ready (opt-out via mark_ready=false). VERIFIES the request actually took effect by re-reading requested_reviewers — returns {requested:false, hint:...} if Copilot wasn't added (common cause: Copilot code review not enabled on the repo).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer", description: "PR number" },
        mark_ready: { type: "boolean", default: true },
      },
      required: ["owner", "repo", "pr"],
    },
  },
  {
    name: "check_copilot_review_status",
    description:
      "Non-blocking snapshot of Copilot's review state on a PR. Returns {status:'done'|'pending'|'absent', ...}. 'done' includes review_id, comment_count, body_preview. 'pending' means Copilot is in requested_reviewers but hasn't submitted. 'absent' means Copilot is neither requested nor has a matching review. Use in a caller-side loop to avoid long-blocking waits.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
        since_iso: {
          type: "string",
          description:
            "Only treat reviews submitted at or after this ISO timestamp as 'done'. Prevents matching stale prior reviews.",
        },
      },
      required: ["owner", "repo", "pr"],
    },
  },
  {
    name: "wait_for_copilot_review",
    description:
      "Block until Copilot submits a review for the PR's current HEAD SHA, or returns early if Copilot is not requested and has no matching review (status:'absent'). Sends MCP progress notifications each poll to keep the client alive. Default timeout 600s, poll 20s. NOTE: the opencode MCP client has its own per-call timeout — set `\"timeout\": 900000` in opencode.json for this server to use long waits, OR prefer check_copilot_review_status in a caller-side loop.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
        timeout_sec: { type: "integer", default: 600, minimum: 30 },
        poll_interval_sec: { type: "integer", default: 20, minimum: 5 },
        since_iso: { type: "string" },
      },
      required: ["owner", "repo", "pr"],
    },
  },
  {
    name: "get_copilot_threads",
    description:
      "List review threads authored by Copilot. Each entry has thread_id (GraphQL node id, for resolve_review_thread) and root_comment_id (REST id, for reply_to_review_comment). Excludes resolved + outdated threads by default.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
        include_resolved: { type: "boolean", default: false },
        include_outdated: { type: "boolean", default: false },
      },
      required: ["owner", "repo", "pr"],
    },
  },
  {
    name: "reply_to_review_comment",
    description:
      "Post a reply to a specific PR review comment (POST /pulls/{n}/comments/{id}/replies). Use root_comment_id from get_copilot_threads as comment_id.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
        comment_id: { type: "integer" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "pr", "comment_id", "body"],
    },
  },
  {
    name: "resolve_review_thread",
    description:
      "Resolve a PR review thread via GraphQL resolveReviewThread mutation. Use thread_id (PRRT_...) from get_copilot_threads.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "enable_copilot_auto_review",
    description:
      "Enable automatic Copilot code review on a repository by creating (or updating) a repository ruleset with the copilot_code_review rule. After this, every NEW PR opened against the matching branches will have Copilot automatically requested as a reviewer — no per-PR request_copilot_review call needed. This is idempotent: if a Copilot-review ruleset already exists on the repo, it's updated in place. Note: ruleset does NOT apply retroactively to already-open PRs. Requires admin permission on the repo.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        review_draft_pull_requests: {
          type: "boolean",
          default: false,
          description:
            "If true, Copilot also reviews draft PRs (not just ready-for-review ones).",
        },
        review_on_push: {
          type: "boolean",
          default: false,
          description:
            "If true, Copilot auto-re-reviews on every new push to the PR. Consumes one premium request per review — turn on carefully.",
        },
        branches: {
          type: "array",
          items: { type: "string" },
          description:
            "Branch patterns to target (defaults to default branch). Accepts bare branch names ('main'), refs ('refs/heads/main'), or GitHub special refs ('~DEFAULT_BRANCH', '~ALL').",
        },
      },
      required: ["owner", "repo"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args = {} } = req.params;
  const progressToken = req.params._meta?.progressToken;
  const sendProgress = extra?.sendNotification
    ? (params) =>
        extra.sendNotification({
          method: "notifications/progress",
          params,
        })
    : null;

  try {
    let result;
    switch (name) {
      case "request_copilot_review":
        result = await requestCopilotReview(args);
        break;
      case "check_copilot_review_status":
        result = await checkCopilotReviewStatus(args);
        break;
      case "wait_for_copilot_review":
        result = await waitForCopilotReview(args, {
          sendProgress,
          progressToken,
        });
        break;
      case "get_copilot_threads":
        result = await getCopilotThreads(args);
        break;
      case "reply_to_review_comment":
        result = await replyToReviewComment(args);
        break;
      case "resolve_review_thread":
        result = await resolveReviewThread(args);
        break;
      case "enable_copilot_auto_review":
        result = await enableCopilotAutoReview(args);
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
