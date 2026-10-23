//! SGR escapes, terminal color-level detection, palette quantization and
//! OKLAB gradients shared by the stderr chrome and the Ratatui dialogs.

use std::collections::HashMap;

use ratatui::style::Color;

pub type Rgb = (u8, u8, u8);

pub const ESC: &str = "\x1b[";
pub const RESET: &str = "\x1b[0m";
pub const SHOW_CURSOR: &str = "\x1b[?25h";
pub const HIDE_CURSOR: &str = "\x1b[?25l";
pub const ERASE_LINE: &str = "\x1b[2K";

pub fn bold(text: &str) -> String {
    format!("{ESC}1m{text}{RESET}")
}

pub fn dim(text: &str) -> String {
    format!("{ESC}2m{text}{RESET}")
}

/// Truecolor foreground; callers wanting adaptive output use [`fg_code`].
pub fn fg(text: &str, rgb: Rgb) -> String {
    format!("{}{text}{RESET}", fg_code(rgb, 3))
}

/// SGR foreground escape for `rgb` at `level`; empty at level 0.
pub fn fg_code(rgb: Rgb, level: u8) -> String {
    let (r, g, b) = rgb;
    match level {
        0 => String::new(),
        1 => format!("{ESC}{}m", nearest16_sgr(rgb)),
        2 => format!("{ESC}38;5;{}m", to256(rgb)),
        _ => format!("{ESC}38;2;{r};{g};{b}m"),
    }
}

pub fn strip_ansi(text: &str) -> String {
    static SGR: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new("\\x1b\\[[0-9;]*m").unwrap());
    SGR.replace_all(text, "").into_owned()
}

const TRUECOLOR_ENV_VARS: [&str; 6] = [
    "KITTY_WINDOW_ID",
    "WT_SESSION",
    "ALACRITTY_LOG",
    "ALACRITTY_SOCKET",
    "KONSOLE_VERSION",
    "WEZTERM_EXECUTABLE",
];
const TRUECOLOR_TERM_PROGRAMS: [&str; 5] = ["iTerm.app", "vscode", "ghostty", "WezTerm", "Hyper"];
const LOW_COLOR_TERMS: [&str; 6] = ["linux", "vt100", "vt220", "vt320", "ansi", "cons25"];

/// 0 = mono, 1 = 16 colors, 2 = 256 colors, 3 = truecolor.
///
/// `NO_COLOR` wins outright; `FORCE_COLOR` (clamped to 0..=3, non-numeric
/// means 1) bypasses the TTY check; then the terminal's own hints decide.
/// A bare modern `TERM` such as `xterm` gets 256 colors: emulators lie
/// about their capability far more often than they lack it.
pub fn color_level(is_tty: bool, env: &HashMap<String, String>) -> u8 {
    if env.contains_key("NO_COLOR") {
        return 0;
    }
    if let Some(force) = env.get("FORCE_COLOR") {
        return force
            .trim()
            .parse::<i64>()
            .map(|n| n.clamp(0, 3) as u8)
            .unwrap_or(1);
    }
    if !is_tty {
        return 0;
    }
    let term = env.get("TERM").map(String::as_str).unwrap_or_default();
    if term == "dumb" {
        return 0;
    }
    if matches!(
        env.get("COLORTERM").map(String::as_str),
        Some("truecolor" | "24bit")
    ) {
        return 3;
    }
    if TRUECOLOR_ENV_VARS.iter().any(|key| env.contains_key(*key)) {
        return 3;
    }
    if env
        .get("TERM_PROGRAM")
        .is_some_and(|program| TRUECOLOR_TERM_PROGRAMS.contains(&program.as_str()))
    {
        return 3;
    }
    if env
        .get("VTE_VERSION")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .is_some_and(|v| v >= 3600)
    {
        return 3;
    }
    if term.contains("-256") {
        return 2;
    }
    if LOW_COLOR_TERMS.contains(&term) {
        return 1;
    }
    2
}

/// Snap `color` to what `level` can display: `Reset` at level 0, the xterm
/// cube or grayscale ramp at level 2, the nearest basic color at level 1.
pub fn quantize(color: Color, level: u8) -> Color {
    if level == 0 {
        return Color::Reset;
    }
    let Color::Rgb(r, g, b) = color else {
        return color;
    };
    match level {
        1 => BASIC_COLORS[nearest16_index((r, g, b))],
        2 => Color::Indexed(to256((r, g, b))),
        _ => color,
    }
}

fn nearest16_index((r, g, b): Rgb) -> usize {
    ansi16::ALL
        .iter()
        .enumerate()
        .min_by_key(|(_, (pr, pg, pb))| {
            (i32::from(r) - i32::from(*pr)).pow(2)
                + (i32::from(g) - i32::from(*pg)).pow(2)
                + (i32::from(b) - i32::from(*pb)).pow(2)
        })
        .map_or(7, |(i, _)| i)
}

/// SGR code of the nearest basic color: 30-37, then 90-97.
fn nearest16_sgr(rgb: Rgb) -> usize {
    let i = nearest16_index(rgb);
    if i < 8 { 30 + i } else { 82 + i }
}

/// The real xterm cube levels, not an even split of 0-255.
const CUBE_LEVELS: [i32; 6] = [0, 95, 135, 175, 215, 255];

/// xterm-256 index: the grayscale ramp (232-255) for neutral colors, which
/// it fits far better than the cube, otherwise the nearest cube cell.
fn to256((r, g, b): Rgb) -> u8 {
    if r == g && g == b {
        return if r < 8 {
            16
        } else if r > 248 {
            231
        } else {
            (((f64::from(r) - 8.0) / 246.0 * 24.0).round() as u8).saturating_add(232)
        };
    }
    let closest = |c: u8| {
        CUBE_LEVELS
            .iter()
            .enumerate()
            .min_by_key(|(_, v)| (i32::from(c) - **v).abs())
            .map_or(0, |(i, _)| i as u8)
    };
    16 + 36 * closest(r) + 6 * closest(g) + closest(b)
}

/// The 16 ANSI colors in SGR order: 30-37 then 90-97.
pub const BASIC_COLORS: [Color; 16] = [
    Color::Black,
    Color::Red,
    Color::Green,
    Color::Yellow,
    Color::Blue,
    Color::Magenta,
    Color::Cyan,
    Color::Gray,
    Color::DarkGray,
    Color::LightRed,
    Color::LightGreen,
    Color::LightYellow,
    Color::LightBlue,
    Color::LightMagenta,
    Color::LightCyan,
    Color::White,
];

/// Default xterm RGB per basic slot. Terminals remap these through the user's
/// palette, so a theme pins an `ansi16` override to land on a known slot.
pub mod ansi16 {
    use super::Rgb;

    pub const BLACK: Rgb = (0, 0, 0);
    pub const RED: Rgb = (170, 0, 0);
    pub const GREEN: Rgb = (0, 170, 0);
    pub const YELLOW: Rgb = (170, 85, 0);
    pub const BLUE: Rgb = (0, 0, 170);
    pub const MAGENTA: Rgb = (170, 0, 170);
    pub const CYAN: Rgb = (0, 170, 170);
    pub const WHITE: Rgb = (170, 170, 170);
    pub const BRIGHT_BLACK: Rgb = (85, 85, 85);
    pub const BRIGHT_RED: Rgb = (255, 85, 85);
    pub const BRIGHT_GREEN: Rgb = (85, 255, 85);
    pub const BRIGHT_YELLOW: Rgb = (255, 255, 85);
    pub const BRIGHT_BLUE: Rgb = (85, 85, 255);
    pub const BRIGHT_MAGENTA: Rgb = (255, 85, 255);
    pub const BRIGHT_CYAN: Rgb = (85, 255, 255);
    pub const BRIGHT_WHITE: Rgb = (255, 255, 255);

    /// Same order as [`super::BASIC_COLORS`].
    pub const ALL: [Rgb; 16] = [
        BLACK,
        RED,
        GREEN,
        YELLOW,
        BLUE,
        MAGENTA,
        CYAN,
        WHITE,
        BRIGHT_BLACK,
        BRIGHT_RED,
        BRIGHT_GREEN,
        BRIGHT_YELLOW,
        BRIGHT_BLUE,
        BRIGHT_MAGENTA,
        BRIGHT_CYAN,
        BRIGHT_WHITE,
    ];
}

type Oklab = palette::Oklab<f32>;

fn to_oklab((r, g, b): Rgb) -> Oklab {
    use palette::FromColor;
    Oklab::from_color(palette::Srgb::new(r, g, b).into_format::<f32>())
}

fn from_oklab(lab: Oklab) -> Rgb {
    use palette::FromColor;
    let rgb: palette::Srgb<u8> = palette::Srgb::from_color(lab).into_format();
    (rgb.red, rgb.green, rgb.blue)
}

fn lerp_oklab(a: Oklab, b: Oklab, t: f32) -> Oklab {
    use palette::Mix;
    a.mix(b, t)
}

/// Position `t` along the piecewise gradient, in OKLAB.
fn interpolate_oklab(stops: &[Rgb], t: f32) -> Oklab {
    let t = if t.is_nan() { 0.0 } else { t.clamp(0.0, 1.0) };
    match stops {
        [] => to_oklab((0, 0, 0)),
        [only] => to_oklab(*only),
        _ => {
            let segments = stops.len() - 1;
            let scaled = t * segments as f32;
            let seg = (scaled.floor() as usize).min(segments - 1);
            lerp_oklab(
                to_oklab(stops[seg]),
                to_oklab(stops[seg + 1]),
                scaled - seg as f32,
            )
        }
    }
}

/// Perceptual (OKLAB) interpolation across `stops` at `t` in `0..=1`.
pub fn interpolate(stops: &[Rgb], t: f32) -> Rgb {
    from_oklab(interpolate_oklab(stops, t))
}

/// Two-stop OKLAB blend at `t` in `0..=1`.
pub fn gradient(start: Rgb, end: Rgb, t: f32) -> Rgb {
    interpolate(&[start, end], t)
}

/// Per-cell rendering of `text` across an OKLAB gradient: each entry is a
/// bare space or an SGR escape glued to its character. A shine at
/// `shine_pos` blends cells within `shine_radius` toward white. Below
/// truecolor the gradient collapses to the first stop (banding would be
/// worse than a solid), and at level 0 the cells carry no escapes.
pub fn gradient_cells(
    text: &str,
    stops: &[Rgb],
    shine_pos: Option<f32>,
    shine_radius: f32,
    level: u8,
) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let solid = (level == 1 || level == 2).then(|| {
        stops
            .first()
            .map_or(String::new(), |stop| fg_code(*stop, level))
    });
    let white = to_oklab((255, 255, 255));
    chars
        .iter()
        .enumerate()
        .map(|(i, ch)| {
            if *ch == ' ' || level == 0 {
                return ch.to_string();
            }
            if let Some(esc) = &solid {
                return format!("{esc}{ch}");
            }
            let t = if len > 1 {
                i as f32 / (len - 1) as f32
            } else {
                0.0
            };
            let mut lab = interpolate_oklab(stops, t);
            if let Some(pos) = shine_pos {
                let dist = (i as f32 - pos).abs();
                if dist < shine_radius {
                    let boost = (1.0 - dist / shine_radius).powi(2);
                    lab = lerp_oklab(lab, white, boost);
                }
            }
            format!("{}{ch}", fg_code(from_oklab(lab), level))
        })
        .collect()
}

/// [`gradient_cells`] joined, terminated with a reset when colored.
pub fn gradient_text(
    text: &str,
    stops: &[Rgb],
    shine_pos: Option<f32>,
    shine_radius: f32,
    level: u8,
) -> String {
    let cells = gradient_cells(text, stops, shine_pos, shine_radius, level);
    if cells.is_empty() {
        return String::new();
    }
    let joined = cells.concat();
    if level == 0 { joined } else { joined + RESET }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn level(is_tty: bool, pairs: &[(&str, &str)]) -> u8 {
        color_level(is_tty, &env(pairs))
    }

    #[test]
    fn bold_and_dim_wrap_text_and_reset() {
        assert_eq!(bold("hello"), "\x1b[1mhello\x1b[0m");
        assert_eq!(dim("hello"), "\x1b[2mhello\x1b[0m");
        assert_eq!(fg("hi", (255, 0, 128)), "\x1b[38;2;255;0;128mhi\x1b[0m");
    }

    #[test]
    fn fg_code_adapts_to_color_level() {
        assert_eq!(fg_code((255, 0, 128), 3), "\x1b[38;2;255;0;128m");
        assert_eq!(fg_code((255, 0, 0), 2), "\x1b[38;5;196m");
        assert_eq!(fg_code((128, 128, 128), 2), "\x1b[38;5;244m");
        assert_eq!(fg_code((0, 0, 0), 2), "\x1b[38;5;16m");
        assert_eq!(fg_code((255, 255, 255), 2), "\x1b[38;5;231m");
        assert_eq!(fg_code((250, 250, 80), 1), "\x1b[93m");
        assert_eq!(fg_code((170, 170, 170), 1), "\x1b[37m");
        assert_eq!(fg_code((255, 0, 0), 0), "");
    }

    #[test]
    fn strip_ansi_removes_sgr_sequences_only() {
        assert_eq!(
            strip_ansi(&format!("{} {}", bold("hello"), fg("world", (1, 2, 3)))),
            "hello world"
        );
        assert_eq!(strip_ansi("plain text"), "plain text");
        assert_eq!(strip_ansi("\x1b[?25lx"), "\x1b[?25lx");
    }

    #[test]
    fn color_level_honors_explicit_opt_out_and_opt_in_first() {
        assert_eq!(level(true, &[("NO_COLOR", ""), ("FORCE_COLOR", "3")]), 0);
        assert_eq!(level(false, &[("FORCE_COLOR", "3")]), 3);
        assert_eq!(level(false, &[("FORCE_COLOR", "2")]), 2);
        assert_eq!(level(true, &[("FORCE_COLOR", "0")]), 0);
        assert_eq!(level(true, &[("FORCE_COLOR", "")]), 1);
        assert_eq!(level(true, &[("FORCE_COLOR", "foo")]), 1);
        assert_eq!(level(true, &[("FORCE_COLOR", "99")]), 3);
        assert_eq!(level(true, &[("FORCE_COLOR", "-1")]), 0);
    }

    #[test]
    fn color_level_sniffs_terminal_capabilities() {
        assert_eq!(level(false, &[("COLORTERM", "truecolor")]), 0);
        assert_eq!(
            level(true, &[("TERM", "dumb"), ("COLORTERM", "truecolor")]),
            0
        );
        assert_eq!(
            level(true, &[("TERM", "xterm"), ("COLORTERM", "truecolor")]),
            3
        );
        assert_eq!(level(true, &[("TERM", "xterm"), ("COLORTERM", "24bit")]), 3);
        assert_eq!(
            level(true, &[("TERM", "xterm"), ("KITTY_WINDOW_ID", "1")]),
            3
        );
        assert_eq!(level(true, &[("TERM", "xterm"), ("WT_SESSION", "x")]), 3);
        assert_eq!(
            level(true, &[("TERM", "xterm"), ("WEZTERM_EXECUTABLE", "x")]),
            3
        );
        assert_eq!(
            level(true, &[("TERM", "xterm"), ("TERM_PROGRAM", "iTerm.app")]),
            3
        );
        assert_eq!(
            level(true, &[("TERM", "xterm"), ("TERM_PROGRAM", "ghostty")]),
            3
        );
        assert_eq!(
            level(
                true,
                &[
                    ("TERM", "xterm-256color"),
                    ("TERM_PROGRAM", "Apple_Terminal")
                ]
            ),
            2
        );
        assert_eq!(
            level(true, &[("TERM", "xterm"), ("VTE_VERSION", "3600")]),
            3
        );
        assert_eq!(
            level(true, &[("TERM", "xterm"), ("VTE_VERSION", "3599")]),
            2
        );
        assert_eq!(level(true, &[("TERM", "xterm-256color")]), 2);
        assert_eq!(level(true, &[("TERM", "screen-256")]), 2);
        for term in ["xterm", "screen", "tmux", "rxvt", "alacritty", "kitty"] {
            assert_eq!(level(true, &[("TERM", term)]), 2, "{term}");
        }
        for term in ["linux", "vt100", "vt220", "vt320", "ansi", "cons25"] {
            assert_eq!(level(true, &[("TERM", term)]), 1, "{term}");
        }
        assert_eq!(level(true, &[]), 2);
    }

    #[test]
    fn quantize_snaps_to_what_the_level_can_show() {
        assert_eq!(quantize(Color::Rgb(1, 2, 3), 0), Color::Reset);
        assert_eq!(quantize(Color::Indexed(5), 0), Color::Reset);
        assert_eq!(quantize(Color::Rgb(1, 2, 3), 3), Color::Rgb(1, 2, 3));
        assert_eq!(quantize(Color::Indexed(5), 2), Color::Indexed(5));
        assert_eq!(quantize(Color::LightRed, 1), Color::LightRed);
        assert_eq!(quantize(Color::Rgb(255, 0, 0), 2), Color::Indexed(196));
        assert_eq!(quantize(Color::Rgb(175, 95, 0), 2), Color::Indexed(130));
        assert_eq!(quantize(Color::Rgb(128, 128, 128), 2), Color::Indexed(244));
        assert_eq!(quantize(Color::Rgb(4, 4, 4), 2), Color::Indexed(16));
        assert_eq!(quantize(Color::Rgb(250, 250, 250), 2), Color::Indexed(231));
        assert_eq!(quantize(Color::Rgb(255, 255, 85), 1), Color::LightYellow);
        assert_eq!(quantize(Color::Rgb(170, 85, 0), 1), Color::Yellow);
        assert_eq!(quantize(Color::Rgb(0, 0, 0), 1), Color::Black);
        assert_eq!(quantize(Color::Rgb(170, 170, 170), 1), Color::Gray);
        assert_eq!(quantize(Color::Rgb(250, 250, 250), 1), Color::White);
    }

    #[test]
    fn interpolate_hits_stops_exactly_and_mixes_perceptually() {
        let stops = [(255, 100, 200), (60, 60, 100)];
        assert_eq!(interpolate(&stops, 0.0), (255, 100, 200));
        assert_eq!(interpolate(&stops, 1.0), (60, 60, 100));
        let three = [(255, 0, 0), (0, 255, 0), (0, 0, 255)];
        assert_eq!(interpolate(&three, 0.5), (0, 255, 0));
        assert_eq!(interpolate(&[(9, 9, 9)], 0.7), (9, 9, 9));
        let (r, g, b) = interpolate(&[(255, 0, 0), (0, 255, 0)], 0.5);
        assert!(u16::from(r) + u16::from(g) > 300, "not muddy: {r} {g} {b}");
        assert!(b < 40);
        assert_eq!(gradient((80, 160, 255), (40, 60, 100), 0.5), (60, 108, 174));
    }

    fn truecolor_escapes(s: &str) -> Vec<(u8, u8, u8)> {
        let re = regex::Regex::new(r"\x1b\[38;2;(\d+);(\d+);(\d+)m").unwrap();
        re.captures_iter(s)
            .map(|c| {
                (
                    c[1].parse().unwrap(),
                    c[2].parse().unwrap(),
                    c[3].parse().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn gradient_text_colors_each_glyph_and_resets_at_the_end() {
        let stops = [(255, 0, 0), (0, 0, 255)];
        let out = gradient_text("abcdefghij", &stops, None, 4.0, 3);
        assert_eq!(strip_ansi(&out), "abcdefghij");
        assert!(out.ends_with(RESET));
        let colors = truecolor_escapes(&out);
        assert_eq!(colors.len(), 10);
        assert!(colors[0].0 >= 250 && colors[0].2 < 100);
        assert!(colors[9].2 >= 250 && colors[9].0 < 100);
        assert_eq!(gradient_text("", &stops, None, 4.0, 3), "");
        assert_eq!(strip_ansi(&gradient_text("x", &stops, None, 4.0, 3)), "x");
    }

    #[test]
    fn gradient_cells_keep_spaces_bare_and_one_entry_per_char() {
        let stops = [(255, 0, 0), (0, 0, 255)];
        let cells = gradient_cells("a b", &stops, None, 4.0, 3);
        assert_eq!(cells.len(), 3);
        assert_eq!(cells[1], " ");
        assert!(cells[0].ends_with('a') && cells[0].starts_with("\x1b[38;2;"));
        assert!(gradient_cells("", &stops, None, 4.0, 3).is_empty());
    }

    #[test]
    fn gradient_shine_brightens_only_near_its_position() {
        let stops = [(100, 0, 0), (0, 0, 100)];
        let plain = gradient_text("abcdefghij", &stops, None, 4.0, 3);
        let shiny = gradient_text("abcdefghij", &stops, Some(5.0), 4.0, 3);
        assert_ne!(plain, shiny);
        assert_eq!(strip_ansi(&shiny), "abcdefghij");
        let (p, s) = (truecolor_escapes(&plain), truecolor_escapes(&shiny));
        assert!(s[5].0 > p[5].0 && s[5].1 > p[5].1 && s[5].2 > p[5].2);
        assert_eq!(p[0], s[0], "cells outside the radius are untouched");
        assert_eq!(
            gradient_text("abcde", &stops, Some(-20.0), 4.0, 3),
            gradient_text("abcde", &stops, None, 4.0, 3)
        );
    }

    #[test]
    fn gradient_collapses_below_truecolor_and_vanishes_at_level_zero() {
        let stops = [(255, 0, 0), (0, 0, 255)];
        assert_eq!(gradient_text("hello", &stops, Some(2.0), 4.0, 0), "hello");
        let cells = gradient_cells("hello", &stops, Some(2.0), 4.0, 0);
        assert_eq!(cells, vec!["h", "e", "l", "l", "o"]);
        let sixteen = gradient_text("hello", &stops, None, 4.0, 1);
        assert!(!sixteen.contains("38;2;") && !sixteen.contains("38;5;"));
        assert_eq!(strip_ansi(&sixteen), "hello");
        let codes: std::collections::HashSet<&str> = regex::Regex::new(r"\x1b\[(\d+)m")
            .unwrap()
            .captures_iter(&sixteen)
            .map(|c| c.get(1).unwrap().as_str())
            .filter(|c| *c != "0")
            .collect();
        assert_eq!(codes, std::collections::HashSet::from(["31"]));
        let two56 = gradient_text("hello", &stops, None, 4.0, 2);
        assert!(two56.matches("\x1b[38;5;196m").count() == 5);
    }
}
