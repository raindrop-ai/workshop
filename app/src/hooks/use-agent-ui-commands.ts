import { useWorkshopEvent } from "./use-workshop-ws";
import { router } from "../router";
import { runPath } from "../utils/navigation";

interface NavigateToRunCommand {
  type: "navigate_to_run";
  run_id: string;
}

interface OpenFilterCommand {
  type: "open_filter";
  event_name?: string;
  user_id?: string;
}

interface ComposeAnnotationCommand {
  type: "compose_annotation";
  run_id?: string;
  span_id?: string;
  note?: string;
}

type AgentUiCommand =
  | NavigateToRunCommand
  | OpenFilterCommand
  | ComposeAnnotationCommand;

export function useAgentUiCommands() {
  useWorkshopEvent("agent_ui_command", (command) => {
    if (!isAgentUiCommand(command)) return;
    if (command.type === "navigate_to_run") {
      openRun(command.run_id);
      return;
    }
    if (command.type === "open_filter") {
      openRunsPage();
      window.dispatchEvent(new CustomEvent("workshop:open-filter", { detail: command }));
      return;
    }
    if (command.type === "compose_annotation") {
      openRunsPage();
      if (command.run_id) openRun(command.run_id);
      window.dispatchEvent(new CustomEvent("workshop:compose-annotation", { detail: command }));
    }
  });
}

function openRunsPage() {
  void router.navigate("/runs");
}

function openRun(runId: string) {
  void router.navigate(runPath(runId));
}

function isAgentUiCommand(value: unknown): value is AgentUiCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<AgentUiCommand>;
  if (command.type === "navigate_to_run") return typeof command.run_id === "string";
  if (command.type === "open_filter") return true;
  if (command.type === "compose_annotation") return true;
  return false;
}
