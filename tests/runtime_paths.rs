use std::path::Path;

use wrap::paths::{home_dir, pretty_path, resolve_path, which};

#[test]
fn tilde_resolves_to_the_home_directory() {
    let home = home_dir().canonicalize().unwrap();
    assert_eq!(resolve_path("~", None), Some(home.clone()));
    assert_eq!(resolve_path("~/", None), Some(home));
}

#[test]
fn relative_paths_resolve_against_the_given_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let expected = dir.path().canonicalize().unwrap();
    assert_eq!(resolve_path(".", Some(dir.path())), Some(expected));
}

#[test]
fn dot_without_cwd_resolves_against_the_process_cwd() {
    let expected = std::env::current_dir().unwrap().canonicalize().unwrap();
    assert_eq!(resolve_path(".", None), Some(expected));
}

#[test]
fn missing_paths_resolve_to_none() {
    assert_eq!(
        resolve_path("/nonexistent/path/that/does/not/exist", None),
        None
    );
    assert_eq!(
        resolve_path("./does-not-exist-at-all", Some(Path::new("/tmp"))),
        None
    );
}

#[test]
fn absolute_paths_ignore_cwd_and_follow_symlinks() {
    let expected = Path::new("/tmp").canonicalize().unwrap();
    assert_eq!(
        resolve_path("/tmp", Some(Path::new("/some/other/dir"))),
        Some(expected)
    );
}

#[test]
fn pretty_path_substitutes_tilde_only_for_the_home_prefix() {
    let home = home_dir();
    let home_str = home.to_str().unwrap();
    assert_eq!(pretty_path(home.join("foo")), "~/foo");
    assert_eq!(pretty_path(&home), "~");
    assert_eq!(pretty_path("/usr/local"), "/usr/local");
    assert_eq!(
        pretty_path(format!("{home_str}extra/foo")),
        format!("{home_str}extra/foo")
    );
    assert_eq!(pretty_path("/"), "/");
}

#[test]
fn which_finds_executables_on_path_and_misses_unknown_names() {
    let sh = which("sh").expect("sh is on PATH");
    assert!(sh.ends_with("/sh"), "{sh}");
    assert_eq!(which("definitely-not-a-real-tool-xyz"), None);
    assert_eq!(which("/bin/sh").as_deref(), Some("/bin/sh"));
    assert_eq!(which("/nonexistent/bin/sh"), None);
}
