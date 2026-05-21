import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AtomicWriteOptions {
	historyDir?: string;
	historyName?: string;
}

function uniqueSuffix(): string {
	return `${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}`;
}

export function atomicWriteFile(target: string, content: string, options?: AtomicWriteOptions): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });

	if (options?.historyDir) {
		let existing: string | null = null;
		try {
			existing = fs.readFileSync(target, "utf-8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw err;
		}
		if (existing !== null && existing !== content) {
			fs.mkdirSync(options.historyDir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const baseName = options.historyName ?? path.basename(target);
			const historyTarget = path.join(
				options.historyDir,
				`${baseName}.${stamp}.${crypto.randomBytes(3).toString("hex")}`,
			);
			const historyTmp = `${historyTarget}.tmp.${uniqueSuffix()}`;
			fs.writeFileSync(historyTmp, existing, "utf-8");
			fs.renameSync(historyTmp, historyTarget);
		}
	}

	const tmp = `${target}.tmp.${uniqueSuffix()}`;
	fs.writeFileSync(tmp, content, "utf-8");
	fs.renameSync(tmp, target);
}
