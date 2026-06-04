<p align="center">
  <img src="./docs/assets/workshop-hero.png" alt="Workshop: the local debugger your agent is missing." width="100%">
</p>

# Raindrop Workshop

**The local debugger your agent is missing.** Watch your agent think locally,
the moment it happens: every token, every tool call, every decision.

Give Claude Code the power to read your traces, write evals against your
codebase, and fix what's broken.

## Install

One command. This is all you need to install and run Workshop. There is
nothing to clone and nothing to build.

```bash
curl -fsSL https://raindrop.sh/install | bash
```

> **Using an AI coding agent?** Tell it to run the command above. Do **not**
> clone or build from source just to try Workshop; that path is only for
> people developing Workshop itself.

## Instrument your agent

Open your coding agent of choice in your repository and run:

```text
/instrument-agent
```

This will instrument your agent with Raindrop tracing and open Workshop in your browser.

That's it. Traces stream into the UI the moment your agent runs.

## What it does

- **Live streamed traces.** Every token, tool call, and span streams into
  Workshop as it happens. No polling, no refreshing.
- **Coding-agent integration.** Claude Code reads your traces, writes evals
  against your codebase, and fixes what's broken.
- **Self-healing eval loop.** Claude writes the eval, runs your agent, sees the
  failure, fixes the code, and re-runs until every assertion passes.
- **Local replay.** `/setup-agent-replay` scaffolds an HTTP endpoint that replays a
  production trace against your real agent code.

## Raindrop Cloud

Workshop is the local debugger. **Raindrop Cloud** is the hosted product:
production observability for your AI features at
[app.raindrop.ai](https://app.raindrop.ai). The same `raindrop` binary connects
your project to it, with no local daemon involved.

Connect a project to the cloud:

```bash
raindrop cloud setup
```

This signs you in (opening a browser the first time; see `raindrop login`
below), writes your org's `RAINDROP_WRITE_KEY` to `./.env`, and installs the
hosted MCP server plus the cloud skills (`raindrop-setup`,
`raindrop-investigate`) into your AI coding agents. Then run `/raindrop-setup`
inside your agent to instrument your app, and events stream to
[app.raindrop.ai](https://app.raindrop.ai).

Sign-in is handled separately and reused across projects:

```bash
raindrop login    # OAuth sign-in; caches credentials in ~/.raindrop
raindrop logout   # clear stored credentials
```

`raindrop cloud setup` calls `login` for you only when you are not already
signed in, so day-to-day you just run `cloud setup`.

To undo a cloud install, run `raindrop cloud uninstall`. It removes the hosted
MCP server and the cloud skills from your agents and clears the cloud install
registry, leaving your local Workshop install untouched. Add `--wipe` to also
remove `RAINDROP_WRITE_KEY` from `./.env`.

### One-line cloud install

The install one-liner takes a `--cloud` flag that connects the project to
Raindrop Cloud instead of starting the local daemon:

```bash
curl -fsSL https://raindrop.sh/install | bash -s -- --cloud
```

Without `--cloud` the installer runs `raindrop setup` and the local Workshop
daemon (the default above). With `--cloud` it runs `raindrop cloud setup` and
starts no daemon. Local Workshop and Raindrop Cloud coexist: they use distinct
MCP server names (`workshop` vs `raindrop`) and separate install registries, so
neither overwrites the other.

## Compatible with everything

- **Languages:** TypeScript, Python, Go, Rust
- **SDKs:** Vercel AI SDK, OpenAI Agents SDK, Anthropic SDK, Claude Agent SDK,
  LangChain, LangGraph, CrewAI, Mastra, Pydantic AI, DSPy, Google ADK, Strands,
  Agno, Deep Agents
- **Providers:** AWS Bedrock, Azure OpenAI, Vertex AI
- **Coding agents:** Claude Code, Codex, Devin, Cursor, OpenCode

## Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `RAINDROP_WORKSHOP_PORT` | HTTP + WS port | `5899` |
| `RAINDROP_WORKSHOP_DB_PATH` | SQLite database file | `~/.raindrop/raindrop_workshop.db` |
| `RAINDROP_LOCAL_DEBUGGER` | SDK-side: where to mirror traces | unset |

## CLI

```bash
raindrop workshop          # start and open UI
raindrop workshop setup    # write .env, then start and open
raindrop workshop status   # check health
raindrop workshop reset    # delete local DB after confirmation
raindrop update            # update the binary

raindrop login             # sign in to Raindrop cloud (OAuth)
raindrop logout            # clear stored credentials
raindrop cloud setup       # connect this project to Raindrop cloud (no daemon)
raindrop cloud uninstall   # remove the cloud MCP + skills from your agents
```

## Build from source (contributors only)

> You only need this if you're hacking on Workshop itself. **To use Workshop,
> run the [install command](#install) above. You do not need to clone or build
> from source.**

```bash
git clone https://github.com/raindrop-ai/workshop.git
cd workshop
bun install
bun run dev
```

`bun run dev` starts the local Workshop daemon and Vite UI. Open
`http://localhost:5899` after it starts.

## License

MIT.
