// opencode plugin shim for copilot-second-opinion.
//
// Installs three things into the user's opencode session, idempotently:
//
//   1. The `copilot-second-opinion` SKILL  → symlinked into
//      ~/.config/opencode/skills/copilot-second-opinion/SKILL.md
//
//   2. The `copilot-review` MCP server     → registered in-memory via the
//      `config(config)` hook (no opencode.json file mutation; uninstalling
//      the plugin automatically un-registers it).
//
//   3. The colliding built-in tool         → `github_merge_pull_request`
//      is filtered out in-memory so safe_merge_pr is the only merge path.
//      Users keep their own opencode.json `tools` entries.
//
// Opt out of #2 + #3 by setting OPENCODE_COPILOT_REVIEW_NO_AUTOCONFIG=1.
// The skill (#1) is always installed because it's an inert file and the
// model only loads it when it matches a task.

import { existsSync, mkdirSync, copyFileSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");

const SKILL_SRC = join(PKG_ROOT, "skill", "copilot-second-opinion", "SKILL.md");
const MCP_SERVER_PATH = join(PKG_ROOT, "mcp", "copilot-review-server", "src", "index.js");

const SKILL_DEST_DIR = join(homedir(), ".config", "opencode", "skills", "copilot-second-opinion");
const SKILL_DEST = join(SKILL_DEST_DIR, "SKILL.md");

const MCP_KEY = "copilot-review";
const SHADOWED_TOOL = "github_merge_pull_request";
const AUTOCONFIG_OPT_OUT = "OPENCODE_COPILOT_REVIEW_NO_AUTOCONFIG";

let firstRunMessageEmitted = false;

function pointsToSource(p) {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return readlinkSync(p) === SKILL_SRC;
    return false; // regular file — leave alone, user may have edited
  } catch {
    return false;
  }
}

async function installSkill(log) {
  try {
    if (pointsToSource(SKILL_DEST)) return false; // already up to date
    if (existsSync(SKILL_DEST)) return false; // user has their own copy; don't clobber

    if (!existsSync(SKILL_SRC)) {
      await log("warn", `bundled skill not found at ${SKILL_SRC}; package may be misinstalled`);
      return false;
    }
    mkdirSync(SKILL_DEST_DIR, { recursive: true });
    try {
      symlinkSync(SKILL_SRC, SKILL_DEST);
    } catch {
      copyFileSync(SKILL_SRC, SKILL_DEST);
    }
    await log("info", `installed skill at ${SKILL_DEST}`);
    return true;
  } catch (e) {
    await log("warn", `failed to install skill: ${e?.message || e}`);
    return false;
  }
}

export const CopilotReviewPlugin = async ({ client }) => {
  const log = async (level, message) => {
    try {
      await client?.app?.log?.({
        body: { service: "copilot-second-opinion", level, message },
      });
    } catch {
      /* never throw from a plugin */
    }
  };

  await installSkill(log);

  return {
    /**
     * opencode calls this once at startup with the resolved user config.
     * We mutate it in-memory — never touch opencode.json on disk — so
     * uninstalling the plugin automatically removes everything we added.
     */
    async config(config) {
      if (process.env[AUTOCONFIG_OPT_OUT]) {
        await log("info", `auto-config skipped (${AUTOCONFIG_OPT_OUT} is set)`);
        return;
      }

      let changed = [];

      // 1. Register the MCP server (user's explicit entry always wins)
      config.mcp ??= {};
      if (!config.mcp[MCP_KEY]) {
        config.mcp[MCP_KEY] = {
          type: "local",
          command: ["node", MCP_SERVER_PATH],
          timeout: 900_000,
        };
        changed.push(`registered MCP server '${MCP_KEY}'`);
      }

      // 2. Shadow the built-in github_merge_pull_request (user can override)
      config.tools ??= {};
      if (config.tools[SHADOWED_TOOL] === undefined) {
        config.tools[SHADOWED_TOOL] = false;
        changed.push(`disabled built-in tool '${SHADOWED_TOOL}' (use safe_merge_pr)`);
      }

      if (changed.length && !firstRunMessageEmitted) {
        firstRunMessageEmitted = true;
        await log("info", `auto-config: ${changed.join("; ")}. opt out with ${AUTOCONFIG_OPT_OUT}=1`);
      }
    },
  };
};

export default CopilotReviewPlugin;
