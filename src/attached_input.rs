//! Piped stdin as attached input: raw-byte capture plus the UTF-8 preview the
//! prompt carries.

use std::io::{IsTerminal, Read};

/// Raw stdin bytes when Wrap is in a pipe. `None` when stdin is a TTY (never
/// read), the pipe carried nothing, or every byte is ASCII whitespace — so
/// `echo "" | w help` is not a query with attached input.
pub fn read_attached_input(
    is_tty: bool,
    read: impl FnOnce() -> std::io::Result<Vec<u8>>,
) -> std::io::Result<Option<Vec<u8>>> {
    if is_tty {
        return Ok(None);
    }
    let bytes = read()?;
    if bytes.is_empty() || is_ascii_whitespace(&bytes) {
        return Ok(None);
    }
    Ok(Some(bytes))
}

/// [`read_attached_input`] over the process's real stdin.
pub fn read_attached_stdin() -> std::io::Result<Option<Vec<u8>>> {
    let stdin = std::io::stdin();
    read_attached_input(stdin.is_terminal(), || {
        let mut bytes = Vec::new();
        stdin.lock().read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}

fn is_ascii_whitespace(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .all(|b| matches!(b, 0x20 | 0x09 | 0x0a | 0x0b | 0x0c | 0x0d))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachedInputPreview {
    pub preview: String,
    pub truncated: bool,
}

/// UTF-8 decode and fit to `max_chars`. Non-UTF-8 bytes yield a one-line
/// summary instead of mojibake; the file on disk keeps the original bytes.
pub fn build_attached_input_preview(bytes: &[u8], max_chars: usize) -> AttachedInputPreview {
    let Ok(decoded) = std::str::from_utf8(bytes) else {
        return AttachedInputPreview {
            preview: format!("Binary content — {} bytes, not previewable.", bytes.len()),
            truncated: false,
        };
    };
    if decoded.chars().count() <= max_chars {
        return AttachedInputPreview {
            preview: decoded.to_string(),
            truncated: false,
        };
    }
    AttachedInputPreview {
        preview: truncate_middle(decoded, max_chars),
        truncated: true,
    }
}

/// Keep the head and tail of `text` within roughly `max_chars` characters,
/// splitting at newlines when possible, with an indicator line in between.
/// The indicator may push the result ~80 chars over the budget. Unchanged
/// input when it already fits.
pub fn truncate_middle(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    if total <= max_chars {
        return text.to_string();
    }

    let budget = max_chars.saturating_sub(80).max(20);
    let head_budget = budget.div_ceil(2);
    let tail_budget = budget - head_budget;

    let mut head_end = head_budget.min(total);
    if let Some(last_newline) = chars[..=head_end.min(total - 1)]
        .iter()
        .rposition(|c| *c == '\n')
        .filter(|i| *i > 0)
    {
        head_end = last_newline;
    }

    let mut tail_start = total.saturating_sub(tail_budget).max(head_end);
    if let Some(offset) = chars[tail_start.min(total)..]
        .iter()
        .position(|c| *c == '\n')
    {
        tail_start = tail_start + offset + 1;
    }
    if tail_start <= head_end {
        tail_start = total;
    }

    let head: String = chars[..head_end].iter().collect();
    let tail: String = if tail_start < total {
        chars[tail_start..].iter().collect()
    } else {
        String::new()
    };
    let tail_len = total.saturating_sub(tail_start.min(total));
    format!(
        "{head}\n[…truncated, showing first {head_end} and last {tail_len} of {total} chars]\n{tail}"
    )
}
