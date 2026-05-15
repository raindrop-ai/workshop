import fs from "fs";
import path from "path";
import { workshopStatePath } from "./state-dir";

const STATE_PATH = workshopStatePath("active-workspace.json");
export const ACTIVE_WORKSPACE_MISSING_MESSAGE =
  "No active Workshop project. Run `raindrop workshop` from your agent project.";

export interface ActiveWorkspace {
  cwd: string;
  updated_at: string;
}

export function getActiveWorkspace(): ActiveWorkspace | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<ActiveWorkspace>;
    if (typeof parsed.cwd === "string" && path.isAbsolute(parsed.cwd) && fs.existsSync(parsed.cwd)) {
      return {
        cwd: parsed.cwd,
        updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
      };
    }
  } catch {
    return getProcessWorkspace();
  }
  return getProcessWorkspace();
}

export function setActiveWorkspace(cwd: string): ActiveWorkspace {
  const resolved = path.resolve(cwd);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`active workspace must be a directory: ${resolved}`);
  }

  const workspace = {
    cwd: resolved,
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(workspace, null, 2) + "\n");
  return workspace;
}

function getProcessWorkspace(): ActiveWorkspace | null {
  const cwd = process.cwd();
  try {
    if (path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()) {
      return { cwd, updated_at: new Date().toISOString() };
    }
  } catch {
    return null;
  }
  return null;
}
