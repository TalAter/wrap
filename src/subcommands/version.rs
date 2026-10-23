//! `--version`: the crate version on stdout, nothing else.

use std::io::Write;

use crate::chrome::chrome;

use super::registry::{self, CliFlag};

pub fn flag() -> CliFlag {
    registry::command(
        "--version",
        &["-v"],
        "version",
        "Show version",
        "w --version",
        None,
        None,
    )
}

pub fn run(args: &[String], out: &mut dyn Write) -> i32 {
    if !args.is_empty() {
        chrome("--version does not take an argument.", None);
        return 1;
    }
    let _ = writeln!(out, "{}", env!("CARGO_PKG_VERSION"));
    0
}
