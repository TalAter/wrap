//! Ratatui dialogs on the stderr alternate screen: the terminal session and
//! drive loop, the shared dialog chrome (gradient border, pills, status),
//! the reusable widgets, and the response dialog that confirms commands.
//!
//! Everything renders in truecolor and is reduced to the terminal's color
//! level in one final buffer pass ([`apply_color_level`]), so tests can
//! assert on real token colors and degradation separately.

pub mod drive;
pub mod frame;
pub mod response_dialog;
pub mod terminal;
pub mod widgets;

pub use drive::{Dialog, Progress, draw_frame, drive};
pub use frame::{
    Align, DIALOG_CHROME_HEIGHT, DIALOG_CHROME_WIDTH, DialogFrame, PillSegment, PreparedTop,
    SizeBasis, TopBadge, bottom_border_line, content_natural_width, dialog_inner_width, fit_top,
    pill_spans, pill_width, top_border_line,
};
pub use response_dialog::{
    COPY_FLASH, ClipboardCopy, CommandDisplay, DialogSignal, EXECUTING_STEP_STATUS, EditorInfo,
    FOLLOWUP_FALLBACK_STATUS, INTERACTIVE_PLACEHOLDERS, OUTPUT_SLOT_EMPTY, ResponseDialog,
    ResponseDialogOptions, fold_command, format_output_slot, truncate_command,
};
pub use terminal::{
    SessionSignals, TerminalSession, drain_pending_input, keyboard_enhancement_active,
    restore_terminal,
};
pub use widgets::{
    ActionItem, Checklist, ChecklistEvent, ChecklistItem, Cursor, InputEvent, InputFrame,
    InputLayout, MAX_BUFFER_BYTES, Paint, Select, SelectEvent, SelectOption, TextInput,
    action_bar_line, action_bar_width, apply_color_level, clamp_buffer_size,
    format_continuation_badge, spinner_status,
};
