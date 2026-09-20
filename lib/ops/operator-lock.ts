import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function safeKey(key: string) {
  const normalized = key.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 160);
  if (!normalized) throw new Error("operator_lock.invalid_key");
  return normalized;
}

function processAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

async function createLockDirectory(lockPath: string) {
  try {
    await mkdir(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw error;
  }
}

export interface OperatorLock {
  release(): Promise<void>;
}

export async function acquireOperatorLock(key: string): Promise<OperatorLock> {
  const lockPath = path.join(tmpdir(), "worldcons-" + safeKey(key) + ".lock");
  let claimed = await createLockDirectory(lockPath);
  if (!claimed) {
    let pid = 0;
    try {
      pid = Number((await readFile(path.join(lockPath, "pid"), "utf8")).trim());
    } catch {
      // A lock directory without a readable PID is stale.
    }
    if (processAlive(pid)) throw new Error("operator_lock.busy");
    await rm(lockPath, { recursive: true, force: true });
    claimed = await createLockDirectory(lockPath);
    if (!claimed) throw new Error("operator_lock.busy");
  }

  await writeFile(path.join(lockPath, "pid"), String(process.pid), { encoding: "utf8" });
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}
