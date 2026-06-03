/**
 * Date helpers for pi-reflect tools.
 *
 * The vault-daily and vault-pending tools both date files by "today." That
 * date must come from the host's local timezone — not UTC — because:
 *
 *   1. The vault root `CLAUDE.md` explicitly forbids creating future-dated
 *      Daily files. `new Date().toISOString().slice(0, 10)` is UTC, which
 *      means any session run after ~6–7pm local (depending on DST/offset)
 *      writes "tomorrow's" file by the user's clock.
 *   2. `vault-daily` already uses LOCAL time (`Date#getHours`) for the
 *      session timestamp inside the file. If the date were UTC and the time
 *      were local, a single session header could read `2026-06-03.md` with
 *      a `### Session — 21:54` body, which is internally inconsistent.
 *
 * Always use `localDateStr()` when naming files by "today."
 *
 * Timestamps (full ISO strings used as cross-machine records, e.g. the
 * `proposed:` frontmatter in pending items or the `ts` field in journal
 * records) should remain UTC via `Date#toISOString` — that is the canonical
 * format for unambiguous machine-readable times.
 */

export function localDateStr(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
