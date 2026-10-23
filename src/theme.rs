//! Theme tokens for dark and light terminals, the active-theme store, and
//! appearance detection (env, config, hour-old cache, terminal probe).

use std::collections::HashMap;
use std::io::IsTerminal;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};

use ratatui::style::Color;

use crate::ansi::{Rgb, ansi16, quantize};

// ── Token types ──────────────────────────────────────────────────

/// Truecolor base with optional overrides for the palettes where the
/// automatic snap would land on a harsh slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ColorRef {
    pub base: Rgb,
    pub ansi16: Option<Rgb>,
    pub ansi256: Option<Rgb>,
}

impl ColorRef {
    pub const fn rgb(base: Rgb) -> Self {
        Self {
            base,
            ansi16: None,
            ansi256: None,
        }
    }

    pub const fn with_ansi16(base: Rgb, ansi16: Rgb) -> Self {
        Self {
            base,
            ansi16: Some(ansi16),
            ansi256: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenPair {
    pub fg: ColorRef,
    pub bg: ColorRef,
}

pub type FrameStops = [Rgb; 2];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CopyTokens {
    pub body: ColorRef,
    pub supporting: ColorRef,
    pub note: ColorRef,
    pub unavailable: ColorRef,
    pub link: ColorRef,
    pub pop: ColorRef,
    pub success: ColorRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DialogTokens {
    pub status: ColorRef,
    pub prompt: ColorRef,
    pub output_label: ColorRef,
    pub output_text: ColorRef,
    pub explanation: ColorRef,
    pub plan: ColorRef,
    pub fold_indicator: TokenPair,
    pub compose_pill: TokenPair,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputTokens {
    pub surface: ColorRef,
    pub text: ColorRef,
    pub placeholder: ColorRef,
    pub editor_status: ColorRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActionBarTokens {
    pub label: ColorRef,
    pub selected: ColorRef,
    pub shortcut: ColorRef,
    pub shortcut_primary: ColorRef,
    pub selected_shortcut: ColorRef,
    pub selected_shortcut_primary: ColorRef,
    pub selected_bg: ColorRef,
    pub separator: ColorRef,
    pub success: ColorRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChecklistTokens {
    pub row: ColorRef,
    pub row_checked: ColorRef,
    pub row_focused: ColorRef,
    pub row_focused_bg: ColorRef,
    pub section_label: ColorRef,
    pub section_rule: ColorRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PickerTokens {
    pub option: ColorRef,
    pub option_focused: ColorRef,
    pub option_selected: ColorRef,
    pub focus_indicator: ColorRef,
    pub selected_indicator: ColorRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WizardTokens {
    pub frame: FrameStops,
    pub label_pill: TokenPair,
    pub step_done: TokenPair,
    pub step_active: TokenPair,
    pub step_pending: TokenPair,
    pub provider_link: ColorRef,
    pub nerd_choice_marker: ColorRef,
    pub nerd_choice_label: ColorRef,
    pub nerd_choice_selected_label: ColorRef,
    pub welcome_logo: FrameStops,
    pub welcome_brain: &'static [Rgb],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RiskTokens {
    pub frame: FrameStops,
    pub pill: TokenPair,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RiskSet {
    pub low: RiskTokens,
    pub medium: RiskTokens,
    pub high: RiskTokens,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForgetTokens {
    pub frame: FrameStops,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub copy: CopyTokens,
    pub dialog: DialogTokens,
    pub input: InputTokens,
    pub action_bar: ActionBarTokens,
    pub checklist: ChecklistTokens,
    pub picker: PickerTokens,
    pub wizard: WizardTokens,
    pub risk: RiskSet,
    pub forget: ForgetTokens,
}

// ── Palettes ─────────────────────────────────────────────────────

const fn c(r: u8, g: u8, b: u8) -> ColorRef {
    ColorRef::rgb((r, g, b))
}

const fn pair(fg: Rgb, bg: Rgb) -> TokenPair {
    TokenPair {
        fg: ColorRef::rgb(fg),
        bg: ColorRef::rgb(bg),
    }
}

const DARK_NOTE: ColorRef = ColorRef::with_ansi16((115, 115, 140), ansi16::WHITE);
const DARK_POP: ColorRef = ColorRef::with_ansi16((245, 186, 74), ansi16::BRIGHT_YELLOW);
const DARK_SUCCESS: ColorRef = ColorRef::with_ansi16((120, 230, 160), ansi16::GREEN);
const DARK_WARNING: RiskTokens = RiskTokens {
    frame: [(255, 100, 200), (60, 60, 100)],
    pill: pair((255, 200, 80), (80, 50, 20)),
};
const DARK_DANGER: RiskTokens = RiskTokens {
    frame: [(255, 60, 80), (60, 60, 100)],
    pill: pair((255, 100, 100), (80, 25, 25)),
};

pub static DARK: Theme = Theme {
    copy: CopyTokens {
        body: c(210, 210, 225),
        supporting: c(170, 170, 195),
        note: DARK_NOTE,
        unavailable: c(65, 65, 80),
        link: c(120, 180, 255),
        pop: DARK_POP,
        success: DARK_SUCCESS,
    },
    dialog: DialogTokens {
        status: c(210, 210, 225),
        prompt: c(210, 210, 225),
        output_label: DARK_NOTE,
        output_text: c(170, 170, 195),
        explanation: DARK_NOTE,
        plan: c(120, 180, 255),
        fold_indicator: pair((210, 210, 225), (60, 60, 100)),
        compose_pill: pair((102, 204, 136), (25, 70, 60)),
    },
    input: InputTokens {
        surface: c(35, 35, 50),
        text: c(210, 210, 225),
        placeholder: DARK_NOTE,
        editor_status: DARK_NOTE,
    },
    action_bar: ActionBarTokens {
        label: DARK_NOTE,
        selected: c(210, 210, 225),
        shortcut: c(170, 170, 195),
        shortcut_primary: DARK_POP,
        selected_shortcut: c(210, 210, 225),
        selected_shortcut_primary: DARK_POP,
        selected_bg: c(55, 45, 80),
        separator: c(65, 65, 80),
        success: DARK_SUCCESS,
    },
    checklist: ChecklistTokens {
        row: DARK_NOTE,
        row_checked: DARK_SUCCESS,
        row_focused: c(210, 210, 225),
        row_focused_bg: c(26, 42, 77),
        section_label: c(170, 170, 195),
        section_rule: c(60, 60, 100),
    },
    picker: PickerTokens {
        option: c(170, 170, 195),
        option_focused: c(210, 210, 225),
        option_selected: DARK_SUCCESS,
        focus_indicator: c(210, 210, 225),
        selected_indicator: DARK_SUCCESS,
    },
    wizard: WizardTokens {
        frame: [(120, 180, 255), (60, 60, 100)],
        label_pill: pair((210, 210, 225), (30, 50, 90)),
        step_done: pair((130, 220, 160), (40, 90, 60)),
        step_active: pair((180, 200, 255), (60, 80, 160)),
        step_pending: pair((100, 100, 140), (50, 50, 80)),
        provider_link: DARK_NOTE,
        nerd_choice_marker: DARK_POP,
        nerd_choice_label: DARK_NOTE,
        nerd_choice_selected_label: c(210, 210, 225),
        welcome_logo: [(179, 179, 179), (255, 255, 255)],
        welcome_brain: &[(245, 186, 74), (206, 114, 255), (94, 214, 255)],
    },
    risk: RiskSet {
        low: RiskTokens {
            frame: [(80, 220, 200), (60, 60, 100)],
            pill: pair((102, 204, 136), (25, 70, 60)),
        },
        medium: DARK_WARNING,
        high: DARK_DANGER,
    },
    forget: ForgetTokens {
        frame: [(255, 60, 80), (60, 60, 100)],
    },
};

const LIGHT_WARNING: RiskTokens = RiskTokens {
    frame: [(175, 35, 115), (170, 170, 195)],
    pill: pair((160, 95, 0), (248, 232, 200)),
};
const LIGHT_DANGER: RiskTokens = RiskTokens {
    frame: [(190, 25, 45), (170, 170, 195)],
    pill: pair((190, 25, 45), (248, 218, 218)),
};

pub static LIGHT: Theme = Theme {
    copy: CopyTokens {
        body: c(0, 0, 0),
        supporting: c(45, 45, 70),
        note: c(105, 105, 130),
        unavailable: c(175, 175, 195),
        link: c(25, 90, 190),
        pop: c(255, 165, 50),
        success: c(15, 125, 55),
    },
    dialog: DialogTokens {
        status: c(0, 0, 0),
        prompt: c(0, 0, 0),
        output_label: c(105, 105, 130),
        output_text: c(45, 45, 70),
        explanation: c(105, 105, 130),
        plan: c(25, 90, 190),
        fold_indicator: pair((45, 45, 70), (210, 215, 230)),
        compose_pill: pair((15, 125, 55), (215, 238, 220)),
    },
    input: InputTokens {
        surface: c(218, 232, 250),
        text: c(0, 0, 0),
        placeholder: c(105, 105, 130),
        editor_status: c(105, 105, 130),
    },
    action_bar: ActionBarTokens {
        label: c(105, 105, 130),
        selected: c(0, 0, 0),
        shortcut: c(45, 45, 70),
        shortcut_primary: c(255, 165, 50),
        selected_shortcut: c(0, 0, 0),
        selected_shortcut_primary: c(255, 165, 50),
        selected_bg: c(220, 215, 238),
        separator: c(175, 175, 195),
        success: c(15, 125, 55),
    },
    checklist: ChecklistTokens {
        row: c(105, 105, 130),
        row_checked: c(15, 125, 55),
        row_focused: c(0, 0, 0),
        row_focused_bg: c(210, 220, 245),
        section_label: c(45, 45, 70),
        section_rule: c(170, 170, 195),
    },
    picker: PickerTokens {
        option: c(45, 45, 70),
        option_focused: c(0, 0, 0),
        option_selected: c(15, 125, 55),
        focus_indicator: c(0, 0, 0),
        selected_indicator: c(15, 125, 55),
    },
    wizard: WizardTokens {
        frame: [(25, 90, 190), (170, 170, 195)],
        label_pill: pair((10, 20, 90), (150, 175, 220)),
        step_done: pair((15, 110, 55), (210, 240, 215)),
        step_active: pair((30, 75, 190), (210, 225, 250)),
        step_pending: pair((130, 130, 155), (220, 220, 230)),
        provider_link: c(105, 105, 130),
        nerd_choice_marker: c(255, 165, 50),
        nerd_choice_label: c(105, 105, 130),
        nerd_choice_selected_label: c(0, 0, 0),
        welcome_logo: [(160, 121, 191), (79, 94, 133)],
        welcome_brain: &[(211, 76, 243), (29, 227, 235)],
    },
    risk: RiskSet {
        low: RiskTokens {
            frame: [(15, 150, 130), (170, 170, 195)],
            pill: pair((15, 125, 55), (215, 238, 220)),
        },
        medium: LIGHT_WARNING,
        high: LIGHT_DANGER,
    },
    forget: ForgetTokens {
        frame: [(190, 25, 45), (170, 170, 195)],
    },
};

// ── Appearance ───────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    Dark,
    Light,
}

impl Appearance {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "dark" => Some(Self::Dark),
            "light" => Some(Self::Light),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}

pub fn theme_for(appearance: Appearance) -> &'static Theme {
    match appearance {
        Appearance::Dark => &DARK,
        Appearance::Light => &LIGHT,
    }
}

/// The tuple a token uses at `level`: its override when one matches, else
/// the base. For callers that build SGR escapes themselves.
pub fn resolve_rgb(color: &ColorRef, level: u8) -> Rgb {
    match level {
        1 => color.ansi16.unwrap_or(color.base),
        2 => color.ansi256.unwrap_or(color.base),
        _ => color.base,
    }
}

/// [`resolve_rgb`] snapped to what `level` can display.
pub fn resolve_color(color: &ColorRef, level: u8) -> Color {
    let (r, g, b) = resolve_rgb(color, level);
    quantize(Color::Rgb(r, g, b), level)
}

// ── Active theme store ───────────────────────────────────────────

/// 0 = dark, 1 = light.
static ACTIVE: AtomicU8 = AtomicU8::new(0);

pub fn set_theme(appearance: Appearance) {
    ACTIVE.store(
        match appearance {
            Appearance::Dark => 0,
            Appearance::Light => 1,
        },
        Ordering::Relaxed,
    );
}

pub fn get_appearance() -> Appearance {
    match ACTIVE.load(Ordering::Relaxed) {
        1 => Appearance::Light,
        _ => Appearance::Dark,
    }
}

pub fn get_theme() -> &'static Theme {
    theme_for(get_appearance())
}

// ── Appearance detection ─────────────────────────────────────────

const CACHE_FILE: &str = "cache/appearance.json";
const CACHE_TTL_MS: u64 = 60 * 60 * 1000;
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DetectedAppearance {
    pub appearance: Appearance,
    /// Set only when the terminal probe produced the answer.
    probed_at: Option<u64>,
}

impl DetectedAppearance {
    /// Caches a probe result for an hour; env, config and cache answers are
    /// never rewritten. Best-effort: an unwritable home is not an error.
    pub fn persist(&self, home_root: &Path) {
        let Some(now) = self.probed_at else {
            return;
        };
        let path = home_root.join(CACHE_FILE);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let body = serde_json::json!({ "appearance": self.appearance.name(), "ts": now });
        let _ = std::fs::write(path, body.to_string());
    }
}

/// `WRAP_THEME` → config → fresh cache → terminal probe → dark. Nothing is
/// written; call [`DetectedAppearance::persist`] to cache a probe result.
pub fn detect_appearance(
    home_root: &Path,
    env: &HashMap<String, String>,
    config_appearance: Option<Appearance>,
) -> DetectedAppearance {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    appearance_with(
        home_root,
        env.get("WRAP_THEME").map(String::as_str),
        config_appearance,
        now,
        probe_terminal_background,
    )
}

/// Asks the terminal for its background color over stderr. Only when
/// stderr is a terminal, and bounded so a mute terminal costs two seconds
/// at most.
fn probe_terminal_background() -> Option<Appearance> {
    if !std::io::stderr().is_terminal() {
        return None;
    }
    let mut options = terminal_colorsaurus::QueryOptions::default();
    options.timeout = PROBE_TIMEOUT;
    let color = terminal_colorsaurus::background_color(options).ok()?;
    Some(appearance_for_background(color.scale_to_8bit()))
}

fn appearance_with(
    home_root: &Path,
    env_override: Option<&str>,
    config_appearance: Option<Appearance>,
    now_ms: u64,
    probe: impl FnOnce() -> Option<Appearance>,
) -> DetectedAppearance {
    let known = |appearance| DetectedAppearance {
        appearance,
        probed_at: None,
    };
    if let Some(appearance) = env_override.and_then(Appearance::parse) {
        return known(appearance);
    }
    if let Some(appearance) = config_appearance {
        return known(appearance);
    }
    if let Some(appearance) = cached_appearance(home_root, now_ms) {
        return known(appearance);
    }
    match probe() {
        Some(appearance) => DetectedAppearance {
            appearance,
            probed_at: Some(now_ms),
        },
        None => known(Appearance::Dark),
    }
}

/// The cache is an optimization only: anything unreadable or malformed
/// reads as a miss.
fn cached_appearance(home_root: &Path, now_ms: u64) -> Option<Appearance> {
    let bytes = std::fs::read(home_root.join(CACHE_FILE)).ok()?;
    let cache: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let appearance = cache["appearance"].as_str().and_then(Appearance::parse)?;
    let ts = cache["ts"].as_u64()?;
    (ts.saturating_add(CACHE_TTL_MS) >= now_ms).then_some(appearance)
}

/// WCAG relative luminance over 0.5 reads as a light background.
fn appearance_for_background((r, g, b): Rgb) -> Appearance {
    let luminance = (0.2126 * f64::from(r) + 0.7152 * f64::from(g) + 0.0722 * f64::from(b)) / 255.0;
    if luminance > 0.5 {
        Appearance::Light
    } else {
        Appearance::Dark
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_tiers_reuse_the_core_severity_frames_and_pills() {
        assert_eq!(theme_for(Appearance::Dark).copy.body.base, (210, 210, 225));
        assert_eq!(theme_for(Appearance::Light).copy.body.base, (0, 0, 0));
        assert_eq!(DARK.risk.medium.frame, [(255, 100, 200), (60, 60, 100)]);
        assert_eq!(DARK.risk.high.pill.bg.base, (80, 25, 25));
        assert_eq!(LIGHT.risk.medium.pill.fg.base, (160, 95, 0));
        assert_eq!(LIGHT.risk.high.frame, [(190, 25, 45), (170, 170, 195)]);
        assert_eq!(DARK.dialog.output_label.ansi16, Some(ansi16::WHITE));
        assert_eq!(LIGHT.dialog.output_label.ansi16, None);
    }

    #[test]
    fn resolve_color_applies_the_override_matching_the_level_then_quantizes() {
        let plain = ColorRef::rgb((245, 186, 74));
        assert_eq!(resolve_color(&plain, 3), Color::Rgb(245, 186, 74));
        let with16 = ColorRef::with_ansi16((245, 186, 74), (170, 85, 0));
        assert_eq!(resolve_color(&with16, 3), Color::Rgb(245, 186, 74));
        assert_eq!(resolve_color(&with16, 1), Color::Yellow);
        assert_eq!(resolve_rgb(&with16, 1), (170, 85, 0));
        let with256 = ColorRef {
            base: (245, 186, 74),
            ansi16: None,
            ansi256: Some((175, 95, 0)),
        };
        assert_eq!(resolve_color(&with256, 2), Color::Indexed(130));
        assert_eq!(resolve_color(&with256, 1), resolve_color(&plain, 1));
        assert_eq!(resolve_color(&with16, 2), resolve_color(&plain, 2));
        assert_eq!(resolve_color(&with16, 0), Color::Reset);
    }

    #[test]
    fn theme_store_round_trips_and_defaults_to_dark() {
        assert_eq!(get_appearance(), Appearance::Dark);
        set_theme(Appearance::Light);
        assert_eq!(get_appearance(), Appearance::Light);
        assert!(std::ptr::eq(get_theme(), &LIGHT));
        set_theme(Appearance::Dark);
        assert!(std::ptr::eq(get_theme(), &DARK));
    }

    #[test]
    fn background_luminance_splits_dark_from_light() {
        assert_eq!(
            appearance_for_background((0x28, 0x2c, 0x34)),
            Appearance::Dark
        );
        assert_eq!(
            appearance_for_background((0x40, 0x40, 0x40)),
            Appearance::Dark
        );
        assert_eq!(
            appearance_for_background((0xc0, 0xc0, 0xc0)),
            Appearance::Light
        );
        assert_eq!(
            appearance_for_background((0xff, 0xff, 0xff)),
            Appearance::Light
        );
    }

    fn write_cache(home: &Path, body: &str) {
        std::fs::create_dir_all(home.join("cache")).unwrap();
        std::fs::write(home.join(CACHE_FILE), body).unwrap();
    }

    #[test]
    fn env_then_config_then_fresh_cache_short_circuit_the_probe() {
        let home = tempfile::tempdir().unwrap();
        write_cache(home.path(), r#"{"appearance":"light","ts":1000}"#);
        let probe = || panic!("probe must not run");
        let detect = |env: Option<&str>, cfg, now| {
            appearance_with(home.path(), env, cfg, now, probe).appearance
        };
        assert_eq!(
            detect(Some("dark"), Some(Appearance::Light), 2000),
            Appearance::Dark
        );
        assert_eq!(
            detect(Some("light"), Some(Appearance::Dark), 2000),
            Appearance::Light
        );
        assert_eq!(detect(None, Some(Appearance::Dark), 2000), Appearance::Dark);
        assert_eq!(detect(None, None, 2000), Appearance::Light);
        assert_eq!(detect(Some("auto"), None, 2000), Appearance::Light);
        assert_eq!(
            detect(Some("midnight"), None, 1000 + CACHE_TTL_MS),
            Appearance::Light
        );
    }

    #[test]
    fn stale_or_broken_cache_falls_through_to_the_probe_then_dark() {
        let home = tempfile::tempdir().unwrap();
        let probe_light = || Some(Appearance::Light);
        let detect = |now| appearance_with(home.path(), None, None, now, probe_light);
        assert_eq!(detect(5000).appearance, Appearance::Light, "no cache");
        assert_eq!(detect(5000).probed_at, Some(5000));
        write_cache(home.path(), r#"{"appearance":"dark","ts":1000}"#);
        assert_eq!(
            detect(1000 + CACHE_TTL_MS + 1).appearance,
            Appearance::Light
        );
        for body in [
            "not valid json{",
            r#"{"appearance":"midnight","ts":1000}"#,
            r#"{"appearance":"dark","ts":"yesterday"}"#,
            r#"{"appearance":"dark"}"#,
        ] {
            write_cache(home.path(), body);
            assert_eq!(detect(1500).appearance, Appearance::Light, "{body}");
        }
        std::fs::remove_file(home.path().join(CACHE_FILE)).unwrap();
        let fallback = appearance_with(home.path(), None, None, 1, || None);
        assert_eq!(fallback.appearance, Appearance::Dark);
        assert_eq!(fallback.probed_at, None);
    }

    #[test]
    fn only_a_probe_result_is_cached_and_only_on_persist() {
        let home = tempfile::tempdir().unwrap();
        let cache = home.path().join(CACHE_FILE);
        let probed = appearance_with(home.path(), None, None, 5000, || Some(Appearance::Light));
        assert!(
            !home.path().join("cache").exists(),
            "detection must not write"
        );
        appearance_with(home.path(), Some("dark"), None, 5000, || None).persist(home.path());
        appearance_with(home.path(), None, Some(Appearance::Dark), 5000, || None)
            .persist(home.path());
        appearance_with(home.path(), None, None, 5000, || None).persist(home.path());
        assert!(
            !cache.exists(),
            "env, config and fallback answers are not cached"
        );
        probed.persist(home.path());
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert_eq!(
            written,
            serde_json::json!({"appearance": "light", "ts": 5000})
        );
        assert_eq!(
            appearance_with(home.path(), None, None, 6000, || panic!("cache must win")).appearance,
            Appearance::Light
        );
    }

    #[test]
    fn persist_tolerates_an_unwritable_home() {
        let home = tempfile::tempdir().unwrap();
        let file_in_the_way = home.path().join("blocked");
        std::fs::write(&file_in_the_way, "").unwrap();
        appearance_with(&file_in_the_way, None, None, 5000, || {
            Some(Appearance::Light)
        })
        .persist(&file_in_the_way);
    }

    #[test]
    fn detect_appearance_reads_wrap_theme_from_the_given_env() {
        let home = tempfile::tempdir().unwrap();
        let env = HashMap::from([("WRAP_THEME".to_string(), "light".to_string())]);
        assert_eq!(
            detect_appearance(home.path(), &env, Some(Appearance::Dark)).appearance,
            Appearance::Light
        );
    }
}
