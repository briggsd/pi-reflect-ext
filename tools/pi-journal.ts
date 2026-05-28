import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function getJournalFile(): string {
	return path.join(os.homedir(), ".pi", "reflect", "journal.jsonl");
}

function nowIso(): string {
	return new Date().toISOString();
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
	ts: string;
	file: string;
	created: boolean;
}

export const piJournalTool = defineTool({
	name: "pi_journal",
	label: "Pi Journal",
	description:
		"Append a detailed session entry to ~/.pi/reflect/journal.jsonl. One JSON line per session. Primary session record — write with full detail so a future agent can reconstruct what happened and why. No vault required.",
	parameters: PiJournalParams,
	async execute(_toolCallId, params) {
		const journalFile = getJournalFile();
		const journalDir = path.dirname(journalFile);

		fs.mkdirSync(journalDir, { recursive: true });

		const existed = fs.existsSync(journalFile);

		const entry = JSON.stringify({
			ts: nowIso(),
			focus: params.focus,
			worked_on: params.worked_on,
			...(params.decisions?.length ? { decisions: params.decisions } : {}),
			...(params.files_touched?.length ? { files: params.files_touched } : {}),
			...(params.open_items?.length ? { open: params.open_items } : {}),
		});

		try {
			fs.appendFileSync(journalFile, entry + "\n", "utf-8");
		} catch (e) {
			return {
				content: [{ type: "text", text: `pi_journal: write error: ${(e as Error).message}` }],
				details: { ts: nowIso(), file: journalFile, created: false } as PiJournalDetails,
				isError: true as const,
			};
		}

		return {
			content: [{ type: "text", text: `pi_journal: session logged to journal.jsonl${!existed ? " (created)" : ""}` }],
			details: { ts: nowIso(), file: journalFile, created: !existed } as PiJournalDetails,
		};
	},
});
