import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadMemory, withMemoryLock, writeMemory } from "../memory.ts";

const MemoryToolParams = Type.Object({
	action: StringEnum(["add", "replace", "remove"] as const, {
		description:
			"add appends a block; replace swaps `match` for `content` (full-file replace if no match); remove deletes `match`",
	}),
	content: Type.Optional(
		Type.String({ description: "Replacement or appended content. Required for add and replace." }),
	),
	match: Type.Optional(
		Type.String({
			description: "Exact substring to locate. Required for remove. Optional for replace (full-file when omitted).",
		}),
	),
});

function applyAdd(current: string, content: string): string {
	if (current.length === 0) return content.endsWith("\n") ? content : `${content}\n`;
	const sep = current.endsWith("\n") ? "" : "\n";
	const trailing = content.endsWith("\n") ? "" : "\n";
	return `${current}${sep}${content}${trailing}`;
}

function applyReplace(current: string, match: string | undefined, content: string): string {
	if (match === undefined) return content;
	const idx = current.indexOf(match);
	if (idx < 0) throw new Error(`match not found in memory.md`);
	return current.slice(0, idx) + content + current.slice(idx + match.length);
}

function applyRemove(current: string, match: string): string {
	const idx = current.indexOf(match);
	if (idx < 0) throw new Error(`match not found in memory.md`);
	return current.slice(0, idx) + current.slice(idx + match.length);
}

export interface MemoryToolDetails {
	action: "add" | "replace" | "remove";
	bytesBefore: number;
	bytesAfter: number;
}

export const memoryTool = defineTool({
	name: "memory",
	label: "Memory",
	description:
		"Edit the agent's persistent user memory at ~/.pi/memory.md. Use to record durable facts about the user, their preferences, and recurring conventions. Do not record transient task narratives.",
	parameters: MemoryToolParams,
	async execute(_toolCallId, params) {
		return withMemoryLock(() => {
		const current = loadMemory();
		let next: string;
		switch (params.action) {
			case "add": {
				if (params.content === undefined || params.content.length === 0) {
					return {
						content: [{ type: "text", text: "memory: add requires non-empty content" }],
						details: { action: params.action, bytesBefore: current.length, bytesAfter: current.length },
						isError: true,
					};
				}
				next = applyAdd(current, params.content);
				break;
			}
			case "replace": {
				if (params.content === undefined) {
					return {
						content: [{ type: "text", text: "memory: replace requires content" }],
						details: { action: params.action, bytesBefore: current.length, bytesAfter: current.length },
						isError: true,
					};
				}
				try {
					next = applyReplace(current, params.match, params.content);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `memory: ${message}` }],
						details: { action: params.action, bytesBefore: current.length, bytesAfter: current.length },
						isError: true,
					};
				}
				break;
			}
			case "remove": {
				if (params.match === undefined || params.match.length === 0) {
					return {
						content: [{ type: "text", text: "memory: remove requires match" }],
						details: { action: params.action, bytesBefore: current.length, bytesAfter: current.length },
						isError: true,
					};
				}
				try {
					next = applyRemove(current, params.match);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `memory: ${message}` }],
						details: { action: params.action, bytesBefore: current.length, bytesAfter: current.length },
						isError: true,
					};
				}
				break;
			}
		}

		writeMemory(next);
		const details: MemoryToolDetails = {
			action: params.action,
			bytesBefore: current.length,
			bytesAfter: next.length,
		};
		return {
			content: [{ type: "text", text: `memory: ${params.action} ok (${current.length} -> ${next.length} bytes)` }],
			details,
		};
		});
	},
});
