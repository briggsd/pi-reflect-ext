import * as fs from "node:fs";
import * as path from "node:path";
import { getReflectHome } from "./safe-path.ts";

export type ReflectMode = "off" | "session" | "turn";

const MODES: ReadonlyArray<ReflectMode> = ["off", "session", "turn"];

export function isReflectMode(value: unknown): value is ReflectMode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export interface ReflectSettings {
	mode: ReflectMode;
	protectedSkills: string[];
	turnInterval: number;
}

const DEFAULT_SETTINGS: ReflectSettings = {
	mode: "session",
	protectedSkills: [],
	turnInterval: 5,
};

function settingsPath(): string {
	return path.join(getReflectHome(), "settings.json");
}

interface SettingsFileShape {
	"pi-reflect"?: {
		mode?: unknown;
		protectedSkills?: unknown;
		turnInterval?: unknown;
	};
}

function parseTurnInterval(value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	return DEFAULT_SETTINGS.turnInterval;
}

function parseProtectedSkills(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.length > 0) out.push(item);
	}
	return out;
}

let cache: ReflectSettings | null = null;

export function loadSettings(): ReflectSettings {
	if (cache) return cache;
	const target = settingsPath();
	try {
		const raw = fs.readFileSync(target, "utf-8");
		const parsed = JSON.parse(raw) as SettingsFileShape;
		const section = parsed["pi-reflect"];
		if (!section || typeof section !== "object") {
			cache = { ...DEFAULT_SETTINGS };
			return cache;
		}
		const mode = isReflectMode(section.mode) ? section.mode : DEFAULT_SETTINGS.mode;
		const protectedSkills = parseProtectedSkills(section.protectedSkills);
		const turnInterval = parseTurnInterval(section.turnInterval);
		cache = { mode, protectedSkills, turnInterval };
		return cache;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			cache = { ...DEFAULT_SETTINGS };
			return cache;
		}
		cache = { ...DEFAULT_SETTINGS };
		return cache;
	}
}

export function invalidateSettingsCache(): void {
	cache = null;
}

export function overrideMode(mode: ReflectMode): ReflectSettings {
	const current = loadSettings();
	cache = { ...current, mode };
	return cache;
}
