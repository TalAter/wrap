use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use wrap::clipboard::{
    CLIPBOARD_TOOLS, clipboard_argv, copy_to_clipboard, copy_with_program, resolve_clipboard_tool,
};

#[test]
fn resolution_takes_the_first_available_tool_in_declared_order() {
    let which = |cmd: &str| (cmd == "xclip" || cmd == "pbcopy").then(|| format!("/usr/bin/{cmd}"));
    assert_eq!(resolve_clipboard_tool(which), Some("xclip"));
    assert_eq!(resolve_clipboard_tool(|_| None), None);
    assert_eq!(
        resolve_clipboard_tool(|cmd| (cmd == "clip.exe").then(|| "c".to_string())),
        Some("clip.exe")
    );
}

#[test]
fn each_tool_gets_its_own_argv() {
    assert_eq!(clipboard_argv("wl-copy"), Some(vec!["wl-copy"]));
    assert_eq!(
        clipboard_argv("xclip"),
        Some(vec!["xclip", "-selection", "clipboard"])
    );
    assert_eq!(clipboard_argv("xsel"), Some(vec!["xsel", "-ib"]));
    assert_eq!(clipboard_argv("pbcopy"), Some(vec!["pbcopy"]));
    assert_eq!(clipboard_argv("clip.exe"), Some(vec!["clip.exe"]));
    assert_eq!(clipboard_argv("notepad"), None);
    for tool in CLIPBOARD_TOOLS {
        assert_eq!(clipboard_argv(tool).unwrap()[0], tool);
    }
}

// Serialises the spawning tests: a forked child briefly inherits another
// test's write fd on its script, which makes exec fail with ETXTBSY.
static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn fake_tool(dir: &Path, script: &str) -> PathBuf {
    let path = dir.join("fake-clip.sh");
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn wait_for(path: &Path) -> String {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(3) {
        if let Ok(content) = fs::read_to_string(path)
            && content.ends_with("END\n")
        {
            return content;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("clipboard tool never received the payload");
}

#[test]
fn payload_strips_trailing_newlines_but_keeps_interior_ones() {
    let _turn = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.txt");
    let script = format!(
        "#!/bin/sh\n[ \"$1\" = \"--flag\" ] || exit 9\ncat > \"{0}\"\nprintf END\\\\n >> \"{0}\"\n",
        out.display()
    );
    let tool = fake_tool(dir.path(), &script);
    copy_with_program(
        tool.to_str().unwrap(),
        &["--flag"],
        "echo hello\necho world\n\n\n",
    );
    assert_eq!(wait_for(&out), "echo hello\necho worldEND\n");

    let dir2 = tempfile::tempdir().unwrap();
    let out2 = dir2.path().join("out.txt");
    let script = format!(
        "#!/bin/sh\ncat > \"{0}\"\nprintf END\\\\n >> \"{0}\"\n",
        out2.display()
    );
    let tool = fake_tool(dir2.path(), &script);
    copy_with_program(tool.to_str().unwrap(), &[], "ls -la");
    assert_eq!(wait_for(&out2), "ls -laEND\n");
}

#[test]
fn copy_never_blocks_or_panics_on_hung_or_missing_tools() {
    let _turn = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let hung = fake_tool(dir.path(), "#!/bin/sh\nsleep 3\n");
    let start = Instant::now();
    copy_with_program(hung.to_str().unwrap(), &[], &"x".repeat(200_000));
    assert!(start.elapsed() < Duration::from_millis(500));
    copy_with_program("/nonexistent/clip-tool", &[], "x");
    copy_to_clipboard("x", "not-a-known-tool");
}
