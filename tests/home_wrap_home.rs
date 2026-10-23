use std::collections::HashMap;
use std::fs;
use std::path::Path;
use wrap::home::WrapHome;

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn from_env_uses_wrap_home_when_non_empty() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::from_env(&env(&[("WRAP_HOME", dir.path().to_str().unwrap())]));
    assert_eq!(home.root(), dir.path());
}

#[test]
fn from_env_falls_back_to_dot_wrap_under_home_when_unset_or_empty() {
    let user_home = tempfile::tempdir().unwrap();
    let expected = user_home.path().join(".wrap");
    let hp = user_home.path().to_str().unwrap();
    assert_eq!(WrapHome::from_env(&env(&[("HOME", hp)])).root(), expected);
    assert_eq!(
        WrapHome::from_env(&env(&[("HOME", hp), ("WRAP_HOME", "")])).root(),
        expected
    );
}

#[test]
fn resolve_joins_root_with_relative_path() {
    let home = WrapHome::new("/tmp/x");
    assert_eq!(home.resolve("a/b.txt"), Path::new("/tmp/x/a/b.txt"));
}

#[test]
fn read_returns_none_for_missing_and_empty_string_for_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    assert_eq!(home.read("nope.txt").unwrap(), None);
    home.write("empty.txt", "").unwrap();
    assert_eq!(home.read("empty.txt").unwrap(), Some(String::new()));
}

#[test]
fn read_surfaces_non_missing_errors() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    fs::create_dir(dir.path().join("actually-a-dir")).unwrap();
    assert!(home.read("actually-a-dir").is_err());
}

#[test]
fn write_creates_parents_and_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    home.write("cache/models.dev.json", "{\"ok\":1}").unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("cache/models.dev.json")).unwrap(),
        "{\"ok\":1}"
    );
    home.write("cache/models.dev.json", "second").unwrap();
    assert_eq!(
        home.read("cache/models.dev.json").unwrap().unwrap(),
        "second"
    );
}

#[test]
fn append_creates_parents_then_appends() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    home.append("logs/app.log", "line1\n").unwrap();
    home.append("logs/app.log", "line2\n").unwrap();
    assert_eq!(
        home.read("logs/app.log").unwrap().unwrap(),
        "line1\nline2\n"
    );
}

#[test]
fn exists_covers_files_and_directories_but_not_missing_paths() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    home.write("x.txt", "y").unwrap();
    fs::create_dir(dir.path().join("subdir")).unwrap();
    assert!(home.exists("x.txt"));
    assert!(home.exists("subdir"));
    assert!(!home.exists("never"));
}

#[test]
fn root_is_not_created_until_first_write() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("not-yet");
    let home = WrapHome::new(&root);
    assert!(!root.exists());
    home.write("hello.txt", "hi").unwrap();
    assert!(root.exists());
    assert_eq!(home.read("hello.txt").unwrap().unwrap(), "hi");
}
