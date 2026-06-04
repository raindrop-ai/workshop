import os from "node:os";
import path from "node:path";

/** Canonical source of truth for the cloud skills (never forked/embedded). */
export const SKILLS_REPO = "raindrop-ai/skills";

/** Default git ref to pull skills from; resolved to an immutable SHA at install. */
export const SKILLS_DEFAULT_REF = "main";

/** Cloud skills installed by `raindrop cloud setup`. */
export const CLOUD_SKILL_NAMES = ["raindrop-setup", "raindrop-investigate"] as const;

/** Cache dir for downloaded skill bundles (separate from the daemon's bundles). */
export function cloudBundlesDir(): string {
  return path.join(os.homedir(), ".raindrop", "cloud-bundles");
}

/**
 * Cloud install registry — deliberately separate from Workshop's
 * `install-registry.json` so cloud and local installs never overwrite or
 * uninstall each other's entries.
 */
export function cloudInstallRegistryPath(): string {
  return path.join(os.homedir(), ".raindrop", "cloud-install-registry.json");
}
