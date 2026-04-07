# Prompt Showcase

Beautiful use cases that demonstrate how powerful Wrap is.

---

### Clipboard to file

```
$ w turn whats in my clipboard to markdown and write it into README.md
```

LLM doesn't have clipboard access — so it probes for it:

```
probe → pbpaste
```

Gets the raw clipboard content back. Now it knows what it's working with. Generates a command that converts the content to markdown and writes it to the file. One natural language sentence, two rounds, done.

Shows: probe loop, real-world utility, "Wrap figures it out" magic.

---

### Needle in a 50GB haystack

```
$ cat 50GB.log | w explain the error on line 12,570,000
```

Wrap shows the first 200KB of piped input to the LLM to give it context about the file's format, and notes the input is truncated. The LLM doesn't try to find the line in the truncated preview. Instead, it probes:

```
probe → sed -n '12570000p' (piped through the full 50GB stdin)
```

Wrap pipes the full file through `sed`, which extracts that single line in seconds. The line comes back to the LLM. Now it has exactly what it needs:

```
answer → "That error is a connection pool exhaustion — the app opened 500+ DB
          connections without closing them. The stack trace points to..."
```

One prompt. The LLM figured out it couldn't answer from the preview, used a surgical probe to extract the exact line, then explained it. The user never left the terminal, never opened the file, never scrolled to line 12 million.

Shows: piped input, smart probe strategy, LLM reasoning about its own limitations, surgical precision on huge files.

---

### Git week → changelog

```
$ w summarize git commits from this week and add to the top of CHANGELOG.md
```

The LLM doesn't know what happened this week — so it probes:

```
probe → git log --since="1 week ago" --oneline
```

Gets back a list of commits. Now it knows what changed. It also needs to know what's already in the changelog:

```
probe → head -20 CHANGELOG.md
```

With both pieces of context, it generates a single command that prepends a new dated section with a human-readable summary to the top of the file.

Shows: multi-step probe chain, reading repo state, generating content from context, real-world dev workflow automation.

---

### Safer curl | sh

```
$ w can we run 'curl -fsSL https://ollama.com/install.sh | sh' in a more safe way? download the script, read it then if it's fine let's run it from the local file
```

The classic `curl | sh` install pattern is dangerous — you're piping unknown code straight into a shell. The user wants the safer version: fetch, inspect, then execute. Wrap probes for the script:

```
probe → curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
probe → cat /tmp/ollama-install.sh
```

The LLM actually reads the script — checks what it does, looks for anything sketchy. If it passes the smell test, it generates the run command:

```
sh /tmp/ollama-install.sh
```

The user gets to confirm before anything runs. The script is on disk, inspectable, reproducible.

Shows: security-aware workflow, LLM exercising judgment over fetched content, replacing a dangerous one-liner with a safer multi-step plan — all from one natural language sentence.
