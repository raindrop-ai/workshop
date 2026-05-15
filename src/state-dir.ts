import os from "os";
import path from "path";

export function workshopStatePath(filename: string): string {
  const stateDir = process.env.RAINDROP_WORKSHOP_STATE_DIR
    ? path.resolve(process.env.RAINDROP_WORKSHOP_STATE_DIR)
    : path.join(os.homedir(), ".raindrop");
  return path.join(stateDir, filename);
}
