import { useEffect, useState } from "react";
import { Folder } from "lucide-react";
import { providerLabel, type AgentProviderId } from "../utils/agent-provider";

type ChannelState = "green" | "amber" | "gray";

interface Status {
  state: ChannelState;
  session_id?: string;
}

interface RegisteredWorkspace {
  cwd: string;
  agents?: string[];
  active?: boolean;
}

const COLORS: Record<ChannelState, string> = {
  green: "#22c55e",
  amber: "#f59e0b",
  gray: "#6b7280",
};

function cwdLabel(cwd: string | null): string {
  if (!cwd) return "";
  const trimmed = cwd.replace(/\/+$/, "");
  const base = trimmed.split("/").pop();
  return base || trimmed;
}

export function ConnectionIndicator({
  cwd = null,
  provider = "claude",
  onChooseFolder,
}: {
  cwd?: string | null;
  provider?: AgentProviderId;
  onChooseFolder?: () => void;
} = {}) {
  const [status, setStatus] = useState<Status>({ state: "gray" });
  const [showRemediation, setShowRemediation] = useState(false);
  const [firstTimeOpen, setFirstTimeOpen] = useState(false);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [workspaces, setWorkspaces] = useState<RegisteredWorkspace[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((body) => setStatus(body.agent ?? body.claude_code ?? { state: "gray" }))
      .catch(() => setStatus({ state: "gray" }));
  }, [provider]);

  useEffect(() => {
    if (!showRemediation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowRemediation(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showRemediation]);

  useEffect(() => {
    if (!showWorkspaceMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowWorkspaceMenu(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-workspace-switcher]")) setShowWorkspaceMenu(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [showWorkspaceMenu]);

  const installer =
    "curl -fsSL https://raw.githubusercontent.com/raindrop-ai/cli/main/install.sh | bash";
  const mcpAddCommand =
    "claude mcp add raindrop -- bun /path/to/workshop2/src/index.ts workshop mcp";
  const dir = status.state === "green" ? cwdLabel(cwd) : "";
  const statusContent = (
    <>
      <span
        className="w-2 h-2 rounded-full"
        style={{ background: COLORS[status.state] }}
      />
      {status.state !== "green" && (
        <span className="truncate text-xs text-white/70">{providerLabel(provider)} unavailable</span>
      )}
      {dir && (
        <span className="flex min-w-0 items-center gap-1 text-xs text-white/45">
          <Folder className="h-3 w-3 shrink-0" />
          <span className="truncate">{dir}</span>
        </span>
      )}
    </>
  );

  return (
    <div className="relative" data-workspace-switcher>
      {status.state === "green" ? (
        <button
          className="flex min-w-0 items-center gap-2 rounded px-2 py-1 transition hover:bg-white/5"
          onClick={() => {
            setShowWorkspaceMenu((value) => !value);
            void loadRegisteredWorkspaces(setWorkspaces, setWorkspaceError);
          }}
          title="Switch workspace"
        >
          {statusContent}
        </button>
      ) : (
        <button
          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 transition"
          onClick={() => setShowRemediation((v) => !v)}
        >
          {statusContent}
        </button>
      )}
      {showWorkspaceMenu && status.state === "green" && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 rounded-lg border border-white/10 bg-zinc-900/95 p-1 text-xs shadow-2xl backdrop-blur">
          {onChooseFolder && (
            <button
              type="button"
              className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-white/75 transition-colors hover:bg-white/5 hover:text-white"
              onClick={() => {
                setShowWorkspaceMenu(false);
                onChooseFolder();
              }}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Choose folder...</span>
            </button>
          )}
          {workspaceError && (
            <div className="px-2 py-1.5 text-red-100/80">{workspaceError}</div>
          )}
          {!workspaceError && workspaces.length === 0 && (
            <div className="px-2 py-2 text-white/40">No registered workspaces.</div>
          )}
          {!workspaceError && workspaces.map((workspace) => (
            <button
              key={workspace.cwd}
              type="button"
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                workspace.cwd === cwd ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white"
              }`}
              onClick={() => void switchWorkspace(workspace.cwd, setShowWorkspaceMenu, setWorkspaceError)}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{cwdLabel(workspace.cwd)}</span>
              {workspace.agents && workspace.agents.length > 0 && (
                <span className="shrink-0 truncate text-[10px] text-white/30">{workspace.agents.join(", ")}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {showRemediation && status.state !== "green" && (
        <div className="absolute right-0 top-full mt-2 w-80 rounded-lg border border-white/10 bg-zinc-900/95 backdrop-blur p-3 z-50 text-xs">
          <div className="text-white/80 mb-2 leading-relaxed">
            Workshop chat streams through your local {providerLabel(provider)} CLI. Make sure
            <code className="mx-1 rounded bg-black/40 px-1 font-mono">{provider === "codex" ? "codex" : "claude"}</code>
            is on your PATH and you are logged in.
          </div>
          <button
            className="mt-1 text-white/50 hover:text-white/80"
            onClick={() => setFirstTimeOpen((v) => !v)}
          >
            First time? {firstTimeOpen ? "▾" : "▸"}
          </button>
          {firstTimeOpen && (
            <div className="mt-2 text-white/60 leading-relaxed space-y-2">
              <div>
                Run this once to install the raindrop CLI and drop MCP + skill
                files into your coding tool config:
              </div>
              <div className="flex items-center gap-2 rounded bg-black/40 px-2 py-1.5 font-mono text-[10px] text-white/90">
                <span className="flex-1 select-all break-all">{installer}</span>
              </div>
              <div>
                For source-tree development, register the stdio MCP command once:
              </div>
              <div className="flex items-center gap-2 rounded bg-black/40 px-2 py-1.5 font-mono text-[10px] text-white/90">
                <span className="flex-1 select-all break-all">{mcpAddCommand}</span>
              </div>
              <div>
                Workshop chat streams through {providerLabel(provider)} and
                passes the Raindrop MCP into that session. The Claude Code MCP
                entry lives in{" "}
                <code className="font-mono bg-black/40 px-1 rounded">
                  ~/.claude.json
                </code>
                ; Codex can also read MCP servers from{" "}
                <code className="font-mono bg-black/40 px-1 rounded">
                  ~/.codex/config.toml
                </code>
                .
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function loadRegisteredWorkspaces(
  setWorkspaces: (workspaces: RegisteredWorkspace[]) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    const res = await fetch("/api/workspace/registered");
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? "Could not load registered workspaces.");
    setWorkspaces(Array.isArray(body?.workspaces) ? body.workspaces : []);
  } catch (err) {
    setError((err as Error).message);
    setWorkspaces([]);
  }
}

async function switchWorkspace(
  cwd: string,
  setOpen: (open: boolean) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    const res = await fetch("/api/workspace/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? "Could not switch workspace.");
    setOpen(false);
  } catch (err) {
    setError((err as Error).message);
  }
}
