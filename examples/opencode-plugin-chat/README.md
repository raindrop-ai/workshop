# opencode-plugin-chat

End-to-end demo of [`@raindrop-ai/opencode-plugin`](https://www.npmjs.com/package/@raindrop-ai/opencode-plugin) loaded into the real [OpenCode](https://opencode.ai) CLI.

Each chat turn spawns `opencode run` as a subprocess in a per-process sandbox workspace pre-seeded with a tiny demo project (`README.md`, `app.json`, `hello.txt`, plus an empty `.git/` so opencode treats the dir as the workspace root). The plugin streams session, message, and tool spans (read / list / write / shell / etc.) directly to your local Workshop daemon. The example server only proxies opencode's stdout/stderr back to the chat UI.

## Setup

```bash
cd examples/opencode-plugin-chat
bun install

# OpenCode itself needs provider creds. Either:
#   1. opencode auth login   # interactive credential setup
#   2. export OPENAI_API_KEY=sk-...   # passed through to the subprocess
```

## Run

```bash
bun run dev
# or via the workshop dev-all aggregator (pinned to port 3021):
bun run dev:examples
```

Open `http://localhost:3021`. The default model is `openai/gpt-4o-mini` — change it in the UI to anything `opencode models` lists. The default prompt asks the agent to list and summarise every file in the sandbox; it produces ~25 spans (one per `list` / `read` tool call plus the final LLM reply) so the resulting Workshop run is meaty enough to compare side-by-side with the other example apps.

## Workshop wiring

The plugin's Workshop resolution chain:

1. `localWorkshopUrl` field in `~/.config/opencode/raindrop.json` or `<workspace>/.opencode/raindrop.json`
2. `RAINDROP_LOCAL_WORKSHOP_URL` env var (passed through to the subprocess)
3. `RAINDROP_LOCAL_DEBUGGER` / `RAINDROP_WORKSHOP` env vars
4. Auto-detect: `NODE_ENV=development` or localhost-ish hostname

`RAINDROP_WRITE_KEY` is optional — when absent, the plugin runs local-only.

## Multi-turn

The "Continue session" checkbox passes `--continue` to `opencode run`, which resumes the workspace's most recent session. **Reset** clears the local "last session started" flag AND restores the seeded files (`README.md` / `app.json` / `hello.txt`) to their original contents in case the agent overwrote them.

## Why a sandbox

OpenCode auto-detects its workspace by walking up from the current directory looking for project markers (`.git`, `package.json`, etc.). Without a sandbox, it would walk up to your shell's cwd (probably the workshop repo itself) and start reading/modifying its files. The per-process sandbox in `$TMPDIR/raindrop-opencode-plugin-chat-<pid>/` keeps each demo session isolated and reproducible.
