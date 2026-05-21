import * as fs from "node:fs";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadMemory } from "./memory.ts";
import { combinedReviewPrompt, type SkillSummary } from "./prompts.ts";
import { isSkillProtected, type ProtectedSkillsConfig } from "./protected.ts";
import { getSkillsRoot, resolveSkillFile } from "./safe-path.ts";
import { type EditRecord, summarizeEdits } from "./summarize.ts";
import { memoryTool } from "./tools/memory.ts";
import { createSkillManageTool } from "./tools/skill-manage.ts";

const REVIEW_TIMEOUT_MS = 60_000;
const MAX_TURNS = 16;
const TRANSCRIPT_TAIL_BYTES = 24_000;

export interface BackgroundReviewResult {
	summary: string | null;
	edits: EditRecord[];
	skipped?: "no_model" | "no_api_key" | "no_messages" | "aborted";
	truncated: boolean;
	errorMessage?: string;
}

export interface RunBackgroundReviewOptions {
	streamFn?: StreamFn;
}

export async function runBackgroundReview(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	protectedConfig: ProtectedSkillsConfig,
	options?: RunBackgroundReviewOptions,
): Promise<BackgroundReviewResult> {
	const empty: BackgroundReviewResult = { summary: null, edits: [], truncated: false };

	const model = ctx.model;
	if (!model) return { ...empty, skipped: "no_model" };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ...empty, skipped: "no_api_key", errorMessage: auth.error };
	if (!auth.apiKey) return { ...empty, skipped: "no_api_key" };
	const apiKey = auth.apiKey;

	const messagesSnapshot = captureMessages(ctx);
	if (messagesSnapshot.length === 0) return { ...empty, skipped: "no_messages" };

	const transcript = renderTranscript(messagesSnapshot);
	const memoryText = safeLoadMemory();
	const skills = listSkillSummaries(protectedConfig);
	const promptText = combinedReviewPrompt({ memory: memoryText, skills, transcript });

	const systemPrompt = ctx.getSystemPrompt();
	const tools: AgentTool[] = [
		toAgentTool(memoryTool, ctx),
		toAgentTool(
			createSkillManageTool(() => protectedConfig),
			ctx,
		),
	];

	const reviewContext: AgentContext = {
		systemPrompt,
		messages: [],
		tools,
	};

	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), REVIEW_TIMEOUT_MS);

	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		convertToLlm: (msgs: AgentMessage[]): Message[] => convertToLlm(msgs),
		shouldStopAfterTurn: async ({ message }) => {
			turnCount++;
			if (turnCount >= MAX_TURNS) return true;
			if (message.role !== "assistant") return true;
			const hasToolCall = message.content.some((c) => c.type === "toolCall");
			return !hasToolCall;
		},
	};

	const userPrompt: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: promptText }],
		timestamp: Date.now(),
	};

	const edits: EditRecord[] = [];
	let truncated = false;
	let errorMessage: string | undefined;

	try {
		const stream = agentLoop([userPrompt], reviewContext, config, abortController.signal, options?.streamFn);
		for await (const event of stream as AsyncIterable<AgentEvent>) {
			if (event.type === "tool_execution_end" && !event.isError) {
				if (event.toolName === "memory" || event.toolName === "skill_manage") {
					edits.push({
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						details: event.result?.details,
					});
				}
			}
		}
	} catch (err) {
		errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(timeout);
	}

	if (abortController.signal.aborted) {
		truncated = true;
	}
	if (turnCount >= MAX_TURNS) {
		truncated = true;
	}

	return {
		summary: summarizeEdits(edits),
		edits,
		truncated,
		errorMessage,
	};
}

function captureMessages(ctx: ExtensionContext): AgentMessage[] {
	const branch = ctx.sessionManager.getBranch();
	const out: AgentMessage[] = [];
	for (const entry of branch) {
		if (entry.type === "message") {
			out.push(structuredClone(entry.message));
		}
	}
	return out;
}

function renderTranscript(messages: AgentMessage[]): string {
	const llmMessages = convertToLlm(messages);
	const lines: string[] = [];
	for (const m of llmMessages) {
		lines.push(formatMessage(m));
	}
	const joined = lines.join("\n\n");
	if (joined.length <= TRANSCRIPT_TAIL_BYTES) return joined;
	const tail = joined.slice(joined.length - TRANSCRIPT_TAIL_BYTES);
	return `[...transcript truncated; showing tail ${TRANSCRIPT_TAIL_BYTES} bytes...]\n${tail}`;
}

function formatMessage(m: Message): string {
	switch (m.role) {
		case "user": {
			const text = typeof m.content === "string" ? m.content : extractText(m.content);
			return `[user]\n${text}`;
		}
		case "assistant": {
			const parts: string[] = [];
			for (const block of m.content) {
				if (block.type === "text") parts.push(block.text);
				else if (block.type === "toolCall") {
					parts.push(
						`<tool_call name="${block.name}" id="${block.id}">${safeStringify(block.arguments)}</tool_call>`,
					);
				}
			}
			return `[assistant]\n${parts.join("\n")}`;
		}
		case "toolResult": {
			const text = extractText(m.content);
			return `[tool_result name="${m.toolName}"${m.isError ? " error=true" : ""}]\n${text}`;
		}
	}
}

function extractText(content: { type: string; text?: string }[]): string {
	return content
		.map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
		.filter((s) => s.length > 0)
		.join("\n");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function safeLoadMemory(): string {
	try {
		return loadMemory();
	} catch {
		return "";
	}
}

function listSkillSummaries(config: ProtectedSkillsConfig): SkillSummary[] {
	const root = getSkillsRoot();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		return [];
	}
	const out: SkillSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (entry.name.startsWith(".")) continue;
		const name = entry.name;
		let file: string;
		try {
			file = resolveSkillFile(name);
		} catch {
			continue;
		}
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		out.push({
			name,
			description: extractDescription(raw),
			protected: isSkillProtected(name, config),
		});
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
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

function toAgentTool<TParams, TDetails>(
	definition: ToolDefinition<TParams extends import("typebox").TSchema ? TParams : never, TDetails>,
	ctx: ExtensionContext,
): AgentTool<TParams extends import("typebox").TSchema ? TParams : never, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) => definition.execute(toolCallId, params, signal, onUpdate, ctx),
	};
}
