2026-04-04 | tui | Ink confirmation borders must use real column children plus `measureElement()` for height sync; newline-joined border text breaks when the middle column wraps.
2026-04-04 | tui | Ink components should read terminal width from `useStdout().stdout`, not `process.stderr`, because `useStdout` follows the stream passed to `render({ stdout })`.
2026-04-04 | tui | Ink clears/reflows on terminal resize, but custom width-dependent component props still need explicit state tied to the render stream's `resize` event or they stay stale until some other rerender happens.
2026-04-04 | tui | For interactive confirmation, mount Ink in alternate screen (`?1049h`/`?1049l`) so resize redraw artifacts cannot corrupt normal terminal scrollback.
2026-04-04 | tui | In alternate screen mode, center the confirm panel in a full-screen root box and drive width/height from resize subscriptions; avoid brittle tests that assume the panel starts on line 1.
2026-04-05 | tui | When terminal shrinks, cap confirmation panel total width to available columns (`termCols - margin`) instead of enforcing action-bar minimum width; otherwise right border/corner clips on narrow terminals.
2026-04-05 | tui | For Ink terminal size in one component, use a single `useSyncExternalStore` subscription for both columns and rows; avoid duplicate `resize` listeners per dimension.
