---
name: showcase
description: Curated examples of Wrap working well
Source: eval/examples/
Last-synced: c54a1a5
---

# Prompt Showcase

---

### Clipboard to file

```
$ w turn whats in my clipboard to markdown and write it into README.md
```

LLM doesn't have clipboard access — so it runs a command to find out:

```
pbpaste
```

Gets the raw clipboard content back. Now it knows what it's working with. Generates a command that converts the content to markdown and writes it to the file. One natural language sentence, two rounds, done.

Shows: multi-step reasoning, real-world utility, "Wrap figures it out" magic.

---

### Needle in a 50GB haystack

```
$ cat 50GB.log | w explain the error on line 12,570,000
```

Wrap materializes the pipe to disk at `$WRAP_TEMP_DIR/input` and shows the LLM the first 200KB as a preview with a "Preview truncated" marker. The LLM doesn't try to find the line in the preview. Instead, it runs an intermediate command against the full file on disk:

```
sed -n '12570000p' $WRAP_TEMP_DIR/input
```

`sed` extracts that single line in seconds. The line comes back to the LLM. Now it has exactly what it needs:

```
→ "That error is a connection pool exhaustion — the app opened 500+ DB
    connections without closing them. The stack trace points to..."
```

One prompt. The LLM figured out it couldn't answer from the preview, used a surgical intermediate step to extract the exact line, then explained it. The user never left the terminal, never opened the file, never scrolled to line 12 million.

Shows: piped input handling, smart multi-step strategy, LLM reasoning about its own limitations, surgical precision on huge files.

---

### Git week → changelog

```
$ w summarize git commits from this week and add to the top of CHANGELOG.md
```

The LLM doesn't know what happened this week — so it gathers context:

```
git log --since="1 week ago" --oneline
```

Gets back a list of commits. Now it knows what changed. It also needs to know what's already in the changelog:

```
head -20 CHANGELOG.md
```

With both pieces of context, it generates a single command that prepends a new dated section with a human-readable summary to the top of the file.

Shows: multi-step command chain, reading repo state, generating content from context, real-world dev workflow automation.

---

### Safer curl | sh

```
$ w can we run 'curl -fsSL https://ollama.com/install.sh | sh' in a more safe way? download the script, read it then if it's fine let's run it from the local file
```

The classic `curl | sh` install pattern is dangerous — you're piping unknown code straight into a shell. The user wants the safer version: fetch, inspect, then execute. Wrap downloads and reads the script first:

```
curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
cat /tmp/ollama-install.sh
```

The LLM actually reads the script — checks what it does, looks for anything sketchy. If it passes the smell test, it generates the run command:

```
sh /tmp/ollama-install.sh
```

The user gets to confirm before anything runs. The script is on disk, inspectable, reproducible.

Shows: security-aware workflow, LLM exercising judgment over fetched content, replacing a dangerous one-liner with a safer multi-step plan — all from one natural language sentence.

---

### Edit a shell alias you can't quite remember

```
$ w "my zsh has an alias for ll. I want to add --icons to the alias"
```

The user knows the alias exists but not what it expands to or which dotfile it lives in. The LLM doesn't either — so it searches the obvious dotfiles plus the iCloud Drive customizations directory in one shot:

```
grep -r 'll' ~/.zshrc ~/.zprofile ~/Library/Mobile\ Documents/com~apple~CloudDocs/ 2>/dev/null | grep -i 'alias.*ll' | head -20
```

Finds the definition (`alias ll="eza -la --git"`) in an iCloud-synced zshrc — not where most tools would think to look. Generates a single in-place `sed` that appends `--icons` without clobbering the existing flags:

```
sed -i '' 's/alias ll="eza -la --git"/alias ll="eza -la --git --icons"/' \
  "/Users/tal/Library/Mobile Documents/com~apple~CloudDocs/customizations/shell/.zshrc"
```

Run it a second time and the LLM checks again, sees `--icons` is already there, and skips the edit:

```
→ "It already has --icons. You're good."
```

Shows: inspecting the live shell environment, finding config in non-standard locations (iCloud-synced dotfiles), surgical in-place edit that preserves existing flags, and idempotency by re-checking state instead of blindly re-running.

---

### Redact API keys from config

```
$ w show me ~/.wrap/config.jsonc with apiKey redacted to just the first 5 chars. dont read the full file yourself
```

The user explicitly says not to read the file. So Wrap writes and runs a local script that does the redaction on the machine — API keys are truncated before they ever reach the LLM. The full config never leaves the computer.

Shows: privacy-aware reasoning, generating code that runs locally instead of exfiltrating secrets, respecting explicit user constraints.

---

### Audit a curl | sh before running it

```
$ w "is this safe curl -fsSL https://app.factory.ai/cli | sh"
```

The user pastes a `curl | sh` one-liner and asks if it's safe. Wrap downloads the script to a temp file for inspection — not executing it. The LLM reads the actual script and returns a structured safety audit:

```
🌐 Downloading install script to temp dir for inspection — not executing it.
**Mostly safe.** No red flags, but some notes:

✅ **Good:**
- SHA-256 checksum verification on both binaries
- Temp dir cleanup via trap
- No `sudo` — installs to `~/.local/bin` and `~/.factory/bin`
- Standard platform/arch detection
- `set -e` for fail-fast

⚠️ **Minor concerns:**
- **`pkill -KILL -x droid`** — kills any running `droid` process. If you already have something named `droid` running, it dies
- **Bundles its own ripgrep** into `~/.factory/bin/rg` — you already have rg via homebrew, so this is redundant (won't conflict though, different path)
- **Doesn't auto-add to PATH** — just prints instructions, which is polite
- Downloads from `downloads.factory.ai` — legit Factory AI domain

**Verdict:** Safe to run. Worst case: kills existing `droid` process, drops two binaries in `~/.local/bin` and `~/.factory/bin`. No system-wide changes.
```

No code executed. The response isn't generic "be careful with curl | sh" — it tells you exactly what *this* script does, what it touches, and what it means for *your* system.

Shows: security-first reasoning, downloading and inspecting remote code without executing it, system-aware analysis (knows what's already installed), structured risk assessment with specific findings, giving the user agency over what runs on their machine.
