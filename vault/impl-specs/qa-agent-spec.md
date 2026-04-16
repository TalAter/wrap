# QA Agent for Wrap

## Goal

Autonomous exploration of `w` use cases in a sandboxed Linux container. Surface novel/creative use cases and bugs. Exploration over regression — bugs are a side benefit.

**Keep v1 dead simple.** Generator + judge are Claude Code skills, not code. Only the runner is code (cheap loop). Run it on the developer's machine. Evolve later if the simple version proves itself.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Claude Code (you, running in this repo)     │
│                                              │
│   /qa-generate  ─────┐                       │
│                      ├──── writes to ─-──┐   │
│   /qa-judge     ─────┘                   │   │
└──────────────────────────────────────────│───┘
                                           ▼
                                      ┌─────────┐
                                      │ qa.db   │  (SQLite)
                                      └────┬────┘
                                           ▲
                                           │
                              ┌────────────┴───────────┐
                              │  runner (TS loop)      │
                              │  reads unrun, executes │
                              │  via docker exec       │
                              └────────────┬───────────┘
                                           │
                                           ▼
                                ┌──────────────────┐
                                │  container       │
                                │  ubuntu + git +  │
                                │  curl + w binary │
                                └──────────────────┘
```

Three roles, run independently when you want:

- **Generator** — `/qa-generate` skill in Claude Code. User invokes it; Claude does the work and writes scenarios to SQLite via Bash.
- **Runner** — `bun run runner.ts`. Picks up unrun scenarios, executes in container, writes results back. Pure code, no LLM.
- **Judge** — `/qa-judge` skill in Claude Code. User invokes it; Claude reads unjudged scenarios from SQLite, writes findings, may insert follow-ups scenarios to SQLite.

## Skills

Skills live in wrap-qa's `.claude/skills/` so they load automatically when you run Claude Code from that repo.

### `/qa-generate`

Skill body (markdown) tells Claude:

1. **Pick a theme.** If user passed a hint in the skill invocation (e.g. `/qa-generate top rust repos`), use it. Otherwise pick from:
   - HN top stories: `https://hacker-news.firebaseio.com/v0/topstories.json` + `/v0/item/{id}.json`
   - GitHub trending: `gh api 'search/repositories?q=created:>{date}+language:{language}&sort=stars&order=desc&per_page=10'`
     Pick a random language per invocation from: `python, rust, go, typescript, ruby, elixir, zig, haskell, lua, swift, kotlin, java, javascript, html, clojure, ocaml, nim, crystal, gleam`. Lean toward obscurer ones — weirder repos = weirder scenarios.
   - Wrap's own `specs/` directory (read for edge cases)
2. Generate ~15 scenario ideas tied to the theme (single-prompt scenarios, things a user might type after `w `).
3. Add 5 more ideas that go beyond the theme — general OS / dev box tasks (cron setup, edit config files, install + use software from man pages, system optimization, weird clipboard tricks, multi-tool pipelines).
4. Self-critique the full pool (~20): rate 1–5 for novelty, drop boring ones, generate 10 weirder replacements. Push for lateral / cross-domain / unexpected combinations.
5. Pick final ~10 scenarios.
6. Insert into `scenarios` table via `sqlite3 db/qa.db`.

### `/qa-judge`

Skill body tells Claude:
1. Query unjudged scenarios (scenarios with a `ran_at` but no corresponding row in `findings`).
2. For each, read scenario + result + `w_log`.
3. Write exactly one finding row for EVERY scenario. Four possible types:
   - `surprising` — cool, novel, or clever use case worth remembering
   - `broken` — `w` failed or did the wrong thing
   - `awkward` — worked, but clunky / fragile / surprising-in-a-bad-way
   - `uninteresting` — nothing worth remembering
4. Judging `uninteresting` is a judgment about the concept + outcome together, not about output verbosity. A scenario with empty stdout can absolutely be `surprising` if the idea itself is clever and worked (e.g., `w find optimization ideas across my system and put them in clipboard with unicorn emoji bullets` — no stdout, but the concept is cool). Conversely, a scenario with lots of output can be `uninteresting` if it's a mundane success.
5. Filter non-uninteresting tightly. When in doubt, mark `uninteresting` — less noise to review, easier dedup later.
6. Tag with category labels + a short semantic fingerprint (see next sub-sections). Skip labels and fingerprint for `uninteresting` findings.
7. Optionally insert follow-up scenarios into `scenarios` (with `parent_id` pointing to the scenario being judged). Cap chain depth at 5 — reject insert if `parent_id` chain length ≥5.

#### Labels — reuse before invent

Before assigning labels, query existing ones:

```sql
SELECT DISTINCT label FROM finding_labels ORDER BY label;
```

Show the full list to the judge. For each new finding:
- If an existing label fits, **reuse it verbatim**.
- Only create a new label if the finding is genuinely a new category.

This prevents proliferation like `test-fail`, `tests-broken`, `testing-failure` all existing in parallel.

#### Fingerprints — canonical form, scoped comparison

Fingerprint format: `[component]:[failure-mode]`. Lower case, hyphens. Examples: `cron:crond-not-installed`, `pdf:font-rendering-wrong`, `clipboard:unicode-mangled`.

Before assigning, query fingerprints from findings of the **same type** (narrows the comparison):

```sql
SELECT DISTINCT fingerprint FROM findings WHERE type = ? AND fingerprint IS NOT NULL;
```

Show that list to the judge. For the new finding:
- If a listed fingerprint matches this issue, **reuse verbatim**.
- If close but materially different, create a new fingerprint following the same template.

Skip fingerprint for `uninteresting` — nothing to dedup.

#### When to insert a follow-up

Each `w` invocation is stateless — the next `w` call has NO memory of what the previous one did or asked. Follow-ups must be fully self-contained prompts. Reference concrete filenames / on-disk state, not "it" or "your previous refactor".

Follow-ups are valuable when the previous run left on-disk artifacts or installed tools that the next prompt can probe, or when pivoting to a related question.

Examples, each probing a different axis:

- (cross-invocation memory) Scenario: `w note: my favorite color is blue. remember this.` → worked.
  Follow-up: `w what's my favorite color?` — does `w`'s memory system persist facts across separate invocations, or does each call start blank?
- (constraint adaptation) Scenario: `w create /etc/motd with a welcome banner quoting Marcus Aurelius` → failed (not root).
  Follow-up: `w make a login banner with a Marcus Aurelius quote that shows when I open a new shell` — does `w` find a userland alternative (~/.zshrc, ~/.profile) after the privileged path was blocked?
- (semantic ambiguity) Scenario: `w set the system timezone to Asia/Tokyo` → worked.
  Follow-up: `w schedule a reminder for 9am every weekday` — does `w` notice the ambiguity (9am Tokyo? 9am original local? 9am UTC?) and ask, or silently pick one?
- (on-disk delta analysis) Scenario: `w snapshot all running processes to /tmp/running.txt` → worked.
  Follow-up: `w snapshot current processes and report what's new or gone vs /tmp/running.txt` — can `w` do a structured diff across two artifacts it or the user created?

Don't insert follow-ups just to be thorough. Skip if the scenario is a dead end, if the follow-up would retest the same thing, or if it's not interesting. **Err on the side of no follow-ups.** Only insert when inspiration for a cool probe popped up.

## Runner (the only real code)

`src/runner.ts`. Bun script. Pure loop, no LLM.

On startup:
1. Cross-compile wrap to Linux: `bun build --compile --target=bun-linux-arm64 src/index.ts --outfile=build/wrap-linux` (run from wrap repo at `WRAP_REPO_PATH`).
2. Capture wrap git SHA: `git -C $WRAP_REPO_PATH rev-parse HEAD` (always main HEAD).
3. Ensure container is up; restart if needed (`docker stop && docker start`). Mount `build/wrap-linux` at `/usr/local/bin/w`.
4. Inject `ANTHROPIC_API_KEY` (the dedicated Wrap runtime key, separate from the key used for claude code) as env var.

Loop:
1. Fetch next unrun scenario (`ran_at IS NULL`) by `id ASC`.
2. `docker exec container w --yolo --verbose "$prompt"` — capture stdout/stderr/exit/duration. 10 min timeout.
3. `docker exec container w --log 1` — capture full JSON log.
4. Canary: `docker exec container echo OK` AND check `/canary.txt` exists. If failed, log container death, restart container, mark scenario, continue.
5. Update scenarios row.
6. Repeat until no unrun scenarios.

Arm64 only (Orbstack on Apple Silicon). x64 deferred until cloud move.

## Container

- Base: `ubuntu:24.04`
- Pre-installed: `git`, `curl` only. Test `w`'s ability to install things on demand.
- No bun (the wrap binary from `bun build --compile` is self-contained).
- `/canary.txt` created at container start.
- Persistent: `docker stop && docker start` between batches, not rebuild. State accumulates intentionally — simulates a real dev box. You decide when to nuke.

### Wrap config inside container

A hardcoded `config.jsonc` lives in the wrap-qa repo and is mounted/copied into the container at wrap's expected config path. This is the single source of truth for how `w` runs in QA:

- Provider + model pinned (no host config bleed-through)
- API key referenced via env var (`ANTHROPIC_API_KEY` injected by runner), not hardcoded in file
- `yolo: true`
- `verbose: true`

Avoids any risk of `w` falling back to host config files via mount leakage.

## Database

```sql
CREATE TABLE scenarios (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL,
  theme TEXT,
  prompt TEXT NOT NULL,
  parent_id INTEGER REFERENCES scenarios,
  stdout TEXT,
  stderr TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  w_log TEXT,
  w_git_sha TEXT,
  canary_ok BOOLEAN,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ran_at TIMESTAMP
);

CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  scenario_id INTEGER UNIQUE REFERENCES scenarios,
  type TEXT NOT NULL,    -- surprising | broken | awkward | uninteresting
  summary TEXT,
  analysis TEXT,
  fingerprint TEXT,
  status TEXT DEFAULT 'new',  -- new | reviewed | duplicate | archived
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE finding_labels (
  finding_id INTEGER REFERENCES findings,
  label TEXT,
  PRIMARY KEY (finding_id, label)
);
```

Review: direct sqlite queries. No UI for v1.

## Repo layout (`wrap-qa`)

```
wrap-qa/
├── README.md          # how to run: open in claude code, /qa-generate, bun run runner.ts, /qa-judge
├── Dockerfile         # ubuntu:24.04 + git + curl + canary
├── config.jsonc       # wrap config for in-container use (provider, model, yolo, verbose, API key via env)
├── .env               # gitignored — ANTHROPIC_API_KEY (for w), QA repo doesn't need its own LLM key (Claude Code uses your session)
├── .gitignore
├── package.json       # just bun:sqlite
├── db/
│   ├── schema.sql
│   └── qa.db          # gitignored
├── src/
│   └── runner.ts
├── .claude/
│   └── skills/
│       ├── qa-generate.md
│       └── qa-judge.md
└── build/
    └── wrap-linux     # cross-compiled, gitignored
```

## Configuration

`.env` (gitignored):
```
ANTHROPIC_API_KEY=sk-...        # used BY w INSIDE the container — separate dedicated key
WRAP_REPO_PATH=/Users/tal/mysite/wrap
```

Claude Code (running on host) uses your normal session — no extra key needed for generator/judge skills.

## Prerequisites

- **Blocker**: `w --yolo` mode. Currently in development in a separate worktree. Runner can't go live until yolo lands.
- Host machine has:
  - Docker running
  - `gh` CLI authenticated on host machine
  - Bun

## Usage

```bash
# one-time
make build-container

# every batch
claude       # in wrap-qa dir
# > /qa-generate get ideas from top rust repos on github
# (exit Claude Code or open new pane)
bun run src/runner.ts
# back in claude
# > /qa-judge

# review
sqlite3 db/qa.db "SELECT * FROM findings WHERE type != 'uninteresting' AND status = 'new'"
```

## Deferred (not v1)

- Triage agent for dedup/labeling/pruning — future, possibly via [Claude Code routines](https://code.claude.com/docs/en/routines)
- GitHub Issues — using SQLite instead
- Cloud deployment
- Parallel scenario execution / WRAP_HOME isolation — sequential
- TUI driver (yolo handles it)
- Network proxy logging
- Heartbeat / advanced sandbox escape detection
- Stdout contract testing
- Flakiness bucketing
- Multi-step pre-planned scenarios (judge follow-ups cover this)
- Cost ceiling enforcement
- Findings review UI
- x64 builds
- Generator memory across batches (always fresh)
- Auto-orchestrator (`make qa` chaining all three)
