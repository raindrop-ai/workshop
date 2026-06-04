import fs from "node:fs";
import path from "node:path";

import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { authStorePath } from "./constants";

export interface AuthStore {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** Org write key grabbed at login time so `cloud setup` can reuse it. Secret. */
  writeKey?: string;
}

export function loadAuthStore(file: string = authStorePath()): AuthStore {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Don't silently return {} on a transient read error — saving over it would
    // drop existing client registration / tokens. Surface it instead.
    throw new Error(
      `Could not read the Raindrop auth store at ${file}: ${(err as Error).message}. ` +
        "Delete it (or run `raindrop logout`) and retry.",
    );
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt store must not be blown away implicitly — tell the user.
    throw new Error(
      `The Raindrop auth store at ${file} is corrupted. ` +
        "Delete it (or run `raindrop logout`) and retry.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed as AuthStore;
}

export function saveAuthStore(store: AuthStore, file: string = authStorePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort: tokens file should be user-only, but don't fail login over perms
  }
}

export function clearAuthStore(file: string = authStorePath()): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // nothing to clear
  }
}
