use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use wrap::editor::{EDITORS, EditorMeta, ResolvedEditor, editor_key, resolve_editor, spawn_editor};
use wrap::home::WrapHome;

#[test]
fn editor_key_strips_directories_and_exe_suffix() {
    assert_eq!(editor_key("/usr/local/bin/code"), "code");
    assert_eq!(
        editor_key("C:\\Program Files\\Notepad\\notepad.exe"),
        "notepad"
    );
    assert_eq!(editor_key("vim"), "vim");
    assert_eq!(editor_key("/usr/bin/code.exe.bak"), "code.exe.bak");
    assert_eq!(editor_key("\\vim"), "vim");
    assert_eq!(editor_key("C:\\Apps\\nano.EXE"), "nano");
}

#[test]
fn gui_editors_carry_wait_flags_and_terminal_editors_do_not() {
    for (key, meta) in EDITORS {
        assert!(!meta.display_name.is_empty(), "{key}");
        if meta.gui {
            assert!(meta.wait_flag.is_some_and(|f| !f.is_empty()), "{key}");
        } else {
            assert!(meta.wait_flag.is_none(), "{key}");
        }
    }
}

fn which_only(hit: &'static str, path: &'static str) -> impl Fn(&str) -> Option<String> {
    move |cmd| (cmd == hit).then(|| path.to_string())
}

#[test]
fn visual_wins_over_editor_and_the_sweep() {
    let r = resolve_editor(
        Some("code"),
        Some("nano"),
        which_only("code", "/usr/local/bin/code"),
    )
    .unwrap();
    assert_eq!(r.key, "code");
    assert_eq!(r.path, "/usr/local/bin/code");
    assert_eq!(r.meta.display_name, "VS Code");
    assert!(r.meta.gui);
    assert_eq!(r.meta.wait_flag, Some("-w"));
}

#[test]
fn editor_is_used_when_visual_is_unset_or_blank() {
    let r = resolve_editor(Some(""), Some("vim"), which_only("vim", "/usr/bin/vim")).unwrap();
    assert_eq!(r.key, "vim");
    assert!(!r.meta.gui);
    let r = resolve_editor(None, Some("  nano\n"), which_only("nano", "/bin/nano")).unwrap();
    assert_eq!(r.key, "nano");
    let r = resolve_editor(Some("  vim  "), Some(""), which_only("vim", "/usr/bin/vim")).unwrap();
    assert_eq!(r.key, "vim");
}

#[test]
fn unknown_env_editor_passes_through_as_a_terminal_editor() {
    let r = resolve_editor(Some(""), Some("my-custom-editor"), |_| None).unwrap();
    assert_eq!(r.path, "my-custom-editor");
    assert_eq!(r.key, "my-custom-editor");
    assert_eq!(
        r.meta,
        EditorMeta {
            display_name: "my-custom-editor".into(),
            wait_flag: None,
            gui: false
        }
    );
}

#[test]
fn absolute_vs_code_path_is_recognised_as_gui() {
    let path = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    let r = resolve_editor(Some(""), Some(path), |cmd| {
        (cmd == path).then(|| path.to_string())
    })
    .unwrap();
    assert_eq!(r.key, "code");
    assert!(r.meta.gui);
    assert_eq!(r.meta.wait_flag, Some("-w"));
}

#[test]
fn without_env_the_sweep_short_circuits_on_the_first_hit_in_declaration_order() {
    let calls = std::sync::Mutex::new(Vec::new());
    let r = resolve_editor(None, None, |cmd| {
        calls.lock().unwrap().push(cmd.to_string());
        (cmd == "nano").then(|| "/bin/nano".to_string())
    })
    .unwrap();
    assert_eq!(r.key, "nano");
    let calls = calls.lock().unwrap();
    assert_eq!(calls.last().map(String::as_str), Some("nano"));
    assert_eq!(&calls[..3], ["code", "code-insiders", "cursor"]);
    assert!(resolve_editor(None, None, |_| None).is_none());
}

// --- spawn ----------------------------------------------------------------

// Spawning while another test still has its fake editor open for writing
// trips ETXTBSY (the forked child inherits the write fd for an instant), so
// the spawn tests take turns.
static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Rig {
    _dir: tempfile::TempDir,
    home: WrapHome,
    seq: usize,
    _turn: std::sync::MutexGuard<'static, ()>,
}

impl Rig {
    fn new() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let home = WrapHome::new(dir.path());
        Rig {
            _dir: dir,
            home,
            seq: 0,
            _turn: SPAWN.lock().unwrap_or_else(|p| p.into_inner()),
        }
    }
    fn fake(&mut self, script: &str) -> ResolvedEditor {
        self.seq += 1;
        let path = self.home.root().join(format!("fake-{}.sh", self.seq));
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        ResolvedEditor {
            path: path.to_string_lossy().into_owned(),
            key: "fake".into(),
            meta: EditorMeta {
                display_name: "Fake".into(),
                wait_flag: None,
                gui: false,
            },
        }
    }
    fn sentinel(&self) -> std::path::PathBuf {
        self.home.root().join("seen-seed.txt")
    }
}

#[tokio::test]
async fn editor_output_replaces_the_draft_with_one_trailing_newline_stripped() {
    let mut rig = Rig::new();
    let editor = rig.fake("#!/bin/sh\nprintf 'new buffer\\n' > \"$1\"\n");
    assert_eq!(
        spawn_editor(&editor, "seed", &rig.home, None).await,
        Ok(Some("new buffer".into()))
    );
    let multi = rig.fake("#!/bin/sh\nprintf 'line1\\nline2\\n\\n' > \"$1\"\n");
    assert_eq!(
        spawn_editor(&multi, "seed", &rig.home, None).await,
        Ok(Some("line1\nline2\n".into()))
    );
}

#[tokio::test]
async fn untouched_file_returns_the_seed_and_empty_file_keeps_the_draft() {
    let mut rig = Rig::new();
    let quits = rig.fake("#!/bin/sh\nexit 0\n");
    assert_eq!(
        spawn_editor(&quits, "seed text", &rig.home, None).await,
        Ok(Some("seed text".into()))
    );
    let empties = rig.fake("#!/bin/sh\n: > \"$1\"\n");
    assert_eq!(
        spawn_editor(&empties, "seed", &rig.home, None).await,
        Ok(None)
    );
    let newline_only = rig.fake("#!/bin/sh\nprintf '\\n' > \"$1\"\n");
    assert_eq!(
        spawn_editor(&newline_only, "seed", &rig.home, None).await,
        Ok(None)
    );
}

#[tokio::test]
async fn seed_is_written_to_compose_md_before_the_editor_runs() {
    let mut rig = Rig::new();
    let sentinel = rig.sentinel();
    let editor = rig.fake(&format!(
        "#!/bin/sh\ncat \"$1\" > \"{}\"\nprintf 'done' > \"$1\"\n",
        sentinel.display()
    ));
    assert_eq!(
        spawn_editor(&editor, "initial draft\nline 2", &rig.home, None).await,
        Ok(Some("done".into()))
    );
    assert_eq!(
        fs::read_to_string(&sentinel).unwrap(),
        "initial draft\nline 2"
    );
    assert!(rig.home.exists("cache/compose.md"));
    assert_eq!(
        spawn_editor(&editor, "again", &rig.home, None).await,
        Ok(Some("done".into()))
    );
}

#[tokio::test]
async fn non_zero_exit_keeps_the_draft_with_a_notice() {
    let mut rig = Rig::new();
    let editor = rig.fake("#!/bin/sh\nprintf 'ignored' > \"$1\"\nexit 2\n");
    assert_eq!(
        spawn_editor(&editor, "seed", &rig.home, None).await,
        Err("Fake exited with code 2 — keeping current draft".into())
    );
}

#[tokio::test]
async fn unlaunchable_editor_reports_an_editor_error() {
    let rig = Rig::new();
    let editor = ResolvedEditor {
        path: "/nonexistent/xyz-not-an-editor".into(),
        key: "xyz".into(),
        meta: EditorMeta {
            display_name: "xyz".into(),
            wait_flag: None,
            gui: false,
        },
    };
    let err = spawn_editor(&editor, "seed", &rig.home, None)
        .await
        .unwrap_err();
    assert!(err.starts_with("Editor error: "), "{err}");
}

#[tokio::test]
async fn gui_editors_receive_the_wait_flag_before_the_file() {
    let mut rig = Rig::new();
    let mut editor =
        rig.fake("#!/bin/sh\n[ \"$1\" = \"-w\" ] || exit 3\nprintf 'gui edit' > \"$2\"\n");
    editor.meta = EditorMeta {
        display_name: "VS Code".into(),
        wait_flag: Some("-w"),
        gui: true,
    };
    assert_eq!(
        spawn_editor(&editor, "seed", &rig.home, None).await,
        Ok(Some("gui edit".into()))
    );
}

#[tokio::test]
async fn cancellation_abandons_the_wait_without_killing_the_editor() {
    let mut rig = Rig::new();
    let pre = CancellationToken::new();
    pre.cancel();
    let sleeper = rig.fake("#!/bin/sh\nsleep 1\n");
    let start = Instant::now();
    assert_eq!(
        spawn_editor(&sleeper, "seed", &rig.home, Some(pre)).await,
        Ok(None)
    );
    assert!(start.elapsed() < Duration::from_millis(500));

    let marker = rig.home.root().join("finished");
    let late = rig.fake(&format!(
        "#!/bin/sh\nprintf 'unexpected' > \"$1\"\nsleep 0.3\ntouch \"{}\"\n",
        marker.display()
    ));
    let token = CancellationToken::new();
    let cancel = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
    });
    let start = Instant::now();
    assert_eq!(
        spawn_editor(&late, "seed", &rig.home, Some(token)).await,
        Ok(None)
    );
    assert!(start.elapsed() < Duration::from_millis(250));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        Path::new(&marker).exists(),
        "the editor must keep running after wrap stops waiting"
    );

    let never = CancellationToken::new();
    let edits = rig.fake("#!/bin/sh\nprintf 'edited' > \"$1\"\n");
    assert_eq!(
        spawn_editor(&edits, "seed", &rig.home, Some(never)).await,
        Ok(Some("edited".into()))
    );
}
