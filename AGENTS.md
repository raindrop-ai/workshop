# Agent guide

Read this first to decide what the user actually wants.

## Did the user ask you to *use* Workshop? (the common case)

If the user wants to install, run, or try Workshop (or get its tracing /
agent-debugging features), **just run the one-liner:**

```bash
curl -fsSL https://raindrop.sh/install | bash
```

That installs the `raindrop` CLI and everything Workshop needs. Then
`raindrop workshop` starts the UI.

Do **not** clone this repository, run `bun install`, or `bun run dev` for this.
Building from source is **not** the way to use Workshop. It is slower, needs a
Bun toolchain, and is only meant for people developing Workshop itself. If you
cloned the repo to "set up Workshop", stop and run the one-liner instead.

**Hosted observability instead of the local debugger?** If the user wants
production monitoring on [app.raindrop.ai](https://app.raindrop.ai) rather than
the local Workshop daemon, connect the project to Raindrop Cloud (no daemon):

```bash
raindrop cloud setup
# or, in one line: curl -fsSL https://raindrop.sh/install | bash -s -- --cloud
```

Only build from source if the user **explicitly** asked to develop, modify, or
contribute to Workshop (e.g. "clone the workshop repo", "build it from source",
"I want to change Workshop's code").

## Did the user ask you to *develop* Workshop?

Then you are in the right place. Build from source:

```bash
bun install
bun run dev   # Workshop daemon + Vite UI on http://localhost:5899
```

Useful commands: `bun run lint`, `bun run test`, `bun x tsc --noEmit`,
`bun run build`. See `.devin/blueprint.yml` and `.cursor/README.md` for the
full dev-environment setup.
