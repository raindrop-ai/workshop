import fs from "node:fs";
import path from "node:path";

const WRITE_KEY_ENV_VAR = "RAINDROP_WRITE_KEY";

export interface WriteEnvResult {
  envPath: string;
  examplePath: string;
  /** "created" when the var was added, "updated" when an existing value changed,
   * "unchanged" when the same value was already present. */
  action: "created" | "updated" | "unchanged";
  exampleUpdated: boolean;
  gitignored: boolean;
}

export interface WriteEnvOptions {
  cwd?: string;
  envFile?: string;
  key: string;
}

/** Set `name=value` in dotenv content, preserving every other line. Appends if absent. */
function upsertEnvLine(
  content: string,
  name: string,
  value: string,
): { content: string; action: "created" | "updated" | "unchanged" } {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(content)) {
    const existing = content.match(re)?.[0];
    if (existing === line) return { content, action: "unchanged" };
    // Replacer function so a `$` in the value isn't treated as a special
    // replacement pattern (e.g. `$&`, `$1`).
    return { content: content.replace(re, () => line), action: "updated" };
  }
  const prefix = content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
  return { content: `${prefix}${line}\n`, action: "created" };
}

function isGitignored(cwd: string, target: string): boolean {
  const gitignorePath = path.join(cwd, ".gitignore");
  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    return false;
  }
  const base = path.basename(target);
  const patterns = new Set([base, `/${base}`, `${base}/`]);
  if (base.endsWith(".env")) patterns.add("*.env");
  if (base.startsWith(".env")) patterns.add(".env*");
  return content
    .split("\n")
    .map((l) => l.trim())
    .some((l) => patterns.has(l));
}

/**
 * Refuse to write through a symlink. A hostile repo could commit `.env` (or
 * `.env.example`) as a symlink pointing outside the project so that running
 * setup redirects the write key to an attacker-chosen path. We only ever write
 * a regular file (or create a new one), never follow a symlink.
 */
function assertSafeWriteTarget(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to write ${target} because it is a symlink. ` +
        "Remove the symlink and re-run so the key is written to a real file inside your project.",
    );
  }
}

/**
 * Persist the write key to `.env` and mirror a placeholder into `.env.example`.
 * The key value is never returned in a printable summary or logged by callers.
 */
export function writeWriteKeyToEnv(opts: WriteEnvOptions): WriteEnvResult {
  const cwd = opts.cwd ?? process.cwd();
  const envPath = path.resolve(cwd, opts.envFile ?? ".env");
  const examplePath = path.resolve(cwd, ".env.example");

  let current = "";
  try {
    current = fs.readFileSync(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let exampleContent = "";
  try {
    exampleContent = fs.readFileSync(examplePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const { content, action } = upsertEnvLine(current, WRITE_KEY_ENV_VAR, opts.key);
  const needsEnvWrite = action !== "unchanged";
  const needsExampleWrite = !new RegExp(`^${WRITE_KEY_ENV_VAR}=`, "m").test(exampleContent);

  // Validate every target we're about to write *before* writing any of them, so
  // a symlinked `.env.example` can't abort the run after the live key has
  // already been persisted to `.env` (leaving a half-finished, error-exit
  // setup with the secret on disk).
  if (needsEnvWrite) assertSafeWriteTarget(envPath);
  if (needsExampleWrite) assertSafeWriteTarget(examplePath);

  if (needsEnvWrite) {
    fs.writeFileSync(envPath, content);
    // The .env now holds a live write key. When we create it, lock it down to
    // owner-only (matching the 0600 auth store) rather than the default 0644.
    // We only touch perms on creation so a user's deliberate mode is preserved.
    if (action === "created") {
      try {
        fs.chmodSync(envPath, 0o600);
      } catch {
        // chmod is unsupported on some filesystems (e.g. Windows) — best effort.
      }
    }
  }

  let exampleUpdated = false;
  if (needsExampleWrite) {
    const updated = upsertEnvLine(exampleContent, WRITE_KEY_ENV_VAR, "");
    fs.writeFileSync(examplePath, updated.content);
    exampleUpdated = true;
  }

  return {
    envPath,
    examplePath,
    action,
    exampleUpdated,
    gitignored: isGitignored(cwd, envPath),
  };
}

export interface RemoveWriteKeyResult {
  envPath: string;
  examplePath: string;
  /** True when the live `RAINDROP_WRITE_KEY=...` line was removed from `.env`. */
  removedFromEnv: boolean;
  /** True when the `RAINDROP_WRITE_KEY=` placeholder was removed from `.env.example`. */
  removedFromExample: boolean;
}

/** Drop a `name=...` line from dotenv content, preserving every other line.
 * Returns the original content untouched when the var is absent. */
function removeEnvLine(content: string, name: string): { content: string; removed: boolean } {
  const re = new RegExp(`^${name}=.*\\r?\\n?`, "m");
  if (!re.test(content)) return { content, removed: false };
  return { content: content.replace(re, ""), removed: true };
}

/** Read a file only after confirming it is a real (non-symlink) file. Returns
 * null when the file does not exist so a missing `.env` is a no-op, not an error. */
function readRealFile(file: string): string | null {
  try {
    assertSafeWriteTarget(file);
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Remove the write key written by `writeWriteKeyToEnv` from `./.env` (the live
 * secret) and the placeholder from `./.env.example`. Used by `cloud uninstall
 * --wipe`. Refuses to write through a symlink for the same reason `setup` does.
 */
export function removeWriteKeyFromEnv(opts: { cwd?: string; envFile?: string } = {}): RemoveWriteKeyResult {
  const cwd = opts.cwd ?? process.cwd();
  const envPath = path.resolve(cwd, opts.envFile ?? ".env");
  const examplePath = path.resolve(cwd, ".env.example");

  // Read (and symlink-validate) both files before writing either, so a
  // symlinked `.env.example` can't leave `.env` stripped but the placeholder
  // untouched. `readRealFile` throws on a symlink, aborting before any write.
  const envContent = readRealFile(envPath);
  const exampleContent = readRealFile(examplePath);

  const envEdit = envContent !== null ? removeEnvLine(envContent, WRITE_KEY_ENV_VAR) : null;
  const exampleEdit =
    exampleContent !== null ? removeEnvLine(exampleContent, WRITE_KEY_ENV_VAR) : null;

  if (envEdit?.removed) fs.writeFileSync(envPath, envEdit.content);
  if (exampleEdit?.removed) fs.writeFileSync(examplePath, exampleEdit.content);

  return {
    envPath,
    examplePath,
    removedFromEnv: envEdit?.removed ?? false,
    removedFromExample: exampleEdit?.removed ?? false,
  };
}
