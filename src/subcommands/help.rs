//! `--help`: the full help page (plain, styled, or with the logo shine
//! animation) and per-flag help.

use std::io::Write;
use std::thread;
use std::time::Duration;

use crate::ansi::{
    HIDE_CURSOR, RESET, Rgb, SHOW_CURSOR, bold, color_level, dim, fg_code, gradient_cells,
    gradient_text,
};
use crate::chrome::{chrome, chrome_raw, register_exit_teardown};
use crate::theme::{get_theme, resolve_rgb};

use super::registry::{self, CliFlag, FlagKind, commands, options};
use super::{Context, supports_color};

pub fn flag() -> CliFlag {
    registry::command(
        "--help",
        &["-h"],
        "help",
        "Show this help",
        "w --help [command]",
        Some(
            "You already know this. You're here.\n\nRun it with a command name for help on that command, e.g. w --help log"
                .to_string(),
        ),
        None,
    )
}

const LOGO: [&str; 6] = [
    "██╗    ██╗██████╗  █████╗ ██████╗ ",
    "██║    ██║██╔══██╗██╔══██╗██╔══██╗",
    "██║ █╗ ██║██████╔╝███████║██████╔╝",
    "██║███╗██║██╔══██╗██╔══██║██╔═══╝ ",
    "╚███╔███╔╝██║  ██║██║  ██║██║     ",
    " ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ",
];
const LOGO_WIDTH: usize = 34;

// ZX Spectrum rainbow: decorative, identical in both themes.
const SPECTRUM: [Rgb; 7] = [
    (255, 51, 51),
    (255, 136, 0),
    (255, 204, 0),
    (51, 204, 51),
    (0, 204, 204),
    (51, 102, 255),
    (204, 51, 255),
];
const INDENT: &str = "  ";
const FLAG_COLUMN: usize = 24;

const FRAMES: usize = 16;
const FRAME_DELAY: Duration = Duration::from_millis(60);
const SHINE_RADIUS: usize = 4;

fn bar() -> String {
    format!("{INDENT}{}", "─".repeat(LOGO_WIDTH))
}

/// Bar, indented logo lines, bar: the rows the shine animates over.
fn art_lines() -> Vec<String> {
    std::iter::once(bar())
        .chain(LOGO.iter().map(|l| format!("{INDENT}{l}")))
        .chain(std::iter::once(bar()))
        .collect()
}

fn format_flags(flags: &[CliFlag], colorize: Option<&dyn Fn(&str) -> String>) -> Vec<String> {
    flags
        .iter()
        .map(|c| {
            // "w --flag [args]" → "--flag [args]"
            let hint = c
                .usage
                .strip_prefix('w')
                .filter(|rest| rest.starts_with(char::is_whitespace))
                .map(str::trim_start)
                .unwrap_or(&c.usage);
            let column = format!("{INDENT}{hint}");
            let padding = " ".repeat(FLAG_COLUMN.saturating_sub(column.chars().count()).max(1));
            let column = colorize.map_or_else(|| column.clone(), |f| f(&column));
            format!("{column}{padding}{}", c.description)
        })
        .collect()
}

const EXAMPLES_PLAIN: [&str; 7] = [
    "Examples:",
    "  wrap copy the contents of my .env file to clipboard, mask any IP addresses",
    "      wrap writes the shell command for your request and runs it after",
    "      you confirm",
    "  wrap",
    "      launch interactive mode — compose a multiline prompt in a friendly",
    "      editor",
];

pub fn render_plain(commands: &[CliFlag], options: &[CliFlag]) -> String {
    let mut lines: Vec<String> = vec![
        "wrap - natural language shell commands".into(),
        String::new(),
        "Usage: w <prompt>         Run a natural language query".into(),
        String::new(),
    ];
    lines.extend(EXAMPLES_PLAIN.iter().map(|l| l.to_string()));
    lines.push(String::new());
    lines.push("Commands:".into());
    lines.extend(format_flags(commands, None));
    lines.push(String::new());
    lines.push("Options:".into());
    lines.extend(format_flags(options, None));
    format!("{}\n", lines.join("\n"))
}

pub fn render_styled(commands: &[CliFlag], options: &[CliFlag], level: u8) -> String {
    let flag_prefix = fg_code(resolve_rgb(&get_theme().copy.link, level), level);
    let flag_reset = if flag_prefix.is_empty() { "" } else { RESET };
    let colorize = |text: &str| format!("{flag_prefix}{text}{flag_reset}");
    let shine = |text: &str| gradient_text(text, &SPECTRUM, None, SHINE_RADIUS as f32, level);

    let mut lines: Vec<String> = vec![String::new()];
    lines.extend(art_lines().iter().map(|l| shine(l)));
    lines.extend([
        String::new(),
        format!("{INDENT}{}", dim("natural language shell commands")),
        String::new(),
        format!("{INDENT}{} w <prompt>", bold("Usage:")),
        String::new(),
        format!("{INDENT}{}", bold("Examples:")),
        format!(
            "    {}",
            colorize("wrap copy the contents of my .env file to clipboard, mask any IP addresses")
        ),
        format!(
            "        {}",
            dim("wrap writes the shell command for your request and runs it after")
        ),
        format!("        {}", dim("you confirm")),
        format!("    {}", colorize("wrap")),
        format!(
            "        {}",
            dim("launch interactive mode — compose a multiline prompt in a friendly")
        ),
        format!("        {}", dim("editor")),
        String::new(),
        format!("{INDENT}{}", bold("Commands:")),
    ]);
    lines.extend(format_flags(commands, Some(&colorize)));
    lines.push(String::new());
    lines.push(format!("{INDENT}{}", bold("Options:")));
    lines.extend(format_flags(options, Some(&colorize)));
    lines.push(String::new());
    format!("{}\n", lines.join("\n"))
}

pub fn render_flag_help(flag: &CliFlag) -> String {
    let mut lines = vec![
        flag.usage.clone(),
        String::new(),
        format!("  {}", flag.description),
    ];
    if let Some(help) = &flag.help {
        lines.push(String::new());
        lines.push(help.clone());
    }
    if let FlagKind::Option { env, .. } = &flag.kind
        && !env.is_empty()
    {
        lines.push(String::new());
        lines.push(format!("  Env: {}", env.join(", ")));
    }
    format!("{}\n", lines.join("\n"))
}

/// The animation returns to the logo with cursor-up. When the page is
/// taller than the viewport the styled write scrolls the logo away,
/// cursor-up clamps at the top and frames paint over the help text, so the
/// animation only runs when the whole page fits. Unknown height is trusted.
pub fn animation_fits(content_rows: usize, terminal_rows: Option<u16>) -> bool {
    match terminal_rows {
        Some(rows) if rows > 0 => content_rows <= rows as usize,
        _ => true,
    }
}

fn smoothstep(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

fn build_frame(shine_pos: Option<f32>, level: u8) -> Vec<Vec<String>> {
    art_lines()
        .iter()
        .map(|line| gradient_cells(line, &SPECTRUM, shine_pos, SHINE_RADIUS as f32, level))
        .collect()
}

/// Escape sequence painting only the cells of `curr` that differ from
/// `prev` (every cell when there is no baseline): fewer bytes on the wire
/// and no flicker from full rewrites on slow terminals.
///
/// The cursor enters and leaves at column 0 of the first art row.
pub fn build_diff_escape(prev: Option<&[Vec<String>]>, curr: &[Vec<String>]) -> String {
    let mut out = String::new();
    let mut at_row = 0;
    for (row, line) in curr.iter().enumerate() {
        let prev_line = prev.and_then(|p| p.get(row));
        let dirty: Vec<usize> = (0..line.len())
            .filter(|&c| prev_line.is_none_or(|p| p.get(c) != Some(&line[c])))
            .collect();
        let (Some(&min), Some(&max)) = (dirty.first(), dirty.last()) else {
            continue;
        };
        let dy = row - at_row;
        if dy > 0 {
            out.push_str(&format!("\x1b[{dy}B"));
        }
        out.push('\r');
        if min > 0 {
            out.push_str(&format!("\x1b[{min}C"));
        }
        for cell in &line[min..=max] {
            out.push_str(cell);
        }
        out.push_str(RESET);
        at_row = row;
    }
    if at_row > 0 {
        out.push_str(&format!("\x1b[{at_row}A"));
    }
    out.push('\r');
    out
}

fn render_animated(
    commands: &[CliFlag],
    options: &[CliFlag],
    level: u8,
    terminal_rows: Option<u16>,
    out: &mut dyn Write,
) -> std::io::Result<()> {
    let styled = render_styled(commands, options, level);
    // The shine blends white into the gradient, which needs truecolor;
    // below that the logo is a solid and there is nothing to animate.
    if level < 3 {
        return out.write_all(styled.as_bytes());
    }
    let total_rows = styled.matches('\n').count();
    let art_start = 1;
    let up = total_rows - art_start;
    if !animation_fits(total_rows, terminal_rows) {
        return out.write_all(styled.as_bytes());
    }

    out.write_all(styled.as_bytes())?;
    out.flush()?;

    // Ctrl+C mid-animation: restore the cursor and land below the page so
    // the shell prompt does not appear on top of the help text.
    let _show_cursor = register_exit_teardown(SHOW_CURSOR);
    let landing: &'static str = Box::leak(format!("\r\x1b[{up}B\n").into_boxed_str());
    let _landing = register_exit_teardown(landing);
    chrome_raw(HIDE_CURSOR);

    let result = (|| {
        write!(out, "\x1b[{up}A")?;
        // The baseline matches the styled page, so frame 0 is a no-op diff
        // that still takes its delay: total duration stays FRAMES × DELAY.
        let mut prev = build_frame(None, level);
        for frame in 0..FRAMES {
            let t = smoothstep(frame as f32 / (FRAMES - 1) as f32);
            let shine_pos =
                (t * (LOGO_WIDTH + 2 * SHINE_RADIUS) as f32).round() - SHINE_RADIUS as f32;
            let curr = build_frame(Some(shine_pos), level);
            out.write_all(build_diff_escape(Some(&prev), &curr).as_bytes())?;
            out.flush()?;
            prev = curr;
            thread::sleep(FRAME_DELAY);
        }
        write!(out, "\x1b[{up}B")?;
        out.flush()
    })();
    chrome_raw(SHOW_CURSOR);
    result
}

pub fn run(args: &[String], ctx: &Context, out: &mut dyn Write) -> i32 {
    let commands = commands();
    let options = options();

    if args.is_empty() {
        let level = color_level(ctx.stdout_is_tty, ctx.env);
        let _ = if !ctx.config.no_animation && ctx.stdout_is_tty {
            render_animated(&commands, &options, level, ctx.terminal_rows, out)
        } else if supports_color(ctx.stdout_is_tty, ctx.env) {
            out.write_all(render_styled(&commands, &options, level).as_bytes())
        } else {
            out.write_all(render_plain(&commands, &options).as_bytes())
        };
        return 0;
    }

    if args.len() > 1 {
        chrome("--help takes at most one argument.", None);
        return 1;
    }

    let name = args[0].strip_prefix("--").unwrap_or(&args[0]);
    let wanted = format!("--{name}");
    let Some(flag) = commands
        .iter()
        .chain(options.iter())
        .find(|f| f.flag == wanted)
    else {
        chrome(&format!("Unknown flag: {}", args[0]), None);
        return 1;
    };
    let _ = out.write_all(render_flag_help(flag).as_bytes());
    0
}
