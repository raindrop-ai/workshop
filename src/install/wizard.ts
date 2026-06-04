import {
  cancel,
  intro,
  isCancel,
  outro,
  select,
} from "@clack/prompts";
import type { Readable, Writable } from "node:stream";
import { getSupportedInstallAgents } from "./detect";
import { buildInstallPlan } from "./plan";
import type {
  InstallPlan,
  InstallScope,
} from "./types";

export interface InstallWizardOptions {
  cwd: string;
  input?: Readable;
  output?: Writable;
}

export interface InstallWizardResult {
  plan: InstallPlan;
  skipped?: boolean;
  scope: InstallScope;
}

function promptOptions(opts: InstallWizardOptions): { input?: Readable; output?: Writable } {
  return { input: opts.input, output: opts.output };
}

function abort(opts: InstallWizardOptions): never {
  cancel("Setup cancelled.", promptOptions(opts));
  process.exit(130);
}

function cyan(text: string): string {
  if (process.env.NO_COLOR) return text;
  return `\x1b[36m${text}\x1b[0m`;
}

const setupCommand = cyan("raindrop setup");

export async function runInstallWizard(
  opts: InstallWizardOptions,
): Promise<InstallWizardResult> {
  const io = promptOptions(opts);
  intro("Raindrop Setup", io);
  const mode = await select<"default" | "customise">({
    message: "Choose setup mode",
    options: [
      {
        value: "default",
        label: "Default",
        hint: "installs skills and MCP globally",
      },
      {
        value: "customise",
        label: "Customise",
        hint: "choose path",
      },
    ],
    initialValue: "default",
    ...io,
  });
  if (isCancel(mode)) abort(opts);

  let scope: InstallScope = "global";
  if (mode === "customise") {
    const customChoice = await select<"local" | "skip">({
      message: "Where should Raindrop be set up?",
      options: [
        {
          value: "local",
          label: "Install in the current directory",
          hint: opts.cwd,
        },
        {
          value: "skip",
          label: `Run ${setupCommand} in your project directory`,
          hint: "skip for now",
        },
      ],
      initialValue: "local",
      ...io,
    });
    if (isCancel(customChoice)) abort(opts);
    if (customChoice === "skip") {
      outro(`Run ${setupCommand} from the project directory you want to set up.`, io);
      return { plan: { items: [] }, skipped: true, scope };
    }
    scope = "local";
  }

  const agents = getSupportedInstallAgents({
    scope,
    cwd: opts.cwd,
  })
    .filter((agent) => agent.supportsSkills && agent.supportsMcp)
    .map((agent) => agent.agent);

  const plan = buildInstallPlan({
    agents,
    scope,
    cwd: opts.cwd,
  });
  outro("Setting up Raindrop.", io);
  return { plan, scope };
}
