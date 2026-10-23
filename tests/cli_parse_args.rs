use std::collections::{HashMap, HashSet};
use wrap::cli::{Input, ModifierSpec, Modifiers, modifier_specs, parse_args};

fn specs() -> Vec<ModifierSpec> {
    vec![
        ModifierSpec {
            name: "verbose",
            flags: vec!["--verbose"],
            takes_value: false,
        },
        ModifierSpec {
            name: "model",
            flags: vec!["--model", "--provider"],
            takes_value: true,
        },
    ]
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn mods(flags: &[&str], values: &[(&str, &str)]) -> Modifiers {
    Modifiers {
        flags: flags.iter().map(|s| s.to_string()).collect::<HashSet<_>>(),
        values: values
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<HashMap<_, _>>(),
    }
}

fn parse(list: &[&str]) -> (Modifiers, Input) {
    parse_args(&args(list), &specs()).unwrap()
}

fn prompt(s: &str) -> Input {
    Input::Prompt(s.to_string())
}

fn flag(f: &str, rest: &[&str]) -> Input {
    Input::Flag {
        flag: f.to_string(),
        args: args(rest),
    }
}

#[test]
fn no_args_yields_no_modifiers_and_no_input() {
    assert_eq!(parse(&[]), (mods(&[], &[]), Input::None));
}

#[test]
fn leading_boolean_modifier_is_extracted_before_prompt_or_flag() {
    assert_eq!(
        parse(&["--verbose", "find", "files"]),
        (mods(&["verbose"], &[]), prompt("find files"))
    );
    assert_eq!(
        parse(&["--verbose", "--help"]),
        (mods(&["verbose"], &[]), flag("--help", &[]))
    );
    assert_eq!(
        parse(&["--verbose"]),
        (mods(&["verbose"], &[]), Input::None)
    );
}

#[test]
fn modifiers_in_non_leading_positions_stay_in_the_input() {
    assert_eq!(
        parse(&["find", "--verbose", "files"]),
        (mods(&[], &[]), prompt("find --verbose files"))
    );
    assert_eq!(
        parse(&["--help", "--verbose"]),
        (mods(&[], &[]), flag("--help", &["--verbose"]))
    );
    assert_eq!(
        parse(&["find", "--model", "anthropic", "files"]),
        (mods(&[], &[]), prompt("find --model anthropic files"))
    );
}

#[test]
fn boolean_modifier_rejects_equals_form() {
    assert_eq!(
        parse_args(&args(&["--verbose=true", "find"]), &specs()).unwrap_err(),
        "Config error: --verbose does not take a value."
    );
}

#[test]
fn value_modifier_accepts_space_and_equals_forms_and_aliases() {
    assert_eq!(
        parse(&["--model", "anthropic", "find", "files"]),
        (mods(&[], &[("model", "anthropic")]), prompt("find files"))
    );
    assert_eq!(
        parse(&["--model=anthropic:claude-opus-4-5", "hi"]),
        (
            mods(&[], &[("model", "anthropic:claude-opus-4-5")]),
            prompt("hi")
        )
    );
    assert_eq!(
        parse(&["--provider=openai", "do", "thing"]),
        (mods(&[], &[("model", "openai")]), prompt("do thing"))
    );
    assert_eq!(
        parse(&["--provider", "openai"]),
        (mods(&[], &[("model", "openai")]), Input::None)
    );
}

#[test]
fn value_modifier_keeps_empty_values() {
    assert_eq!(
        parse(&["--model", "", "hi"]),
        (mods(&[], &[("model", "")]), prompt("hi"))
    );
    assert_eq!(
        parse(&["--model=", "hi"]),
        (mods(&[], &[("model", "")]), prompt("hi"))
    );
}

#[test]
fn modifiers_combine_in_any_order_and_last_value_wins() {
    let expected = (
        mods(&["verbose"], &[("model", "gpt-4o")]),
        prompt("find files"),
    );
    assert_eq!(
        parse(&["--verbose", "--model", "gpt-4o", "find", "files"]),
        expected
    );
    assert_eq!(
        parse(&["--model", "gpt-4o", "--verbose", "find", "files"]),
        expected
    );
    assert_eq!(
        parse(&["--model", "anthropic", "--provider", "openai", "go"]),
        (mods(&[], &[("model", "openai")]), prompt("go"))
    );
}

#[test]
fn value_modifier_without_a_value_is_an_error() {
    for list in [vec!["--model"], vec!["--model", "--verbose", "find"]] {
        assert_eq!(
            parse_args(&args(&list), &specs()).unwrap_err(),
            "Config error: --model requires a value.",
            "{list:?}"
        );
    }
    assert_eq!(
        parse_args(&args(&["--provider"]), &specs()).unwrap_err(),
        "Config error: --provider requires a value."
    );
}

#[test]
fn empty_specs_extract_nothing() {
    assert_eq!(
        parse_args(&args(&["--verbose", "find"]), &[]).unwrap(),
        (mods(&[], &[]), flag("--verbose", &["find"]))
    );
}

#[test]
fn custom_specs_including_short_flags_work() {
    let custom = vec![
        ModifierSpec {
            name: "logLevel",
            flags: vec!["--log", "-l"],
            takes_value: true,
        },
        ModifierSpec {
            name: "dryRun",
            flags: vec!["--dry"],
            takes_value: false,
        },
    ];
    assert_eq!(
        parse_args(&args(&["--dry", "-l", "debug", "go"]), &custom).unwrap(),
        (mods(&["dryRun"], &[("logLevel", "debug")]), prompt("go"))
    );
}

#[test]
fn input_flag_collects_everything_after_it_as_args() {
    assert_eq!(parse(&["--log"]), (mods(&[], &[]), flag("--log", &[])));
    assert_eq!(
        parse(&["--log", "symlink to", "10"]),
        (mods(&[], &[]), flag("--log", &["symlink to", "10"]))
    );
    assert_eq!(
        parse(&["--log", "term", "--raw"]),
        (mods(&[], &[]), flag("--log", &["term", "--raw"]))
    );
    assert_eq!(
        parse(&["-h", "--log"]),
        (mods(&[], &[]), flag("-h", &["--log"]))
    );
    assert_eq!(
        parse(&["-rf", "foo"]),
        (mods(&[], &[]), flag("-rf", &["foo"]))
    );
    assert_eq!(
        parse(&["--log-pretty"]),
        (mods(&[], &[]), flag("--log-pretty", &[]))
    );
}

#[test]
fn dash_words_after_the_first_are_natural_language() {
    assert_eq!(
        parse(&["find", "files", "with", "--verbose"]),
        (mods(&[], &[]), prompt("find files with --verbose"))
    );
}

#[test]
fn modifier_specs_are_derived_from_flagged_settings() {
    let specs = modifier_specs();
    let by_name: HashMap<&str, &ModifierSpec> = specs.iter().map(|s| (s.name, s)).collect();
    let model = by_name["model"];
    assert_eq!(model.flags, vec!["--model", "--provider"]);
    assert!(model.takes_value);
    assert_eq!(by_name["verbose"].flags, vec!["--verbose"]);
    assert!(!by_name["verbose"].takes_value);
    assert_eq!(by_name["continue"].flags, vec!["-c", "--continue"]);
    assert!(!by_name["noAnimation"].takes_value);
    assert_eq!(by_name["logTraces"].flags, vec!["--log-traces"]);
    assert!(by_name["yolo"].flags.contains(&"--yolo"));
    for flagless in ["maxRounds", "nerdFonts", "defaultProvider"] {
        assert!(!by_name.contains_key(flagless), "{flagless}");
    }
    let mut seen = HashSet::new();
    for spec in &specs {
        for f in &spec.flags {
            assert!(seen.insert(*f), "duplicate flag {f}");
        }
    }
}
