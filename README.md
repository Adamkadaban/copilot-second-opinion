# copilot-second-opinion

OpenCode skill + MCP server that runs GitHub Copilot's PR reviewer in a loop: request review → wait → reply/resolve each comment → fix → repeat.

## Install

```bash
./install.sh
```

Add to `~/.config/opencode/opencode.json`:

```json
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

**Requires:** Node 18+, `gh` CLI authenticated, Copilot code review enabled on the repo.

## Usage

From OpenCode:

> get a second opinion from Copilot on PR 42

## License

MIT
