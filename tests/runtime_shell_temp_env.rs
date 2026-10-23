//! Lives in its own binary: the first shell execution exports
//! `WRAP_TEMP_DIR` into the process environment, which must not race the
//! other temp or shell tests.
use wrap::shell::{ShellMode, execute_with_shell};

#[tokio::test]
async fn the_temp_dir_is_created_lazily_and_inherited_by_the_child() {
    assert!(std::env::var_os("WRAP_TEMP_DIR").is_none());
    let result = execute_with_shell(
        "printf %s \"$WRAP_TEMP_DIR\"",
        "/bin/sh",
        ShellMode::Capture,
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.exit_code, 0);
    assert!(!result.stdout.is_empty());
    assert!(std::path::Path::new(&result.stdout).is_dir());
    assert_eq!(std::env::var("WRAP_TEMP_DIR").unwrap(), result.stdout);
    std::fs::remove_dir_all(&result.stdout).unwrap();
}
