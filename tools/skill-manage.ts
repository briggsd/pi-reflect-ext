import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { atomicWriteFile } from "../atomic-write.ts";
import { isSkillProtected, type ProtectedSkillsConfig } from "../protected.ts";
import {
	getSkillsRoot,
	PathConfinementError,
	resolveSkillFile,
	resolveSkillSupportPath,
	validateSkillName,
} from "../safe-path.ts";

const SkillManageParams = Type.Object({
	action: StringEnum(["list", "view", "write", "write_file"] as const, {
		description:
			"list: enumerate skills. view: read SKILL.md. write: create/replace SKILL.md. write_file: write a support file under references/, templates/, or scripts/.",
	}),
	name: Type.Optional(Type.String({ description: "Skill name (parent directory under ~/.pi/skills/)." })),
	content: Type.Optional(Type.String({ description: "File contents for write and write_file." })),
	file_path: Type.Optional(
		Type.String({
			description:
				"Relative path under the skill directory for write_file (must start with references/, templates/, or scripts/).",
		}),
	),
});

interface SkillSummary {
	name: string;
	description: string;
	path: string;
	protected: boolean;
}

function listSkills(config: ProtectedSkillsConfig): SkillSummary[] {
	const root = getSkillsRoot();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		throw err;
	}
	const skills: SkillSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (entry.name.startsWith(".")) continue;
		const skillName = entry.name;
		let skillFile: string;
		try {
			skillFile = resolveSkillFile(skillName);
		} catch {
			continue;
		}
		let raw: string;
		try {
			raw = fs.readFileSync(skillFile, "utf-8");
		} catch {
			continue;
		}
		const description = extractDescription(raw);
		skills.push({
			name: skillName,
			description,
			path: skillFile,
			protected: isSkillProtected(skillName, config),
		});
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return skills;
}

function extractDescription(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return "";
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return "";
	const block = normalized.slice(4, endIndex);
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		const match = /^description\s*:\s*(.+?)\s*$/.exec(line);
		if (match) {
			let value = match[1];
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			return value;
		}
	}
	return "";
}

export interface SkillManageDetails {
	action: "list" | "view" | "write" | "write_file";
	skill?: string;
	relativePath?: string;
	bytesAfter?: number;
}

export function createSkillManageTool(getConfig: () => ProtectedSkillsConfig) {
	return defineTool({
		name: "skill_manage",
		label: "Skill Manage",
		description:
			"Manage skills under ~/.pi/skills/. Use list to enumerate, view to read a SKILL.md, write to create or replace a SKILL.md (frontmatter required: name + description), and write_file for support files under references/, templates/, or scripts/. Protected skills cannot be modified.",
		parameters: SkillManageParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const skills = listSkills(getConfig());
					const lines =
						skills.length === 0
							? ["(no skills found under ~/.pi/skills/)"]
							: skills.map(
									(s) => `${s.protected ? "*" : "-"} ${s.name}${s.description ? ` — ${s.description}` : ""}`,
								);
					const details: SkillManageDetails = { action: "list" };
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { ...details, skills } as SkillManageDetails & { skills: SkillSummary[] },
					};
				}
				case "view": {
					if (!params.name) {
						return errorResult("view", "name is required");
					}
					let target: string;
					try {
						validateSkillName(params.name);
						target = resolveSkillFile(params.name);
					} catch (err) {
						return errorResult("view", confinementMessage(err));
					}
					let raw: string;
					try {
						raw = fs.readFileSync(target, "utf-8");
					} catch (err) {
						const code = (err as NodeJS.ErrnoException).code;
						if (code === "ENOENT") {
							return errorResult("view", `skill "${params.name}" has no SKILL.md`);
						}
						return errorResult("view", (err as Error).message);
					}
					return {
						content: [{ type: "text", text: raw }],
						details: { action: "view", skill: params.name, bytesAfter: raw.length } as SkillManageDetails,
					};
				}
				case "write": {
					if (!params.name) return errorResult("write", "name is required");
					if (params.content === undefined) return errorResult("write", "content is required");
					try {
						validateSkillName(params.name);
					} catch (err) {
						return errorResult("write", confinementMessage(err));
					}
					if (isSkillProtected(params.name, getConfig())) {
						return errorResult("write", `skill "${params.name}" is protected and cannot be modified`);
					}
					const validation = validateSkillMarkdown(params.content);
					if (validation) return errorResult("write", validation);
					const target = resolveSkillFile(params.name);
					const skillDir = path.dirname(target);
					atomicWriteFile(target, params.content, {
						historyDir: path.join(skillDir, ".history"),
						historyName: "SKILL.md",
					});
					return {
						content: [{ type: "text", text: `wrote ${target} (${params.content.length} bytes)` }],
						details: {
							action: "write",
							skill: params.name,
							bytesAfter: params.content.length,
						} as SkillManageDetails,
					};
				}
				case "write_file": {
					if (!params.name) return errorResult("write_file", "name is required");
					if (!params.file_path) return errorResult("write_file", "file_path is required");
					if (params.content === undefined) return errorResult("write_file", "content is required");
					try {
						validateSkillName(params.name);
					} catch (err) {
						return errorResult("write_file", confinementMessage(err));
					}
					if (isSkillProtected(params.name, getConfig())) {
						return errorResult("write_file", `skill "${params.name}" is protected and cannot be modified`);
					}
					let resolved: ReturnType<typeof resolveSkillSupportPath>;
					try {
						resolved = resolveSkillSupportPath(params.name, params.file_path);
					} catch (err) {
						return errorResult("write_file", confinementMessage(err));
					}
					atomicWriteFile(resolved.absolute, params.content);
					return {
						content: [
							{
								type: "text",
								text: `wrote ${resolved.absolute} (${params.content.length} bytes)`,
							},
						],
						details: {
							action: "write_file",
							skill: params.name,
							relativePath: resolved.relative,
							bytesAfter: params.content.length,
						} as SkillManageDetails,
					};
				}
			}
		},
	});
}

function errorResult(
	action: SkillManageDetails["action"],
	message: string,
): { content: [{ type: "text"; text: string }]; details: SkillManageDetails; isError: true } {
	return {
		content: [{ type: "text", text: `skill_manage ${action}: ${message}` }],
		details: { action },
		isError: true,
	};
}

function confinementMessage(err: unknown): string {
	if (err instanceof PathConfinementError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

function validateSkillMarkdown(content: string): string | undefined {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) {
		return "SKILL.md must start with YAML frontmatter delimited by ---";
	}
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return "SKILL.md frontmatter is not terminated by ---";
	const block = normalized.slice(4, endIndex);
	let hasName = false;
	let hasDescription = false;
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("name:")) hasName = true;
		if (line.startsWith("description:")) hasDescription = true;
	}
	if (!hasName) return "SKILL.md frontmatter must include a name field";
	if (!hasDescription) return "SKILL.md frontmatter must include a description field";
	return undefined;
}
