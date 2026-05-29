import * as fs from "node:fs";
import * as path from "node:path";

// Cross-process advisory lock via O_CREAT|O_EXCL lockfile.
//
// Why this exists: pi-reflect's memory / state / journal / vault-daily tools all
// do read-modify-write (RMW) on shared files. Two pi sessions on the same machine
// can race and lose updates (memory: stale cachedMemory + system-prompt injection
// makes the loser silently clobber the winner's edits). pi_journal additionally
// appendFileSync's >PIPE_BUF entries → interleaving risk → corrupt JSONL.
//
// O_EXCL on a lockfile is the standard POSIX primitive for this and needs no deps.
// Stale-lock detection: if the lockfile mtime is older than `staleMs` AND the
// recorded pid is not alive, steal it. The pid+timestamp body is for debugging
// and stale detection only — we never trust it for ownership.
//
// Sync API on purpose: existing tool code is sync. We block the thread via
// Atomics.wait on a SharedArrayBuffer so the event loop stays parked rather than
// spinning. Contention is rare (only when concurrent sessions race).

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const RETRY_BASE_MS = 10;
const RETRY_MAX_MS = 200;

function sleepSyncMs(ms: number): void {
	const buf = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buf, 0, 0, ms);
}

function writeLockFile(lockPath: string): number {
	// 'wx' = O_CREAT | O_EXCL | O_WRONLY. Atomic create-or-fail across processes
	// on every POSIX filesystem we care about (and on NTFS via Node's wrapper).
	const fd = fs.openSync(lockPath, "wx");
	try {
		fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
	} catch {
		// Body write is best-effort metadata only. The lock is held by the file's
		// existence, not its contents.
	}
	return fd;
}

function processAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but we can't signal it — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function tryStealStaleLock(lockPath: string, staleMs: number): boolean {
	let st: fs.Stats;
	try {
		st = fs.statSync(lockPath);
	} catch {
		// Vanished underneath us — fine, the next acquire attempt will succeed.
		return true;
	}
	if (Date.now() - st.mtimeMs <= staleMs) return false;

	let pid = NaN;
	try {
		const body = fs.readFileSync(lockPath, "utf-8");
		pid = parseInt(body.split("\n")[0] ?? "", 10);
	} catch {
		// Empty or unreadable body → fall through to mtime-only steal.
	}
	if (Number.isFinite(pid) && processAlive(pid)) {
		// Old mtime but holder is still alive (long RMW on a big file, debugger
		// paused, etc.). Don't steal.
		return false;
	}
	try {
		fs.unlinkSync(lockPath);
		return true;
	} catch {
		return false;
	}
}

export interface LockOptions {
	timeoutMs?: number;
	staleMs?: number;
}

/**
 * Run `fn` while holding an advisory lock on `<target>.lock`. Lock is released
 * (and the lockfile unlinked) before this function returns, even if `fn` throws.
 *
 * Throws if the lock cannot be acquired within `timeoutMs` (default 5s) and the
 * existing holder is not stale.
 */
export function withFileLockSync<T>(target: string, fn: () => T, options?: LockOptions): T {
	const lockPath = `${target}.lock`;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;

	fs.mkdirSync(path.dirname(lockPath), { recursive: true });

	const deadline = Date.now() + timeoutMs;
	let fd: number | null = null;
	let attempt = 0;

	while (fd === null) {
		try {
			fd = writeLockFile(lockPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			if (tryStealStaleLock(lockPath, staleMs)) {
				// Retry immediately after a successful steal; don't backoff.
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`withFileLockSync: timeout acquiring ${lockPath} after ${timeoutMs}ms (holder appears live)`,
				);
			}
			const wait = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
			attempt++;
			sleepSyncMs(wait);
		}
	}

	try {
		return fn();
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// ignore
		}
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// May have been stolen by another process after a stale-timeout; that's
			// fine — they now own the lock and will release it themselves.
		}
	}
}
