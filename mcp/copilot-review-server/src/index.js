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
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
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

// ---------- Copilot workflow-run helpers ----------
//
// Modern Copilot PR review is implemented as a real GitHub Actions workflow run
// named "Running Copilot Code Review" under workflow `Copilot` (event: dynamic).
// That means we can deterministically wait on it with `gh run watch` instead of
// blind-polling the REST reviews endpoint. Older repos (or rollouts that don't
// produce the workflow run) fall back to the original poll loop.

async function findCopilotRun(owner, repo, headSha) {
  // Workflow name varies across Copilot rollouts ("Copilot", "Copilot code
  // review", etc.) but the runs always use `event: dynamic` and a `name`
  // containing "copilot". Filter on commit, then match defensively.
  try {
    const runs = await ghJson([
      "run",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--commit",
      headSha,
      "--json",
      "databaseId,status,conclusion,headSha,createdAt,url,event,name,workflowName",
      "--limit",
      "30",
    ]);
    if (!Array.isArray(runs)) return null;
    const matches = runs.filter((r) => {
      if (r.headSha !== headSha) return false;
      if (r.event !== "dynamic") return false;
      const name = `${r.name || ""} ${r.workflowName || ""}`.toLowerCase();
      return name.includes("copilot");
    });
    if (!matches.length) return null;
    matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return matches[0];
  } catch {
    return null;
  }
}

async function watchRun(owner, repo, runId, { sendProgress, progressToken } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      "gh",
      [
        "run",
        "watch",
        String(runId),
        "--repo",
        `${owner}/${repo}`,
        "--exit-status",
        "--interval",
        "3",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const start = Date.now();
    const progressTimer = setInterval(() => {
      if (sendProgress && progressToken !== undefined) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        sendProgress({
          progressToken,
          progress: elapsed,
          message: `watching Copilot review run ${runId} (${elapsed}s elapsed)`,
        }).catch(() => {});
      }
    }, 10000);
    // Drain to avoid backpressure
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      clearInterval(progressTimer);
      resolve({ exit_code: code });
    });
    child.on("error", () => {
      clearInterval(progressTimer);
      resolve({ exit_code: -1 });
    });
  });
}

// ---------- tool implementations ----------

// Copilot's PR-reviewer bot — stable GraphQL node ID across all repos.
// Used as the deterministic re-request fallback when the REST path no-ops
// (which happens consistently when the ruleset's `review_on_push: true`
// fails to fire — see community/community#186152, IDAHO-VAULT#399).
const COPILOT_BOT_NODE_ID = "BOT_kgDOCnlnWA";

async function getPrNodeId(owner, repo, pr) {
  const resp = await ghJson([
    "api",
    "graphql",
    "-f",
    `query=query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){id}}}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repo}`,
    "-F",
    `pr=${pr}`,
  ]);
  return resp?.data?.repository?.pullRequest?.id || null;
}

// GraphQL `requestReviews` with `botIds` is the only programmatic path that
// reliably re-requests Copilot after it has already submitted a review.
// REST `POST .../requested_reviewers reviewers[]=Copilot` returns 200 but
// silently no-ops in this scenario. Verified 5/5 in repeatability testing
// (commit message in this file's git history for details).
async function requestCopilotReviewViaGraphql(owner, repo, pr) {
  const prNodeId = await getPrNodeId(owner, repo, pr);
  if (!prNodeId) {
    throw new Error(`could not resolve node id for ${owner}/${repo}#${pr}`);
  }
  const mutation = `mutation($pr:ID!,$bots:[ID!]!){requestReviews(input:{pullRequestId:$pr,botIds:$bots,union:true}){pullRequest{id}}}`;
  await ghJson([
    "api",
    "graphql",
    "-f",
    `query=${mutation}`,
    "-F",
    `pr=${prNodeId}`,
    "-F",
    `bots[]=${COPILOT_BOT_NODE_ID}`,
  ]);
}

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
      method: "already-requested",
      head_sha: prData.head.sha,
      was_draft: wasDraft && mark_ready,
    };
  }

  // Path A: REST POST requested_reviewers. Works for first-time requests on
  // repos where Copilot is a configured reviewer. Returns 200 even when it
  // silently no-ops, so must verify by re-reading.
  const methodsTried = [];
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
    methodsTried.push("rest-reviewers-copilot");
  } catch (err) {
    postError = err.message;
  }

  // Path A.2: `gh pr edit --add-reviewer Copilot` fallback if the raw POST
  // errored. Same semantics, but exercises gh's own URL/handling.
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
      methodsTried.push("gh-pr-edit");
      postError = null;
    } catch (err2) {
      postError = `${postError}; fallback gh pr edit also failed: ${err2.message}`;
    }
  }

  let verify = await getPr(owner, repo, pr);
  if (isCopilotRequested(verify)) {
    return {
      requested: true,
      method: methodsTried[methodsTried.length - 1] || "rest-reviewers-copilot",
      methods_tried: methodsTried,
      head_sha: verify.head.sha,
      was_draft: wasDraft && mark_ready,
    };
  }

  // Path B: GraphQL `requestReviews` with `botIds`. This is the documented
  // community workaround (community/community#186152, comment by @pacnpal)
  // and is reliable when REST returns no-op. We always try it before giving
  // up — verified deterministic in repeatability testing.
  let graphqlError = null;
  try {
    await requestCopilotReviewViaGraphql(owner, repo, pr);
    methodsTried.push("graphql-botids");
  } catch (err) {
    graphqlError = err.message;
  }

  verify = await getPr(owner, repo, pr);
  if (isCopilotRequested(verify)) {
    return {
      requested: true,
      method: "graphql-botids",
      methods_tried: methodsTried,
      head_sha: verify.head.sha,
      was_draft: wasDraft && mark_ready,
      note: "REST path no-opped; recovered via GraphQL requestReviews(botIds:[...]). This is the documented workaround for the review_on_push ruleset glitch (community/community#186152).",
    };
  }

  const priorReview = latestCopilotReview(
    await listReviews(owner, repo, pr),
    verify.head.sha,
  );

  return {
    requested: false,
    method: "all-paths-failed",
    methods_tried: methodsTried,
    head_sha: verify.head.sha,
    was_draft: wasDraft && mark_ready,
    post_error: postError,
    graphql_error: graphqlError,
    prior_review_on_head: priorReview
      ? { review_id: priorReview.id, submitted_at: priorReview.submitted_at }
      : null,
    hint: priorReview
      ? "A Copilot review already exists on the current HEAD. Push a new commit before re-requesting, or treat the existing review as the result."
      : `Both the REST POST and the GraphQL requestReviews(botIds) workaround failed to add Copilot as a reviewer on ${owner}/${repo}#${pr}. This almost always means Copilot code review is not enabled for this specific repo — even with a Copilot Pro/Business/Enterprise subscription, Copilot is not a collaborator on new repos by default. TO ENABLE: (1) Per-repo one-off: go to https://github.com/${owner}/${repo}/settings/rules and add a new ruleset targeting the default branch with the rule 'Request pull request review from Copilot', enforcement Active. (2) All your repos: https://github.com/settings/copilot under 'Automatic code review'. (3) For an org: https://github.com/organizations/ORG/settings/copilot/features. As a last resort, click the 🔄 re-request review button next to Copilot in the PR's Reviewers sidebar — that uses an internal endpoint not exposed to any public API.`,
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
  {
    owner,
    repo,
    pr,
    timeout_sec = 600,
    poll_interval_sec = 20,
    since_iso,
    prefer_run_watch = true,
    run_discovery_timeout_sec = 60,
  },
  { sendProgress, progressToken } = {},
) {
  const start = Date.now();
  const deadline = start + timeout_sec * 1000;

  // Fast path: maybe already done.
  let lastStatus = await checkCopilotReviewStatus({ owner, repo, pr, since_iso });
  if (lastStatus.status === "done") {
    return { ...lastStatus, method: "already-done", attempts: 1 };
  }
  const headSha = lastStatus.head_sha;

  // Deterministic path: discover a Copilot workflow run, then `gh run watch` it.
  if (prefer_run_watch) {
    const discoverDeadline = Math.min(
      start + run_discovery_timeout_sec * 1000,
      deadline,
    );
    let run = null;
    while (Date.now() < discoverDeadline) {
      run = await findCopilotRun(owner, repo, headSha);
      if (run) break;
      if (sendProgress && progressToken !== undefined) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        await sendProgress({
          progressToken,
          progress: elapsed,
          total: timeout_sec,
          message: `discovering Copilot workflow run for ${headSha.slice(0, 7)} (${elapsed}s)`,
        }).catch(() => {});
      }
      await sleep(3000);
    }

    if (run) {
      if (run.status !== "completed") {
        await watchRun(owner, repo, run.databaseId, { sendProgress, progressToken });
      }
      // Give the review API a beat to register the submitted review after the
      // run closes — GitHub posts it as a side-effect of the run finishing.
      for (let i = 0; i < 5; i++) {
        const after = await checkCopilotReviewStatus({ owner, repo, pr, since_iso });
        if (after.status === "done") {
          return {
            ...after,
            method: "run-watch",
            run_id: run.databaseId,
            run_url: run.url,
            attempts: 1,
          };
        }
        await sleep(2000);
      }
      // Fall through to poll loop if the review never materialized
    }
  }

  // Fallback: classic poll loop (older repos / non-pipeline Copilot deployments).
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    lastStatus = await checkCopilotReviewStatus({ owner, repo, pr, since_iso });
    if (lastStatus.status === "done") {
      return { ...lastStatus, method: "poll", attempts };
    }
    if (lastStatus.status === "absent") {
      return { ...lastStatus, method: "poll", attempts };
    }

    if (sendProgress && progressToken !== undefined) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      await sendProgress({
        progressToken,
        progress: elapsed,
        total: timeout_sec,
        message: `waiting for Copilot review (poll attempt ${attempts}, ${elapsed}s elapsed)`,
      }).catch(() => {});
    }

    await sleep(poll_interval_sec * 1000);
  }

  return {
    status: "timeout",
    method: "poll",
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

// ---------- diff inspection ----------
//
// Copilot reviews the WHOLE PR diff against the base branch on every
// invocation — there's no "review only the last commit" mode. So a small
// fix commit on a big PR still triggers a big review (AI credits + Actions
// minutes). This helper computes the delta between the last Copilot review's
// commit and the current HEAD so the caller can decide whether the new push
// is substantive enough to justify another review cycle.

const DOC_FILE_PATTERN =
  /\.(md|mdx|txt|rst|adoc|asciidoc)$|(^|\/)(README|LICENSE|CHANGELOG|AUTHORS|CONTRIBUTORS|CONTRIBUTING|CODE_OF_CONDUCT|NOTICE|SECURITY)(\.|$)/i;

async function diffSinceLastCopilotReview({ owner, repo, pr }) {
  const prData = await getPr(owner, repo, pr);
  const headSha = prData.head.sha;
  const reviews = await listReviews(owner, repo, pr);
  const latestAny = latestCopilotReview(reviews, null);

  if (!latestAny) {
    return {
      status: "no_prior_review",
      head_sha: headSha,
      recommendation: "substantive",
      hint:
        "Copilot has never reviewed this PR. The next call to request_copilot_review will be the first cycle.",
    };
  }

  const baseSha = latestAny.commit_id;

  if (baseSha === headSha) {
    return {
      status: "no_change",
      head_sha: headSha,
      base_sha: baseSha,
      recommendation: "skip",
      hint:
        "Current HEAD is the same commit Copilot last reviewed. Re-requesting will produce a duplicate review — skip and either address remaining threads or merge.",
    };
  }

  let compare;
  try {
    compare = await ghJson([
      "api",
      `repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
    ]);
  } catch (err) {
    return {
      status: "compare_failed",
      head_sha: headSha,
      base_sha: baseSha,
      recommendation: "substantive",
      error: err.message,
      hint:
        "Couldn't compute the diff (commits may have been force-pushed out of history). Assume substantive and re-request.",
    };
  }

  const files = compare?.files || [];
  const filesChanged = files.length;
  const additions = files.reduce((s, f) => s + (f.additions || 0), 0);
  const deletions = files.reduce((s, f) => s + (f.deletions || 0), 0);
  const totalLines = additions + deletions;

  const codeFiles = files.filter((f) => !DOC_FILE_PATTERN.test(f.filename));
  const docOnly = codeFiles.length === 0 && filesChanged > 0;
  const codeLines = codeFiles.reduce(
    (s, f) => s + (f.additions || 0) + (f.deletions || 0),
    0,
  );

  // Heuristics for "trivial". Conservative — bias toward re-reviewing unless
  // the delta is genuinely tiny. Copilot reviews are non-deterministic so a
  // re-review can still surface bugs even on a small delta; skipping is a
  // cost optimization, not a correctness one.
  const reasons = [];
  let recommendation = "substantive";
  if (docOnly) {
    recommendation = "trivial";
    reasons.push(
      `all ${filesChanged} changed file(s) match doc patterns (md/txt/rst/README/LICENSE/...)`,
    );
  } else if (codeLines === 0) {
    recommendation = "trivial";
    reasons.push("zero code-line changes (only whitespace/renames/binary)");
  } else if (codeLines <= 10 && codeFiles.length <= 2) {
    recommendation = "trivial";
    reasons.push(
      `tiny code delta (${codeFiles.length} code file(s), ${codeLines} line(s))`,
    );
  }

  return {
    status: "ok",
    head_sha: headSha,
    base_sha: baseSha,
    head_short: headSha.slice(0, 7),
    base_short: baseSha.slice(0, 7),
    recommendation,
    reasons,
    stats: {
      files_changed: filesChanged,
      code_files_changed: codeFiles.length,
      additions,
      deletions,
      total_lines: totalLines,
      code_lines: codeLines,
    },
    files: files.slice(0, 25).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      is_doc: DOC_FILE_PATTERN.test(f.filename),
    })),
    hint:
      recommendation === "trivial"
        ? "Delta is small/doc-only. Consider skipping the next review cycle and proceeding to merge if all prior threads are addressed. CAVEAT: Copilot's reviews are non-deterministic; a re-review might surface something missed earlier. This is a cost optimization, not a correctness guarantee."
        : "Delta is substantive — request Copilot to re-review.",
  };
}

// ---------- safe merge ----------
//
// Gates merging on (a) Copilot review submitted for the current HEAD, (b) zero
// unresolved Copilot threads, (c) all check runs and commit statuses green.
// Replaces use of github_merge_pull_request — that built-in does no gating and
// will happily merge a PR with failed checks, ignored Copilot review, or open
// review threads. Disable it in opencode.json:
//   "tools": { "github_merge_pull_request": false }

async function getCheckSummary(owner, repo, headSha) {
  const failed = [];
  let pending = 0;
  let total = 0;

  // Check runs (modern Actions / Apps)
  try {
    let page = 1;
    while (true) {
      const resp = await ghJson([
        "api",
        `repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
      ]);
      const runs = resp?.check_runs || [];
      if (!runs.length) break;
      for (const c of runs) {
        total++;
        if (c.status !== "completed") {
          pending++;
          failed.push({
            kind: "check_run",
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            url: c.html_url,
          });
        } else if (!["success", "neutral", "skipped"].includes(c.conclusion)) {
          failed.push({
            kind: "check_run",
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            url: c.html_url,
          });
        }
      }
      if (runs.length < 100) break;
      page++;
    }
  } catch (e) {
    failed.push({ kind: "error", source: "check_runs", message: e.message });
  }

  // Legacy commit statuses (CircleCI etc. that haven't moved to check-runs)
  try {
    const status = await ghJson([
      "api",
      `repos/${owner}/${repo}/commits/${headSha}/status`,
    ]);
    for (const s of status?.statuses || []) {
      total++;
      if (s.state === "pending") {
        pending++;
        failed.push({
          kind: "status",
          name: s.context,
          state: s.state,
          url: s.target_url,
        });
      } else if (s.state !== "success") {
        failed.push({
          kind: "status",
          name: s.context,
          state: s.state,
          url: s.target_url,
        });
      }
    }
  } catch (e) {
    failed.push({ kind: "error", source: "statuses", message: e.message });
  }

  return { ok: failed.length === 0, total, pending, failed };
}

async function safeMergePr({
  owner,
  repo,
  pr,
  merge_method = "squash",
  commit_title,
  commit_message,
  delete_branch = false,
  require_copilot_review = true,
  require_threads_resolved = true,
  require_checks_pass = true,
  force = false,
}) {
  if (!["merge", "squash", "rebase"].includes(merge_method)) {
    throw new Error(`merge_method must be merge|squash|rebase, got ${merge_method}`);
  }

  const prData = await getPr(owner, repo, pr);
  const headSha = prData.head.sha;
  const gates = {};

  // Fetch Copilot status once — re-used by review_not_pending and copilot_review gates.
  const status = await checkCopilotReviewStatus({ owner, repo, pr });

  // Gate: PR is mergeable from GitHub's perspective
  gates.pr_state = {
    ok: prData.state === "open" && prData.draft !== true,
    state: prData.state,
    draft: prData.draft,
    mergeable: prData.mergeable,
    mergeable_state: prData.mergeable_state,
  };

  // Gate: Copilot review is not still in-flight. ALWAYS enforced — cannot be
  // disabled by a require_* flag. Merging while Copilot is mid-review means
  // inline comments land seconds after the merge and you've silently
  // bypassed feedback. Even if the caller doesn't care about review content
  // (require_copilot_review=false), they still don't want this race.
  // Only `force: true` overrides.
  gates.review_not_pending = {
    ok: status.status !== "pending",
    status: status.status,
    copilot_still_requested: status.copilot_still_requested,
  };
  if (status.status === "pending") {
    gates.review_not_pending.hint =
      "Copilot is in requested_reviewers but hasn't submitted a review yet. Wait for it to finish — otherwise inline comments will land seconds after the merge and you'll have silently bypassed feedback. Use wait_for_copilot_review or check_copilot_review_status until status=='done'.";
  }

  // Gate: Copilot review is for current HEAD (stricter than review_not_pending)
  if (require_copilot_review) {
    const ok = status.status === "done" && status.commit_id === headSha;
    gates.copilot_review = {
      ok,
      status: status.status,
      review_commit_id: status.commit_id,
      head_sha: headSha,
      submitted_at: status.submitted_at,
    };
    if (!ok) {
      gates.copilot_review.hint =
        status.status === "done"
          ? `Latest Copilot review is for commit ${status.commit_id?.slice(0, 7)}, but HEAD is ${headSha.slice(0, 7)}. Push triggered a new HEAD — request a fresh Copilot review and wait for it.`
          : "Copilot has not submitted a review for the current HEAD. Run request_copilot_review then wait_for_copilot_review before merging.";
    }
  }

  // Gate: no unresolved Copilot threads
  if (require_threads_resolved) {
    // Three states we need to distinguish:
    //   (a) Some threads unresolved → fail, ask agent to resolve.
    //   (b) All threads resolved (some resolved threads exist) → pass.
    //   (c) No threads of any state, but REST review reports inline comments →
    //       GraphQL `reviewThreads` index hasn't caught up to REST yet
    //       (propagation lag); retry briefly.
    //
    // The pre-v0.6.1 logic conflated (b) and (c): REST `comment_count` is a
    // count of inline comments on the review record, which DOES NOT decrease
    // when threads are resolved. So a legitimately fully-resolved PR
    // (unresolved=0, REST comment_count>0) was misread as propagation lag,
    // failing the gate forever. Fix: cross-check against include_resolved:true
    // to confirm threads have indeed propagated before suspecting lag.
    let { count: unresolvedCount, threads: unresolvedThreads } =
      await getCopilotThreads({
        owner,
        repo,
        pr,
        include_resolved: false,
        include_outdated: false,
      });
    const reviewMatchesHead =
      status.status === "done" && status.commit_id === headSha;
    const restSaysHasComments = (status.comment_count || 0) > 0;

    let propagation_retries = 0;
    let resolved_thread_count = null;

    if (unresolvedCount === 0 && reviewMatchesHead && restSaysHasComments) {
      // Could be (b) all resolved, or (c) propagation lag. Distinguish by
      // asking for ALL threads (including resolved + outdated).
      const allThreads = await getCopilotThreads({
        owner,
        repo,
        pr,
        include_resolved: true,
        include_outdated: true,
      });
      resolved_thread_count = allThreads.count;

      if (allThreads.count === 0) {
        // (c) genuine propagation lag — retry up to 10s
        for (let i = 0; i < 5; i++) {
          await sleep(2000);
          propagation_retries++;
          const probe = await getCopilotThreads({
            owner,
            repo,
            pr,
            include_resolved: true,
            include_outdated: true,
          });
          if (probe.count > 0) {
            resolved_thread_count = probe.count;
            // Re-fetch unresolved subset; if any newly-propagated threads
            // are unresolved we still want to fail the gate.
            const refetch = await getCopilotThreads({
              owner,
              repo,
              pr,
              include_resolved: false,
              include_outdated: false,
            });
            unresolvedCount = refetch.count;
            unresolvedThreads = refetch.threads;
            break;
          }
        }
      }
      // else: (b) all threads exist as resolved — gate legitimately passes,
      // no retry needed.
    }

    gates.threads_resolved = {
      ok: unresolvedCount === 0,
      unresolved_count: unresolvedCount,
      unresolved: unresolvedThreads.slice(0, 10).map((t) => ({
        thread_id: t.thread_id,
        path: t.path,
        line: t.line,
        url: t.url,
        body_preview: (t.body || "").slice(0, 120),
      })),
    };
    if (resolved_thread_count !== null) {
      gates.threads_resolved.resolved_thread_count = resolved_thread_count;
    }
    if (propagation_retries > 0) {
      gates.threads_resolved.propagation_retries = propagation_retries;
    }
    if (unresolvedCount > 0) {
      gates.threads_resolved.hint =
        "Reply to each Copilot thread with your decision and call resolve_review_thread before merging. If you genuinely disagree, reply with your reasoning then resolve.";
    } else if (
      reviewMatchesHead &&
      restSaysHasComments &&
      resolved_thread_count === 0 &&
      propagation_retries === 5
    ) {
      // Waited 10s for ANY thread (resolved or not) to appear and got nothing
      // — genuine propagation lag, refuse to merge until we can actually see
      // the threads.
      gates.threads_resolved.ok = false;
      gates.threads_resolved.hint = `Copilot's REST review reports ${status.comment_count} inline comments for HEAD ${headSha.slice(0, 7)}, but the reviewThreads GraphQL endpoint returns 0 threads of any state (resolved or unresolved) after ${propagation_retries * 2}s. This is the documented propagation lag and means thread data is genuinely unreliable — refuse to merge. Wait 30-60s and retry, or inspect the PR manually at ${prData.html_url}.`;
    }
  }

  // Gate: checks pass
  if (require_checks_pass) {
    const summary = await getCheckSummary(owner, repo, headSha);
    gates.checks_pass = summary;
    if (!summary.ok) {
      gates.checks_pass.hint =
        summary.pending > 0
          ? `${summary.pending} checks still running. Wait for them before merging.`
          : "One or more required checks failed. Fix them before merging.";
    }
  }

  const allOk = Object.values(gates).every((g) => g.ok);
  if (!allOk && !force) {
    return {
      merged: false,
      gates,
      head_sha: headSha,
      hint:
        "One or more merge gates failed. Address them, or pass force=true to override (NOT recommended).",
    };
  }

  const mergeArgs = [
    "pr",
    "merge",
    String(pr),
    "--repo",
    `${owner}/${repo}`,
    `--${merge_method}`,
  ];
  if (commit_title) mergeArgs.push("--subject", commit_title);
  if (commit_message) mergeArgs.push("--body", commit_message);
  if (delete_branch) mergeArgs.push("--delete-branch");

  try {
    await gh(mergeArgs);
    return {
      merged: true,
      forced: !allOk,
      gates,
      head_sha: headSha,
      merge_method,
    };
  } catch (e) {
    return {
      merged: false,
      gates,
      head_sha: headSha,
      merge_error: e.message,
    };
  }
}

// ---------- MCP wiring ----------

const server = new Server(
  { name: "copilot-review-mcp", version: "0.6.1" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const TOOLS = [
  {
    name: "request_copilot_review",
    description:
      "Request GitHub Copilot as a reviewer on a PR. Marks draft PRs as ready (opt-out via mark_ready=false). Tries multiple paths: (1) REST POST requested_reviewers with reviewers[]=Copilot, (2) `gh pr edit --add-reviewer Copilot` if REST errored, (3) GraphQL requestReviews(botIds:[Copilot]) — the documented community workaround that reliably re-requests even when REST silently no-ops (the ruleset's review_on_push glitch, see community/community#186152). VERIFIES the request actually took effect by re-reading requested_reviewers after each attempt. Response includes `method` (which path succeeded) and `methods_tried`. Returns {requested:false, hint:...} only if all paths fail.",
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
      "Block until Copilot submits a review for the PR's current HEAD SHA. Deterministic: first tries to find the Copilot Actions workflow run for the head SHA (modern pipeline-based Copilot review) and `gh run watch`es it, falling back to REST review polling for older repos. Returns early with status:'absent' if Copilot is not requested and has no matching review. Sends MCP progress notifications. Default timeout 600s. NOTE: opencode MCP client has its own per-call timeout — set `\"timeout\": 900000` on this server in opencode.json for long waits.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
        timeout_sec: { type: "integer", default: 600, minimum: 30 },
        poll_interval_sec: {
          type: "integer",
          default: 20,
          minimum: 5,
          description: "Used only by the REST poll fallback.",
        },
        since_iso: { type: "string" },
        prefer_run_watch: {
          type: "boolean",
          default: true,
          description:
            "If true (default), attempt deterministic `gh run watch` on the Copilot workflow run before falling back to polling. Set false to skip discovery for repos known not to use the pipeline.",
        },
        run_discovery_timeout_sec: {
          type: "integer",
          default: 60,
          minimum: 5,
          description:
            "How long to wait for the Copilot workflow run to appear before giving up on the deterministic path and falling back to polling.",
        },
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
  {
    name: "diff_since_last_copilot_review",
    description:
      "Compute the diff between the commit Copilot last reviewed and the PR's current HEAD. Returns stats (files_changed, additions, deletions, code_lines), per-file breakdown, and a `recommendation` of either 'substantive' (re-request another review), 'trivial' (doc-only or <=10 code lines across <=2 files — consider skipping the next cycle to save AI credits / Actions minutes), 'skip' (HEAD is the same commit as the last review — re-requesting yields a duplicate), or 'substantive' fallback for `no_prior_review` / `compare_failed`. Use BEFORE calling request_copilot_review in a new cycle to avoid wasting cycles on trivial pushes. CAVEAT: Copilot reviews are non-deterministic; skipping is a cost optimization, not a correctness guarantee.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
      },
      required: ["owner", "repo", "pr"],
    },
  },
  {
    name: "safe_merge_pr",
    description:
      "Merge a PR ONLY if all gates pass. Always-on gates (cannot be disabled by require_* flags, only by force=true): (a) PR is open and not draft, (b) Copilot review is NOT mid-flight — refuses to merge while Copilot is still working, even if require_copilot_review=false. Optional gates (default on): (c) Copilot has submitted a review for the current HEAD, (d) zero unresolved Copilot review threads (with GraphQL/REST propagation-lag retry), (e) all check runs and commit statuses are green. Replaces the built-in `github_merge_pull_request`, which performs no gating. Disable the built-in in opencode.json with `\"tools\": { \"github_merge_pull_request\": false }`. Returns a per-gate verdict; pass `force=true` to override (NOT recommended). Each optional gate can be individually disabled via require_* flags, but the always-on review_not_pending gate prevents the most common silent footgun (merging while Copilot's inline comments are still in-flight).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
        merge_method: {
          type: "string",
          enum: ["merge", "squash", "rebase"],
          default: "squash",
        },
        commit_title: { type: "string" },
        commit_message: { type: "string" },
        delete_branch: { type: "boolean", default: false },
        require_copilot_review: { type: "boolean", default: true },
        require_threads_resolved: { type: "boolean", default: true },
        require_checks_pass: { type: "boolean", default: true },
        force: {
          type: "boolean",
          default: false,
          description:
            "Override failed gates and merge anyway. The response will show `forced:true` and which gates failed. Reserve for genuine emergencies.",
        },
      },
      required: ["owner", "repo", "pr"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [],
}));

// Per-tool budgets (ms). opencode's MCP `timeout` is server-wide, so without
// these every tool would inherit the longest one (15min for waiting on a
// Copilot review). A hung `gh api` call during a snappy status check would
// then block the agent for 15 minutes. These budgets fail-fast instead.
// `wait_for_copilot_review` is excluded — it manages its own timing via the
// `timeout_sec` arg.
const TOOL_TIMEOUTS_MS = {
  request_copilot_review: 30_000,
  check_copilot_review_status: 30_000,
  get_copilot_threads: 60_000,
  reply_to_review_comment: 30_000,
  resolve_review_thread: 30_000,
  enable_copilot_auto_review: 60_000,
  diff_since_last_copilot_review: 30_000,
  safe_merge_pr: 120_000,
  // wait_for_copilot_review: handled internally
};

function withTimeout(promise, ms, toolName) {
  if (!ms) return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `tool ${toolName} exceeded its ${ms}ms server-side budget (likely a hung gh API call). Retry, or check 'gh auth status' / network.`,
        ),
      );
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

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
    let work;
    switch (name) {
      case "request_copilot_review":
        work = requestCopilotReview(args);
        break;
      case "check_copilot_review_status":
        work = checkCopilotReviewStatus(args);
        break;
      case "wait_for_copilot_review":
        // No outer timeout — uses its own `timeout_sec` arg internally
        work = waitForCopilotReview(args, { sendProgress, progressToken });
        break;
      case "get_copilot_threads":
        work = getCopilotThreads(args);
        break;
      case "reply_to_review_comment":
        work = replyToReviewComment(args);
        break;
      case "resolve_review_thread":
        work = resolveReviewThread(args);
        break;
      case "enable_copilot_auto_review":
        work = enableCopilotAutoReview(args);
        break;
      case "diff_since_last_copilot_review":
        work = diffSinceLastCopilotReview(args);
        break;
      case "safe_merge_pr":
        work = safeMergePr(args);
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    const result = await withTimeout(work, TOOL_TIMEOUTS_MS[name], name);
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
