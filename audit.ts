import * as fs from "node:fs";
import * as path from "node:path";
import { getReflectStateDir } from "./safe-path.ts";
import type { ReflectMode } from "./settings.ts";
import type { RunSummary } from "./state.ts";

export interface AuditEntry {
	ts: string;
	mode: ReflectMode;
	trigger: "turn_end" | "agent_end" | "manual" | "session";
	durationMs: number;
	summary: string | null;
	memoryEdits: number;
	skillEdits: number;
	truncated: boolean;
	skipped?: string;
	errorMessage?: string;
}

export function logPath(): string {
	return path.join(getReflectStateDir(), "log.jsonl");
}

export function appendAudit(run: RunSummary, mode: ReflectMode, trigger: AuditEntry["trigger"]): void {
	const entry: AuditEntry = {
		ts: new Date(run.endedAt).toISOString(),
		mode,
		trigger,
		durationMs: run.endedAt - run.startedAt,
		summary: run.summary,
		memoryEdits: run.memoryEdits,
		skillEdits: run.skillEdits,
		truncated: run.truncated,
		skipped: run.skipped,
		errorMessage: run.errorMessage,
	};
	const line = `${JSON.stringify(entry)}\n`;
	fs.mkdirSync(getReflectStateDir(), { recursive: true });
	fs.appendFileSync(logPath(), line, { encoding: "utf-8" });
}
