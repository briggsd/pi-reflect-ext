import * as fs from "node:fs";
import * as path from "node:path";
import { getSkillsRoot, validateSkillName } from "./safe-path.ts";

export interface ProtectedSkillsConfig {
	protectedSkills: string[];
}

function readProtectedFromFrontmatter(content: string): boolean {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return false;
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return false;
	const yamlBlock = normalized.slice(4, endIndex);
	for (const rawLine of yamlBlock.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const match = /^protected\s*:\s*(.+?)\s*(#.*)?$/.exec(line);
		if (!match) continue;
		const value = match[1].toLowerCase();
		return value === "true" || value === "yes" || value === "on";
	}
	return false;
}

export function isSkillProtected(skillName: string, config: ProtectedSkillsConfig): boolean {
	validateSkillName(skillName);
	if (config.protectedSkills.includes(skillName)) return true;

	const skillRoot = path.join(getSkillsRoot(), skillName);

	const sentinel = path.join(skillRoot, ".protected");
	try {
		if (fs.statSync(sentinel).isFile()) return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw err;
	}

	const skillFile = path.join(skillRoot, "SKILL.md");
	let content: string;
	try {
		content = fs.readFileSync(skillFile, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		throw err;
	}
	return readProtectedFromFrontmatter(content);
}
