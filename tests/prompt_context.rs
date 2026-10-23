use std::collections::BTreeMap;
use wrap::prompt::{Fact, Memory, QueryContext, format_context};

fn memory(entries: &[(&str, &[&str])]) -> Memory {
    let mut m = BTreeMap::new();
    for (scope, facts) in entries {
        m.insert(
            scope.to_string(),
            facts
                .iter()
                .map(|f| Fact {
                    fact: f.to_string(),
                })
                .collect(),
        );
    }
    m
}

fn ctx(cwd: &str, memory: Memory) -> QueryContext {
    QueryContext {
        cwd: cwd.into(),
        memory,
        ..Default::default()
    }
}

#[test]
fn empty_memory_and_no_pipe_yields_an_empty_context() {
    let text = format_context(&ctx("/home/user", memory(&[])));
    assert_eq!(text, "");
}

#[test]
fn global_facts_render_under_the_system_facts_header_one_per_line() {
    let text = format_context(&ctx(
        "/any/where",
        memory(&[("/", &["alpha", "beta", "gamma"])]),
    ));
    assert_eq!(text, "## System facts\n- alpha\n- beta\n- gamma");
}

#[test]
fn scoped_facts_apply_to_the_scope_and_its_subdirectories_only() {
    let m = memory(&[
        ("/", &["macOS"]),
        ("/Users/tal/project", &["Uses bun"]),
        ("/monorepo", &["monorepo fact"]),
    ]);
    let inside = format_context(&ctx("/Users/tal/project/packages/api", m.clone()));
    assert!(inside.contains("## Facts about /Users/tal/project\n- Uses bun"));

    let outside = format_context(&ctx("/Users/tal/other", m.clone()));
    assert!(outside.contains("macOS"));
    assert!(!outside.contains("Uses bun"));
    assert!(!outside.contains("Facts about"));

    let sibling = format_context(&ctx("/monorepo-tools", m));
    assert!(!sibling.contains("monorepo fact"));
}

#[test]
fn sections_run_global_then_specific_separated_by_blank_lines() {
    let m = memory(&[
        ("/", &["global"]),
        ("/Users/tal/project", &["project"]),
        ("/Users/tal/project/packages/api", &["api"]),
    ]);
    let text = format_context(&ctx("/Users/tal/project/packages/api", m));
    assert_eq!(
        text,
        "## System facts\n- global\n\n## Facts about /Users/tal/project\n- project\n\n## Facts about /Users/tal/project/packages/api\n- api"
    );
}

#[test]
fn scopes_with_no_facts_are_skipped() {
    let text = format_context(&ctx("/home/user", memory(&[("/", &[])])));
    assert!(!text.contains("System facts"));
}

#[test]
fn piped_instruction_follows_memory_facts() {
    let mut c = ctx("/home/user", memory(&[("/", &["macOS"])]));
    c.piped = true;
    let text = format_context(&c);
    assert!(text.starts_with("## System facts\n- macOS\n\nstdout is being piped"));
    assert!(text.contains("bare value"));

    c.piped = false;
    assert!(!format_context(&c).contains("stdout is being piped"));
}

#[test]
fn attached_input_section_leads_with_path_size_and_a_blank_line_before_the_preview() {
    let mut c = ctx("/home/user", memory(&[("/", &["macOS"])]));
    c.attached_input_path = Some("/tmp/wrap-scratch-abc/input".into());
    c.attached_input_size = Some(16);
    c.attached_input_preview = Some("some log content".into());
    let text = format_context(&c);
    assert!(text.starts_with(
        "## Attached input\nPath: /tmp/wrap-scratch-abc/input (16B)\n\nsome log content\n\n## System facts"
    ));

    c.attached_input_size = Some(2048);
    assert!(format_context(&c).contains("Path: /tmp/wrap-scratch-abc/input (2K)"));
    c.attached_input_size = Some(3 * 1024 * 1024);
    assert!(format_context(&c).contains("(3M)"));
    c.attached_input_size = None;
    assert!(format_context(&c).contains("Path: /tmp/wrap-scratch-abc/input\n\n"));
}

#[test]
fn truncated_preview_announces_itself_and_no_preview_means_no_section() {
    let mut c = ctx("/home/user", memory(&[]));
    c.attached_input_path = Some("/tmp/wrap-scratch-abc/input".into());
    c.attached_input_size = Some(500);
    c.attached_input_preview = Some("shortened preview".into());
    c.attached_input_truncated = true;
    let text = format_context(&c);
    assert!(text.contains(
        "Path: /tmp/wrap-scratch-abc/input (500B)\nPreview truncated — the file on disk carries the full original bytes.\n\nshortened preview"
    ));

    c.attached_input_truncated = false;
    assert!(!format_context(&c).contains("Preview truncated"));

    c.attached_input_preview = None;
    assert!(!format_context(&c).contains("## Attached input"));
}
