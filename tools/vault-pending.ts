import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { localDateStr } from "../lib/dates.ts";
import { confinePathTo } from "../safe-path.ts";
import { getVaultPendingDir } from "../vault-paths.ts";

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,60}[a-z0-9])?$/;

function validateSlug(slug: string): void {
	if (!SLUG_RE.test(slug)) {
		throw new Error("slug must be lowercase alphanumeric with hyphens, 1–62 chars, no leading/trailing/consecutive hyphens");
	}
	if (slug.includes("--")) {
		throw new Error("slug must not contain consecutive hyphens");
	}
}

// Local-date, not UTC. See ../lib/dates.ts for the why.
function todayIso(): string {
	return localDateStr();
}

const VaultPendingParams = Type.Object({
	action: StringEnum(["propose", "list", "clear"] as const, {
		description:
			"propose: write a new pending item; list: show all pending items; clear: delete a pending item by filename.",
	}),
	type: Type.Optional(
		StringEnum(["semantic", "lead", "source"] as const, {
			description:
				"semantic: a knowledge insight for a vault topic doc; lead: a research question or thread to pursue; source: a URL, book, or article to run through content-synthesis. Required for propose.",
		}),
	),
	slug: Type.Optional(
		Type.String({
			description:
				"kebab-case identifier for the pending item (used in filename, e.g. 'hermes-memory-taxonomy'). Required for propose.",
		}),
	),
	suggested_dest: Type.Optional(
		Type.String({
			description:
				"Vault-relative path or plain description of where this item should land (e.g. 'Intelligence/topics/auto-improving-agents.md'). Required for propose.",
		}),
	),
	content: Type.Optional(
		Type.String({
			description: "The proposal content in plain markdown. Required for propose.",
		}),
	),
	filename: Type.Optional(
		Type.String({
			description: "Exact filename of the pending item to delete. Required for clear.",
		}),
	),
});

export interface VaultPendingDetails {
	action: "propose" | "list" | "clear";
	filename?: string;
	type?: string;
}

export const vaultPendingTool = defineTool({
	name: "vault_pending",
	label: "Vault Pending",
	description:
		"Propose knowledge items for the vault's _pending/ review queue. Items land in ~/vault/_pending/ for the user to route into the vault graph. Use for semantic insights, research leads, and source references that belong in vault topics but should be human-reviewed before landing in the knowledge graph.",
	parameters: VaultPendingParams,
	async execute(_toolCallId, params) {
		const pendingDir = getVaultPendingDir();

		switch (params.action) {
			case "propose": {
				if (!params.type) return err("propose", "type is required");
				if (!params.slug) return err("propose", "slug is required");
				if (!params.suggested_dest) return err("propose", "suggested_dest is required");
				if (!params.content) return err("propose", "content is required");

				try {
					validateSlug(params.slug);
				} catch (e) {
					return err("propose", (e as Error).message);
				}

				const filename = `${todayIso()}-${params.slug}.md`;
				const target = path.join(pendingDir, filename);
				try {
					confinePathTo(pendingDir, target);
				} catch (e) {
					return err("propose", (e as Error).message);
				}

				// Reject if any existing file already contains this slug (regardless of date prefix)
				try {
					const existing = fs.readdirSync(pendingDir).filter(
						(f) => f.endsWith(`-${params.slug}.md`) && f !== filename,
					);
					if (existing.length > 0) {
						return err("propose", `duplicate slug — already pending as: ${existing.join(", ")}`);
					}
				} catch {
					// _pending dir doesn't exist yet — no duplicates possible
				}

				const frontmatter = [
					"---",
					`type: ${params.type}`,
					`proposed: ${new Date().toISOString()}`,
					`suggested-dest: ${params.suggested_dest}`,
					"---",
					"",
				].join("\n");
				const fileContent = frontmatter + params.content + (params.content.endsWith("\n") ? "" : "\n");

				fs.mkdirSync(pendingDir, { recursive: true });
				fs.writeFileSync(target, fileContent, "utf-8");

				return {
					content: [{ type: "text", text: `vault_pending: proposed ${filename}` }],
					details: { action: "propose", filename, type: params.type } as VaultPendingDetails,
				};
			}

			case "list": {
				let entries: fs.Dirent[];
				try {
					entries = fs.readdirSync(pendingDir, { withFileTypes: true });
				} catch (e) {
					const code = (e as NodeJS.ErrnoException).code;
					if (code === "ENOENT") {
						return {
							content: [{ type: "text", text: "(no pending items)" }],
							details: { action: "list" } as VaultPendingDetails,
						};
					}
					return err("list", (e as Error).message);
				}

				const files = entries
					.filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "CLAUDE.md")
					.map((e) => e.name)
					.sort();

				if (files.length === 0) {
					return {
						content: [{ type: "text", text: "(no pending items)" }],
						details: { action: "list" } as VaultPendingDetails,
					};
				}

				const lines = files.map((f) => {
					try {
						const raw = fs.readFileSync(path.join(pendingDir, f), "utf-8");
						const typeMatch = /^type:\s*(\S+)/m.exec(raw);
						const destMatch = /^suggested-dest:\s*(.+)/m.exec(raw);
						const type = typeMatch?.[1] ?? "?";
						const dest = (destMatch?.[1] ?? "?").trim();
						return `${f}  [${type}] → ${dest}`;
					} catch {
						return f;
					}
				});

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { action: "list" } as VaultPendingDetails,
				};
			}

			case "clear": {
				if (!params.filename) return err("clear", "filename is required");

				const target = path.join(pendingDir, params.filename);
				try {
					confinePathTo(pendingDir, target);
				} catch (e) {
					return err("clear", (e as Error).message);
				}

				try {
					fs.unlinkSync(target);
				} catch (e) {
					const code = (e as NodeJS.ErrnoException).code;
					if (code === "ENOENT") return err("clear", `file not found: ${params.filename}`);
					return err("clear", (e as Error).message);
				}

				return {
					content: [{ type: "text", text: `vault_pending: cleared ${params.filename}` }],
					details: { action: "clear", filename: params.filename } as VaultPendingDetails,
				};
			}
		}
	},
});

function err(
	action: VaultPendingDetails["action"],
	message: string,
): { content: [{ type: "text"; text: string }]; details: VaultPendingDetails; isError: true } {
	return {
		content: [{ type: "text", text: `vault_pending ${action}: ${message}` }],
		details: { action },
		isError: true,
	};
}
