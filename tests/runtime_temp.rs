use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

use wrap::temp::{DirStats, dir_stats, format_size, format_temp_dir_section};

fn constant(key: &str) -> String {
    let json: serde_json::Value =
        serde_json::from_str(include_str!("../src/prompt/constants.json")).unwrap();
    json[key].as_str().unwrap().to_string()
}

#[test]
fn unset_dir_gives_the_empty_section_without_creating_anything() {
    let section = format_temp_dir_section(None);
    assert_eq!(
        section,
        format!(
            "{}\n{}",
            constant("sectionTempDir"),
            constant("tempDirEmpty")
        )
    );
}

#[test]
fn empty_dir_gives_the_empty_section_and_never_leaks_the_path() {
    let dir = tempfile::tempdir().unwrap();
    let section = format_temp_dir_section(Some(dir.path()));
    assert!(section.contains("$WRAP_TEMP_DIR"));
    assert!(section.contains("(empty)"));
    assert!(!section.contains(dir.path().to_str().unwrap()));
}

#[test]
fn section_lists_sorted_entries_with_dir_slash_sizes_and_recursion() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("z-file.txt"), "hello").unwrap();
    fs::create_dir(dir.path().join("a-sub")).unwrap();
    fs::write(dir.path().join("a-sub/inner.md"), "xyz").unwrap();
    let section = format_temp_dir_section(Some(dir.path()));
    let lines: Vec<&str> = section.split('\n').collect();
    assert_eq!(
        lines,
        vec![
            constant("sectionTempDir").as_str(),
            "$WRAP_TEMP_DIR/a-sub/",
            "$WRAP_TEMP_DIR/a-sub/inner.md (3B)",
            "$WRAP_TEMP_DIR/z-file.txt (5B)",
        ]
    );
    assert!(!section.contains(dir.path().to_str().unwrap()));
}

#[test]
fn missing_dir_path_gives_the_empty_section() {
    let dir = tempfile::tempdir().unwrap();
    let section = format_temp_dir_section(Some(&dir.path().join("does-not-exist-xyz")));
    assert!(section.contains(&constant("tempDirEmpty")));
}

#[test]
fn broken_symlink_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    symlink(
        dir.path().join("nonexistent-target"),
        dir.path().join("broken-link"),
    )
    .unwrap();
    fs::write(dir.path().join("real.txt"), "x").unwrap();
    let section = format_temp_dir_section(Some(dir.path()));
    assert!(section.contains("real.txt"));
    assert!(!section.contains("broken-link"));
}

#[test]
fn format_size_rounds_to_b_k_m() {
    assert_eq!(format_size(0), "0B");
    assert_eq!(format_size(512), "512B");
    assert_eq!(format_size(1023), "1023B");
    assert_eq!(format_size(1024), "1K");
    assert_eq!(format_size(4096), "4K");
    assert_eq!(format_size(1024 * 1024 - 1), "1024K");
    assert_eq!(format_size(1024 * 1024), "1M");
    assert_eq!(format_size(5 * 1024 * 1024), "5M");
}

#[test]
fn dir_stats_handles_missing_and_empty_dirs() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        dir_stats(&dir.path().join("nope")),
        DirStats { files: 0, bytes: 0 }
    );
    assert_eq!(dir_stats(dir.path()), DirStats { files: 0, bytes: 0 });
}

#[test]
fn dir_stats_counts_files_recursively_and_sums_bytes() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "hello").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("sub/b.txt"), "xyz").unwrap();
    fs::write(dir.path().join("sub/c.bin"), vec![0u8; 100]).unwrap();
    assert_eq!(
        dir_stats(dir.path()),
        DirStats {
            files: 3,
            bytes: 108
        }
    );
}

#[test]
fn dir_stats_counts_symlinks_once_without_following() {
    let dir = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    fs::write(target.path().join("big.bin"), vec![0u8; 10_000]).unwrap();
    symlink(target.path(), dir.path().join("link")).unwrap();
    let stats = dir_stats(dir.path());
    assert_eq!(stats.files, 1);
    assert!(stats.bytes > 0 && stats.bytes < 10_000, "{stats:?}");
}

#[test]
fn dir_stats_root_may_be_a_file_path_parent_free() {
    // A plain file as root has no entries to walk.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f");
    fs::write(&file, "abc").unwrap();
    assert_eq!(dir_stats(Path::new(&file)), DirStats { files: 0, bytes: 0 });
}
