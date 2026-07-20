# Agent guide

Read this first to decide what the user actually wants.

## Did the user ask you to *use* Workshop? (the common case)

**Just run the one-liner:**

```bash
curl -fsSL https://raindrop.sh/install | bash
```

That installs the `raindrop` CLI. Then `raindrop workshop` starts the UI.

Do **not** clone this repo or `bun install` for this. Building from source is only for developing Workshop itself.

**Hosted observability instead?** `raindrop cloud setup` connects to [app.raindrop.ai](https://app.raindrop.ai) (no local daemon).

## Did the user ask you to *develop* Workshop?

Build from source:

```bash
bun install
bun run dev   # daemon on :5899, Vite UI on http://localhost:5900
```

## Commands

```
bun run build         # build
bun run test          # test
bun run lint          # lint
bun x tsc --noEmit    # typecheck
```

See `.devin/blueprint.yml` and `.cursor/README.md` for full dev-environment setup.

## How to work

- Touch only what the task requires. Match existing style.
- Every changed line must trace to the user's request.

## Verification (Definition of Done)

Before creating a PR, **run and confirm:**

```
bun run build         # MUST exit 0
bun run test          # MUST pass
bun run lint          # MUST exit 0
bun x tsc --noEmit    # MUST exit 0
```

For UI changes: visually verify changed pages render correctly and check neighboring pages.

Then: review your diff — no unintended changes, no debug code, changes scoped to the task.

## Do not touch (without explicit permission)

- `.github/workflows/` — propose, don't apply
- The `raindrop` CLI installer (`https://raindrop.sh/install`)
- Publish/release configuration

## Agent operating notes

- Keep a running memory of mistakes here. Add a concrete guardrail when you make a repeatable stumble.
