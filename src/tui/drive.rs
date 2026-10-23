//! The dialog contract and the loop that runs one on an open terminal.

use std::io;

use crossterm::event::{self, Event, KeyEvent};
use ratatui::Frame;

use super::terminal::TerminalSession;

/// What a background poll produced.
pub enum Progress<E> {
    Idle,
    /// Something on screen changed; the next frame is redrawn.
    Changed,
    Exit(E),
}

/// One alternate-screen dialog driven by [`drive`].
pub trait Dialog {
    type Exit;
    fn render(&self, frame: &mut Frame<'_>);
    /// While true, idle frames still redraw every third tick for the spinner.
    fn animating(&self) -> bool;
    fn set_tick(&mut self, tick: usize);
    /// `Some` leaves the loop.
    fn key(&mut self, key: KeyEvent) -> Option<Self::Exit>;
    fn paste(&mut self, text: &str);
    /// Background results, collected after each batch of input so a cancel
    /// wins over errors caused by aborting in-flight work.
    fn poll(&mut self) -> io::Result<Progress<Self::Exit>>;
    /// The exit used when `cancelled` fires (an external signal).
    fn cancelled(&mut self) -> Self::Exit;
    /// True while the dialog wants kitty-disambiguated keys (compose states).
    fn compose_keys(&self) -> bool {
        false
    }
}

/// Draws when something changed or, while animating, every third tick.
pub fn draw_frame<B: ratatui::backend::Backend>(
    terminal: &mut ratatui::Terminal<B>,
    dirty: &mut bool,
    tick: usize,
    animating: bool,
    render: impl FnOnce(&mut Frame<'_>),
) -> Result<(), B::Error> {
    if *dirty || (animating && tick.is_multiple_of(3)) {
        terminal.draw(render)?;
        *dirty = false;
    }
    Ok(())
}

/// Runs `dialog` on an open terminal until it exits. `cancelled` is checked
/// before every frame and before every queued event, so a signal is never
/// outrun by input. Resizes mark the frame dirty.
pub async fn drive<D: Dialog>(
    dialog: &mut D,
    terminal: &mut TerminalSession,
    cancelled: impl Fn() -> bool,
) -> io::Result<D::Exit> {
    let mut dirty = true;
    let mut tick = 0usize;
    loop {
        if cancelled() {
            return Ok(dialog.cancelled());
        }
        if !TerminalSession::active() {
            return Err(io::Error::other(
                "terminal released after a background panic",
            ));
        }
        terminal.set_compose_keys(dialog.compose_keys())?;
        dialog.set_tick(tick);
        draw_frame(
            &mut terminal.terminal,
            &mut dirty,
            tick,
            dialog.animating(),
            |frame| dialog.render(frame),
        )?;
        // The /dev/tty backend skips reads with a zero timeout.
        while event::poll(std::time::Duration::from_millis(1))? {
            if cancelled() {
                return Ok(dialog.cancelled());
            }
            dirty = true;
            let exit = match event::read()? {
                Event::Key(key) => dialog.key(key),
                Event::Paste(text) => {
                    dialog.paste(&text);
                    None
                }
                Event::Resize(_, _) => None,
                _ => None,
            };
            if let Some(exit) = exit {
                return Ok(exit);
            }
        }
        match dialog.poll()? {
            Progress::Idle => {}
            Progress::Changed => dirty = true,
            Progress::Exit(exit) => return Ok(exit),
        }
        tick = tick.wrapping_add(1);
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    #[test]
    fn idle_frames_redraw_only_while_animating_on_every_third_tick() {
        let mut terminal = ratatui::Terminal::new(TestBackend::new(10, 3)).unwrap();
        let mut draws = 0;
        let mut dirty = true;
        let mut draw = |dirty: &mut bool, tick, animating, draws: &mut usize| {
            draw_frame(&mut terminal, dirty, tick, animating, |_| *draws += 1).unwrap();
        };
        draw(&mut dirty, 1, false, &mut draws);
        assert_eq!((draws, dirty), (1, false), "dirty frame draws once");
        draw(&mut dirty, 2, false, &mut draws);
        assert_eq!(draws, 1, "clean idle frame skips");
        draw(&mut dirty, 3, true, &mut draws);
        assert_eq!(draws, 2, "animating redraws on multiples of three");
        draw(&mut dirty, 4, true, &mut draws);
        assert_eq!(draws, 2);
    }
}
