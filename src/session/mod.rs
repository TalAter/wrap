//! Session: state machine vocabulary, reducer, round, loop runner,
//! notification router and the coordinator that ties them together.

pub mod coordinator;
pub mod reducer;
pub mod round;
pub mod router;
pub mod runner;
pub mod state;

pub use coordinator::{
    ContinuationParent, DialogHost, HostFuture, SessionOptions, finalise_outcome, run_session,
    run_terminal_editor,
};
pub use reducer::reduce;
pub use round::{AssistantTurn, RoundError, RoundOptions, run_round};
pub use router::{NotificationRouter, Routed};
pub use runner::{LoopEvent, LoopOptions, LoopState, Transcript, fetches_url, run_loop};
