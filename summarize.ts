export interface EditRecord {
	toolCallId: string;
	toolName: string;
	details: unknown;
}

interface SkillManageDetails {
	action?: string;
	skill?: string;
}

function isSkillManageDetails(value: unknown): value is SkillManageDetails {
	return typeof value === "object" && value !== null;
}

export function summarizeEdits(edits: EditRecord[]): string | null {
	const seen = new Set<string>();
	const parts: string[] = [];
	let memoryReported = false;

	for (const edit of edits) {
		if (seen.has(edit.toolCallId)) continue;
		seen.add(edit.toolCallId);

		if (edit.toolName === "memory") {
			if (!memoryReported) {
				parts.push("Memory updated");
				memoryReported = true;
			}
			continue;
		}

		if (edit.toolName === "skill_manage" && isSkillManageDetails(edit.details)) {
			const action = edit.details.action;
			const skill = edit.details.skill;
			if ((action === "write" || action === "write_file") && typeof skill === "string" && skill.length > 0) {
				parts.push(`Skill "${skill}" patched`);
			}
		}
	}

	if (parts.length === 0) return null;
	return parts.join(" · ");
}
