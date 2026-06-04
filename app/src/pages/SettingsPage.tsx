import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Plus, Trash2, Cpu, Key, FlaskConical } from "lucide-react";
import { C } from "../utils/colors";
import { LocalAgentSetupCTA } from "../components/LocalAgentSetupCTA";
import { SecretInput } from "../components/SecretInput";
import { useWorkshopEvent } from "../hooks/use-workshop-ws";
import {
  deleteSecret,
  getSecretStatuses,
  purgeLegacyBrowserSecrets,
  saveSecret,
  type SecretKey,
  type SecretStatus,
  type SecretStatuses,
} from "../api/secrets";

type Tab = "agents" | "keys" | "debug";

const TABS: { id: Tab; label: string; icon: typeof Cpu }[] = [
  { id: "keys",         label: "API Keys",            icon: Key },
  { id: "agents",       label: "Agent Endpoints",     icon: Cpu },
  { id: "debug",        label: "Debug",               icon: FlaskConical },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("keys");

  const sectionMap: Record<Tab, () => ReactNode> = {
    agents: () => <AgentEndpointsSection />,
    keys: () => <KeysSection />,
    debug: () => <DebugSection />,
  };

  return (
    <div className="h-full flex">
      <div className="w-48 flex-shrink-0 p-6 pr-0">
        <h1
          className="text-[22px] mb-6 pl-3"
          style={{ fontFamily: '"AlphaLyrae", sans-serif', color: C.fg4 }}
        >
          settings
        </h1>
        <nav className="flex flex-col gap-0.5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all duration-150"
              style={{
                color: tab === id ? C.fg4 : C.fg0,
                background: tab === id ? "rgba(255,255,255,0.06)" : "transparent",
              }}
            >
              <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ opacity: tab === id ? 0.9 : 0.4 }} />
              <span className="text-[12px]">{label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 overflow-auto sb p-6 pl-8">
        <div className="max-w-xl pb-16">
          {sectionMap[tab]()}
        </div>
      </div>
    </div>
  );
}

function SectionBlock({ id, title, description, children }: { id: Tab; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`}>
      <h2 className="text-[14px] font-medium mb-0.5" style={{ color: C.fg4 }}>{title}</h2>
      {description && <p className="text-[11px] mb-5 leading-relaxed" style={{ color: C.fg0 }}>{description}</p>}
      {!description && <div className="mb-4" />}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function AgentEndpointsSection() {
  const [agents, setAgents] = useState<Record<string, { url: string; contextFromTrace?: Record<string, string> }>>({});
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [health, setHealth] = useState<Record<string, "online" | "offline" | "checking">>({});

  const reload = useCallback(() => {
    fetch("/api/agents").then(r => r.json()).then(setAgents).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Live updates: server broadcasts `agents_updated` after any external
  // write — `/add-replay` finishing in another window,
  // a manual curl-refresh, or the PUT below. Lets the Settings list match
  // disk in real time without a 15s wait or a page reload.
  useWorkshopEvent("agents_updated", (data: { agents?: typeof agents }) => {
    if (data?.agents) setAgents(data.agents);
  });

  useEffect(() => {
    if (Object.keys(agents).length === 0) return;
    const check = () => {
      for (const name of Object.keys(agents)) setHealth(h => ({ ...h, [name]: "checking" }));
      fetch("/api/agents/health")
        .then(r => r.json())
        .then((results: Record<string, "online" | "offline">) => setHealth(results))
        .catch(() => {
          const offline: Record<string, "offline"> = {};
          for (const name of Object.keys(agents)) offline[name] = "offline";
          setHealth(offline);
        });
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, [agents]);

  const save = useCallback((config: typeof agents) => {
    fetch("/api/agents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) })
      .then(() => setAgents(config))
      .catch(() => {});
  }, []);

  const addAgent = () => {
    if (!newName.trim() || !newUrl.trim()) return;
    save({ ...agents, [newName.trim()]: { url: newUrl.trim() } });
    setNewName("");
    setNewUrl("");
  };

  const removeAgent = (name: string) => {
    const updated = { ...agents };
    delete updated[name];
    save(updated);
  };

  return (
    <SectionBlock
      id="agents"
      title="Agent Endpoints"
      description='Register local endpoints to replay agent runs with real tools. Adds "Local Agent" mode to Replay.'
    >
      <LocalAgentSetupCTA
        title="Register a new agent endpoint"
        description={
          <>
            Wire your agent into Workshop&rsquo;s Local Agent replay mode. Pick
            the path that matches your coding tool — the Claude Code option
            installs the Raindrop plugin if you don&rsquo;t have it yet.
          </>
        }
      />

      {Object.keys(agents).length > 0 && (
        <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
          {Object.entries(agents).map(([name, config], i) => {
            const status = health[name] ?? "checking";
            return (
              <div
                key={name}
                className="flex items-center gap-3 px-3 py-2.5 group"
                style={{ borderTop: i > 0 ? `1px solid ${C.border}` : undefined }}
              >
                <div
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${status === "online" ? "pulse-dot" : ""}`}
                  title={status === "online" ? "Online" : status === "checking" ? "Checking..." : "Offline"}
                  style={{
                    background: status === "online" ? C.green : status === "checking" ? C.fg0 : C.red,
                    opacity: status === "checking" ? 0.4 : 0.8,
                  }}
                />
                <span className="text-[12px] font-medium min-w-[80px]" style={{ color: C.fg3 }}>{name}</span>
                <span className="text-[11px] font-mono flex-1 truncate" style={{ color: C.fg0 }}>{config.url}</span>
                <span className="text-[10px] flex-shrink-0 min-w-[40px] text-right" style={{ color: status === "online" ? C.green : C.fg0 }}>
                  {status === "online" ? "online" : status === "checking" ? "..." : "offline"}
                </span>
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/10"
                  onClick={() => removeAgent(name)}
                >
                  <Trash2 className="h-3 w-3" style={{ color: C.fg0 }} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-1.5">
        <input
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-[12px] font-mono outline-none transition-colors focus:ring-1 focus:ring-white/20"
          style={{ background: "rgba(255,255,255,0.05)", color: C.fg3, border: `1px solid ${C.border}` }}
          placeholder="agent-name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addAgent()}
        />
        <input
          className="flex-[2] min-w-0 px-2.5 py-1.5 rounded-md text-[12px] font-mono outline-none transition-colors focus:ring-1 focus:ring-white/20"
          style={{ background: "rgba(255,255,255,0.05)", color: C.fg3, border: `1px solid ${C.border}` }}
          placeholder="http://localhost:5860/replay"
          value={newUrl}
          onChange={e => setNewUrl(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addAgent()}
        />
        <button
          className="px-2.5 py-1.5 rounded-md text-[12px] transition-colors hover:bg-white/10 flex-shrink-0"
          style={{ background: "rgba(255,255,255,0.05)", color: C.fg2, border: `1px solid ${C.border}` }}
          onClick={addAgent}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </SectionBlock>
  );
}

function KeysSection() {
  const [drafts, setDrafts] = useState<Record<SecretKey, string>>({
    anthropic: "",
    openai: "",
    raindrop: "",
    query: "",
  });
  const [statuses, setStatuses] = useState<SecretStatuses | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<SecretKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    purgeLegacyBrowserSecrets();
    getSecretStatuses()
      .then((next) => { if (!cancelled) setStatuses(next); })
      .catch(() => {
        if (!cancelled) setStatuses(null);
      });
    return () => { cancelled = true; };
  }, []);

  const setDraft = useCallback((key: SecretKey, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
  }, []);

  const persist = useCallback(async (key: SecretKey, rawValue: string) => {
    const value = rawValue.trim();
    if (!value) return;

    setSaveError(null);
    setSavingKey(key);
    try {
      const nextStatus = await saveSecret(key, value);
      setStatuses((current) => current ? { ...current, [key]: nextStatus } : current);
      setDrafts((current) => ({ ...current, [key]: "" }));
      purgeLegacyBrowserSecrets();
      window.dispatchEvent(new CustomEvent("workshop:api-key-change", { detail: { secret: key } }));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }, []);

  const clearSecret = useCallback(async (key: SecretKey) => {
    setSaveError(null);
    setSavingKey(key);
    try {
      const nextStatus = await deleteSecret(key);
      setStatuses((current) => current ? { ...current, [key]: nextStatus } : current);
      setDrafts((current) => ({ ...current, [key]: "" }));
      purgeLegacyBrowserSecrets();
      window.dispatchEvent(new CustomEvent("workshop:api-key-change", { detail: { secret: key } }));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }, []);

  const secretSaved = useCallback((key: SecretKey) => {
    return statuses?.[key]?.configured === true;
  }, [statuses]);

  const sourceText = useCallback((key: SecretKey, fallback: string) => {
    const status = statuses?.[key];
    if (!status?.configured) return fallback;
    return status.source === "env" ? "Configured from environment." : undefined;
  }, [statuses]);

  const canClearSecret = useCallback((key: SecretKey) => {
    return statuses?.[key]?.source === "store";
  }, [statuses]);

  useWorkshopEvent("secrets_updated", (data: { key?: SecretKey; status?: SecretStatus }) => {
    if (!data?.key || !data.status) return;
    setStatuses((current) => current ? { ...current, [data.key as SecretKey]: data.status as SecretStatus } : current);
  });

  return (
    <SectionBlock id="keys" title="API Keys" description="Keys are sent once to the local daemon and are never read back into the browser. Paste a new key to replace a saved one.">
      <SecretInput label="Anthropic" placeholder="sk-ant-..." description={sourceText("anthropic", "Used for replay and Ask chat.")} value={drafts.anthropic} saved={secretSaved("anthropic")} saving={savingKey === "anthropic"} onChange={v => setDraft("anthropic", v)} onSave={v => persist("anthropic", v)} onClear={canClearSecret("anthropic") ? () => clearSecret("anthropic") : undefined} getKeyUrl="https://console.anthropic.com/settings/keys" />
      <SecretInput label="OpenAI" placeholder="sk-..." description={sourceText("openai", "Used for replay with GPT models.")} value={drafts.openai} saved={secretSaved("openai")} saving={savingKey === "openai"} onChange={v => setDraft("openai", v)} onSave={v => persist("openai", v)} onClear={canClearSecret("openai") ? () => clearSecret("openai") : undefined} getKeyUrl="https://platform.openai.com/api-keys" />
      <SecretInput label="Raindrop" placeholder="rk_..." description={sourceText("raindrop", "Write key for trace shipping.")} value={drafts.raindrop} saved={secretSaved("raindrop")} saving={savingKey === "raindrop"} onChange={v => setDraft("raindrop", v)} onSave={v => persist("raindrop", v)} onClear={canClearSecret("raindrop") ? () => clearSecret("raindrop") : undefined} getKeyUrl="https://app.raindrop.ai" />
      <SecretInput label="Query API" placeholder="your-query-api-key" description={sourceText("query", "Key for searching events in the Search tab.")} value={drafts.query} saved={secretSaved("query")} saving={savingKey === "query"} onChange={v => setDraft("query", v)} onSave={v => persist("query", v)} onClear={canClearSecret("query") ? () => clearSecret("query") : undefined} getKeyUrl="https://auth.raindrop.ai/org/api_keys" />
      {saveError && <div className="text-[11px]" style={{ color: C.red }}>{saveError}</div>}
      <DaemonQueryKeyStatus status={statuses?.query ?? null} />
    </SectionBlock>
  );
}

function DaemonQueryKeyStatus({
  status,
}: {
  status: SecretStatus | null;
}) {
  const configured = status?.configured === true;
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2"
      style={{ background: "rgba(255,255,255,0.035)", border: `1px solid ${C.border}` }}
    >
      <div className="min-w-0">
        <div className="text-[11px]" style={{ color: C.fg3 }}>Raindrop Cloud MCP</div>
      </div>
      <span
        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
        style={{
          color: status === null ? C.fg1 : configured ? C.green : C.fg0,
          background: configured ? "rgba(96,227,109,0.08)" : "rgba(255,255,255,0.04)",
        }}
      >
        {status === null ? "checking" : configured ? "enabled" : "not connected"}
      </span>
    </div>
  );
}

function DebugSection() {
  const [reset, setReset] = useState(false);

  const resetChatOnboarding = useCallback(() => {
    try {
      localStorage.removeItem("workshop:messagePane:providerIntroSeen");
    } catch {}
    window.dispatchEvent(new CustomEvent("workshop:messagePane:resetOnboarding"));
    setReset(true);
    window.setTimeout(() => setReset(false), 1400);
  }, []);

  return (
    <SectionBlock id="debug" title="Debug" description="Tools for resetting in-progress local chat UI state.">
      <div className="flex items-center justify-between gap-4 py-1.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-[12px]" style={{ color: C.fg3 }}>Claude Code chat onboarding</span>
          <span className="text-[11px] mt-0.5" style={{ color: C.fg0 }}>
            Show the local coding agent connection screen again.
          </span>
        </div>
        <button
          className="text-[11px] font-mono px-2.5 py-1 rounded-md transition-colors hover:bg-white/10 flex-shrink-0"
          style={{
            color: reset ? C.green : C.fg2,
            background: reset ? "rgba(96,227,109,0.08)" : "rgba(255,255,255,0.05)",
            border: `1px solid ${reset ? "rgba(96,227,109,0.15)" : C.border}`,
          }}
          onClick={resetChatOnboarding}
        >
          {reset ? "done" : "reset"}
        </button>
      </div>
    </SectionBlock>
  );
}
