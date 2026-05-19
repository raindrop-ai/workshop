import { AlertTriangle, ArrowRight, Brain, Check, ChevronDown, ChevronLeft, Copy, ExternalLink, Folder as FolderIcon, KeyRound, Plus, Send, Terminal, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import claudeCodeLogo from "../assets/claude-code-logo.png";
import codexLogo from "../assets/codex-logo.svg";
import { useWorkshopEvent } from "../hooks/use-workshop-ws";
import { router } from "../router";
import { runPath } from "../utils/navigation";
import { isAgentProvider, providerLabel, type AgentProviderId } from "../utils/agent-provider";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { Markdown } from "./Markdown";
import { RaindropLogo } from "./RaindropLogo";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type Role = "user" | "assistant";

interface ClaudeChatMessage {
  id: string;
  role: Role;
  content: string;
  blocks?: ClaudeChatMessageBlock[];
  timestamp: string | null;
  error?: string;
}

type ClaudeChatMessageBlock =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input_preview?: string; output_preview?: string; ok?: boolean }
  | { type: "thinking"; text: string };

interface ClaudeSessionSummary {
  id: string;
  created_at: string | null;
  updated_at: string | null;
  message_count: number;
  last_prompt: string | null;
  preview: string | null;
  cwd?: string;
}

interface ClaudeSessionDetail extends ClaudeSessionSummary {
  messages: ClaudeChatMessage[];
}

type AssistantMessageBlock =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input_preview?: string; output_preview?: string; ok?: boolean; state: "running" | "done" }
  | { type: "thinking"; text: string }
  | { type: "error"; text: string };

interface ClaudeAskUserQuestion {
  id: string;
  session_id: string;
  tool_use_id: string;
  questions: ClaudeAskQuestion[];
  created_at: string;
}

interface ClaudeAskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

interface ClaudeMessageStream {
  client_message_id?: string;
  session_id?: string | null;
  event?: AgentStreamEvent;
}

type AgentStreamEvent =
  | { type: "text"; content: string }
  | ({ type: "loadout" } & AgentLoadout)
  | { type: "error"; content: string }
  | { type: "tool_start"; id: string; name: string; input_preview?: string }
  | { type: "tool_finish"; id: string; ok: boolean; output_preview?: string }
  | { type: "thinking_delta"; content: string }
  | { type: "subagent_start"; parent_id: string; subagent: string }
  | { type: "provider_session"; sessionId: string }
  | { type: "done" };

interface AgentLoadout {
  tools?: string[];
  mcps?: string[];
  skills?: string[];
  plugins?: string[];
  slash_commands?: string[];
  model?: string;
}

interface SlashItem {
  label: string;
  value: string;
  description?: string;
}

const COLLAPSED_KEY = "workshop:messagePane:collapsed";
const WIDTH_KEY = "workshop:messagePane:width";
const PROVIDER_INTRO_SEEN_KEY = "workshop:messagePane:providerIntroSeen";
const MIN_WIDTH = 360;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 460;
const COLLAPSE_PREVIEW_WIDTH = MIN_WIDTH - 24;
const COLLAPSE_COMMIT_WIDTH = MIN_WIDTH - 78;
const COLLAPSE_HOLD_MS = 220;
const COLLAPSE_SPRING_MS = 260;

function loadCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    return stored === null ? true : stored === "1";
  } catch { return true; }
}
function saveCollapsed(v: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0"); } catch {}
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function maxPaneWidth(): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 320));
}
function fitWidth(width: number): number {
  return clamp(width, MIN_WIDTH, maxPaneWidth());
}
function loadWidth(): number {
  try {
    return fitWidth(Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH);
  } catch {
    return fitWidth(DEFAULT_WIDTH);
  }
}
function saveWidth(width: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(width)); } catch {}
}
function loadProviderIntroSeen(): boolean {
  try { return localStorage.getItem(PROVIDER_INTRO_SEEN_KEY) === "1"; } catch { return false; }
}
function saveProviderIntroSeen(): void {
  try { localStorage.setItem(PROVIDER_INTRO_SEEN_KEY, "1"); } catch {}
}

interface MessagePaneProps {
  /** If set, messages sent from the pane will carry this run_id. */
  activeRunId?: string | null;
}

export function MessagePane({ activeRunId }: MessagePaneProps) {
  const [collapsed, setCollapsedState] = useState<boolean>(loadCollapsed);
  const [width, setWidth] = useState<number>(loadWidth);
  const [sessions, setSessions] = useState<ClaudeSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClaudeSessionDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showList, setShowList] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<ClaudeAskUserQuestion[]>([]);
  const [liveBlocks, setLiveBlocks] = useState<AssistantMessageBlock[]>([]);
  const [loadout, setLoadout] = useState<AgentLoadout | null>(null);
  const [provider, setProvider] = useState<AgentProviderId>("claude");
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [showProviderIntro, setShowProviderIntro] = useState(() => !loadProviderIntroSeen());
  const [terminalCommandCopied, setTerminalCommandCopied] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [workspaceCwd, setWorkspaceCwd] = useState<string | null>(null);
  const [showSlash, setShowSlash] = useState(false);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [collapsePreview, setCollapsePreview] = useState(false);
  const [springClosing, setSpringClosing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resizeRef = useRef<{ x: number; width: number; shouldCollapse: boolean } | null>(null);
  const activeClientMessageIdRef = useRef<string | null>(null);
  const liveBlocksRef = useRef<AssistantMessageBlock[]>([]);
  const terminalCopyResetRef = useRef<number | null>(null);
  const collapseHoldTimerRef = useRef<number | null>(null);
  const springCloseTimerRef = useRef<number | null>(null);
  const hiddenPendingQuestionIdsRef = useRef<Set<string>>(new Set());
  const hiddenPendingSessionIdsRef = useRef<Set<string>>(new Set());
  const suppressPendingUntilNextSendRef = useRef(false);

  function setCollapsed(v: boolean) {
    setCollapsePreview(false);
    setSpringClosing(false);
    if (collapseHoldTimerRef.current) {
      window.clearTimeout(collapseHoldTimerRef.current);
      collapseHoldTimerRef.current = null;
    }
    if (springCloseTimerRef.current) {
      window.clearTimeout(springCloseTimerRef.current);
      springCloseTimerRef.current = null;
    }
    setCollapsedState(v);
    saveCollapsed(v);
  }

  function springCloseFromResize() {
    if (springClosing || springCloseTimerRef.current) return;
    resizeRef.current = null;
    if (collapseHoldTimerRef.current) {
      window.clearTimeout(collapseHoldTimerRef.current);
      collapseHoldTimerRef.current = null;
    }
    setWidth(MIN_WIDTH);
    setCollapsePreview(true);
    setSpringClosing(true);
    springCloseTimerRef.current = window.setTimeout(() => {
      springCloseTimerRef.current = null;
      setCollapsed(true);
    }, COLLAPSE_SPRING_MS);
  }

  function dismissProviderIntro() {
    setShowProviderIntro(false);
    saveProviderIntroSeen();
  }

  useEffect(() => () => {
    if (terminalCopyResetRef.current) window.clearTimeout(terminalCopyResetRef.current);
    if (collapseHoldTimerRef.current) window.clearTimeout(collapseHoldTimerRef.current);
    if (springCloseTimerRef.current) window.clearTimeout(springCloseTimerRef.current);
  }, []);

  useEffect(() => {
    if (collapsePreview || springClosing) return;
    saveWidth(width);
  }, [width, collapsePreview, springClosing]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      event.preventDefault();
      const rawWidth = resize.width - (event.clientX - resize.x);
      const shouldPreview = rawWidth < COLLAPSE_PREVIEW_WIDTH;
      const shouldCollapse = rawWidth < COLLAPSE_COMMIT_WIDTH;
      resizeRef.current = { ...resize, shouldCollapse };
      setCollapsePreview(shouldPreview);
      if (shouldPreview) {
        setWidth(MIN_WIDTH);
      } else {
        setWidth(fitWidth(rawWidth));
      }
      if (shouldCollapse) {
        if (!collapseHoldTimerRef.current) {
          collapseHoldTimerRef.current = window.setTimeout(() => {
            collapseHoldTimerRef.current = null;
            if (resizeRef.current?.shouldCollapse) springCloseFromResize();
          }, COLLAPSE_HOLD_MS);
        }
      } else if (collapseHoldTimerRef.current) {
        window.clearTimeout(collapseHoldTimerRef.current);
        collapseHoldTimerRef.current = null;
      }
    };
    const onPointerUp = () => {
      const shouldCollapse = resizeRef.current?.shouldCollapse ?? false;
      resizeRef.current = null;
      if (collapseHoldTimerRef.current) {
        window.clearTimeout(collapseHoldTimerRef.current);
        collapseHoldTimerRef.current = null;
      }
      if (shouldCollapse) {
        springCloseFromResize();
      } else {
        setCollapsePreview(false);
      }
    };
    const onResize = () => setWidth((current) => fitWidth(current));
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const refreshSessions = useCallback(async () => {
    const res = await fetch("/api/agent/sessions");
    if (res.ok) setSessions(await res.json());
  }, []);

  const loadSession = useCallback(async (id: string) => {
    setError(null);
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) {
      setError(`Could not load ${providerLabel(provider)} session.`);
      return;
    }
    pendingQuestions.forEach((question) => {
      if (question.session_id === id) hiddenPendingQuestionIdsRef.current.delete(question.id);
    });
    hiddenPendingSessionIdsRef.current.delete(id);
    suppressPendingUntilNextSendRef.current = false;
    setSelectedId(id);
    setDetail(await res.json());
    setShowList(false);
  }, [pendingQuestions, provider]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    const openPane = () => {
      setShowList(false);
      setCollapsed(false);
    };
    const resetOnboarding = () => {
      setShowProviderIntro(true);
      setShowList(true);
    };
    window.addEventListener("workshop:open-message-pane", openPane);
    window.addEventListener("workshop:messagePane:resetOnboarding", resetOnboarding);
    return () => {
      window.removeEventListener("workshop:open-message-pane", openPane);
      window.removeEventListener("workshop:messagePane:resetOnboarding", resetOnboarding);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/workspace/active");
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        const cwd = typeof body?.cwd === "string" ? body.cwd : null;
        if (!cancelled) setWorkspaceCwd(cwd);
      } catch {
        // Keep resume copy usable without a cwd if the workspace endpoint is unavailable.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/agent/loadout");
      if (!res.ok) return;
      const body = await res.json();
      if (!cancelled) setLoadout(body);
    })();
    return () => { cancelled = true; };
  }, [provider]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.messages.length, pendingQuestions.length, liveBlocks, sending]);

  useEffect(() => {
    if (!draft.startsWith("/")) setShowSlash(false);
  }, [draft]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/agent/provider");
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      if (!cancelled && isAgentProvider(body?.provider)) setProvider(body.provider);
    })();
    return () => { cancelled = true; };
  }, []);

  useWorkshopEvent("agent_provider", (data: { provider?: string }) => {
    if (isAgentProvider(data.provider)) {
      setProvider(data.provider);
      startNewChat();
      setShowList(true);
      void refreshSessions();
    }
  });

  useWorkshopEvent("workspace_changed", (workspace: { cwd?: string | null }) => {
    setWorkspaceCwd(typeof workspace?.cwd === "string" ? workspace.cwd : null);
    startNewChat();
    setShowList(true);
    void refreshSessions();
  });

  useWorkshopEvent("claude_ask_user_question", (question: ClaudeAskUserQuestion) => {
    setPendingQuestions((current) => current.some((item) => item.id === question.id)
      ? current
      : [...current, question]);
    if (
      suppressPendingUntilNextSendRef.current ||
      hiddenPendingQuestionIdsRef.current.has(question.id) ||
      hiddenPendingSessionIdsRef.current.has(question.session_id)
    ) {
      hiddenPendingQuestionIdsRef.current.add(question.id);
      return;
    }
    if (question.session_id) setSelectedId(question.session_id);
    setShowList(false);
    setCollapsed(false);
  });

  useWorkshopEvent("claude_ask_user_question_resolved", (data: { id?: string }) => {
    if (!data?.id) return;
    setPendingQuestions((current) => current.filter((item) => item.id !== data.id));
  });

  useWorkshopEvent("agent_loadout", (data: AgentLoadout) => {
    setLoadout(data);
  });

  useWorkshopEvent("agent_message_stream", (data: ClaudeMessageStream) => {
    if (!data?.client_message_id || data.client_message_id !== activeClientMessageIdRef.current) return;
    if (data.session_id) setSelectedId(data.session_id);
    const event = data.event;
    if (!event) return;
    if (event.type === "loadout") setLoadout(event);
    if (event.type === "done") return;
    if (event.type === "error") setSending(false);
    setLiveBlocks((current) => {
      const next = applyLiveStreamEvent(current, event);
      liveBlocksRef.current = next;
      return next;
    });
  });

  async function sendMessage(overrideContent?: string) {
    let content = (overrideContent ?? draft).trim();
    if (!content || sending) return;
    const commandResult = handleWorkshopCommand(content);
    if (commandResult === true) {
      setDraft("");
      setShowSlash(false);
      return;
    }
    if (typeof commandResult === "string") content = commandResult;
    suppressPendingUntilNextSendRef.current = false;
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeClientMessageIdRef.current = clientMessageId;
    liveBlocksRef.current = [];
    setLiveBlocks([]);
    setSending(true);
    setError(null);
    try {
      const optimistic: ClaudeChatMessage = {
        id: `pending-${Date.now()}`,
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      };
      setDetail((current) => current
        ? { ...current, messages: [...current.messages, optimistic] }
        : {
          id: "new",
          created_at: optimistic.timestamp,
          updated_at: optimistic.timestamp,
          message_count: 1,
          last_prompt: content,
          preview: content,
          messages: [optimistic],
        });
      setShowList(false);
      setDraft("");
      setShowSlash(false);
      const res = await fetch("/api/agent/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          session_id: selectedId,
          run_id: activeRunId ?? null,
          client_message_id: clientMessageId,
        }),
      });
      const body = await res.json().catch(() => null);
      if (activeClientMessageIdRef.current !== clientMessageId) return;
      if (!res.ok) throw new Error(body?.error ?? `${providerLabel(provider)} request failed (${res.status})`);
      if (body?.session_id) setSelectedId(body.session_id);
      if (body?.session) {
        setDetail(appendLiveCompletionIfMissing(body.session, liveBlocksRef.current));
      } else if (typeof body?.text === "string") {
        const capturedBlocks = liveBlocksRef.current.length
          ? liveBlocksRef.current
          : [{ type: "text" as const, text: body.text }];
        setDetail((current) => current
          ? appendLiveCompletionIfMissing(current, capturedBlocks)
          : current);
      }
      void refreshSessions();
    } catch (err) {
      if (activeClientMessageIdRef.current !== clientMessageId) return;
      setError((err as Error).message);
    } finally {
      if (activeClientMessageIdRef.current === clientMessageId) {
        activeClientMessageIdRef.current = null;
        liveBlocksRef.current = [];
        setLiveBlocks([]);
        setSending(false);
      }
    }
  }

  function startNewChat() {
    pendingQuestions.forEach((question) => hiddenPendingQuestionIdsRef.current.add(question.id));
    pendingQuestions.forEach((question) => hiddenPendingSessionIdsRef.current.add(question.session_id));
    if (selectedId) hiddenPendingSessionIdsRef.current.add(selectedId);
    suppressPendingUntilNextSendRef.current = true;
    activeClientMessageIdRef.current = null;
    liveBlocksRef.current = [];
    setSelectedId(null);
    setDetail(null);
    setLiveBlocks([]);
    setSending(false);
    setDraft("");
    setShowSlash(false);
    setError(null);
    setShowList(false);
  }

  async function switchProvider(next: AgentProviderId) {
    if (next === provider || switchingProvider) return;
    const previous = provider;
    setProvider(next);
    setError(null);
    setSwitchingProvider(true);
    try {
      const res = await fetch("/api/agent/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Could not switch local coding agent.");
      if (isAgentProvider(body?.provider)) setProvider(body.provider);
      startNewChat();
      setShowList(true);
      void refreshSessions();
    } catch (err) {
      setProvider(previous);
      setError((err as Error).message);
    } finally {
      setSwitchingProvider(false);
    }
  }

  function selectProvider(next: AgentProviderId) {
    dismissProviderIntro();
    void switchProvider(next);
  }

  function chooseIntroProvider(next: AgentProviderId) {
    selectProvider(next);
  }

  async function copyOpenInTerminalCommand() {
    if (!detail || !selectedId) return;
    const command = resumeCommandForSession(detail, workspaceCwd, provider);
    setTerminalCommand(command);
    if (!copyTextWithTextarea(command)) {
      try {
        await navigator.clipboard?.writeText(command);
      } catch {
        copyTextWithTextarea(command);
      }
    }
    setTerminalCommandCopied(true);
    if (terminalCopyResetRef.current) window.clearTimeout(terminalCopyResetRef.current);
    terminalCopyResetRef.current = window.setTimeout(() => setTerminalCommandCopied(false), 1800);
  }

  function handleWorkshopCommand(content: string): boolean | string {
    const [cmd, ...rest] = content.split(/\s+/);
    if (cmd === "/clear" || cmd === "/new") {
      startNewChat();
      return true;
    }
    if (cmd === "/trace" && rest[0]) {
      void router.navigate(runPath(rest[0]));
      return true;
    }
    const skillName = cmd.startsWith("/") ? cmd.slice(1) : "";
    if (skillName && loadout?.skills?.includes(skillName)) {
      return `Use the ${skillName} skill.${rest.length ? ` ${rest.join(" ")}` : ""}`;
    }
    return false;
  }

  async function answerQuestion(id: string, answers: Record<string, string>) {
    setError(null);
    const res = await fetch(`/api/claude/ask-user-question/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setError(body?.error ?? "Could not send answer.");
      return;
    }
    hiddenPendingQuestionIdsRef.current.delete(id);
    setPendingQuestions((current) => current.filter((question) => question.id !== id));
  }

  const messages = detail?.messages ?? [];
  const visiblePendingQuestions = pendingQuestions.filter((question) => question.session_id === selectedId);
  const visibleLiveBlocks = visibleAssistantBlocks(liveBlocks);
  const showTraceDebugPrompt = !!activeRunId && messages.length === 0 && !sending && visibleLiveBlocks.length === 0;
  const slashItems = useMemo(() => buildSlashItems(loadout, draft, provider), [loadout, draft, provider]);
  const activeSlashItem = showSlash ? slashItems[activeSlashIndex] : undefined;
  const currentCwd = detail?.cwd ?? workspaceCwd;
  const currentCwdDisplay = formatCwdDisplay(currentCwd);

  useEffect(() => {
    setActiveSlashIndex((index) => Math.min(index, Math.max(0, slashItems.length - 1)));
  }, [slashItems.length]);

  useEffect(() => {
    if (!showSlash) return;
    slashItemRefs.current[activeSlashIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeSlashIndex, showSlash]);

  function selectSlash(value: string) {
    setDraft(value);
    setShowSlash(false);
  }

  function insertDraftNewline(textarea: HTMLTextAreaElement) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = `${draft.slice(0, start)}\n${draft.slice(end)}`;
    setDraft(next);
    setShowSlash(false);
    requestAnimationFrame(() => {
      textarea.selectionStart = start + 1;
      textarea.selectionEnd = start + 1;
    });
  }

  if (collapsed) {
    return (
      <FloatingAskButton
        provider={provider}
        onOpen={() => {
          setWidth(loadWidth());
          setShowList(showProviderIntro);
          setCollapsed(false);
        }}
      />
    );
  }

  const paneWidth = springClosing ? 0 : width;

  return (
    <aside
      className="relative flex h-screen origin-right flex-col overflow-hidden border-l border-white/10 bg-zinc-950/40"
      style={{
        width: paneWidth,
        minWidth: paneWidth,
        maxWidth: paneWidth,
        opacity: springClosing ? 0 : collapsePreview ? 0.48 : 1,
        filter: springClosing
          ? "blur(3px) saturate(0.45)"
          : collapsePreview
            ? "blur(1.8px) saturate(0.62)"
            : "none",
        transform: springClosing ? "translateX(20px) scaleX(0.98)" : "translateX(0) scaleX(1)",
        transition: springClosing
          ? "width 260ms cubic-bezier(0.34, 1.56, 0.64, 1), min-width 260ms cubic-bezier(0.34, 1.56, 0.64, 1), max-width 260ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 170ms ease, filter 160ms ease, transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1)"
          : "opacity 140ms ease, filter 140ms ease",
      }}
      aria-hidden={springClosing}
    >
      <div
        className="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-ew-resize transition-colors hover:bg-white/10"
        onPointerDown={(event) => {
          if (springClosing) return;
          resizeRef.current = { x: event.clientX, width, shouldCollapse: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        title="Resize sidebar; drag smaller to hide"
      />
      {!showProviderIntro && (
        showList ? (
          <header className="flex items-start justify-between gap-3 border-b border-white/10 px-3 py-2">
            <div className="flex min-w-0 flex-col gap-1">
              <ProviderDropdown
                provider={provider}
                busy={switchingProvider}
                onProviderChange={selectProvider}
              />
              <ConnectionIndicator cwd={currentCwd} provider={provider} />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => setCollapsed(true)}
                className="min-h-8 rounded-md px-2.5 text-xs font-medium text-white/55 transition-[transform,background-color,color] hover:bg-white/5 hover:text-white active:scale-[0.96]"
                title="Collapse chat"
              >
                Collapse
              </button>
            </div>
          </header>
        ) : (
          <header className="relative z-10 border-b border-white/10 px-3 pb-2 pt-0.5 shadow-[0_18px_34px_rgba(0,0,0,0.92)]">
            <button
              onClick={() => { setShowList(true); void refreshSessions(); }}
              className="mb-1 -ml-1.5 inline-flex items-center gap-0.5 rounded text-xs font-medium text-white/45 transition-colors hover:text-white/80"
              title="Show all chats"
            >
              <ChevronLeft className="h-3 w-3" />
              All Chats
            </button>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white/85" title={detail?.preview ?? detail?.last_prompt ?? "New chat"}>
                  {detail?.preview ?? detail?.last_prompt ?? "New chat"}
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-white/35">
                  <FolderIcon className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 break-all leading-snug" title={currentCwd ?? undefined}>{currentCwdDisplay}</span>
                </div>
              </div>
              <div className="-mr-1 -mt-[22px] flex shrink-0 items-center gap-1">
                {detail && selectedId && (
                  <div className="relative">
                    <HeaderIconTooltip label="Open in terminal">
                      <button
                        onClick={() => void copyOpenInTerminalCommand()}
                        className="grid h-7 w-7 place-items-center rounded-md border border-white/10 bg-white/[0.04] text-white/50 transition-[transform,background-color,border-color,color] hover:border-white/18 hover:bg-white/[0.08] hover:text-white active:scale-[0.96]"
                        aria-label="Open in terminal"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </HeaderIconTooltip>
                    {terminalCommandCopied && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-[11px] leading-relaxed text-white/75 shadow-2xl backdrop-blur">
                      <div>Copied command to clipboard. Run it in your terminal.</div>
                      <code className="mt-2 block select-all break-all rounded bg-black/35 px-2 py-1.5 font-mono text-[10px] text-white/85">
                        {terminalCommand}
                      </code>
                      </div>
                    )}
                  </div>
                )}
                <HeaderIconTooltip label="New chat">
                  <button
                    onClick={startNewChat}
                    className="grid h-7 w-7 place-items-center rounded-md border border-white/10 bg-white/[0.04] text-white/50 transition-[transform,background-color,border-color,color] hover:border-white/18 hover:bg-white/[0.08] hover:text-white active:scale-[0.96]"
                    aria-label="New chat"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </HeaderIconTooltip>
                <HeaderIconTooltip label="Hide">
                  <button
                    onClick={() => setCollapsed(true)}
                    className="grid h-7 w-7 place-items-center rounded-md border border-white/10 bg-white/[0.04] text-white/50 transition-[transform,background-color,border-color,color] hover:border-white/18 hover:bg-white/[0.08] hover:text-white active:scale-[0.96]"
                    aria-label="Hide chat"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </HeaderIconTooltip>
              </div>
            </div>
          </header>
        )
      )}

      {showList ? (
        <ChatList
          sessions={sessions}
          selectedId={selectedId}
          workspaceCwd={workspaceCwd}
          provider={provider}
          providerError={error}
          providerBusy={switchingProvider}
          showProviderIntro={showProviderIntro}
          onProviderIntroChoice={chooseIntroProvider}
          onSelect={(id) => void loadSession(id)}
          onNew={startNewChat}
        />
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className={`flex-1 overflow-y-auto px-3 pt-3 ${showTraceDebugPrompt ? "pb-44" : "pb-36"} space-y-3 text-sm`}>
            {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
            {visibleLiveBlocks.length > 0 && (
              <div className="message-arrive flex flex-col items-start gap-2">
                <AssistantBlocks blocks={visibleLiveBlocks} isLive={true} />
              </div>
            )}
            {visiblePendingQuestions.map((question) => (
              <AskUserQuestionCard
                key={question.id}
                prompt={question}
                onAnswer={(answers) => void answerQuestion(question.id, answers)}
              />
            ))}
            {sending && visiblePendingQuestions.length === 0 && visibleLiveBlocks.length === 0 && <ProviderThinking provider={provider} />}
            {error && <div className="rounded border border-red-400/20 bg-red-500/10 px-2 py-1 text-xs text-red-100">{error}</div>}
          </div>

          <footer className="absolute inset-x-0 bottom-0 z-20 px-2 pb-[10px] pt-3">
            {showTraceDebugPrompt && <TraceDebugPrompt onPrompt={(prompt) => void sendMessage(prompt)} />}
            {showSlash && slashItems.length > 0 && (
              <div id="claude-slash-menu" className="absolute bottom-full left-2 right-2 mb-2 max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-zinc-900/95 p-1 text-xs shadow-2xl">
                {slashItems.map((item, index) => (
                  <button
                    key={`${item.value}-${item.label}`}
                    ref={(element) => { slashItemRefs.current[index] = element; }}
                    type="button"
                    onClick={() => selectSlash(item.value)}
                    onMouseEnter={() => setActiveSlashIndex(index)}
                    className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left transition-[background-color,color] ${
                      index === activeSlashIndex
                        ? "bg-white/10 text-white"
                        : "text-white/70 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{item.label}</span>
                      {item.description && <span className="block truncate text-[10px] text-white/40">{item.description}</span>}
                    </span>
                    <span className="shrink-0 truncate font-mono text-[10px] text-white/35">{item.value}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="relative overflow-hidden rounded-[12px] border border-white/[0.2] bg-[#101010]/[80%] shadow-[0_14px_36px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-sm backdrop-saturate-150 transition-[border-color,background-color,box-shadow] focus-within:border-white/30 focus-within:bg-[#080808]/88 focus-within:shadow-[0_14px_36px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.07)]">
              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setShowSlash(e.target.value.startsWith("/"));
                }}
                onKeyDown={(e) => {
                  if (showSlash && slashItems.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    e.preventDefault();
                    const direction = e.key === "ArrowDown" ? 1 : -1;
                    setActiveSlashIndex((index) => (index + direction + slashItems.length) % slashItems.length);
                    return;
                  }
                  if (showSlash && slashItems.length > 0 && (e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.shiftKey) {
                    e.preventDefault();
                    if (activeSlashItem) selectSlash(activeSlashItem.value);
                    return;
                  }
                  if (e.key === "Escape") {
                    setShowSlash(false);
                    return;
                  }
                  if (e.key === "Enter" && e.metaKey) {
                    e.preventDefault();
                    insertDraftNewline(e.currentTarget);
                    return;
                  }
                  if (e.key === "Enter" && !e.metaKey && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={activeRunId ? "Ask about this trace..." : `Ask ${providerLabel(provider)}...`}
                rows={2}
                aria-expanded={showSlash}
                aria-controls="claude-slash-menu"
                className="block min-h-24 w-full resize-none rounded-[11px] bg-transparent px-3 py-3 pb-12 pr-14 text-sm text-white/90 placeholder:text-white/55 focus:outline-none focus-visible:outline-none"
              />
              <button
                onClick={() => void sendMessage()}
                disabled={!draft.trim() || sending}
                className="absolute bottom-2 right-2 grid min-h-10 min-w-10 place-items-center rounded-[6px] bg-white/10 text-white/75 transition-[transform,background-color,color,opacity] hover:bg-white/15 hover:text-white active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100"
                title="Send"
              >
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </footer>
        </div>
      )}
      {showProviderIntro && (
        <button
          onClick={() => setCollapsed(true)}
          className="absolute right-3 top-3 min-h-8 rounded-md px-2.5 text-xs font-medium text-white/45 transition-[transform,background-color,color] hover:bg-white/5 hover:text-white active:scale-[0.96]"
          title="Hide chat"
        >
          Hide
        </button>
      )}
    </aside>
  );
}

function FloatingAskButton({ provider, onOpen }: { provider: AgentProviderId; onOpen: () => void }) {
  return (
    <div className="group fixed bottom-0 right-0 z-40">
      <div className="pointer-events-none absolute -top-14 right-16 grid h-12 w-12 scale-75 place-items-center rounded-full border border-white/45 bg-white/95 opacity-0 shadow-[0_16px_40px_rgba(255,255,255,0.18),0_8px_26px_rgba(0,0,0,0.32)] transition-all duration-300 group-hover:-translate-y-2 group-hover:-rotate-6 group-hover:scale-100 group-hover:opacity-100 [&>img]:brightness-0">
        <ProviderMark provider="claude" open={true} />
      </div>
      <div className="pointer-events-none absolute -top-12 right-3 grid h-11 w-11 scale-75 place-items-center rounded-full border border-white/40 bg-white/95 opacity-0 shadow-[0_16px_40px_rgba(255,255,255,0.18)] transition-all duration-300 delay-75 group-hover:-translate-y-3 group-hover:rotate-12 group-hover:scale-100 group-hover:opacity-100">
        <img src={codexLogo} alt="" className="h-8 w-8 object-contain" />
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="flex h-11 items-center gap-2 rounded-tl-[15px] rounded-r-none rounded-bl-none border border-r-0 border-b-0 border-white/80 bg-white/95 px-[26px] text-sm font-medium text-zinc-950 shadow-[0_26px_70px_rgba(0,0,0,0.72),0_8px_22px_rgba(255,255,255,0.18),0_0_0_1px_rgba(0,0,0,0.08)] backdrop-blur transition-[transform,background-color,border-color,color,box-shadow] hover:-translate-y-0.5 hover:border-white hover:bg-white hover:text-black hover:shadow-[0_32px_90px_rgba(0,0,0,0.82),0_10px_30px_rgba(255,255,255,0.24),0_0_0_1px_rgba(0,0,0,0.1)] active:translate-y-0"
        title={`Ask ${providerLabel(provider)}`}
      >
        <Terminal className="h-4 w-4 text-zinc-950" />
        <span>Ask Claude Code</span>
      </button>
    </div>
  );
}

function HeaderIconTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="center">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function ProviderMark({ provider, open }: { provider: AgentProviderId; open: boolean }) {
  if (provider === "claude") {
    return <img src={claudeCodeLogo} alt="" className={`h-8 w-8 object-contain ${open ? "" : "opacity-80"}`} />;
  }
  return (
    <span className="grid h-8 w-8 place-items-center rounded-full bg-white shadow-[0_0_24px_rgba(255,255,255,0.12)]">
      <img src={codexLogo} alt="" className="h-7 w-7 object-contain" />
    </span>
  );
}

function SmallProviderIcon({ provider }: { provider: AgentProviderId }) {
  return provider === "claude"
    ? <img src={claudeCodeLogo} alt="" className="h-4 w-4 object-contain brightness-0 invert" />
    : <img src={codexLogo} alt="" className="h-4 w-4 object-contain invert" />;
}

function LargeProviderIcon({ provider }: { provider: AgentProviderId }) {
  return provider === "claude"
    ? <img src={claudeCodeLogo} alt="" className="h-7 w-7 object-contain brightness-0 invert" />
    : <img src={codexLogo} alt="" className="h-7 w-7 object-contain invert" />;
}

function ProviderDropdown({
  provider,
  busy,
  onProviderChange,
}: {
  provider: AgentProviderId;
  busy: boolean;
  onProviderChange: (provider: AgentProviderId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-white/75 transition-colors hover:bg-white/5 hover:text-white"
        aria-expanded={open}
      >
        <SmallProviderIcon provider={provider} />
        <span>{providerLabel(provider)}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-white/35 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-44 rounded-lg border border-white/10 bg-zinc-900/95 p-1 text-xs shadow-2xl backdrop-blur">
          {(["claude", "codex"] as AgentProviderId[]).map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onProviderChange(option);
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                provider === option ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white"
              }`}
            >
              <SmallProviderIcon provider={option} />
              <span>{providerLabel(option)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderThinking({ provider }: { provider: AgentProviderId }) {
  if (provider === "claude") {
    return <div className="text-xs text-white/40">Claude Code is thinking...</div>;
  }
  return (
    <div className="flex items-center gap-2 text-xs text-white/45">
      <span className="grid h-6 w-6 animate-pulse place-items-center rounded-full bg-white">
        <img src={codexLogo} alt="" className="h-5 w-5 object-contain" />
      </span>
      <span>Codex is working...</span>
    </div>
  );
}

function applyLiveStreamEvent(blocks: AssistantMessageBlock[], event: AgentStreamEvent): AssistantMessageBlock[] {
  switch (event.type) {
    case "text":
      return setLiveTextBlock(blocks, event.content);
    case "error":
      return [...blocks, { type: "error", text: event.content }];
    case "tool_start":
      return upsertLiveToolBlock(blocks, {
        type: "tool",
        id: event.id,
        name: event.name,
        input_preview: event.input_preview,
        state: "running",
      });
    case "tool_finish":
      return finishLiveToolBlock(blocks, event.id, event.ok, event.output_preview);
    case "thinking_delta":
      return appendLiveThinkingBlock(blocks, event.content);
    case "subagent_start":
      return upsertLiveToolBlock(blocks, {
        type: "tool",
        id: event.parent_id,
        name: `Agent: ${event.subagent}`,
        state: "running",
      });
    default:
      return blocks;
  }
}

function setLiveTextBlock(blocks: AssistantMessageBlock[], text: string): AssistantMessageBlock[] {
  const next = [...blocks];
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = { ...last, text };
    return next;
  }
  next.push({ type: "text", text });
  return next;
}

function appendLiveThinkingBlock(blocks: AssistantMessageBlock[], content: string): AssistantMessageBlock[] {
  if (!content) return blocks;
  const next = [...blocks];
  const last = next[next.length - 1];
  if (last?.type === "thinking") {
    next[next.length - 1] = { ...last, text: last.text + content };
    return next;
  }
  next.push({ type: "thinking", text: content });
  return next;
}

function upsertLiveToolBlock(
  blocks: AssistantMessageBlock[],
  block: Extract<AssistantMessageBlock, { type: "tool" }>,
): AssistantMessageBlock[] {
  const index = blocks.findIndex((item) => item.type === "tool" && item.id === block.id);
  if (index < 0) return [...blocks, block];
  const next = [...blocks];
  next[index] = { ...(next[index] as Extract<AssistantMessageBlock, { type: "tool" }>), ...block };
  return next;
}

function finishLiveToolBlock(
  blocks: AssistantMessageBlock[],
  id: string,
  ok: boolean,
  output_preview?: string,
): AssistantMessageBlock[] {
  const index = blocks.findIndex((item) => item.type === "tool" && item.id === id);
  if (index < 0) return blocks;
  const next = [...blocks];
  const current = next[index] as Extract<AssistantMessageBlock, { type: "tool" }>;
  next[index] = { ...current, ok, output_preview, state: "done" };
  return next;
}

function visibleAssistantBlocks(blocks: AssistantMessageBlock[]): AssistantMessageBlock[] {
  const visible: AssistantMessageBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text" || block.type === "thinking" || block.type === "error") {
      const text = block.text.trim();
      if (text) visible.push({ ...block, text });
      continue;
    }
    visible.push(block);
  }
  return visible;
}

function appendLiveCompletionIfMissing(
  session: ClaudeSessionDetail,
  liveBlocks: AssistantMessageBlock[],
): ClaudeSessionDetail {
  const blocks = visibleAssistantBlocks(liveBlocks);
  if (!blocks.length) return session;

  const lastUserIndex = findLastMessageIndex(session.messages, "user");
  const hasAssistantAfterUser = session.messages
    .slice(Math.max(0, lastUserIndex + 1))
    .some((message) => message.role === "assistant" && parseAssistantBlocks(message).length > 0);
  if (hasAssistantAfterUser) return session;

  const content = assistantBlocksText(blocks);
  if (!content.trim()) return session;

  return {
    ...session,
    messages: [
      ...session.messages,
      {
        id: `live-complete-${Date.now()}`,
        role: "assistant",
        content,
        blocks: blocks.map(persistableAssistantBlock),
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function findLastMessageIndex(messages: ClaudeChatMessage[], role: Role): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return i;
  }
  return -1;
}

function assistantBlocksText(blocks: AssistantMessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text" || block.type === "error") return block.text;
      if (block.type === "tool") return `[tool: ${block.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function persistableAssistantBlock(block: AssistantMessageBlock): ClaudeChatMessageBlock {
  if (block.type === "tool") {
    const { state: _state, ...tool } = block;
    return tool;
  }
  if (block.type === "error") return { type: "text", text: block.text };
  return block;
}

function AskUserQuestionCard({
  prompt,
  onAnswer,
}: {
  prompt: ClaudeAskUserQuestion;
  onAnswer: (answers: Record<string, string>) => void;
}) {
  const [choices, setChoices] = useState<Record<number, string[]>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});

  function toggle(questionIndex: number, label: string, multiSelect: boolean) {
    setChoices((current) => {
      const selected = current[questionIndex] ?? [];
      if (!multiSelect) return { ...current, [questionIndex]: [label] };
      return selected.includes(label)
        ? { ...current, [questionIndex]: selected.filter((item) => item !== label) }
        : { ...current, [questionIndex]: [...selected, label] };
    });
  }

  const answers = prompt.questions.reduce<Record<string, string>>((acc, question, index) => {
    const answer = [...(choices[index] ?? []), otherText[index]?.trim()]
      .filter(Boolean)
      .join(", ");
    if (answer) acc[question.question] = answer;
    return acc;
  }, {});
  const complete = Object.keys(answers).length === prompt.questions.length;

  return (
    <div className="message-arrive w-[90%] rounded-[4px] border border-amber-300/20 bg-amber-300/[0.08] px-3 py-3 text-white/85">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-amber-100/70">Claude needs input</div>
      <div className="space-y-3">
        {prompt.questions.map((question, questionIndex) => {
          const selected = choices[questionIndex] ?? [];
          return (
            <div key={`${prompt.id}-${questionIndex}`} className="space-y-2">
              <div>
                {question.header && <div className="text-[11px] text-white/45">{question.header}</div>}
                <div className="text-sm text-white/90">{question.question}</div>
              </div>
              <div className="grid gap-1.5">
                {question.options.map((option) => {
                  const active = selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => toggle(questionIndex, option.label, question.multiSelect)}
                      className={`rounded-[4px] border px-2 py-1.5 text-left transition-[background-color,border-color,color] ${
                        active
                          ? "border-amber-200/45 bg-amber-200/15 text-white"
                          : "border-white/10 bg-black/15 text-white/70 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      <div className="text-xs font-medium">{option.label}</div>
                      {option.description && <div className="mt-0.5 text-[11px] text-white/45">{option.description}</div>}
                    </button>
                  );
                })}
              </div>
              <input
                value={otherText[questionIndex] ?? ""}
                onChange={(event) => setOtherText((current) => ({ ...current, [questionIndex]: event.target.value }))}
                placeholder="Other"
                className="w-full rounded-[4px] border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/20"
              />
            </div>
          );
        })}
      </div>
      <button
        type="button"
        disabled={!complete}
        onClick={() => onAnswer(answers)}
        className="mt-3 flex min-h-9 items-center justify-center gap-2 rounded-[4px] border border-white/10 bg-white/10 px-3 text-xs text-white/75 hover:bg-white/15 active:scale-[0.98] transition-[transform,background-color,color] disabled:opacity-35 disabled:cursor-not-allowed disabled:active:scale-100"
      >
        <Send className="h-3.5 w-3.5" />
        Send answer
      </button>
    </div>
  );
}

function ChatList({
  sessions,
  selectedId,
  workspaceCwd,
  provider,
  providerError,
  providerBusy,
  showProviderIntro,
  onProviderIntroChoice,
  onSelect,
  onNew,
}: {
  sessions: ClaudeSessionSummary[];
  selectedId: string | null;
  workspaceCwd: string | null;
  provider: AgentProviderId;
  providerError: string | null;
  providerBusy: boolean;
  showProviderIntro: boolean;
  onProviderIntroChoice: (provider: AgentProviderId) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [introProvider, setIntroProvider] = useState<AgentProviderId>(provider);
  const [introSessions, setIntroSessions] = useState<ClaudeSessionSummary[]>(sessions);

  useEffect(() => {
    if (showProviderIntro) setIntroProvider(provider);
  }, [provider, showProviderIntro]);

  useEffect(() => {
    if (!showProviderIntro) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/agent/sessions?provider=${encodeURIComponent(introProvider)}`);
      if (!res.ok) {
        if (!cancelled) setIntroSessions([]);
        return;
      }
      const body = await res.json();
      if (cancelled) return;
      const currentIds = sessions.map((session) => session.id).join("\n");
      const previewIds = Array.isArray(body) ? body.map((session: ClaudeSessionSummary) => session.id).join("\n") : "";
      setIntroSessions(introProvider !== provider && previewIds === currentIds ? [] : body);
    })();
    return () => { cancelled = true; };
  }, [introProvider, provider, sessions, showProviderIntro]);

  async function copyResumeCommand(event: SyntheticEvent, session: ClaudeSessionSummary, commandProvider: AgentProviderId = provider): Promise<void> {
    event.stopPropagation();
    const command = resumeCommandForSession(session, workspaceCwd, commandProvider);
    setCopiedId(session.id);
    window.setTimeout(() => setCopiedId((current) => current === session.id ? null : current), 1200);
    if (copyTextWithTextarea(command)) return;
    try {
      await navigator.clipboard?.writeText(command);
    } catch {
      copyTextWithTextarea(command);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      {showProviderIntro ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex flex-1 items-center justify-center px-6 py-8">
            <AgentConnectCard
              provider={provider}
              selectedProvider={introProvider}
              error={providerError}
              busy={providerBusy}
              onSelectedProviderChange={setIntroProvider}
              onProviderChange={onProviderIntroChoice}
            />
          </div>
          <div className="h-[210px] overflow-y-auto border-t border-white/10 px-4 py-3">
            <div className="mb-2 text-[11px] text-white/35">
              Your Recent {providerLabel(introProvider)} Chats
            </div>
            <div className="space-y-1.5 opacity-60">
              {introSessions.length === 0 ? (
                <div className="flex h-[150px] items-center justify-center text-xs text-white/35">No chats yet.</div>
              ) : introSessions.slice(0, 4).map((session) => (
                <ChatPreviewItem
                  key={session.id}
                  session={session}
                  workspaceCwd={workspaceCwd}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="h-full overflow-y-auto p-2">
          {providerError && (
        <div className="mb-2 rounded-md border border-red-400/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-100">{providerError}</div>
      )}
          <button
            onClick={onNew}
            className="mb-2 flex w-full items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-left text-sm text-white/75 hover:bg-white/10 hover:text-white active:scale-[0.99] transition-[transform,background-color,color]"
          >
            <Plus className="h-4 w-4" />
            New chat
          </button>
          <div className="space-y-1">
            {sessions.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-white/40">No {providerLabel(provider)} chats yet.</div>
            ) : sessions.map((session) => (
              <ChatListItem
                key={session.id}
                session={session}
                selected={selectedId === session.id}
                workspaceCwd={workspaceCwd}
                provider={provider}
                copied={copiedId === session.id}
                onSelect={onSelect}
                onCopy={copyResumeCommand}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentConnectCard({
  provider,
  selectedProvider,
  error,
  busy,
  onSelectedProviderChange,
  onProviderChange,
}: {
  provider: AgentProviderId;
  selectedProvider: AgentProviderId;
  error: string | null;
  busy: boolean;
  onSelectedProviderChange: (provider: AgentProviderId) => void;
  onProviderChange: (provider: AgentProviderId) => void;
}) {
  return (
    <section className="w-full max-w-[340px] text-center">
      <div className="text-[18px] font-medium text-white/90">Connect your coding agent</div>
      <p className="mx-auto mt-2 max-w-[300px] text-sm leading-relaxed text-white/48">
        Ask questions about traces and resume chats from your terminal.
      </p>
      <div className="mt-5 grid grid-cols-2 gap-1.5 rounded-xl border border-white/10 bg-black/15 p-1">
        {(["claude", "codex"] as AgentProviderId[]).map((option) => {
          const active = selectedProvider === option;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onSelectedProviderChange(option)}
              disabled={busy}
              className={`flex min-h-12 items-center justify-center gap-2 rounded-lg border px-2.5 text-xs transition-[transform,background-color,border-color,color] active:scale-[0.98] ${
                active
                  ? "border-white/18 bg-white/[0.08] text-white"
                  : "border-transparent text-white/50 hover:bg-white/[0.04] hover:text-white/80"
              } disabled:cursor-not-allowed disabled:opacity-55`}
              aria-pressed={active}
            >
              <LargeProviderIcon provider={option} />
              <span className="font-medium">{providerLabel(option)}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => onProviderChange(selectedProvider)}
        className="mt-3 flex min-h-10 w-full items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.07] px-4 text-sm font-medium text-white transition-[transform,background-color,border-color,opacity] hover:border-white/[0.14] hover:bg-white/[0.11] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
      >
        {busy ? "Connecting..." : `Connect ${providerLabel(selectedProvider)}`}
      </button>
      {error && <div className="mt-3 rounded-lg border border-red-400/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-100">{error}</div>}
    </section>
  );
}

function ChatListItem({
  session,
  selected,
  workspaceCwd,
  provider,
  copied,
  onSelect,
  onCopy,
}: {
  session: ClaudeSessionSummary;
  selected: boolean;
  workspaceCwd: string | null;
  provider: AgentProviderId;
  copied: boolean;
  onSelect: (id: string) => void;
  onCopy: (event: SyntheticEvent, session: ClaudeSessionSummary) => Promise<void>;
}) {
  const cwd = session.cwd ?? workspaceCwd;
  const cwdDisplay = formatCwdDisplay(cwd);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(session.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(session.id);
      }}
      className={`w-full rounded-md border px-3 py-2 text-left transition-[background-color,border-color,color] ${
        selected
          ? "border-white/20 bg-white/10 text-white"
          : "border-transparent text-white/65 hover:border-white/10 hover:bg-white/5 hover:text-white"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="truncate text-xs font-medium">{session.preview || "Untitled chat"}</div>
        <div className="shrink-0 text-[10px] text-white/35">{formatSessionTime(session.updated_at)}</div>
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-white/35">
        <Terminal className="h-3 w-3 shrink-0" />
        <span className="truncate" title={cwd ?? "Working directory unavailable"}>
          {cwdDisplay}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-white/30">
        <span>{session.id.slice(0, 8)} · {session.message_count} messages</span>
        <span className="h-3 w-px bg-white/10" />
        <button
          type="button"
          title={`Copy ${resumeCommandForSession(session, workspaceCwd, provider)}`}
          aria-label={`Copy ${resumeCommandForSession(session, workspaceCwd, provider)}`}
          onClick={(event) => void onCopy(event, session)}
          className={`grid h-5 w-5 place-items-center rounded transition-colors focus:outline-none focus-visible:outline-none ${
            copied
              ? "text-emerald-300"
              : "text-white/35 hover:text-white"
          }`}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}

function ChatPreviewItem({
  session,
  workspaceCwd,
}: {
  session: ClaudeSessionSummary;
  workspaceCwd: string | null;
}) {
  const cwd = formatCwdDisplay(session.cwd ?? workspaceCwd);
  return (
    <div className="px-1 py-1">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 truncate text-xs text-white/70">{session.preview || "Untitled chat"}</div>
        <div className="shrink-0 text-[10px] text-white/35">{formatSessionTime(session.updated_at)}</div>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-white/30">
        <Terminal className="h-3 w-3 shrink-0" />
        <span className="truncate">{cwd}</span>
      </div>
    </div>
  );
}

function formatCwdDisplay(cwd: string | null): string {
  if (!cwd) return "Working directory unavailable";
  return cwd.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

function resumeCommandForSession(session: ClaudeSessionSummary, workspaceCwd: string | null, provider: AgentProviderId = "claude"): string {
  const cwd = session.cwd ?? workspaceCwd;
  const resume = provider === "codex" ? `codex resume ${session.id}` : `claude --resume ${session.id}`;
  return cwd
    ? `cd ${shellQuote(cwd)} && ${resume}`
    : resume;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function copyTextWithTextarea(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function TraceDebugPrompt({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  const prompts = ["What went wrong here?", "What workshop tools are available?", "Annotate trace, save it for later"];
  return (
    <div className="mb-2 flex gap-1.5 overflow-x-auto whitespace-nowrap pb-0.5">
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPrompt(prompt)}
          className="min-h-8 shrink-0 rounded-[6px] border border-white/10 bg-black/20 px-2.5 py-1 text-left text-xs text-white/60 shadow-[0_6px_18px_rgba(0,0,0,0.14)] transition-[transform,background-color,border-color,color] hover:border-white/20 hover:bg-white/[0.06] hover:text-white/85 active:scale-[0.96]"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ClaudeChatMessage }) {
  const isUser = message.role === "user";
  const blocks = parseAssistantBlocks(message);
  if (!isUser && blocks.length === 0) return null;
  if (!isUser) {
    return (
      <div className="message-arrive flex flex-col items-start gap-2">
        <AssistantBlocks blocks={blocks} isLive={false} />
      </div>
    );
  }
  return (
    <div className="message-arrive flex flex-col items-end">
      <div
        className="max-w-[90%] min-w-0 overflow-hidden rounded-[4px] border border-blue-400/20 bg-blue-500/15 px-3 py-2 text-white/90"
        onClick={handleDeepLinkClick}
      >
        <MessageText text={message.content} />
      </div>
    </div>
  );
}

function AssistantBlocks({ blocks, isLive }: { blocks: AssistantMessageBlock[]; isLive: boolean }) {
  if (!blocks.length) return null;
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "text") {
          const wide = isWideMarkdown(block.text);
          return (
            <div
              key={index}
              className={`stream-block assistant-bubble min-w-0 overflow-hidden rounded-[4px] border border-white/10 bg-white/5 text-white/85 ${wide ? "assistant-bubble-wide w-full max-w-none px-2 py-2" : "max-w-[90%] px-3 py-2"} ${isLive ? "assistant-bubble-live" : ""}`}
              onClick={handleDeepLinkClick}
            >
              <MessageText text={block.text} />
            </div>
          );
        }
        if (block.type === "error") {
          return <div key={index} className="stream-block whitespace-pre-wrap rounded border border-red-400/20 bg-red-500/10 px-2 py-1 text-red-100">{block.text}</div>;
        }
        if (block.type === "thinking") {
          return <ThinkingActivityCard key={index} text={block.text} />;
        }
        if (isAskAgentTool(block.name)) {
          return <AgentAskCard key={block.id || index} block={block} />;
        }
        return <ToolActivityCard key={block.id || index} block={block} />;
      })}
    </>
  );
}

function ThinkingActivityCard({ text }: { text: string }) {
  return (
    <details
      className="stream-block tool-card activity-inline max-w-[90%] text-[11px] text-white/40"
      title="thinking"
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 py-0.5 outline-none">
        <Brain className="activity-icon h-3.5 w-3.5 shrink-0 text-violet-200/55" />
        <span className="activity-label min-w-0 truncate font-mono text-[11px]">thinking</span>
        <ChevronDown className="tool-card-chevron activity-chevron h-3 w-3 shrink-0 transition-transform" />
      </summary>
      <div className="activity-content mt-1 pl-5">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed">{text}</pre>
      </div>
    </details>
  );
}

function ToolActivityCard({ block }: { block: Extract<AssistantMessageBlock, { type: "tool" }> }) {
  const failed = block.ok === false;
  const running = block.state === "running";
  const isRaindropTool = isRaindropMcpTool(block.name);
  const displayName = compactToolName(block.name);
  const hasPreview = Boolean(block.input_preview || block.output_preview);

  return (
    <details
      className="stream-block tool-card activity-inline max-w-[90%] text-[11px] text-white/40"
      title={block.name}
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 py-0.5 outline-none">
        {isRaindropTool ? (
          <RaindropLogo
            size={14}
            className={`activity-icon shrink-0 ${running ? "animate-pulse" : ""}`}
            style={{ color: failed ? "rgba(254,202,202,0.78)" : "rgba(255,255,255,0.72)" }}
          />
        ) : (
          <Wrench
            className={`activity-icon h-3.5 w-3.5 shrink-0 ${
              failed ? "text-red-200/75" : running ? "animate-pulse text-amber-100/70" : "text-cyan-100/65"
            }`}
          />
        )}
        <span className={`activity-label min-w-0 truncate font-mono text-[11px] ${failed ? "activity-label-error" : ""}`}>{displayName}</span>
        {hasPreview && <ChevronDown className="tool-card-chevron activity-chevron h-3 w-3 shrink-0 transition-transform" />}
      </summary>
      {hasPreview && (
        <div className="activity-content mt-1 pl-5">
          {block.input_preview && (
            <div>
              <div className="activity-kicker mb-0.5 text-[9px] font-medium uppercase tracking-[0.16em]">Input</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed">{block.input_preview}</pre>
            </div>
          )}
          {block.output_preview && (
            <div className={block.input_preview ? "mt-2" : ""}>
              <div className="activity-kicker mb-0.5 text-[9px] font-medium uppercase tracking-[0.16em]">Output</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed">{block.output_preview}</pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function compactToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  return parts.length > 2 ? parts.slice(2).join("__") : name;
}

function isRaindropMcpTool(name: string): boolean {
  return name.startsWith("mcp__raindrop__");
}

function AgentAskCard({ block }: { block: Extract<AssistantMessageBlock, { type: "tool" }> }) {
  const input = parseJsonObject(block.input_preview);
  const result = parseAgentToolResult(block.output_preview);
  const question = typeof input?.question === "string" ? input.question : null;
  const status = result?.status;

  if (block.state === "running") {
    return (
      <div className="stream-block w-[90%] rounded-[8px] border border-sky-300/20 bg-sky-300/[0.07] px-3 py-3 text-white/80 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <div className="text-[11px] font-medium uppercase tracking-wide text-sky-100/70">
          Asking agent
        </div>
        {question && <div className="mt-2 text-sm text-white/90">{question}</div>}
        <div className="mt-2 text-xs text-white/45">Continuing the captured agent context...</div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="stream-block w-[90%] rounded-[8px] border border-sky-300/15 bg-sky-300/[0.05] px-3 py-3 text-white/75">
        <div className="text-[11px] font-medium uppercase tracking-wide text-sky-100/65">
          Asked agent
        </div>
        {question && <div className="mt-2 text-sm text-white/85">{question}</div>}
        <div className="mt-2 text-xs text-white/45">Workshop chat is talking to your agent...</div>
      </div>
    );
  }

  if (status === "answered") {
    return (
      <div className="stream-block w-[90%] rounded-[8px] border border-emerald-300/20 bg-emerald-300/[0.07] px-3 py-3 text-white/85 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-100/70">
          Agent answered
        </div>
        {question && <div className="mt-2 text-xs text-white/45">{question}</div>}
        <div className="mt-2 text-sm leading-relaxed text-white/90">
          <MessageText text={String(result.answer ?? "")} />
        </div>
      </div>
    );
  }

  if (status === "missing_provider_key") {
    const envVar = typeof result.env_var === "string" ? result.env_var : "ANTHROPIC_API_KEY";
    const cwd = typeof result.cwd === "string" ? result.cwd : "your agent project";
    return (
      <div className="stream-block w-[90%] rounded-[8px] border border-amber-300/25 bg-amber-300/[0.08] px-3 py-3 text-white/85">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-amber-100/75">
          <KeyRound className="h-3.5 w-3.5" />
          Agent needs an API key
        </div>
        <div className="mt-2 text-sm text-white/90">Add this to the active project env, then restart Workshop.</div>
        <code className="mt-2 block rounded-[6px] border border-white/10 bg-black/25 px-2 py-1.5 font-mono text-[11px] text-amber-50/90">
          {envVar}=...
        </code>
        <div className="mt-2 text-[11px] text-white/45">{cwd}/.env</div>
      </div>
    );
  }

  if (status === "missing_context") {
    return (
      <div className="stream-block w-[90%] rounded-[8px] border border-amber-300/20 bg-amber-300/[0.07] px-3 py-3 text-white/85">
        <div className="text-[11px] font-medium uppercase tracking-wide text-amber-100/70">
          Agent context unavailable
        </div>
        <div className="mt-2 text-sm leading-relaxed text-white/85">{String(result.message ?? "This run does not include an LLM input payload that Workshop can continue.")}</div>
      </div>
    );
  }

  return (
    <div className="stream-block w-[90%] rounded-[8px] border border-red-300/20 bg-red-400/[0.08] px-3 py-3 text-white/85">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-red-100/75">
        <AlertTriangle className="h-3.5 w-3.5" />
        Agent ask failed
      </div>
      <div className="mt-2 whitespace-pre-wrap text-sm text-white/85">{String(result.message ?? result.error ?? "The captured agent context did not return a usable answer.")}</div>
    </div>
  );
}

function isAskAgentTool(name: string): boolean {
  return name === "ask_agent" || name === "mcp__raindrop__ask_agent" || name.endsWith("__ask_agent");
}

function parseAgentToolResult(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null;
  const parsed = parseJsonValue(output);
  if (isRecord(parsed) && typeof parsed.status === "string") return parsed;
  if (Array.isArray(parsed)) {
    const textBlock = parsed.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
    if (isRecord(textBlock) && typeof textBlock.text === "string") {
      const inner = parseJsonValue(textBlock.text);
      if (isRecord(inner) && typeof inner.status === "string") return inner;
    }
  }
  if (isRecord(parsed) && Array.isArray(parsed.content)) {
    const textBlock = parsed.content.find((item: unknown) => isRecord(item) && item.type === "text" && typeof item.text === "string");
    if (isRecord(textBlock) && typeof textBlock.text === "string") {
      const inner = parseJsonValue(textBlock.text);
      if (isRecord(inner) && typeof inner.status === "string") return inner;
    }
  }
  return null;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  const parsed = parseJsonValue(text);
  return isRecord(parsed) ? parsed : null;
}

function parseJsonValue(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function MessageText({ text }: { text: string }) {
  return <Markdown>{escapeEmptyOrderedListMarkers(linkifyDeepRefs(text))}</Markdown>;
}

function escapeEmptyOrderedListMarkers(text: string): string {
  return text.replace(/^(\s*\d+)\.\s*$/gm, "$1\\.");
}

function parseAssistantBlocks(message: ClaudeChatMessage): AssistantMessageBlock[] {
  if (message.role === "user") return [{ type: "text", text: message.content }];
  if (message.error) return visibleAssistantBlocks([{ type: "error", text: message.content }]);
  if (message.blocks?.length) {
    return visibleAssistantBlocks(message.blocks.map((block): AssistantMessageBlock => {
      if (block.type === "tool") return { ...block, state: "done" };
      return block;
    }));
  }
  return visibleAssistantBlocks([{ type: "text", text: message.content }]);
}

function isWideMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.some((line, index) => {
    const next = lines[index + 1];
    return isMarkdownTableRow(line) && next !== undefined && isMarkdownTableDivider(next);
  });
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && line.split("|").length >= 3;
}

function isMarkdownTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function buildSlashItems(loadout: AgentLoadout | null, draft: string, provider: AgentProviderId): SlashItem[] {
  const query = draft.startsWith("/") ? draft.slice(1).trim().toLowerCase() : "";
  const matches = (item: SlashItem) => {
    if (!query) return true;
    return [item.label, item.value, item.description ?? ""]
      .some((value) => value.toLowerCase().includes(query));
  };
  const label = providerLabel(provider);
  const commands: SlashItem[] = [
    { label: "New chat", value: "/new", description: `Start a fresh ${label} session` },
  ].filter(matches);
  const skills = (loadout?.skills ?? [])
    .map((skill): SlashItem => ({
      label: skill,
      value: `/${skill} `,
      description: `Use ${label} skill`,
    }))
    .filter(matches)
    .slice(0, 12);
  const slash = (loadout?.slash_commands ?? [])
    .map((cmd): SlashItem => ({
      label: cmd,
      value: cmd.startsWith("/") ? `${cmd} ` : `/${cmd} `,
      description: `${label} command`,
    }))
    .filter(matches);
  return [...commands, ...skills, ...slash].slice(0, 50);
}

function formatSessionTime(value: string | null): string {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const diff = Date.now() - time;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/**
 * Turn bare `span_id: <id>` and `trace_<id>` tokens into markdown links
 * with a custom hash scheme. The click handler on the bubble intercepts
 * the resulting anchor clicks and routes them to either the span-scroll
 * event or a `/runs/:runId` navigation.
 */
const DEEP_LINK_RE = /(span_id:\s*)([0-9a-f]{8,64})|(trace_)([0-9a-f]{8,64})/gi;
function linkifyDeepRefs(text: string): string {
  if (!text) return text;
  return text.replace(DEEP_LINK_RE, (match, sPrefix, sId, rPrefix, rId) => {
    if (sId) return `[${sPrefix}${sId}](#wd-span-${sId})`;
    if (rId) return `[${rPrefix}${rId}](#wd-run-${rId})`;
    return match;
  });
}

function handleDeepLinkClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  const anchor = target.closest("a") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  if (href.startsWith("#wd-span-")) {
    e.preventDefault();
    const spanId = href.slice("#wd-span-".length);
    window.dispatchEvent(new CustomEvent("workshop:deep-link-span", { detail: { spanId } }));
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("workshop:deep-link-span", { detail: { spanId } }));
    }, 80);
  } else if (href.startsWith("#wd-run-")) {
    e.preventDefault();
    const runId = href.slice("#wd-run-".length);
    void router.navigate(runPath(runId));
  }
}
