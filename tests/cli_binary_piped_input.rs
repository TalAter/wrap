//! Piped stdin through the real binary: materialised to a 0600 file under
//! `$WRAP_TEMP_DIR`, described in the log, never fed to the command's stdin.

mod cli_binary_common;

use cli_binary_common::{Wrap, command, first_user_text, reply, step};

fn scratch_input_is_forgotten_with_temp_env(key: &str, non_utf8: bool) {
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    use std::process::{Command, Stdio};

    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().join(std::ffi::OsStr::from_bytes(if non_utf8 {
        b"scratch-\xff"
    } else {
        b"scratch"
    }));
    let fallback = tmp.path().join("fallback");
    let supports_path = match std::fs::create_dir(&base) {
        Ok(()) => true,
        Err(error) if non_utf8 && error.raw_os_error() == Some(libc::EILSEQ) => false,
        Err(error) => panic!("cannot create scratch fixture: {error}"),
    };
    std::fs::create_dir(&fallback).unwrap();
    std::fs::write(
        home.path().join("memory.json"),
        cli_binary_common::MEMORY_SEED,
    )
    .unwrap();
    let process = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_wrap"));
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", "/bin/sh")
            .env("WRAP_HOME", home.path())
            .env("WRAP_CONFIG", "{}")
            .env("WRAP_THEME", "dark")
            .env("WRAP_TEST_RESPONSE", reply("ok").to_string())
            .env("TMP", &fallback)
            .env(key, &base)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());
        if key == "TEMP" {
            command.env_remove("TMP");
        }
        command
    };
    let mut child = process().arg("explain").spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"private input")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    if !supports_path {
        assert!(!output.status.success(), "{output:?}");
        assert!(output.stdout.is_empty(), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("Input error: could not save the piped input"),
            "{output:?}"
        );
        assert_eq!(std::fs::read_dir(&fallback).unwrap().count(), 0);
        assert!(!home.path().join("logs/wrap.jsonl").exists());
        return;
    }
    assert!(output.status.success(), "{output:?}");
    let input = [&base, &fallback]
        .into_iter()
        .flat_map(|dir| std::fs::read_dir(dir).unwrap())
        .map(|entry| entry.unwrap().path().join("input"))
        .find(|path| path.is_file())
        .expect("attached input created in a configured temp directory");
    assert_eq!(std::fs::read(&input).unwrap(), b"private input");

    let output = process()
        .args(["--forget", "--yolo"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let forgotten = !input.exists();
    if !forgotten {
        std::fs::remove_dir_all(input.parent().unwrap()).unwrap();
    }
    assert!(output.status.success(), "{output:?}");
    assert!(forgotten, "--forget left piped input behind with {key}");
    assert!(input.starts_with(&base), "scratch ignored {key}: {input:?}");
}

#[test]
fn scratch_input_uses_tmp_and_is_forgotten() {
    scratch_input_is_forgotten_with_temp_env("TMP", false);
}

#[test]
fn scratch_input_uses_temp_and_is_forgotten() {
    scratch_input_is_forgotten_with_temp_env("TEMP", false);
}

#[test]
fn non_utf8_scratch_input_is_forgotten_or_rejected_by_the_filesystem() {
    scratch_input_is_forgotten_with_temp_env("TMPDIR", true);
}

#[test]
fn pipe_with_a_prompt_runs_the_query_not_help() {
    let out = Wrap::seeded()
        .response(reply("It's an error log"))
        .stdin("ERROR: connection refused")
        .run(&["explain this"]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "It's an error log\n");
}

#[test]
fn pipe_without_a_prompt_still_runs_a_query_with_an_empty_prompt() {
    let wrap = Wrap::seeded().response(reply("3 lines")).stdin("a\nb\nc");
    let out = wrap.run(&[]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "3 lines\n");
    let entry = wrap.log_entry();
    assert_eq!(entry["input_source"], "pipe");
    assert_eq!(first_user_text(&entry), "");
}

#[test]
fn piped_content_is_never_parsed_as_flags() {
    let out = Wrap::seeded()
        .response(reply("That's a version flag"))
        .stdin("--version")
        .run(&["explain this"]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "That's a version flag\n");
}

#[test]
fn the_command_reads_the_full_bytes_from_the_input_file() {
    let out = Wrap::seeded()
        .response(command("wc -l < $WRAP_TEMP_DIR/input", "low"))
        .stdin("line1\nline2\nline3\n")
        .run(&["count lines"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "3");
}

#[test]
fn the_input_file_is_mode_0600() {
    use std::os::unix::fs::PermissionsExt;
    let wrap = Wrap::seeded().response(reply("ok")).stdin("hello");
    let out = wrap.run(&["read mode"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let entry = wrap.log_entry();
    let path = entry["attached_input"]["path"].as_str().unwrap();
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn the_command_stdin_does_not_carry_the_attached_bytes() {
    let out = Wrap::seeded()
        .response(command("cat; echo end", "low"))
        .stdin("this should not be piped")
        .run(&["list files"]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "end\n");
}

#[test]
fn a_non_final_step_can_read_the_input_file() {
    let out = Wrap::seeded()
        .responses(vec![
            step("wc -l < $WRAP_TEMP_DIR/input", "Counting"),
            reply("3 lines"),
        ])
        .stdin("a\nb\nc\n")
        .run(&["count lines"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "3 lines\n");
}

#[test]
fn attached_input_is_logged_with_path_size_and_preview() {
    let wrap = Wrap::seeded().response(reply("ok")).stdin("log data here");
    assert_eq!(wrap.run(&["explain"]).code, 0);
    let entry = wrap.log_entry();
    let attached = &entry["attached_input"];
    assert_eq!(attached["preview"], "log data here");
    assert_eq!(attached["size"], "log data here".len());
    let path = attached["path"].as_str().unwrap();
    assert!(path.contains("wrap-scratch-"), "{path}");
    assert!(path.ends_with("/input"), "{path}");
    assert!(std::path::Path::new(path).exists());
    assert_eq!(entry["input_source"], "argv");
}

#[test]
fn large_attached_input_preview_is_truncated_in_the_log() {
    let wrap = Wrap::seeded().response(reply("ok")).stdin("x".repeat(5000));
    assert_eq!(wrap.run(&["explain"]).code, 0);
    let attached = &wrap.log_entry()["attached_input"];
    assert!(
        attached["preview"]
            .as_str()
            .unwrap()
            .contains("[…truncated,")
    );
    assert!(attached["preview"].as_str().unwrap().len() < 5000);
    assert_eq!(attached["size"], 5000);
}

#[test]
fn verbose_reports_the_input_file_and_its_size() {
    let out = Wrap::seeded()
        .response(reply("ok"))
        .stdin("abcde")
        .run(&["--verbose", "explain"]);
    assert_eq!(out.code, 0);
    let line = out
        .stderr
        .lines()
        .find(|l| l.contains("Input file: "))
        .unwrap_or_else(|| panic!("{}", out.stderr));
    assert!(line.contains("/input"), "{line}");
    assert!(line.contains("(5B)"), "{line}");
}
