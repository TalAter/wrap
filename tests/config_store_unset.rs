use wrap::config::store::get_config;

#[test]
#[should_panic(expected = "Config accessed before initialization")]
fn reading_the_store_before_set_config_panics() {
    let _ = get_config();
}
