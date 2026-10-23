//! Lives in its own binary: `ensure_temp_dir` exports `WRAP_TEMP_DIR` into the
//! process environment, which must not race the other temp tests.
use wrap::temp::{ensure_temp_dir, format_temp_dir_section_from_env};

#[test]
fn ensure_temp_dir_creates_once_and_exports_the_env_var() {
    assert!(std::env::var_os("WRAP_TEMP_DIR").is_none());
    assert!(format_temp_dir_section_from_env().contains("(empty)"));
    assert!(
        std::env::var_os("WRAP_TEMP_DIR").is_none(),
        "formatting must not create the dir"
    );

    let first = ensure_temp_dir().unwrap();
    assert_eq!(
        std::env::var_os("WRAP_TEMP_DIR").unwrap(),
        first.as_os_str()
    );
    assert!(first.is_dir());
    assert!(
        first
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("wrap-scratch-")
    );
    std::fs::write(first.join("probe.txt"), "hello").unwrap();

    let second = ensure_temp_dir().unwrap();
    assert_eq!(first, second);
    assert!(format_temp_dir_section_from_env().contains("$WRAP_TEMP_DIR/probe.txt (5B)"));

    std::fs::remove_dir_all(&first).unwrap();
}
