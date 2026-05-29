import * as fs from "node:fs";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { atomicWriteFile } from "../atomic-write.ts";
import { withFileLockSync } from "../file-lock.ts";
import { getVaultSourcesFile } from "../vault-paths.ts";

const VaultSourceParams = Type.Object({
	entry: Type.String({
		description:
			"The source line to add (e.g. 'Author — Title — brief note on why it's worth capturing'). Do not include a leading dash; the tool adds it.",
	}),
	topic_hint: Type.Optional(
		Type.String({
			description:
				"Vault topic slug this source relates to (e.g. 'auto-improving-agents'). Used to add a cross-reference annotation.",
		}),
	),
});

export interface VaultSourceDetails {
	entry: string;
	bytesBefore: number;
	bytesAfter: number;
}

export const vaultSourceTool = defineTool({
	name: "vault_source",
	label: "Vault Source",
	description:
		"Queue a source (YouTube video, article, paper, book) for capture via the content-synthesis pipeline. Appends to the ## New section of Intelligence/sources-to-capture.md. Use when a session explicitly discusses a specific external source worth capturing — a URL, a book reference, a paper someone mentioned.",
	parameters: VaultSourceParams,
	async execute(_toolCallId, params) {
		const target = getVaultSourcesFile();

		return withFileLockSync(target, () => {
		let current = "";
		try {
			current = fs.readFileSync(target, "utf-8");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				current = "List of sources that need to be ingested via content-synthesis skill.\n\n## New\n\n## Completed\n";
			} else {
				return {
					content: [{ type: "text", text: `vault_source: read error: ${(e as Error).message}` }],
					details: { entry: params.entry, bytesBefore: 0, bytesAfter: 0 } as VaultSourceDetails,
					isError: true as const,
				};
			}
		}

		const bytesBefore = current.length;
		const trimmed = params.entry.trim();
		const line = trimmed.startsWith("- ") ? trimmed : `- ${trimmed}`;
		const topicSuffix =
			params.topic_hint && !line.includes("→") && !line.includes("[[")
				? ` → for [[Intelligence/topics/${params.topic_hint}]]`
				: "";
		const fullLine = `${line}${topicSuffix}`;

		// Insert as first entry under ## New
		const newIdx = current.indexOf("## New");
		let next: string;
		if (newIdx >= 0) {
			const afterHeader = current.indexOf("\n", newIdx) + 1;
			const sep = current[afterHeader] === "\n" ? "" : "\n";
			next = current.slice(0, afterHeader) + sep + fullLine + "\n" + current.slice(afterHeader);
		} else {
			next = `## New\n${fullLine}\n\n${current}`;
		}

		atomicWriteFile(target, next);

		const preview = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
		return {
			content: [{ type: "text", text: `vault_source: queued "${preview}"` }],
			details: { entry: trimmed, bytesBefore, bytesAfter: next.length } as VaultSourceDetails,
		};
		});
	},
});
