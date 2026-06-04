import fs from "node:fs";
import path from "node:path";

import * as tar from "tar";

import {
  CLOUD_SKILL_NAMES,
  SKILLS_DEFAULT_REF,
  SKILLS_REPO,
  cloudBundlesDir,
} from "./constants";

export interface SkillBundle {
  /** Resolved ref — a 40-char commit SHA when pinning succeeds, else the input ref. */
  ref: string;
  /** Directory containing the skill subdirectories (each with a SKILL.md). */
  skillsDir: string;
}

export interface FetchSkillBundleOptions {
  ref?: string;
  /** Force a re-download even if a cached bundle exists. */
  force?: boolean;
}

/**
 * Headers for the GitHub API calls. Unauthenticated requests are limited to 60
 * per hour per IP, which can flake on shared CI runners, so honor a token from
 * the environment when present to lift the limit (5000/hr).
 */
function ghHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    "User-Agent": "raindrop-cli",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Reject anything that isn't a simple, safe git ref before it ever reaches the
 * filesystem or a URL. This blocks:
 *  - `..` path-traversal (which would otherwise escape ~/.raindrop/cloud-bundles
 *    via path.join and let the recursive rmSync below delete unrelated dirs), and
 *  - `/`, so the ref can be dropped into the GitHub `commits/{ref}` and
 *    `tarball/{ref}` URL paths as a single segment without being reinterpreted
 *    as extra path segments (which 404s or targets the wrong branch).
 * Allowed: letters, digits, and `._-` — i.e. `main`, `v1.2.3`, tags, and 40-char
 * SHAs. Slash-containing branch names aren't supported as a skills ref; pin to a
 * tag or commit SHA instead.
 */
function assertValidRef(ref: string): void {
  const ok =
    ref.length > 0 &&
    ref.length <= 256 &&
    /^[A-Za-z0-9._-]+$/.test(ref) &&
    !ref.includes("..") &&
    !ref.startsWith("-");
  if (!ok) {
    throw new Error(`Invalid skills ref: ${JSON.stringify(ref)} (use a tag or commit SHA)`);
  }
}

/** Resolve a branch/tag/ref to an immutable commit SHA so installs are pinned. */
async function resolveCommitSha(ref: string): Promise<string> {
  if (isCommitSha(ref)) return ref;
  try {
    const res = await fetch(`https://api.github.com/repos/${SKILLS_REPO}/commits/${ref}`, {
      headers: ghHeaders({ Accept: "application/vnd.github.sha" }),
    });
    if (!res.ok) return ref;
    const sha = (await res.text()).trim();
    return isCommitSha(sha) ? sha : ref;
  } catch {
    return ref;
  }
}

function bundleReady(dir: string): boolean {
  return CLOUD_SKILL_NAMES.every((name) => fs.existsSync(path.join(dir, name, "SKILL.md")));
}

/**
 * Download the {@link SKILLS_REPO} skills at a pinned commit and cache them under
 * `~/.raindrop/cloud-bundles/`. Skills are never forked or embedded — they are
 * fetched from the source of truth and cached so repeat runs are offline +
 * reproducible. Each skill directory (incl. its `references/`) is extracted whole.
 */
export async function fetchSkillBundle(opts: FetchSkillBundleOptions = {}): Promise<SkillBundle> {
  const requested = opts.ref ?? SKILLS_DEFAULT_REF;
  assertValidRef(requested);
  const ref = await resolveCommitSha(requested);
  const cacheDir = path.join(cloudBundlesDir(), `skills-${ref}`);

  // Only trust the cache for an immutable commit SHA. A mutable branch/tag ref
  // (e.g. when SHA resolution failed) must re-download so later runs pick up
  // new commits instead of serving a stale bundle.
  if (!opts.force && isCommitSha(ref) && bundleReady(cacheDir)) {
    return { ref, skillsDir: cacheDir };
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const res = await fetch(`https://api.github.com/repos/${SKILLS_REPO}/tarball/${ref}`, {
    headers: ghHeaders({ Accept: "application/vnd.github+json" }),
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(
      `Failed to download Raindrop skills from ${SKILLS_REPO}@${ref} (HTTP ${res.status}). ` +
        "Check your connection (or set GITHUB_TOKEN if rate-limited) and retry.",
    );
  }

  const tmpFile = path.join(cloudBundlesDir(), `skills-${ref}.download.tgz`);
  fs.writeFileSync(tmpFile, Buffer.from(await res.arrayBuffer()));

  const wanted = new Set<string>(CLOUD_SKILL_NAMES);
  try {
    await tar.x({
      file: tmpFile,
      cwd: cacheDir,
      // GitHub tarballs nest everything under a `<owner>-<repo>-<sha>/` root.
      strip: 1,
      filter: (entryPath) => {
        const parts = entryPath.split("/");
        return parts.length > 1 && wanted.has(parts[1]);
      },
    });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  if (!bundleReady(cacheDir)) {
    throw new Error(
      `Downloaded skills bundle is missing expected skills (${CLOUD_SKILL_NAMES.join(", ")}).`,
    );
  }

  return { ref, skillsDir: cacheDir };
}
