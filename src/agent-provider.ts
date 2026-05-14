export const AGENT_PROVIDER_IDS = ["claude", "codex", "opencode"] as const;

export type AgentProviderId = typeof AGENT_PROVIDER_IDS[number];

export const AGENT_ANNOTATION_SOURCES = ["claude-code", "codex", "opencode"] as const;

export type AgentAnnotationSource = typeof AGENT_ANNOTATION_SOURCES[number];

export interface AgentProviderDefinition {
  id: AgentProviderId;
  label: string;
  annotationSource: AgentAnnotationSource;
  cliCommand: string;
  defaultSlashCommands: string[];
}

export const AGENT_PROVIDERS: Record<AgentProviderId, AgentProviderDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    annotationSource: "claude-code",
    cliCommand: "claude",
    defaultSlashCommands: [],
  },
  codex: {
    id: "codex",
    label: "Codex",
    annotationSource: "codex",
    cliCommand: "codex",
    defaultSlashCommands: ["/clear", "/trace"],
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    annotationSource: "opencode",
    cliCommand: "opencode",
    defaultSlashCommands: ["/clear", "/trace"],
  },
};

export function isAgentProvider(value: unknown): value is AgentProviderId {
  return typeof value === "string" && value in AGENT_PROVIDERS;
}

export function parseAgentProvider(value: unknown): AgentProviderId | null {
  return isAgentProvider(value) ? value : null;
}

export function providerLabel(provider: AgentProviderId): string {
  return AGENT_PROVIDERS[provider].label;
}

export function providerAnnotationSource(provider: AgentProviderId): AgentAnnotationSource {
  return AGENT_PROVIDERS[provider].annotationSource;
}

export function providerCliCommand(provider: AgentProviderId): string {
  return AGENT_PROVIDERS[provider].cliCommand;
}

export function providerDefaultSlashCommands(provider: AgentProviderId): string[] {
  return [...AGENT_PROVIDERS[provider].defaultSlashCommands];
}
