/**
 * runtime/lock.ts — a cross-process advisory lock via atomic `mkdir` (portable, no deps).
 * Serializes the "check → spawn the runtime" critical section so two clients starting at
 * once (the desktop launching while a `glyphh` turn fires) can't spawn two runtimes. A
 * lock whose holder process has died is broken automatically.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface LockHandle {
  release(): void;
}

/** Best-effort: is a process with this pid alive? (EPERM means it exists but isn't ours.) */
function alive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One non-blocking attempt to take the lock. Returns a handle if acquired, or null if a
 * LIVE process holds it. A lock held by a dead process is broken and retaken.
 */
export function tryAcquireLock(lockDir: string): LockHandle | null {
  const pidFile = join(lockDir, "pid");
  try {
    mkdirSync(lockDir); // atomic; throws EEXIST if already held
    writeFileSync(pidFile, String(process.pid));
    return { release: () => release(lockDir) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let holder = 0;
    try {
      holder = Number(readFileSync(pidFile, "utf8")) || 0;
    } catch {
      /* holder wrote the dir but not yet the pid — treat as live, back off */
    }
    if (holder && !alive(holder)) {
      release(lockDir); // stale — break it, let the caller retry
    }
    return null;
  }
}

function release(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* already released */
  }
}
