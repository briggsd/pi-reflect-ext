import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { type AuditEntry, appendAudit } from "./audit.ts";
import { type BackgroundReviewResult, runBackgroundReview } from "./background-review.ts";
import { injectMemoryIntoSystemPrompt, invalidateMemoryCache, loadMemory, writeMemory } from "./memory.ts";
import type { ProtectedSkillsConfig } from "./protected.ts";
import { invalidateSettingsCache, isReflectMode, loadSettings, overrideMode, type ReflectMode } from "./settings.ts";
import { formatStatus, invalidateStateCache, loadState, type RunSummary, recordRun, recordTurn } from "./state.ts";
import { memoryTool } from "./tools/memory.ts";
import { createSkillManageTool } from "./tools/skill-manage.ts";
import { piJournalTool } from "./tools/pi-journal.ts";
import { vaultDailyTool } from "./tools/vault-daily.ts";
import { vaultPendingTool } from "./tools/vault-pending.ts";
import { vaultSourceTool } from "./tools/vault-source.ts";

const protectedConfig: ProtectedSkillsConfig = { protectedSkills: [] };

let reviewInFlight = false;
let agentRunsSinceReview = 0;

function refreshSettings(): void {
	invalidateSettingsCache();
	const settings = loadSettings();
	protectedConfig.protectedSkills = [...settings.protectedSkills];
}

function toRunSummary(result: BackgroundReviewResult, startedAt: number, endedAt: number): RunSummary {
	let memoryEdits = 0;
	let skillEdits = 0;
	const seen = new Set<string>();
	for (const edit of result.edits) {
		if (seen.has(edit.toolCallId)) continue;
		seen.add(edit.toolCallId);
		if (edit.toolName === "memory") memoryEdits += 1;
		else if (edit.toolName === "skill_manage") skillEdits += 1;
	}
	return {
		startedAt,
		endedAt,
		summary: result.summary,
		memoryEdits,
		skillEdits,
		truncated: result.truncated,
		errorMessage: result.errorMessage,
		skipped: result.skipped,
	};
}

function recordSkippedRun(reason: "in_flight", trigger: AuditEntry["trigger"], mode: ReflectMode): void {
	const now = Date.now();
	const run: RunSummary = {
		startedAt: now,
		endedAt: now,
		summary: null,
		memoryEdits: 0,
		skillEdits: 0,
		truncated: false,
		skipped: reason,
	};
	try {
		recordRun(run);
	} catch {
		// best-effort
	}
	try {
		appendAudit(run, mode, trigger);
	} catch {
		// best-effort
	}
}

async function dispatchReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	trigger: AuditEntry["trigger"],
	mode: ReflectMode,
	notifyEmpty: boolean,
): Promise<void> {
	if (reviewInFlight) {
		recordSkippedRun("in_flight", trigger, mode);
		if (notifyEmpty) ctx.ui.notify("pi-reflect: review already in flight, skipping.", "warning");
		return;
	}
	reviewInFlight = true;
	const startedAt = Date.now();
	try {
		const result = await runBackgroundReview(pi, ctx, protectedConfig);
		const run = toRunSummary(result, startedAt, Date.now());
		try {
			recordRun(run);
		} catch {
			// best-effort
		}
		try {
			appendAudit(run, mode, trigger);
		} catch {
			// best-effort
		}
		if (result.skipped) {
			if (notifyEmpty) ctx.ui.notify(`pi-reflect: skipped (${result.skipped}).`, "info");
		} else if (result.summary) {
			ctx.ui.notify(`pi-reflect: ${result.summary}`, "info");
		} else if (notifyEmpty) {
			ctx.ui.notify("pi-reflect: no edits.", "info");
		}
		if (result.errorMessage) {
			ctx.ui.notify(`pi-reflect review error: ${result.errorMessage}`, "warning");
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const run: RunSummary = {
			startedAt,
			endedAt: Date.now(),
			summary: null,
			memoryEdits: 0,
			skillEdits: 0,
			truncated: false,
			errorMessage: message,
		};
		try {
			recordRun(run);
		} catch {
			// best-effort
		}
		try {
			appendAudit(run, mode, trigger);
		} catch {
			// best-effort
		}
		ctx.ui.notify(`pi-reflect review crashed: ${message}`, "warning");
	} finally {
		reviewInFlight = false;
	}
}

export default function piReflect(pi: ExtensionAPI): void {
	pi.registerTool(memoryTool);
	pi.registerTool(createSkillManageTool(() => protectedConfig));
	pi.registerTool(vaultPendingTool);
	pi.registerTool(piJournalTool);
	pi.registerTool(vaultDailyTool);
	pi.registerTool(vaultSourceTool);

	refreshSettings();

	pi.on("session_start", () => {
		invalidateMemoryCache();
		invalidateStateCache();
		refreshSettings();
		agentRunsSinceReview = 0;
	});

	pi.on("before_agent_start", (event) => {
		const memory = loadMemory();
		if (memory.trim().length === 0) return;
		return { systemPrompt: injectMemoryIntoSystemPrompt(event.systemPrompt, memory) };
	});

	pi.on("turn_end", () => {
		try {
			recordTurn();
		} catch {
			// state recording is best-effort
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		const { mode, batchSize } = loadSettings();
		if (mode === "off") return;
		agentRunsSinceReview++;
		const threshold = mode === "session" ? 1 : batchSize;
		if (agentRunsSinceReview < threshold) return;
		agentRunsSinceReview = 0;
		setImmediate(() => {
			void dispatchReview(pi, ctx, "agent_end", mode, false);
		});
	});

	pi.registerMessageRenderer("reflect.memory.show", (message, _options, theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		if (content.trim().length === 0) {
			box.addChild(new Text(theme.fg("muted", "(memory is empty)"), 0, 0));
		} else {
			box.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
		}
		return box;
	});

	pi.registerMessageRenderer("reflect.status.show", (message, _options, theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(content, 0, 0));
		return box;
	});

	pi.registerCommand("reflect", {
		description: "Self-improvement reflection loop (pi-reflect)",
		getArgumentCompletions: (prefix) => {
			const tokens = prefix.split(/\s+/);
			if (tokens.length <= 1) {
				const subs = ["status", "now", "mode"];
				const filtered = subs.filter((s) => s.startsWith(tokens[0] ?? ""));
				return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
			}
			if (tokens[0] === "mode") {
				const modes = ["off", "session", "batch"];
				const filtered = modes.filter((m) => m.startsWith(tokens[1] ?? ""));
				return filtered.length > 0 ? filtered.map((m) => ({ value: `mode ${m}`, label: `mode ${m}` })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "" || trimmed === "status") {
				const state = loadState();
				const settings = loadSettings();
				const content = `${formatStatus(state)}\n\nmode:            ${settings.mode}\nprotected skills: ${settings.protectedSkills.length === 0 ? "(none)" : settings.protectedSkills.join(", ")}`;
				pi.sendMessage({
					customType: "reflect.status.show",
					content,
					display: true,
				});
				return;
			}
			if (trimmed === "now") {
				await dispatchReview(pi, ctx, "manual", loadSettings().mode, true);
				return;
			}
			if (trimmed.startsWith("mode")) {
				const arg = trimmed.slice(4).trim();
				if (arg === "") {
					ctx.ui.notify(`pi-reflect mode: ${loadSettings().mode}`, "info");
					return;
				}
				if (!isReflectMode(arg)) {
					ctx.ui.notify(`pi-reflect: unknown mode "${arg}". Use off, session, or batch.`, "warning");
					return;
				}
				const next = overrideMode(arg);
				ctx.ui.notify(`pi-reflect mode set to ${next.mode} (session-only override).`, "info");
				return;
			}
			ctx.ui.notify(
				`Unknown subcommand: ${trimmed}. Try /reflect status, /reflect now, or /reflect mode.`,
				"warning",
			);
		},
	});

	pi.registerCommand("memory", {
		description: "View or edit persistent memory (~/.pi/memory.md)",
		getArgumentCompletions: (prefix) => {
			const subs = ["show"];
			const filtered = subs.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "show") {
				const memory = loadMemory();
				pi.sendMessage({
					customType: "reflect.memory.show",
					content: memory,
					display: true,
				});
				return;
			}
			if (sub !== "") {
				ctx.ui.notify(`Unknown subcommand: ${sub}. Try /memory or /memory show.`, "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/memory requires interactive mode.", "warning");
				return;
			}
			const current = loadMemory();
			const edited = await ctx.ui.editor("Persistent memory", current);
			if (edited === undefined) return;
			if (edited === current) {
				ctx.ui.notify("Memory unchanged.", "info");
				return;
			}
			writeMemory(edited);
			ctx.ui.notify(`Memory saved (${edited.length} chars).`, "info");
		},
	});
}
