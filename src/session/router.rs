//! Routes notifications between three sinks depending on whether the dialog
//! is mounted and whether the session is in a live dialog state.
//!
//! - **No dialog**: straight to stderr. Chrome from the initial loop's steps
//!   and memory updates lands in real scrollback as it happens.
//! - **Dialog mounted**: buffered for replay after unmount; a direct stderr
//!   write would land in the alternate screen and vanish on exit.
//! - **Dialog mounted and live** (`processing-followup`,
//!   `processing-interactive`, `executing-step`): also handed to the
//!   coordinator, which dispatches it so the reducer can update the status
//!   line (chrome) or the output slot (step output).
//!
//! The router is the single source of truth for "is a dialog up?". The
//! coordinator unmounts the dialog *before* writing the flushed lines, so
//! they land in scrollback rather than in the alternate buffer about to
//! disappear.

use crate::chrome::Notification;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Routed {
    /// Write to stderr now.
    Stderr(Notification),
    /// Held for the flush after unmount.
    Buffered,
    /// Held for the flush, and the dialog wants it now.
    Live(Notification),
}

#[derive(Debug, Default)]
pub struct NotificationRouter {
    mounted: bool,
    buffered: Vec<Notification>,
}

impl NotificationRouter {
    pub fn new() -> NotificationRouter {
        NotificationRouter::default()
    }

    pub fn route(&mut self, notification: Notification, dialog_live: bool) -> Routed {
        if !self.mounted {
            return Routed::Stderr(notification);
        }
        self.buffered.push(notification.clone());
        if dialog_live {
            Routed::Live(notification)
        } else {
            Routed::Buffered
        }
    }

    pub fn set_dialog_mounted(&mut self) {
        self.mounted = true;
    }

    pub fn is_dialog_mounted(&self) -> bool {
        self.mounted
    }

    /// Forget the dialog and hand back everything buffered while it was up,
    /// in order. `None` when no dialog was mounted.
    pub fn teardown_dialog(&mut self) -> Option<Vec<Notification>> {
        if !self.mounted {
            return None;
        }
        self.mounted = false;
        Some(std::mem::take(&mut self.buffered))
    }
}
