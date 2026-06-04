import { apiJson, jsonInit } from "./request";

export type SecretKey = "anthropic" | "openai" | "raindrop" | "query";
export type SecretSource = "env" | "store" | null;

export interface SecretStatus {
  configured: boolean;
  source: SecretSource;
  env_var: string;
}

export type SecretStatuses = Record<SecretKey, SecretStatus>;

export async function getSecretStatuses(): Promise<SecretStatuses> {
  const body = await apiJson<{ keys: SecretStatuses }>("/api/secrets");
  return body.keys;
}

export async function saveSecret(key: SecretKey, value: string): Promise<SecretStatus> {
  const body = await apiJson<{ status: SecretStatus }>(`/api/secrets/${key}`, jsonInit("PUT", { value }));
  return body.status;
}

export async function deleteSecret(key: SecretKey): Promise<SecretStatus> {
  const body = await apiJson<{ status: SecretStatus }>(`/api/secrets/${key}`, jsonInit("DELETE"));
  return body.status;
}

export function purgeLegacyBrowserSecrets(): void {
  for (const key of ["rd_api_key", "rd_openai_key", "rd_raindrop_key", "rd_query_key"]) {
    try { localStorage.removeItem(key); } catch {}
  }
}
