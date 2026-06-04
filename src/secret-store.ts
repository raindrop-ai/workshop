import fs from "fs";
import os from "os";
import path from "path";

export const RAINDROP_SECRET_STORE_PATH_ENV = "RAINDROP_WORKSHOP_SECRET_STORE_PATH";

export const SECRET_DEFS = {
  anthropic: {
    label: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
  },
  openai: {
    label: "OpenAI",
    envVars: ["OPENAI_API_KEY", "RAINDROP_OPENAI_API_KEY"],
  },
  raindrop: {
    label: "Raindrop",
    envVars: ["RAINDROP_API_KEY", "RAINDROP_WRITE_KEY"],
  },
  query: {
    label: "Query API",
    envVars: ["RAINDROP_QUERY_API_KEY"],
  },
} as const;

export type SecretKey = keyof typeof SECRET_DEFS;
export type SecretSource = "env" | "store" | null;

export interface SecretStatus {
  configured: boolean;
  source: SecretSource;
  env_var: string;
}

type SecretFile = Partial<Record<SecretKey, string>>;

const SECRET_KEYS = Object.keys(SECRET_DEFS) as SecretKey[];

export function parseSecretKey(value: string): SecretKey | null {
  return SECRET_KEYS.includes(value as SecretKey) ? value as SecretKey : null;
}

export function secretStorePath(): string {
  const explicit = process.env[RAINDROP_SECRET_STORE_PATH_ENV]?.trim();
  return explicit || path.join(os.homedir(), ".raindrop", "secrets.json");
}

function ensureStoreDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(filePath), 0o700);
  } catch {
    // Best effort: Windows and some network filesystems may not support chmod.
  }
}

function readStore(): SecretFile {
  const filePath = secretStorePath();
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: SecretFile = {};
  for (const key of SECRET_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

function writeStore(store: SecretFile): void {
  const filePath = secretStorePath();
  ensureStoreDirectory(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort: Windows and some network filesystems may not support chmod.
  }
}

export function getStoredSecret(key: SecretKey): string | null {
  return readStore()[key] ?? null;
}

export function setStoredSecret(key: SecretKey, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    deleteStoredSecret(key);
    return;
  }
  const store = readStore();
  store[key] = trimmed;
  writeStore(store);
}

export function deleteStoredSecret(key: SecretKey): void {
  const store = readStore();
  delete store[key];
  writeStore(store);
}

export function getEnvSecret(key: SecretKey): { value: string; envVar: string } | null {
  for (const envVar of SECRET_DEFS[key].envVars) {
    const value = process.env[envVar]?.trim();
    if (value) return { value, envVar };
  }
  return null;
}

export function getEffectiveSecret(key: SecretKey): string | null {
  return getEnvSecret(key)?.value ?? getStoredSecret(key);
}

export function getSecretStatus(key: SecretKey): SecretStatus {
  const env = getEnvSecret(key);
  if (env) {
    return { configured: true, source: "env", env_var: env.envVar };
  }
  const stored = getStoredSecret(key);
  return {
    configured: !!stored,
    source: stored ? "store" : null,
    env_var: SECRET_DEFS[key].envVars[0],
  };
}

export function getSecretStatuses(): Record<SecretKey, SecretStatus> {
  return Object.fromEntries(
    SECRET_KEYS.map((key) => [key, getSecretStatus(key)]),
  ) as Record<SecretKey, SecretStatus>;
}
