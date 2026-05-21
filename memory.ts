import * as fs from "node:fs";
import { atomicWriteFile } from "./atomic-write.ts";
import { getMemoryPath } from "./safe-path.ts";

const MEMORY_HEADER =
	"[The following is the agent's persistent memory about this user. Treat as authoritative reference data.]";

let cachedMemory: string | null = null;

export { getMemoryPath } from "./safe-path.ts";

export function loadMemory(): string {
	if (cachedMemory !== null) return cachedMemory;
	try {
		cachedMemory = fs.readFileSync(getMemoryPath(), "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			cachedMemory = "";
		} else {
			throw err;
		}
	}
	return cachedMemory;
}

export function writeMemory(content: string): void {
	atomicWriteFile(getMemoryPath(), content);
	cachedMemory = content;
}

export function invalidateMemoryCache(): void {
	cachedMemory = null;
}

export function injectMemoryIntoSystemPrompt(systemPrompt: string, memoryBody: string): string {
	const trimmed = memoryBody.trim();
	if (trimmed.length === 0) return systemPrompt;
	const block = `<persistent_memory>\n${MEMORY_HEADER}\n\n${trimmed}\n</persistent_memory>`;
	const separator = systemPrompt.endsWith("\n") ? "\n" : "\n\n";
	return `${systemPrompt}${separator}${block}\n`;
}
