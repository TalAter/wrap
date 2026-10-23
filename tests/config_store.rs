use std::collections::HashMap;
use wrap::cli::Modifiers;
use wrap::config::store::{get_config, set_config, update_config};
use wrap::config::{Config, resolve_settings};

fn seed(f: impl FnOnce(&mut Config)) {
    let mut c = Config::default();
    f(&mut c);
    set_config(resolve_settings(&Modifiers::default(), &HashMap::new(), &c).unwrap());
}

// The store is process-global, so every assertion lives in one test body.
#[test]
fn store_replaces_on_set_and_patches_on_update() {
    seed(|c| {
        c.verbose = Some(true);
        c.nerd_fonts = Some(false);
    });
    assert!(get_config().verbose);
    assert!(!get_config().nerd_fonts);

    seed(|c| c.max_rounds = Some(42));
    seed(|c| c.verbose = Some(true));
    assert!(get_config().verbose);
    assert_eq!(
        get_config().max_rounds,
        5,
        "set_config must replace, not merge"
    );

    seed(|c| {
        c.verbose = Some(false);
        c.max_rounds = Some(7);
    });
    update_config(|c| c.nerd_fonts = true);
    assert!(!get_config().verbose);
    assert!(get_config().nerd_fonts);
    assert_eq!(get_config().max_rounds, 7);
    update_config(|c| c.max_rounds = 10);
    assert_eq!(get_config().max_rounds, 10);
}
