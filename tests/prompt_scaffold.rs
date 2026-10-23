use wrap::llm::{LlmMessage, Role};
use wrap::prompt::{
    FewShotExample, PromptConfig, QueryContext, assemble_prompt_scaffold, build_prompt_scaffold,
    optimized,
};

fn config() -> PromptConfig {
    PromptConfig {
        instruction: "You are a CLI tool.".into(),
        schema_instruction: "Respond with JSON:".into(),
        schema_text: "z.object({ type: z.string() })".into(),
        memory_recency_instruction: "Later facts override earlier ones.".into(),
        tools_scope_instruction: "Tools are not exhaustive.".into(),
        voice_instructions: "Be concise.".into(),
        temp_dir_principle: "Use $WRAP_TEMP_DIR for intermediate artifacts.".into(),
        final_flag_instruction: "Set final: false for non-terminal discovery steps.".into(),
        wrap_note_instruction: "<wrap-note> tags are session metadata.".into(),
        attached_input_instruction: None,
        few_shot_examples: vec![FewShotExample {
            input: "list files".into(),
            output: r#"{"type":"command","content":"ls"}"#.into(),
        }],
        few_shot_separator: "Now handle the following request.".into(),
        section_user_request: "## User's request".into(),
    }
}

fn user(s: &str) -> LlmMessage {
    LlmMessage {
        role: Role::User,
        content: s.into(),
    }
}
fn assistant(s: &str) -> LlmMessage {
    LlmMessage {
        role: Role::Assistant,
        content: s.into(),
    }
}

#[test]
fn system_joins_every_instruction_part_with_blank_lines_in_order() {
    let scaffold = build_prompt_scaffold(&config(), "");
    assert_eq!(
        scaffold.system,
        "You are a CLI tool.\n\nLater facts override earlier ones.\n\nTools are not exhaustive.\n\nBe concise.\n\nUse $WRAP_TEMP_DIR for intermediate artifacts.\n\nSet final: false for non-terminal discovery steps.\n\n<wrap-note> tags are session metadata.\n\nRespond with JSON:\nz.object({ type: z.string() })"
    );
    assert!(!scaffold.system.contains("\n\n\n"));
}

#[test]
fn schema_block_omitted_when_schema_text_is_empty() {
    let mut c = config();
    c.schema_text = String::new();
    let scaffold = build_prompt_scaffold(&c, "");
    assert!(!scaffold.system.contains("Respond with JSON:"));
    assert!(
        scaffold
            .system
            .ends_with("<wrap-note> tags are session metadata.")
    );
}

#[test]
fn attached_input_instruction_slots_before_the_schema_block_when_present() {
    let mut c = config();
    c.attached_input_instruction = Some("stdin lives at $WRAP_TEMP_DIR/input".into());
    let scaffold = build_prompt_scaffold(&c, "");
    assert!(scaffold.system.contains(
        "<wrap-note> tags are session metadata.\n\nstdin lives at $WRAP_TEMP_DIR/input\n\nRespond with JSON:"
    ));
}

#[test]
fn few_shot_examples_become_pairs_followed_by_the_separator() {
    let mut c = config();
    c.few_shot_examples = vec![
        FewShotExample {
            input: "first".into(),
            output: "out1".into(),
        },
        FewShotExample {
            input: "second".into(),
            output: "out2".into(),
        },
    ];
    let scaffold = build_prompt_scaffold(&c, "");
    assert_eq!(
        scaffold.prefix_messages,
        vec![
            user("first"),
            assistant("out1"),
            user("second"),
            assistant("out2"),
            user("Now handle the following request."),
        ]
    );
}

#[test]
fn no_examples_means_no_prefix_messages_at_all() {
    let mut c = config();
    c.few_shot_examples.clear();
    assert!(build_prompt_scaffold(&c, "").prefix_messages.is_empty());
}

#[test]
fn context_string_and_section_header_pass_through_verbatim() {
    let scaffold = build_prompt_scaffold(&config(), "## System facts\n- macOS");
    assert_eq!(scaffold.context_string, "## System facts\n- macOS");
    assert_eq!(scaffold.section_user_request, "## User's request");
    assert_eq!(build_prompt_scaffold(&config(), "").context_string, "");
}

#[test]
fn assembled_scaffold_uses_the_optimized_instruction_and_schema_text() {
    let ctx = QueryContext {
        cwd: "/home/user".into(),
        ..Default::default()
    };
    let scaffold = assemble_prompt_scaffold(&ctx);
    assert!(scaffold.system.contains(&optimized().instruction));
    assert!(scaffold.system.contains(&optimized().schema_text));
    let examples = optimized().few_shot_examples.len();
    let expected = if examples > 0 { examples * 2 + 1 } else { 0 };
    assert_eq!(scaffold.prefix_messages.len(), expected);
    assert_eq!(scaffold.section_user_request, "## User's request");
}

#[test]
fn attached_input_instruction_enters_the_system_prompt_only_with_a_preview() {
    let without = assemble_prompt_scaffold(&QueryContext {
        cwd: "/home/user".into(),
        ..Default::default()
    });
    assert!(!without.system.contains("$WRAP_TEMP_DIR/input"));

    let with = assemble_prompt_scaffold(&QueryContext {
        cwd: "/home/user".into(),
        attached_input_path: Some("/tmp/wrap-scratch-abc/input".into()),
        attached_input_size: Some(9),
        attached_input_preview: Some("some data".into()),
        ..Default::default()
    });
    assert!(with.system.contains("$WRAP_TEMP_DIR/input"));
    assert!(with.system.contains("file on disk"));
    assert!(with.context_string.contains("## Attached input"));
}

#[test]
fn optimized_schema_text_mirrors_the_schema_source() {
    assert_eq!(
        optimized().schema_text.trim(),
        include_str!("../src/prompt/schema.txt").trim()
    );
}
