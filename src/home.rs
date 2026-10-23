//! Filesystem handle scoped to Wrap's data directory (`$WRAP_HOME`, default `~/.wrap`).

use std::collections::HashMap;
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WrapHome {
    root: PathBuf,
}

impl WrapHome {
    /// `WRAP_HOME` when non-empty, else `~/.wrap` (home from `HOME` in `env`,
    /// falling back to the OS home directory).
    pub fn from_env(env: &HashMap<String, String>) -> WrapHome {
        if let Some(root) = env.get("WRAP_HOME").filter(|v| !v.is_empty()) {
            return WrapHome::new(root);
        }
        let home = env
            .get("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(std::env::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        WrapHome::new(home.join(".wrap"))
    }

    pub fn new(root: impl Into<PathBuf>) -> WrapHome {
        WrapHome { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Join `root` with a relative path. No `..` guarding — callers are trusted.
    pub fn resolve(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    /// `Ok(None)` when the file does not exist; an existing empty file reads as `Some("")`.
    pub fn read(&self, rel: &str) -> io::Result<Option<String>> {
        match fs::read_to_string(self.resolve(rel)) {
            Ok(content) => Ok(Some(content)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Overwrite a file, creating parent directories as needed.
    pub fn write(&self, rel: &str, content: &str) -> io::Result<()> {
        let path = self.resolve(rel);
        ensure_parent(&path)?;
        fs::write(path, content)
    }

    /// Append to a file, creating it and its parent directories as needed.
    pub fn append(&self, rel: &str, content: &str) -> io::Result<()> {
        let path = self.resolve(rel);
        ensure_parent(&path)?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        file.write_all(content.as_bytes())
    }

    /// True for an existing file or directory. Follows symlinks, so a dangling
    /// symlink reads as absent.
    pub fn exists(&self, rel: &str) -> bool {
        self.resolve(rel).exists()
    }
}

fn ensure_parent(path: &Path) -> io::Result<()> {
    match path.parent() {
        Some(parent) => fs::create_dir_all(parent),
        None => Ok(()),
    }
}
