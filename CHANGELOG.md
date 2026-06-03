# Changelog

All notable changes to `pi-reflect` are documented here. Patch entries are
small bugfixes; minor entries change behavior in user-visible ways.

## [0.1.1] — 2026-06-02

### Fixed

- **`vault_daily` and `vault_pending` now date files in the host's local
  timezone, not UTC.** Both tools previously called
  `new Date().toISOString().slice(0, 10)`, which is always UTC. Any session
  run past ~6–7pm local time (depending on DST/offset) would write a
  "tomorrow" file: e.g. a `Daily/2026-06-03.md` file created at 21:54 CDT
  on 2026-06-02. This directly violated the vault root `CLAUDE.md` rule
  *"Do NOT create future-dated Daily files proactively"* and produced
  internally inconsistent session blocks (UTC date in filename, local time
  in `### Session — HH:MM` header). Both tools now use a shared
  `lib/dates.ts#localDateStr()` helper that reads `Date#getFullYear` /
  `getMonth` / `getDate` from the host clock.

  Full ISO timestamps used as cross-machine records (`pi-journal` entries,
  the `proposed:` frontmatter inside pending items) remain UTC. Only
  filenames and other "today by the user's clock" surfaces moved to local.

## [0.1.0]

Initial release.
