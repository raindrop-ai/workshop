import fs from "node:fs";
import type { Readable } from "node:stream";

import { confirm, isCancel } from "@clack/prompts";

import type { InstallScope } from "../install/types";
import { APP_ORIGIN } from "../auth/constants";
import { cloudInstallRegistryPath } from "./constants";

/** True when `cloud setup` has already wired this machine up (registry has at
 * least one recorded install). Used to skip the opt-in prompt on re-runs of
 * `raindrop setup` so we don't nag users who already chose cloud. */
export function cloudAlreadyConfigured(registryFile?: string): boolean {
  const file = registryFile ?? cloudInstallRegistryPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { installs?: unknown[] };
    return Array.isArray(parsed.installs) && parsed.installs.length > 0;
  } catch {
    return false;
  }
}

export interface OfferCloudOptions {
  scope: InstallScope;
  cwd: string;
  /** Interactive input stream (real TTY stdin or /dev/tty under the installer). */
  input?: Readable;
  registryFile?: string;
  /** Test seam: answer the opt-in prompt without a real TTY. */
  promptConfirm?: () => Promise<boolean | symbol>;
  /** Test seam: stand in for `cmdCloudSetup`. */
  runCloudSetup?: (argv: string[]) => Promise<number>;
}

function dim(text: string): string {
  return process.env.NO_COLOR ? text : `\x1b[2m${text}\x1b[0m`;
}

/** After a successful local Workshop setup, offer to also instrument Raindrop
 * Cloud. Cloud is strictly optional: declining (or cancelling) leaves the
 * project Workshop-only and prints how to enable cloud later. Saying yes runs
 * `cloud setup` (sign in + write key + hosted MCP/skills) for the same scope. */
export async function offerCloudInstrumentation(opts: OfferCloudOptions): Promise<void> {
  if (cloudAlreadyConfigured(opts.registryFile)) {
    console.log(dim("Raindrop Cloud is already set up here."));
    console.log(
      dim(`  Run /raindrop-setup inside your AI coding agent to instrument for cloud (events go to ${APP_ORIGIN}).`),
    );
    console.log(
      dim("  Manage it with `raindrop cloud setup` (reconfigure) or `raindrop cloud uninstall` (remove)."),
    );
    return;
  }

  const ask =
    opts.promptConfirm ??
    (() =>
      confirm({
        message: `Also instrument Raindrop Cloud? Optional. Sends events to ${APP_ORIGIN} for hosted monitoring.`,
        active: "Yes, set up cloud",
        inactive: "No, skip",
        initialValue: false,
        ...(opts.input ? { input: opts.input } : {}),
      }));

  const answer = await ask();
  if (isCancel(answer) || answer !== true) {
    console.log(dim("Skipping Raindrop Cloud. Run `raindrop cloud setup` anytime to enable it."));
    return;
  }

  const cloudArgs = [`--scope=${opts.scope}`, `--cwd=${opts.cwd}`];
  if (opts.registryFile) cloudArgs.push(`--registry-file=${opts.registryFile}`);

  const run =
    opts.runCloudSetup ??
    (async (argv: string[]) => {
      const { cmdCloudSetup } = await import("./setup");
      return cmdCloudSetup(argv);
    });

  const code = await run(cloudArgs);
  if (code !== 0) {
    console.log(
      "\x1b[33m!\x1b[0m Cloud setup did not complete. Workshop is still set up; re-run `raindrop cloud setup` to try again.",
    );
  }
}
