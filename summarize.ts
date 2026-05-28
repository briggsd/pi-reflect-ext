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

interface PiJournalDetails {
	ts?: string;
	file?: string;
	created?: boolean;
}

function isPiJournalDetails(value: unknown): value is PiJournalDetails {
	return typeof value === "object" && value !== null;
}

interface VaultDailyDetails {
	date?: string;
	created?: boolean;
}

interface VaultPendingDetails {
	action?: string;
	type?: string;
	filename?: string;
}

interface VaultSourceDetails {
	entry?: string;
}

function isVaultDailyDetails(value: unknown): value is VaultDailyDetails {
	return typeof value === "object" && value !== null;
}

function isVaultPendingDetails(value: unknown): value is VaultPendingDetails {
	return typeof value === "object" && value !== null;
}

function isVaultSourceDetails(value: unknown): value is VaultSourceDetails {
	return typeof value === "object" && value !== null;
}

export function summarizeEdits(edits: EditRecord[]): string | null {
	const seen = new Set<string>();
	const parts: string[] = [];
	let memoryReported = false;
	let journalReported = false;
	let dailyReported = false;
	let pendingCount = 0;
	let sourceCount = 0;

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
			continue;
		}

		if (edit.toolName === "pi_journal" && isPiJournalDetails(edit.details)) {
			if (!journalReported) {
				parts.push("Session logged");
				journalReported = true;
			}
			continue;
		}

		if (edit.toolName === "vault_daily" && isVaultDailyDetails(edit.details)) {
			if (!dailyReported) {
				const suffix = edit.details.created ? " (created)" : "";
				parts.push(`Daily note updated${suffix}`);
				dailyReported = true;
			}
			continue;
		}

		if (edit.toolName === "vault_pending" && isVaultPendingDetails(edit.details)) {
			if (edit.details.action === "propose") {
				pendingCount++;
			}
			continue;
		}

		if (edit.toolName === "vault_source" && isVaultSourceDetails(edit.details)) {
			sourceCount++;
			continue;
		}
	}

	if (pendingCount > 0) {
		parts.push(`${pendingCount} vault ${pendingCount === 1 ? "item" : "items"} proposed`);
	}
	if (sourceCount > 0) {
		parts.push(`${sourceCount} ${sourceCount === 1 ? "source" : "sources"} queued`);
	}

	if (parts.length === 0) return null;
	return parts.join(" · ");
}
