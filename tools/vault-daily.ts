import * as fs from "node:fs";
import * as path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { atomicWriteFile } from "../atomic-write.ts";
import { confinePathTo } from "../safe-path.ts";
import { getVaultDailyDir, getVaultRoot } from "../vault-paths.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function todayDateStr(): string {
	return new Date().toISOString().slice(0, 10);
}

function todayTimeStr(): string {
	const now = new Date();
	return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function dayOfWeek(dateStr: string): string {
	return DAYS[new Date(`${dateStr}T12:00:00`).getDay()];
}

function scaffoldDailyNote(dateStr: string): string {
	return [
		`# ${dateStr} — ${dayOfWeek(dateStr)}`,
		"",
		"## Intentions",
		"- Top 3 priorities for today:",
		"  1.",
		"  2.",
		"  3.",
		"",
		"## Schedule",
		"-",
		"",
		"## Captures",
		"<!-- Ad-hoc thoughts, ideas, links, observations throughout the day -->",
		"",
		"## Meetings",
		"<!-- Meeting notes here. Link to Team/ files for attendees. -->",
		"",
		"## Decisions",
		"<!-- Any decisions made today. One-liner + rationale. -->",
		"",
		"## Done",
		"<!-- What actually got finished -->",
		"",
		"## Tomorrow",
		"<!-- What's queued up for tomorrow -->",
		"",
		"---",
		"",
		"## Sessions",
		"",
	].join("\n");
}

function formatSessionBlock(params: {
	focus: string;
	worked_on: string[];
	decisions?: string[];
	open_items?: string[];
	files_touched?: string[];
}): string {
	const lines: string[] = [`### Session — ${todayTimeStr()}`];
	lines.push(`**Focus:** ${params.focus}`);

	lines.push("**Worked on:**");
	for (const item of params.worked_on) lines.push(`- ${item}`);

	if (params.decisions && params.decisions.length > 0) {
		lines.push("**Decisions:**");
		for (const d of params.decisions) lines.push(`- ${d}`);
	}

	if (params.open_items && params.open_items.length > 0) {
		lines.push("**Open / next time:**");
		for (const o of params.open_items) lines.push(`- ${o}`);
	}

	if (params.files_touched && params.files_touched.length > 0) {
		lines.push("**Files touched:**");
		for (const f of params.files_touched) lines.push(`- ${f}`);
	}

	lines.push("");
	return lines.join("\n");
}

const VaultDailyParams = Type.Object({
	focus: Type.String({
		description: "One-line description of what the session focused on.",
	}),
	worked_on: Type.Array(Type.String(), {
		description: "Bullet points of what was worked on this session.",
		minItems: 1,
	}),
	decisions: Type.Optional(
		Type.Array(Type.String(), {
			description: "Decisions made during the session.",
		}),
	),
	open_items: Type.Optional(
		Type.Array(Type.String(), {
			description: "Open items or next steps for a future session.",
		}),
	),
	files_touched: Type.Optional(
		Type.Array(Type.String(), {
			description: "Key files created or modified.",
		}),
	),
});

export interface VaultDailyDetails {
	date: string;
	created: boolean;
	bytesBefore: number;
	bytesAfter: number;
}

export const vaultDailyTool = defineTool({
	name: "vault_daily",
	label: "Vault Daily Note",
	description:
		"Append a session block to today's vault daily note (~/vault/Daily/YYYY-MM-DD.md). Creates the note from the standard template if it doesn't exist yet. Use at the end of any substantive session — any session where real work happened, decisions were made, files were created or modified, or new tools/projects/people came up.",
	parameters: VaultDailyParams,
	async execute(_toolCallId, params) {
		const dateStr = todayDateStr();
		const dailyDir = getVaultDailyDir();
		const target = path.join(dailyDir, `${dateStr}.md`);

		// Skip gracefully if vault Daily directory doesn't exist
		if (!fs.existsSync(dailyDir)) {
			return {
				content: [{ type: "text", text: `vault_daily: skipped — vault Daily dir not found at ${dailyDir}` }],
				details: { date: dateStr, created: false, bytesBefore: 0, bytesAfter: 0 } as VaultDailyDetails,
			};
		}

		try {
			confinePathTo(getVaultRoot(), target);
		} catch (e) {
			return {
				content: [{ type: "text", text: `vault_daily: path error: ${(e as Error).message}` }],
				details: { date: dateStr, created: false, bytesBefore: 0, bytesAfter: 0 } as VaultDailyDetails,
				isError: true as const,
			};
		}

		let current = "";
		let created = false;
		try {
			current = fs.readFileSync(target, "utf-8");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				current = scaffoldDailyNote(dateStr);
				created = true;
			} else {
				return {
					content: [{ type: "text", text: `vault_daily: read error: ${(e as Error).message}` }],
					details: { date: dateStr, created: false, bytesBefore: 0, bytesAfter: 0 } as VaultDailyDetails,
					isError: true as const,
				};
			}
		}

		const bytesBefore = current.length;
		const block = formatSessionBlock(params);
		const sep = current.endsWith("\n") ? "" : "\n";
		const next = `${current}${sep}${block}`;

		atomicWriteFile(target, next);

		return {
			content: [
				{
					type: "text",
					text: `vault_daily: appended session to ${dateStr}.md${created ? " (created)" : ""}`,
				},
			],
			details: { date: dateStr, created, bytesBefore, bytesAfter: next.length } as VaultDailyDetails,
		};
	},
});
