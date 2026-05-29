import * as fs from "node:fs";
import { atomicWriteFile } from "./atomic-write.ts";
import { withFileLockSync } from "./file-lock.ts";
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

/**
 * Run an RMW on memory.md under a cross-process file lock with the in-process
 * cache invalidated up front. Use this for any tool that does
 * `loadMemory() -> mutate -> writeMemory()`; calling loadMemory/writeMemory
 * outside this wrapper risks a lost update when another pi session is also
 * editing memory.md.
 *
 * Cache invalidation MUST happen inside the critical section: another process
 * may have rewritten the file between our last load and now, and our cached
 * copy would silently clobber their edit on write.
 */
export function withMemoryLock<T>(fn: () => T): T {
	return withFileLockSync(getMemoryPath(), () => {
		cachedMemory = null;
		return fn();
	});
}

export function injectMemoryIntoSystemPrompt(systemPrompt: string, memoryBody: string): string {
	const trimmed = memoryBody.trim();
	if (trimmed.length === 0) return systemPrompt;
	const block = `<persistent_memory>\n${MEMORY_HEADER}\n\n${trimmed}\n</persistent_memory>`;
	const separator = systemPrompt.endsWith("\n") ? "\n" : "\n\n";
	return `${systemPrompt}${separator}${block}\n`;
}
