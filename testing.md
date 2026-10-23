# Testing

Tests protect observable behavior and catch realistic bugs. Audit coverage before
changing a behavior; add a meaningful regression test for missing contracts.

- Write a failing test before implementation. Confirm an assertion fails for the
  intended behavior, not a missing symbol or compile error. Implement, get green,
  then refactor. Each commit must be green and atomic.
- Prioritize the execution gate, response parsing, session state transitions,
  persisted records, configuration precedence, subprocess side effects, and
  failure paths. Skip exports, type assertions, trivial getters, and other
  compiler-checked plumbing.
- Exercise real code through public boundaries. Substitute the model
  (`WRAP_TEST_RESPONSES` playback or a local HTTP fixture), the terminal (the
  scripted dialog host, `TestBackend` buffers) and clocks when needed; don't
  mock away the behavior tested.
- Use temporary homes and local HTTP fixtures. Pass `WRAP_HOME` to subprocesses;
  don't mutate process-global environment in parallel tests. Verify existing
  log, memory, and configuration fixtures remain readable, including unknown
  fields.
- Command fixtures must be harmless: `echo`, `true`, `false`, or `exit 3`. The
  inline-step path runs the real shell, so a regression would execute them.
- Check exit codes, stdout/stderr separation, persisted results, and the absence
  of side effects before confirmation. Test cancellation and blocked paths too.
- Test the reducer and focused Ratatui buffer contracts, then exercise a real
  PTY: navigation, Unicode editing, resize, scrolling, confirmation,
  cancellation, child terminal handoff, and restoration after errors and signals.
- Fix regressions instead of weakening assertions. Remove redundant tests when
  their contracts remain covered.

Use focused `cargo test <filter>` or `cargo test --test <target>` while working.
Choose verification by the change, not by running every suite after every edit:

- Before committing Rust changes: `cargo fmt --check`,
  `cargo clippy --locked --all-targets -- -D warnings`, and relevant
  `cargo test --locked` coverage. Use `make check` for integrated changes or
  when the affected scope is unclear.
- For terminal/UI changes: also run `make terminal` (the PTY suite against the
  debug binary).
- For dependency/build-environment changes or environment-specific failures:
  use `make linux-test` for a clean container build. It is optional for routine
  native Linux development; it does not replace macOS coverage.
- For documentation-only changes: verify the edited content directly.

`make check && make terminal` runs the full native verification. CI runs both
commands on Linux and macOS for pushes and pull requests. Local commits have no
automatic Git hook; agents must run the applicable checks and report gaps.
Do not repeat successful checks unless further changes or failures warrant it.
