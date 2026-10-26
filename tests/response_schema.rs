use serde_json::{Value, json};
use wrap::response::{CommandResponse, ResponseType, RiskLevel, command_response_json_schema};

fn parse(v: Value) -> Result<CommandResponse, serde_json::Error> {
    serde_json::from_value(v)
}

#[test]
fn parses_command_and_reply_responses() {
    let cmd = parse(json!({
        "type": "command",
        "content": "find . -name '*.ts' -mtime 0",
        "risk_level": "low",
        "explanation": "Find TypeScript files modified today"
    }))
    .unwrap();
    assert_eq!(cmd.kind, ResponseType::Command);
    assert_eq!(cmd.content, "find . -name '*.ts' -mtime 0");
    assert_eq!(cmd.risk_level, RiskLevel::Low);
    assert_eq!(
        cmd.explanation.as_deref(),
        Some("Find TypeScript files modified today")
    );

    let reply = parse(json!({"type": "reply", "content": "42", "risk_level": "low"})).unwrap();
    assert_eq!(reply.kind, ResponseType::Reply);
    assert!(reply.is_final);
}

#[test]
fn rejects_legacy_and_invalid_enum_values() {
    for kind in ["answer", "probe", "invalid"] {
        assert!(parse(json!({"type": kind, "content": "x", "risk_level": "low"})).is_err());
    }
    assert!(parse(json!({"type": "command", "content": "ls", "risk_level": "extreme"})).is_err());
    for level in ["low", "medium", "high"] {
        assert!(parse(json!({"type": "command", "content": "true", "risk_level": level})).is_ok());
    }
}

#[test]
fn requires_type_content_and_risk_level() {
    assert!(parse(json!({"content": "ls", "risk_level": "low"})).is_err());
    assert!(parse(json!({"type": "command", "risk_level": "low"})).is_err());
    assert!(parse(json!({"type": "command", "content": "ls"})).is_err());
}

#[test]
fn final_defaults_to_true_and_plan_rides_non_final_steps() {
    let step = parse(json!({
        "type": "command",
        "content": "echo probe",
        "risk_level": "low",
        "final": false,
        "plan": "Download, inspect, then run from the temp dir."
    }))
    .unwrap();
    assert!(!step.is_final);
    assert_eq!(
        step.plan.as_deref(),
        Some("Download, inspect, then run from the temp dir.")
    );
    let terminal = parse(json!({"type": "command", "content": "ls", "risk_level": "low"})).unwrap();
    assert!(terminal.is_final);
    assert!(terminal.plan.is_none());
}

#[test]
fn memory_updates_require_fact_and_scope() {
    let ok = parse(json!({
        "type": "command",
        "content": "true",
        "risk_level": "medium",
        "memory_updates": [
            {"fact": "Default shell is zsh", "scope": "/"},
            {"fact": "Uses bun", "scope": "/Users/tal/project"}
        ],
        "memory_updates_message": "Noted"
    }))
    .unwrap();
    let updates = ok.memory_updates.unwrap();
    assert_eq!(updates.len(), 2);
    assert_eq!(updates[1].scope, "/Users/tal/project");
    assert_eq!(ok.memory_updates_message.as_deref(), Some("Noted"));

    assert!(
        parse(
            json!({"type": "command", "content": "ls", "risk_level": "low",
            "memory_updates": [{"fact": "Uses zsh"}]})
        )
        .is_err()
    );
    assert!(
        parse(
            json!({"type": "command", "content": "ls", "risk_level": "low",
            "memory_updates": [{"key": "shell", "value": "zsh"}]})
        )
        .is_err()
    );
}

#[test]
fn nullable_fields_accept_null_omitted_and_empty_lists() {
    let nulls = parse(json!({
        "type": "command", "content": "ls", "risk_level": "low",
        "_scratchpad": null, "plan": null, "explanation": null, "memory_updates": null,
        "memory_updates_message": null, "watchlist_additions": null
    }))
    .unwrap();
    assert!(nulls.scratchpad.is_none());
    assert!(nulls.explanation.is_none());
    assert!(nulls.memory_updates.is_none());
    assert!(nulls.watchlist_additions.is_none());

    let empty = parse(json!({
        "type": "command", "content": "ls", "risk_level": "low",
        "memory_updates": [], "watchlist_additions": []
    }))
    .unwrap();
    assert_eq!(empty.memory_updates.unwrap().len(), 0);
    assert_eq!(empty.watchlist_additions.unwrap().len(), 0);

    let listed = parse(json!({
        "type": "command", "content": "which sips", "risk_level": "low", "final": false,
        "watchlist_additions": ["sips", "convert", "magick"]
    }))
    .unwrap();
    assert_eq!(
        listed.watchlist_additions.unwrap(),
        vec!["sips", "convert", "magick"]
    );
}

#[test]
fn ignores_stray_fields_from_old_responses() {
    let r = parse(
        json!({"type": "command", "content": "wc -l", "risk_level": "low", "pipe_stdin": true}),
    )
    .unwrap();
    let back = serde_json::to_value(&r).unwrap();
    assert!(back.get("pipe_stdin").is_none());
}

#[test]
fn discard_command_roundtrips_booleans_and_omits_null_or_missing() {
    for discard in [
        Some(json!(true)),
        Some(json!(false)),
        Some(Value::Null),
        None,
    ] {
        let mut wire = json!({"type": "reply", "content": "It prints hello.", "risk_level": "low"});
        if let Some(value) = &discard {
            wire["discard_command"] = value.clone();
        }
        let response = parse(wire).unwrap();
        let back = serde_json::to_value(&response).unwrap();
        let expected = discard.filter(|value| !value.is_null());
        assert_eq!(back.get("discard_command"), expected.as_ref());
        assert_eq!(parse(back).unwrap(), response);
    }
}

#[test]
fn discard_command_rejects_non_boolean_values() {
    for invalid in [json!("true"), json!(1), json!([])] {
        assert!(
            parse(json!({
                "type": "reply", "content": "It prints hello.", "risk_level": "low",
                "discard_command": invalid
            }))
            .is_err()
        );
    }
}

#[test]
fn serializes_with_wire_names_and_drops_absent_optionals() {
    let r = parse(json!({
        "_scratchpad": "think", "type": "command", "content": "ls", "risk_level": "low"
    }))
    .unwrap();
    let back = serde_json::to_value(&r).unwrap();
    assert_eq!(
        back,
        json!({"_scratchpad": "think", "type": "command", "final": true, "content": "ls", "risk_level": "low"})
    );
    let keys: Vec<&str> = back
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["_scratchpad", "type", "final", "content", "risk_level"]
    );
}

/// Top-level property names in schema.txt, in source order (two-space
/// indented `name: z.` lines; nested object fields are indented deeper).
fn schema_txt_keys() -> Vec<String> {
    include_str!("../src/prompt/schema.txt")
        .lines()
        .filter(|line| line.starts_with("  ") && !line.starts_with("   "))
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let (name, rest) = trimmed.split_once(':')?;
            rest.trim_start().starts_with('z').then(|| name.to_string())
        })
        .collect()
}

#[test]
fn json_schema_property_order_matches_schema_txt_with_scratchpad_first() {
    let schema = command_response_json_schema();
    let props: Vec<String> = schema["properties"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(props[0], "_scratchpad");
    let expected = schema_txt_keys();
    assert_eq!(
        expected.len(),
        11,
        "schema.txt parsing drifted: {expected:?}"
    );
    assert_eq!(props, expected);
}

#[test]
fn json_schema_mirrors_zod_projection() {
    let schema = command_response_json_schema();
    assert_eq!(schema["type"], "object");
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(
        schema["required"],
        json!(["type", "final", "content", "risk_level"])
    );
    assert_eq!(
        schema["properties"]["type"]["enum"],
        json!(["command", "reply"])
    );
    assert_eq!(
        schema["properties"]["risk_level"]["enum"],
        json!(["low", "medium", "high"])
    );
    assert_eq!(schema["properties"]["final"]["default"], true);
    assert_eq!(
        schema["properties"]["discard_command"],
        json!({"anyOf": [{"type": "boolean"}, {"type": "null"}]})
    );
    assert_eq!(
        schema["properties"]["plan"],
        json!({"anyOf": [{"type": "string"}, {"type": "null"}]})
    );
    let items = &schema["properties"]["memory_updates"]["anyOf"][0]["items"];
    assert_eq!(items["required"], json!(["fact", "scope"]));
    assert_eq!(items["additionalProperties"], false);
    let item_keys: Vec<&String> = items["properties"].as_object().unwrap().keys().collect();
    assert_eq!(item_keys, ["fact", "scope"]);
}
