import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class PathConfinementError extends Error {
	readonly attemptedPath: string;
	readonly base: string;
	constructor(attemptedPath: string, base: string, reason: string) {
		super(`path "${attemptedPath}" escapes confinement base "${base}": ${reason}`);
		this.name = "PathConfinementError";
		this.attemptedPath = attemptedPath;
		this.base = base;
	}
}

export function getReflectHome(): string {
	return path.join(os.homedir(), ".pi");
}

export function getSkillsRoot(): string {
	return path.join(getReflectHome(), "skills");
}

export function getMemoryPath(): string {
	return path.join(getReflectHome(), "memory.md");
}

export function getReflectStateDir(): string {
	return path.join(getReflectHome(), "reflect");
}

export function getStatePath(): string {
	return path.join(getReflectStateDir(), "state.json");
}

function realpathOrParent(target: string): string {
	let cursor = target;
	while (true) {
		try {
			return fs.realpathSync(cursor);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw err;
			const parent = path.dirname(cursor);
			if (parent === cursor) return cursor;
			cursor = parent;
		}
	}
}

function isWithin(child: string, parent: string): boolean {
	if (child === parent) return true;
	const sep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
	return child.startsWith(sep);
}

export function confinePathTo(base: string, candidate: string): string {
	if (candidate.length === 0) {
		throw new PathConfinementError(candidate, base, "empty path");
	}
	if (candidate.includes("\0")) {
		throw new PathConfinementError(candidate, base, "null byte in path");
	}
	const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(base, candidate);
	const normalized = path.normalize(absolute);
	const realBase = realpathOrParent(base);
	const realCandidate = realpathOrParent(normalized);
	if (!isWithin(realCandidate, realBase)) {
		throw new PathConfinementError(candidate, base, "resolves outside base after symlink/realpath");
	}
	return normalized;
}

const SUPPORT_SUBDIRS = new Set(["references", "templates", "scripts"]);

export interface SkillSupportTarget {
	skillName: string;
	subdir: "references" | "templates" | "scripts";
	relative: string;
	absolute: string;
}

export function resolveSkillSupportPath(skillName: string, relativePath: string): SkillSupportTarget {
	validateSkillName(skillName);
	const skillRoot = path.join(getSkillsRoot(), skillName);
	const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
	const segments = normalized.split("/").filter((s) => s.length > 0);
	if (segments.length < 2) {
		throw new PathConfinementError(
			relativePath,
			skillRoot,
			"support file must live under references/, templates/, or scripts/",
		);
	}
	const head = segments[0];
	if (!SUPPORT_SUBDIRS.has(head)) {
		throw new PathConfinementError(
			relativePath,
			skillRoot,
			`top-level dir "${head}" not allowed; expected references/, templates/, or scripts/`,
		);
	}
	const subdir = head as "references" | "templates" | "scripts";
	const candidate = path.join(skillRoot, ...segments);
	const absolute = confinePathTo(skillRoot, candidate);
	return { skillName, subdir, relative: segments.join("/"), absolute };
}

export function resolveSkillFile(skillName: string): string {
	validateSkillName(skillName);
	const skillRoot = path.join(getSkillsRoot(), skillName);
	const candidate = path.join(skillRoot, "SKILL.md");
	return confinePathTo(getSkillsRoot(), candidate);
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export function validateSkillName(name: string): void {
	if (!SKILL_NAME_RE.test(name)) {
		throw new PathConfinementError(
			name,
			getSkillsRoot(),
			"skill name must be lowercase a-z0-9 with optional hyphens, 1-64 chars, no leading/trailing/consecutive hyphens",
		);
	}
	if (name.includes("--")) {
		throw new PathConfinementError(name, getSkillsRoot(), "skill name must not contain consecutive hyphens");
	}
}
