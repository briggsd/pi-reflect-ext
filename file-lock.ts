import * as crypto from "node:crypto";
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

interface AcquiredLock {
	fd: number;
	token: string;
}

function writeLockFile(lockPath: string): AcquiredLock {
	// 'wx' = O_CREAT | O_EXCL | O_WRONLY. Atomic create-or-fail across processes
	// on every POSIX filesystem we care about (and on NTFS via Node's wrapper).
	const fd = fs.openSync(lockPath, "wx");
	const token = crypto.randomBytes(8).toString("hex");
	// Body MUST be written successfully: stale-steal liveness checks read the pid
	// from it, and the release path reads the token to confirm we still own this
	// lockfile before unlinking (so we don't accidentally unlink a lock that was
	// stolen from us during a long critical section). If writeSync fails we drop
	// the lock atomically and let the caller retry / surface the error.
	try {
		fs.writeSync(fd, `${process.pid}\n${Date.now()}\n${token}\n`);
	} catch (err) {
		try { fs.closeSync(fd); } catch { /* ignore */ }
		try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
		throw err;
	}
	return { fd, token };
}

function readLockToken(lockPath: string): string | null {
	try {
		const body = fs.readFileSync(lockPath, "utf-8");
		const parts = body.split("\n");
		return parts[2] ?? null;
	} catch {
		return null;
	}
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
	let acquired: AcquiredLock | null = null;
	let attempt = 0;

	while (acquired === null) {
		try {
			acquired = writeLockFile(lockPath);
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
			fs.closeSync(acquired.fd);
		} catch {
			// ignore
		}
		// Only unlink if the lockfile still carries OUR token. If another process
		// stale-stole the lock and replaced it with their own, the token won't
		// match — unlinking would drop THEIR lock and let a third process enter
		// the critical section concurrently with them.
		const currentToken = readLockToken(lockPath);
		if (currentToken === acquired.token) {
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// Vanished between read and unlink — fine.
			}
		}
		// else: token mismatch (stolen) or unreadable — leave the file alone.
	}
}
