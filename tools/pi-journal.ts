import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { atomicWriteFile } from "../atomic-write.ts";

function getJournalDir(): string {
	return path.join(os.homedir(), ".pi", "reflect", "journal");
}

function todayDateStr(): string {
	return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatJournalBlock(params: {
	focus: string;
	worked_on: string[];
	decisions?: string[];
	files_touched?: string[];
	open_items?: string[];
}): string {
	const lines: string[] = [`## Session — ${nowIso()}`, ""];
	lines.push(`**Focus:** ${params.focus}`, "");

	lines.push("### Worked On");
	for (const item of params.worked_on) lines.push(`- ${item}`);
	lines.push("");

	if (params.decisions && params.decisions.length > 0) {
		lines.push("### Decisions");
		for (const d of params.decisions) lines.push(`- ${d}`);
		lines.push("");
	}

	if (params.files_touched && params.files_touched.length > 0) {
		lines.push("### Files");
		for (const f of params.files_touched) lines.push(`- ${f}`);
		lines.push("");
	}

	if (params.open_items && params.open_items.length > 0) {
		lines.push("### Open");
		for (const o of params.open_items) lines.push(`- ${o}`);
		lines.push("");
	}

	lines.push("---", "");
	return lines.join("\n");
}

const PiJournalParams = Type.Object({
	focus: Type.String({
		description: "One-line description of what the session focused on.",
	}),
	worked_on: Type.Array(Type.String(), {
		description: "Detailed bullet points of what was worked on. Be specific — include context, rationale, and outcomes, not just task names. This is the primary recall surface for future sessions.",
		minItems: 1,
	}),
	decisions: Type.Optional(
		Type.Array(Type.String(), {
			description: "Decisions made during the session, with rationale where relevant.",
		}),
	),
	files_touched: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files created or modified, with full paths.",
		}),
	),
	open_items: Type.Optional(
		Type.Array(Type.String(), {
			description: "Open items or next steps, with enough context to resume without re-reading the full session.",
		}),
	),
});

export interface PiJournalDetails {
	date: string;
	file: string;
	created: boolean;
}

export const piJournalTool = defineTool({
	name: "pi_journal",
	label: "Pi Journal",
	description:
		"Append a detailed session log to ~/.pi/reflect/journal/YYYY-MM-DD.md. This is the primary session record — write with enough detail that a future agent can reconstruct what happened and why without re-reading the conversation. Use for every substantive session. No vault required.",
	parameters: PiJournalParams,
	async execute(_toolCallId, params) {
		const dateStr = todayDateStr();
		const journalDir = getJournalDir();
		const target = path.join(journalDir, `${dateStr}.md`);

		fs.mkdirSync(journalDir, { recursive: true });

		let current = "";
		let created = false;
		try {
			current = fs.readFileSync(target, "utf-8");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				current = `# Journal — ${dateStr}\n\n`;
				created = true;
			} else {
				return {
					content: [{ type: "text", text: `pi_journal: read error: ${(e as Error).message}` }],
					details: { date: dateStr, file: target, created: false } as PiJournalDetails,
					isError: true as const,
				};
			}
		}

		const block = formatJournalBlock(params);
		const sep = current.endsWith("\n") ? "" : "\n";
		const next = `${current}${sep}${block}`;

		atomicWriteFile(target, next);

		return {
			content: [{ type: "text", text: `pi_journal: appended session to ${dateStr}.md${created ? " (created)" : ""}` }],
			details: { date: dateStr, file: target, created } as PiJournalDetails,
		};
	},
});
