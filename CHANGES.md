# pi-reflect — milestone summary

A self-improvement extension for pi. Runs a background reviewer subagent after
each turn or each agent run; the reviewer may edit a freeform persistent memory
file and skills under `~/.pi/skills/` via two dedicated tools.

## Locked decisions (§11)

| Decision | Value |
|---|---|
| Extension name | `pi-reflect` |
| Default mode | `session` (one review per `agent_end`) |
| Memory format | Freeform Markdown (`~/.pi/memory.md`) |
| Memory scope | User-only, no project memory |
| Skill scope | User-only (`~/.pi/skills/`) |
| Settings file | `~/.pi/settings.json`, key `"pi-reflect"` |
| State file | `~/.pi/reflect/state.json` |
| Audit log | `~/.pi/reflect/log.jsonl` |

## Milestone map

### M0 — Skeleton

Extension package and stub at `packages/coding-agent/examples/extensions/pi-reflect/`.
Auto-loaded via `.pi/extensions/pi-reflect.ts` re-export. `/reflect status`
placeholder command. Verified `npm run check` and TUI boot.

### M1 — Memory wiring

- `memory.ts`: freeform Markdown memory with module-level cache.
- `before_agent_start` hook injects `<persistent_memory>` block into the
  system prompt.
- `/memory` opens the file in `ctx.ui.editor()`; `/memory show` renders via a
  custom `reflect.memory.show` renderer.
- Memory file lives at `~/.pi/memory.md`.

### M2 — Tools layer

- `safe-path.ts`: `confinePathTo`, `resolveSkillFile`, `resolveSkillSupportPath`,
  `validateSkillName`. Real-path canonicalization rejects symlink-escape,
  parent-traversal, absolute-out, null-byte, and non-allowlisted subdirs
  (`references/`, `templates/`, `scripts/` only).
- `protected.ts`: skill is protected if frontmatter has `protected: true`,
  a sibling `.protected` sentinel exists, or the name appears in
  `settings.protectedSkills`. Inline frontmatter parser — no `yaml` dep.
- `atomic-write.ts`: tmp + rename with `crypto.randomBytes` suffixes for
  collision safety; optional `.history/<file>.<ISO>.<rand>` snapshot on
  overwrite.
- `tools/memory.ts`: `memory` tool with `add | replace | remove`.
- `tools/skill-manage.ts`: `skill_manage` tool with `list | view | write |
  write_file`. Validates SKILL.md frontmatter (name + description required).
  Protected skills cannot be written. Factory pattern `createSkillManageTool
  (getConfig)` so the protected list can change at runtime.

### M3 — Reviewer subagent

- `prompts.ts`: three review templates (`memoryReviewPrompt`,
  `skillReviewPrompt`, `combinedReviewPrompt`) with strict "be conservative,
  persist only durable insights" guard rails.
- `summarize.ts`: dedupes successful tool results by `toolCallId` and emits
  a one-line summary such as `Memory updated · Skill "foo" patched`.
- `background-review.ts`: `runBackgroundReview(pi, ctx, protectedConfig,
  options?)`:
  - Snapshots the parent agent's model, system prompt, and transcript from
    `ctx.sessionManager.getBranch()` (deep-cloned via `structuredClone`).
  - Resolves API key via `ctx.modelRegistry.getApiKeyAndHeaders(model)`.
  - Wraps `memoryTool` + `createSkillManageTool` into raw `AgentTool` via a
    local `toAgentTool` adapter (mirrors `wrapToolDefinition`, no deep
    import).
  - Runs `agentLoop()` from `@earendil-works/pi-agent-core` with
    `convertToLlm`, 60 s timeout via `AbortController`, 16-turn cap via
    `shouldStopAfterTurn`.
  - Returns `{ summary, edits, truncated, errorMessage, skipped }`.
- Accepts an injected `streamFn` for testability; otherwise uses the
  provider default.

### M4 — Counters, state, commands

- `state.ts`: `ReflectState` v1 schema (`turns`, `reviews`, `reviewsSkipped`,
  `edits: {memory, skills}`, `errors`, `lastRun`). Module-level cache;
  atomic JSON write.
- `index.ts` wiring: `recordTurn()` on every `turn_end`, `recordRun()` after
  each `runBackgroundReview` (including skipped / errored runs).
- `/reflect status` renders `formatStatus(state)` via a custom
  `reflect.status.show` renderer.
- `/reflect now` synchronously fires a review, awaits the summary, surfaces
  it via `ctx.ui.notify`.

### M5 — Modes, audit, settings

- `settings.ts`: reads `~/.pi/settings.json`, key `"pi-reflect"`. Validates
  `mode ∈ {off, session, turn}`. Parses `protectedSkills: string[]`.
  Defaults `mode = "session"`, `protectedSkills = []`. Tolerant of missing
  file, bad JSON, missing section, unknown mode. `overrideMode(mode)` for
  session-only changes.
- `audit.ts`: `appendAudit(run, mode, trigger)` writes one JSONL line per
  review attempt (success, skip, or error) to `~/.pi/reflect/log.jsonl`.
- `index.ts`:
  - `turn_end` review fires only when `mode === "turn"`.
  - `agent_end` review fires only when `mode === "session"` (default).
  - `protectedConfig.protectedSkills` is refreshed from `settings.json` on
    every `session_start`.
  - `/reflect mode` views and sets the session-scoped mode.
  - `/reflect status` adds `mode:` and `protected skills:` lines.

### M6 — Prompt-cache parity & atomic-write safety

- `injectMemoryIntoSystemPrompt` simplified: always **appends** the memory
  block at the end of the system prompt. The static prefix (pi's stock
  prompt + project context + skills section + date) stays byte-identical
  run-to-run, preserving Anthropic-style prompt cache for everything
  upstream of the memory block. Changing memory.md only invalidates the
  tail.
- `atomicWriteFile` tmp/history filenames now include
  `crypto.randomBytes` suffixes — sub-millisecond concurrent writes no
  longer collide.

### M8 — Cross-process concurrency safety

- New `file-lock.ts`: `withFileLockSync(target, fn)` — O_EXCL lockfile
  primitive, no new deps. Stale-lock detection via mtime + pid liveness
  check; sync API uses `Atomics.wait` on a `SharedArrayBuffer` so the
  thread blocks cleanly during the (rare) contention window.
- All read-modify-write paths on shared files now hold a lock for the
  critical section, with in-process caches invalidated **inside** the
  lock so a stale cache can't clobber another session's write:
  - `memory.ts`: new `withMemoryLock(fn)`; `tools/memory.ts` wraps its
    load→mutate→write under it. The `/memory` slash command uses
    optimistic concurrency — if the file changed on disk while the
    editor was open, the save is refused and the user is notified
    instead of silently clobbering.
  - `state.ts`: new `withStateLock(fn)`; `recordTurn` / `recordRun` use it.
  - `tools/vault-daily.ts` and `tools/vault-source.ts`: RMW wrapped.
  - `tools/pi-journal.ts` and `audit.ts`: JSONL appends wrapped
    (defense in depth — entries can exceed PIPE_BUF, beyond which
    `appendFileSync` atomicity is not guaranteed by POSIX).
- Fixes the lost-update race documented in the 2026-05-28 concurrency
  audit: two pi sessions both editing memory.md (or vault Daily, or
  state.json) would previously have one session silently clobber the
  other on its next write due to per-process `cachedMemory` +
  system-prompt injection at session start. Caches are still loaded at
  session start as before; the lock ensures the *write* path can't
  produce a lost update.
- Release is **token-verified**: each lock acquisition writes a random
  16-hex-char token into the lockfile body; on release we only `unlink`
  if the file still carries our token. Closes the otherwise-theoretical
  race where (a) `writeSync` of the body fails, (b) the lock is held
  past the stale-steal threshold (30 s), (c) another process steals and
  writes a fresh lock, and (d) our `finally` runs and would have
  silently unlinked the new owner's lockfile.
- Reader-drift residual: long-running pi sessions still observe memory
  as of their last `session_start`, even if a sibling session updates
  memory.md mid-life. The lock prevents *lost writes*; making readers
  strongly consistent across sessions would defeat the cache that
  keeps the system prompt stable for Anthropic prompt-cache hits.

### M7 — End-to-end acceptance

Six scenarios covered by an offline acceptance harness driving
`runBackgroundReview` with a stubbed `streamFn`:

| Scenario | Assertion |
|---|---|
| A — no-op review | summary null, no disk side effects |
| B — memory edit | `memory.md` written, state.json + log.jsonl incremented |
| C — skill write | `~/.pi/skills/foo-recipe/SKILL.md` created with valid frontmatter |
| D — protected skill | write rejected, on-disk content untouched |
| E — no model | structured `skipped: "no_model"`, no errorMessage |
| F — empty transcript | structured `skipped: "no_messages"` |

## File layout

```
packages/coding-agent/examples/extensions/pi-reflect/
├── atomic-write.ts        # tmp + rename + .history snapshot
├── audit.ts               # JSONL audit log
├── background-review.ts   # agentLoop driver + tool adapter
├── index.ts               # extension entry: tools, hooks, commands
├── memory.ts              # ~/.pi/memory.md cache and injection
├── package.json
├── prompts.ts             # reviewer prompt templates
├── protected.ts           # protected-skill detection
├── safe-path.ts           # path confinement helpers
├── settings.ts            # ~/.pi/settings.json reader
├── state.ts               # ~/.pi/reflect/state.json
├── summarize.ts           # one-line edit summary
└── tools/
    ├── memory.ts          # memory tool (add/replace/remove)
    └── skill-manage.ts    # skill_manage tool (list/view/write/write_file)
```

## Commands

| Command | Behavior |
|---|---|
| `/memory` | Open `~/.pi/memory.md` in the editor (interactive only) |
| `/memory show` | Render memory contents inline |
| `/reflect status` | Show counters, last-run details, mode, protected skills |
| `/reflect now` | Synchronously fire a review and surface the result |
| `/reflect mode [off|session|turn]` | View or override the active mode (session-scoped) |

## Tools (registered with `pi.registerTool`)

| Name | Actions |
|---|---|
| `memory` | `add`, `replace`, `remove` |
| `skill_manage` | `list`, `view`, `write`, `write_file` |

## Verified

- `npm run check` clean (601 files).
- 25 end-to-end acceptance assertions pass.
- M2-M6 spot-check suites pass with no regressions.
- Live in pi (no API key): extension loads, tools register, `/reflect
  status` and `/reflect mode` work, no extension errors.
