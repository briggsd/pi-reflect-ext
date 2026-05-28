# pi-reflect

A self-improvement extension for [pi](https://pi.dev). After each turn or
each agent run, pi-reflect spawns a background reviewer that decides whether
the conversation produced a durable insight worth persisting — a user
preference, a recurring fact, or a reusable recipe — and writes it to a
freeform memory file or a skill.

The next time you (or pi) start a new session, that knowledge is already in
the system prompt. Pi gets a little better at working with you every time
you use it.

## What it does

Two surfaces, both at user scope:

- **`~/.pi/memory.md`** — a freeform Markdown file. Treated as authoritative
  reference data and injected into the system prompt of every agent run.
  Good for facts about you: preferences, conventions, tool choices.
- **`~/.pi/skills/<name>/SKILL.md`** — proper skill files that pi can invoke
  on demand. Good for reusable recipes the agent worked out from scratch.

After every turn (or every agent run, depending on mode), pi-reflect
silently runs an LLM reviewer with the same model you're using as the main
agent. The reviewer sees the just-completed transcript plus your current
memory and skill list, and may call either `memory` or `skill_manage` to
record what it learned. If it has nothing to record, it stays silent.

When the reviewer does make an edit, you get a single notification line:

```
pi-reflect: Memory updated
pi-reflect: Skill "foo-recipe" patched
pi-reflect: Memory updated · Skill "bar" patched
```

## Install

pi-reflect is a global extension. Symlink the extension **directory** (not
just `index.ts`) into pi's user extension directory:

```bash
git clone https://github.com/briggsd/pi-reflect-ext.git ~/path/to/pi-reflect-ext
mkdir -p ~/.pi/agent/extensions
ln -s ~/path/to/pi-reflect-ext ~/.pi/agent/extensions/pi-reflect
```

Pi reads `package.json` from the linked directory, finds the `pi.extensions`
entry, and loads `index.ts`. Relative imports between the extension's own
files (e.g., `./audit.ts`) resolve correctly because pi treats the linked
directory as the extension's package root. A single-file symlink to
`index.ts` will *not* work — relative imports break.

Pi will auto-discover the extension on every session, in every project.

To uninstall, just remove the symlink:

```bash
rm ~/.pi/agent/extensions/pi-reflect
```

Optionally `npm install` inside the repo to get full IDE intellisense
against pi's published packages. Pi itself doesn't need this — it bundles
its own runtime — but editors do.

## Quick start

After install, launch pi from anywhere:

```
/login                            # connect your provider if you haven't
/reflect status                   # confirm pi-reflect loaded
/reflect mode turn                # optional: per-turn review for faster feedback
```

Type a message that contains a stable preference about how you work:

```
I prefer 2-space indentation and double quotes in TypeScript.
```

A few seconds after the agent's response, watch for:

```
pi-reflect: Memory updated
```

Confirm with `/memory show` or `cat ~/.pi/memory.md`.

## Modes

Set in `~/.pi/settings.json` or via `/reflect mode <value>` (session-only
override):

| Mode | When the reviewer fires |
|---|---|
| `off` | Never. |
| `session` | After every `agent_end` — once per message. **Default.** |
| `batch` | Every `batchSize` agent runs (default 5). Lower cost, more signal before each review. |

## Commands

| Command | What it does |
|---|---|
| `/memory` | Open `~/.pi/memory.md` in pi's editor (interactive mode only). |
| `/memory show` | Render memory contents inline. |
| `/reflect status` | Show counters, last run, mode, and protected skills. |
| `/reflect now` | Synchronously fire a review and surface the result. |
| `/reflect mode [off\|session\|batch]` | View or set the mode for this session. |

## Tools the reviewer can call

These are also registered with pi globally — you (or the main agent) can
call them directly if you want.

### `memory`

Edit `~/.pi/memory.md`.

| Action | Required args | Effect |
|---|---|---|
| `add` | `content` | Append the block at the end (auto-newlines). |
| `replace` | `content`, `match?` | Swap `match` for `content`. Omit `match` to replace the whole file. |
| `remove` | `match` | Delete the matching substring. |

### `skill_manage`

Manage skills under `~/.pi/skills/`.

| Action | Required args | Effect |
|---|---|---|
| `list` | — | Enumerate skills. Protected ones are marked with `*`. |
| `view` | `name` | Read `~/.pi/skills/<name>/SKILL.md`. |
| `write` | `name`, `content` | Create or replace `SKILL.md`. Frontmatter must include `name` and `description`. |
| `write_file` | `name`, `file_path`, `content` | Write a support file. `file_path` must live under `references/`, `templates/`, or `scripts/`. |

Protected skills cannot be overwritten. See "Protecting skills" below.

## Settings

`~/.pi/settings.json`:

```json
{
  "pi-reflect": {
    "mode": "session",
    "turnInterval": 5,
    "protectedSkills": ["create-skill", "review"]
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"off"` \| `"session"` \| `"turn"` | `"session"` | Reviewer trigger. |
| `batchSize` | `number` | `5` | In `batch` mode, how many agent runs to accumulate before firing a review. Must be a positive integer. |
| `protectedSkills` | `string[]` | `[]` | Skill names the reviewer (and any agent) cannot overwrite. |

Settings are read at every `session_start`. Edit the file and restart pi to
pick up changes — except for `mode`, which you can also flip live via
`/reflect mode`.

### Protecting skills

A skill is considered protected if any of these is true:

1. Its SKILL.md frontmatter has `protected: true`.
2. A sibling file `~/.pi/skills/<name>/.protected` exists.
3. Its name appears in `settings.protectedSkills`.

Protection is enforced inside `skill_manage` itself — both reviewer-driven
and user-driven `write`/`write_file` calls against a protected skill are
rejected with an error tool result.

## Files pi-reflect creates

```
~/.pi/
├── memory.md                       # freeform user memory (M1)
├── skills/<name>/SKILL.md          # any skills the reviewer creates (M2)
├── skills/<name>/.history/         # prior versions, snapshotted on overwrite
└── reflect/
    ├── state.json                  # counters, last run, edits
    └── log.jsonl                   # append-only audit log
```

### `state.json`

Cumulative counters across the lifetime of pi-reflect on this machine.
Rendered by `/reflect status`.

```json
{
  "version": 1,
  "turns": 42,
  "reviews": 21,
  "reviewsSkipped": { "no_model": 0, "no_api_key": 0, ... },
  "edits": { "memory": 3, "skills": 1 },
  "errors": 0,
  "lastRun": { "ts": "...", "summary": "Memory updated", ... }
}
```

### `log.jsonl`

One JSON object per review attempt, including skipped and errored runs.
Useful for understanding why something did or didn't happen:

```bash
# Show every run that produced an edit:
jq -r 'select(.summary != null) | "\(.ts) \(.trigger) \(.summary)"' ~/.pi/reflect/log.jsonl

# Show every skipped run with reason:
jq -r 'select(.skipped != null) | "\(.ts) \(.skipped)"' ~/.pi/reflect/log.jsonl
```

Fields:

- `ts` — ISO timestamp of when the run ended.
- `mode` — `"off"` \| `"session"` \| `"turn"`.
- `trigger` — `"turn_end"` \| `"agent_end"` \| `"manual"` \| `"session"`.
- `durationMs` — wall time of the reviewer call.
- `summary` — string or `null`. See [What it does](#what-it-does).
- `memoryEdits`, `skillEdits` — counts of successful tool calls in this run.
- `truncated` — `true` if the reviewer hit the 16-turn cap or 60s timeout.
- `skipped` — `"no_model"` \| `"no_api_key"` \| `"no_messages"` \|
  `"in_flight"` \| `"aborted"` if the run never ran.
- `errorMessage` — populated if the run crashed.

## How reviews work under the hood

1. After `turn_end` (or `agent_end`, depending on mode), pi-reflect snapshots:
   - The parent agent's resolved model and API key.
   - The current system prompt.
   - The full transcript from `sessionManager.getBranch()`, deep-cloned.
2. It builds a single-shot prompt embedding the transcript, your current
   memory, and the skill list.
3. It calls `agentLoop()` from `@earendil-works/pi-agent-core` with only
   the `memory` and `skill_manage` tools available, a 60-second timeout,
   and a 16-turn cap.
4. Any successful `memory` or `skill_manage` tool result is collected,
   deduped by `toolCallId`, and summarized as a one-liner.
5. The summary is reported via `ctx.ui.notify`, the run is recorded in
   `state.json`, and an audit entry is appended to `log.jsonl`.

The reviewer is run concurrently with — but doesn't block — your next
prompt. If a previous review is still in flight when a new turn ends, the
new turn's review is skipped with `skipped: "in_flight"`.

## Prompt-cache friendliness

Memory is appended at the **end** of the system prompt. This is intentional:
Anthropic-style prompt caches key on the prefix bytes, so keeping the
upstream portion of the prompt byte-identical run-to-run means changing
memory only invalidates the small suffix. Static skills and date markers
upstream of memory stay cached.

## Limitations and caveats

- **User scope only.** Memory and skills both live under `~/.pi/`. No
  per-project memory. (Decision locked in §11.)
- **No undo command yet.** If the reviewer makes an edit you don't like:
  - Memory: just edit `~/.pi/memory.md` (or use `/memory`) and remove the
    line.
  - Skills: `~/.pi/skills/<name>/.history/SKILL.md.<timestamp>.<rand>`
    contains the prior version. Copy it back over `SKILL.md`.
- **Costs add up.** Each review is a real LLM call against your provider.
  `session` mode is one extra call per agent run. `turn` mode is one per
  turn. Watch `/reflect status` for `reviews fired`.
- **The reviewer is intentionally conservative.** Most turns should produce
  no edit. If you want it more aggressive, edit the prompt in `prompts.ts`.
- **`log.jsonl` grows forever.** Manually rotate when you care:
  `mv ~/.pi/reflect/log.jsonl ~/.pi/reflect/log.jsonl.$(date +%Y%m).bak`.

## Disabling

Two options:

- Temporary: `/reflect mode off` for this session.
- Permanent: set `"mode": "off"` in `~/.pi/settings.json`, or remove the
  re-export at `.pi/extensions/pi-reflect.ts`.

## File layout

See [CHANGES.md](./CHANGES.md) for the milestone-by-milestone implementation
narrative and the full file map.

## License

Same as the parent pi repo.
