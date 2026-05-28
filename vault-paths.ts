import * as os from "node:os";
import * as path from "node:path";
import { loadSettings } from "./settings.ts";

export function getVaultRoot(): string {
	const { vaultPath } = loadSettings();
	if (!vaultPath) return path.join(os.homedir(), "vault");
	if (vaultPath.startsWith("~/")) return path.join(os.homedir(), vaultPath.slice(2));
	if (vaultPath === "~") return os.homedir();
	return vaultPath;
}

export function getVaultPendingDir(): string {
	return path.join(getVaultRoot(), "_pending");
}

export function getVaultDailyDir(): string {
	return path.join(getVaultRoot(), "Daily");
}

export function getVaultSourcesFile(): string {
	return path.join(getVaultRoot(), "Intelligence", "sources-to-capture.md");
}
