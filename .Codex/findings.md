2026-04-04 | tui | Ink confirmation borders must use real column children plus `measureElement()` for height sync; newline-joined border text breaks when the middle column wraps.
2026-04-04 | tui | Ink components should read terminal width from `useStdout().stdout`, not `process.stderr`, because `useStdout` follows the stream passed to `render({ stdout })`.
