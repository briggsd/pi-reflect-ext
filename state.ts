import * as fs from "node:fs";
import { atomicWriteFile } from "./atomic-write.ts";
import { withFileLockSync } from "./file-lock.ts";
import { getReflectStateDir, getStatePath } from "./safe-path.ts";

export type SkipReason = "no_model" | "no_api_key" | "no_messages" | "in_flight" | "aborted";

export interface SkippedCounts {
	no_model: number;
	no_api_key: number;
	no_messages: number;
	in_flight: number;
	aborted: number;
}

export interface EditCounts {
	memory: number;
	skills: number;
}

export interface LastRun {
	ts: string;
	summary: string | null;
	durationMs: number;
	truncated: boolean;
	errorMessage?: string;
	skipped?: SkipReason;
}

export interface ReflectState {
	version: 1;
	turns: number;
	reviews: number;
	reviewsSkipped: SkippedCounts;
	edits: EditCounts;
	errors: number;
	lastRun: LastRun | null;
}

function emptyState(): ReflectState {
	return {
		version: 1,
		turns: 0,
		reviews: 0,
		reviewsSkipped: { no_model: 0, no_api_key: 0, no_messages: 0, in_flight: 0, aborted: 0 },
		edits: { memory: 0, skills: 0 },
		errors: 0,
		lastRun: null,
	};
}

let cache: ReflectState | null = null;

export function loadState(): ReflectState {
	if (cache) return cache;
	const target = getStatePath();
	try {
		const raw = fs.readFileSync(target, "utf-8");
		const parsed = JSON.parse(raw) as Partial<ReflectState> & { version?: number };
		if (parsed.version !== 1) {
			cache = emptyState();
			return cache;
		}
		const state = mergeWithEmpty(parsed);
		cache = state;
		return state;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			cache = emptyState();
			return cache;
		}
		cache = emptyState();
		return cache;
	}
}

function mergeWithEmpty(input: Partial<ReflectState>): ReflectState {
	const base = emptyState();
	return {
		version: 1,
		turns: input.turns ?? base.turns,
		reviews: input.reviews ?? base.reviews,
		reviewsSkipped: { ...base.reviewsSkipped, ...(input.reviewsSkipped ?? {}) },
		edits: { ...base.edits, ...(input.edits ?? {}) },
		errors: input.errors ?? base.errors,
		lastRun: input.lastRun ?? base.lastRun,
	};
}

export function writeState(state: ReflectState): void {
	cache = state;
	fs.mkdirSync(getReflectStateDir(), { recursive: true });
	atomicWriteFile(getStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function invalidateStateCache(): void {
	cache = null;
}

/**
 * Run an RMW on state.json under a cross-process file lock with the in-process
 * cache invalidated up front. Mirrors withMemoryLock — see memory.ts for the
 * rationale on why cache invalidation must happen inside the critical section.
 */
export function withStateLock<T>(fn: () => T): T {
	return withFileLockSync(getStatePath(), () => {
		cache = null;
		return fn();
	});
}

export interface RunSummary {
	startedAt: number;
	endedAt: number;
	summary: string | null;
	memoryEdits: number;
	skillEdits: number;
	truncated: boolean;
	errorMessage?: string;
	skipped?: SkipReason;
}

export function recordTurn(): ReflectState {
	return withStateLock(() => {
		const state = loadState();
		const next: ReflectState = { ...state, turns: state.turns + 1 };
		writeState(next);
		return next;
	});
}

export function recordRun(run: RunSummary): ReflectState {
	return withStateLock(() => {
	const state = loadState();
	const reviewsSkipped: SkippedCounts = { ...state.reviewsSkipped };
	if (run.skipped) {
		reviewsSkipped[run.skipped] += 1;
	}
	const next: ReflectState = {
		...state,
		reviews: state.reviews + 1,
		reviewsSkipped,
		edits: {
			memory: state.edits.memory + run.memoryEdits,
			skills: state.edits.skills + run.skillEdits,
		},
		errors: state.errors + (run.errorMessage ? 1 : 0),
		lastRun: {
			ts: new Date(run.endedAt).toISOString(),
			summary: run.summary,
			durationMs: run.endedAt - run.startedAt,
			truncated: run.truncated,
			errorMessage: run.errorMessage,
			skipped: run.skipped,
		},
	};
	writeState(next);
	return next;
	});
}

export function formatStatus(state: ReflectState): string {
	const lines: string[] = [];
	lines.push("pi-reflect — M4 status");
	lines.push(`  turns observed:  ${state.turns}`);
	lines.push(`  reviews fired:   ${state.reviews}`);
	lines.push(`  edits — memory: ${state.edits.memory}, skills: ${state.edits.skills}`);
	lines.push(`  errors:          ${state.errors}`);

	const skipParts: string[] = [];
	if (state.reviewsSkipped.no_model > 0) skipParts.push(`no_model=${state.reviewsSkipped.no_model}`);
	if (state.reviewsSkipped.no_api_key > 0) skipParts.push(`no_api_key=${state.reviewsSkipped.no_api_key}`);
	if (state.reviewsSkipped.no_messages > 0) skipParts.push(`no_messages=${state.reviewsSkipped.no_messages}`);
	if (state.reviewsSkipped.in_flight > 0) skipParts.push(`in_flight=${state.reviewsSkipped.in_flight}`);
	if (state.reviewsSkipped.aborted > 0) skipParts.push(`aborted=${state.reviewsSkipped.aborted}`);
	if (skipParts.length > 0) lines.push(`  skipped:         ${skipParts.join(", ")}`);

	const lr = state.lastRun;
	if (lr) {
		const status = lr.errorMessage
			? "error"
			: lr.skipped
				? `skipped (${lr.skipped})`
				: lr.summary
					? "edited"
					: "no-op";
		lines.push("");
		lines.push("last run:");
		lines.push(`  at:        ${lr.ts}`);
		lines.push(`  duration:  ${lr.durationMs} ms`);
		lines.push(`  status:    ${status}`);
		if (lr.summary) lines.push(`  summary:   ${lr.summary}`);
		if (lr.truncated) lines.push(`  truncated: yes`);
		if (lr.errorMessage) lines.push(`  error:     ${lr.errorMessage}`);
	} else {
		lines.push("");
		lines.push("last run:    (none yet)");
	}
	return lines.join("\n");
}
