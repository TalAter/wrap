//! Process-wide resolved config, set once at startup and read everywhere.

use std::sync::{Arc, RwLock};

use super::ResolvedConfig;

static STORE: RwLock<Option<Arc<ResolvedConfig>>> = RwLock::new(None);

/// Replace the current config wholesale.
pub fn set_config(config: ResolvedConfig) {
    *STORE.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(config));
}

/// Panics when called before `set_config`.
pub fn get_config() -> Arc<ResolvedConfig> {
    STORE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .expect("Config accessed before initialization")
}

/// Patch the current config in place. Panics when called before `set_config`.
pub fn update_config(f: impl FnOnce(&mut ResolvedConfig)) {
    let mut guard = STORE.write().unwrap_or_else(|e| e.into_inner());
    let current = guard
        .as_ref()
        .expect("Config accessed before initialization");
    let mut next = (**current).clone();
    f(&mut next);
    *guard = Some(Arc::new(next));
}
