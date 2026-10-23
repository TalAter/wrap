//! Copying a command to the system clipboard through whichever tool is on
//! PATH. Fire-and-forget by design: the dialog flips its label regardless,
//! and a hung tool must never wedge the dialog or block exit.

use std::io::Write;
use std::process::{Command, Stdio};

/// Candidate copy tools in resolution order.
pub const CLIPBOARD_TOOLS: [&str; 5] = ["wl-copy", "xclip", "xsel", "pbcopy", "clip.exe"];
/// Paste-side counterparts, probed by discovery so the model knows they exist.
pub const CLIPBOARD_PASTE_TOOLS: [&str; 2] = ["pbpaste", "wl-paste"];

/// The first [`CLIPBOARD_TOOLS`] entry `which` finds. The caller caches the
/// result for the process lifetime.
pub fn resolve_clipboard_tool(which: impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    CLIPBOARD_TOOLS
        .into_iter()
        .find(|tool| which(tool).is_some())
}

/// [`resolve_clipboard_tool`] over PATH.
pub fn resolve_clipboard_tool_on_path() -> Option<&'static str> {
    resolve_clipboard_tool(crate::paths::which)
}

/// Full argv for a known tool.
pub fn clipboard_argv(tool: &str) -> Option<Vec<&'static str>> {
    Some(match tool {
        "wl-copy" => vec!["wl-copy"],
        "xclip" => vec!["xclip", "-selection", "clipboard"],
        "xsel" => vec!["xsel", "-ib"],
        "pbcopy" => vec!["pbcopy"],
        "clip.exe" => vec!["clip.exe"],
        _ => return None,
    })
}

/// Write `text` to the clipboard via `tool`. Silent on every failure.
pub fn copy_to_clipboard(text: &str, tool: &str) {
    if let Some(argv) = clipboard_argv(tool) {
        copy_with_program(argv[0], &argv[1..], text);
    }
}

/// Spawn `program args` with `text` (trailing newlines stripped) on stdin.
/// Returns immediately: the write happens on a detached thread, and nothing
/// waits for the tool, so a stalled X11 selection or WSL interop never blocks.
pub fn copy_with_program(program: &str, args: &[&str], text: &str) {
    let payload = text.trim_end_matches('\n').to_string();
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let Some(mut stdin) = child.stdin.take() else {
        return;
    };
    std::thread::spawn(move || {
        let _ = stdin.write_all(payload.as_bytes());
        drop(stdin);
        let _ = child.wait();
    });
}
