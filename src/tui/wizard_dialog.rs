//! The first-run config wizard as one dialog: welcome → nerd icons →
//! providers. The providers section drives the pure reducer in
//! `wizard::state` from the checklist, input and select widgets, and loads
//! the models.dev catalog as a background task.

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use tokio::sync::oneshot;

use super::drive::{Dialog, Progress};
use super::frame::{Align, DialogFrame, PillSegment, TopBadge};
use super::nerd_icons::{NerdIconsExit, NerdIconsSection};
use super::welcome::{WelcomeExit, WelcomeSection};
use super::widgets::{
    ActionItem, Checklist, ChecklistEvent, ChecklistItem, InputEvent, InputFrame, Paint, Select,
    SelectEvent, SelectOption, TextInput, action_bar_line,
};
use crate::chrome::SPINNER_FRAMES;
use crate::config::WizardResult;
use crate::config::providers::{API_PROVIDERS, CLI_PROVIDERS, api_provider, cli_provider};
use crate::theme::Theme;
use crate::wizard::models_dev::ModelsDevData;
use crate::wizard::state::{Action, ProviderScreen, ProviderWizardState, ScreenTag, reduce};

pub const WIZARD_CONTENT_WIDTH: u16 = 70;
const WIZARD_LABEL: &str = "🧙 Setup Wizard";
const MAX_VISIBLE_OPTIONS: usize = 8;
/// Ticks are 25ms; the spinner advances with the 80ms chrome cadence.
const TICKS_PER_SPINNER_FRAME: usize = 3;
const LOADING_BODY: &str = "Loading models…";
const LOADING_STATUS: &str = "Loading models list…";
const DISCLAIMER_HEAD: &str = "Wrap will route your queries through the ";
const DISCLAIMER_TAIL: &str = " CLI instead of calling the Anthropic API directly. This is slower, and your prompts flow through Claude Code under its own terms — bring your own subscription and credentials.";

const ICON_CHECK: &str = "\u{F00C}";
const ICON_LIST: &str = "\u{F03A}";
const ICON_KEY: &str = "\u{F084}";
const ICON_CUBE: &str = "\u{F1B2}";
const ICON_STAR: &str = "\u{F005}";

struct StepDef {
    key: &'static str,
    icon: &'static str,
    label: &'static str,
    abbr: &'static str,
}

const WIZARD_STEPS: [StepDef; 4] = [
    StepDef {
        key: "providers",
        icon: ICON_LIST,
        label: "Providers",
        abbr: "P",
    },
    StepDef {
        key: "apikey",
        icon: ICON_KEY,
        label: "API Key",
        abbr: "K",
    },
    StepDef {
        key: "model",
        icon: ICON_CUBE,
        label: "Model",
        abbr: "M",
    },
    StepDef {
        key: "default",
        icon: ICON_STAR,
        label: "Set Default",
        abbr: "D",
    },
];

// ── Pill chrome ─────────────────────────────────────────────────

/// Which of the four steps a screen belongs to. The disclaimer sits on the
/// API Key step because it is the claude-code auth step; `Done` is past the
/// last step.
pub fn step_index_from_screen(tag: ScreenTag) -> usize {
    match tag {
        ScreenTag::SelectingProviders | ScreenTag::LoadingModels => 0,
        ScreenTag::EnteringKey | ScreenTag::Disclaimer => 1,
        ScreenTag::PickingModel => 2,
        ScreenTag::PickingDefault => 3,
        ScreenTag::Done => WIZARD_STEPS.len(),
    }
}

fn wizard_seg(theme: &Theme) -> PillSegment {
    PillSegment::new(WIZARD_LABEL, theme.wizard.label_pill).bold()
}

/// Just the wizard label, for sections before the provider steps.
pub fn wizard_label_pill(theme: &Theme) -> Vec<PillSegment> {
    vec![wizard_seg(theme)]
}

/// The provider whose loop the wizard is inside; it replaces the done
/// "Providers" crumb so the chain reads `Anthropic › API Key`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveProvider {
    pub display_name: String,
    pub nerd_icon: Option<String>,
}

/// Wizard label, then every done step with a check, then the bold active
/// step. On the default picker only the Providers crumb is kept so the
/// chain reads as a summary.
pub fn wizard_crumb_pill(
    theme: &Theme,
    step_index: usize,
    nerd: bool,
    active_provider: Option<&ActiveProvider>,
) -> Vec<PillSegment> {
    let mut segs = vec![wizard_seg(theme)];
    let active_step = WIZARD_STEPS.get(step_index);
    let done_steps = WIZARD_STEPS[..step_index.min(WIZARD_STEPS.len())]
        .iter()
        .filter(|s| active_step.is_none_or(|a| a.key != "default") || s.key == "providers");
    for step in done_steps {
        let provider = active_provider.filter(|_| step.key == "providers");
        let step_label = provider.map_or(step.label, |p| p.display_name.as_str());
        let step_icon = provider
            .and_then(|p| p.nerd_icon.as_deref())
            .unwrap_or(step.icon);
        let label = if nerd {
            format!("{ICON_CHECK} {step_icon} {step_label}")
        } else if provider.is_some() {
            step_label.to_string()
        } else {
            format!("✓ {step_label}")
        };
        segs.push(PillSegment::new(label, theme.wizard.step_done).narrow(step.abbr));
    }
    if let Some(step) = active_step {
        let label = if nerd {
            format!("{} {}", step.icon, step.label)
        } else {
            step.label.to_string()
        };
        segs.push(
            PillSegment::new(label, theme.wizard.step_active)
                .narrow(step.abbr)
                .bold(),
        );
    }
    segs
}

/// The fallback chain without the wizard label: one segment per step so
/// the position in the flow stays visible when the wide chain cannot fit.
pub fn wizard_crumb_pill_narrow(theme: &Theme, step_index: usize, nerd: bool) -> Vec<PillSegment> {
    WIZARD_STEPS
        .iter()
        .enumerate()
        .map(|(i, step)| {
            if i < step_index {
                PillSegment::new(if nerd { ICON_CHECK } else { "✓" }, theme.wizard.step_done)
            } else if i == step_index {
                let label = if nerd {
                    format!("{} {}", step.icon, step.label)
                } else {
                    step.label.to_string()
                };
                PillSegment::new(label, theme.wizard.step_active)
                    .narrow(if nerd { step.icon } else { step.abbr })
                    .bold()
            } else {
                PillSegment::new(
                    if nerd { step.icon } else { step.abbr },
                    theme.wizard.step_pending,
                )
            }
        })
        .collect()
}

// ── Shared body rendering ───────────────────────────────────────

/// Draws `frame` around `lines` (one row each) centered in `area` and
/// applies the color level.
pub(crate) fn render_body(
    buf: &mut Buffer,
    area: Rect,
    paint: Paint,
    frame: &DialogFrame,
    lines: Vec<Line<'static>>,
) {
    let rows: Vec<Row> = lines.into_iter().map(Row::Line).collect();
    render_rows(buf, area, paint, frame, &rows);
}

/// One row group of a dialog body.
pub(crate) enum Row {
    Line(Line<'static>),
    /// Word-wrapped text; takes as many rows as it needs at the inner width.
    Para(Line<'static>),
    Input(InputFrame),
}

impl Row {
    fn height(&self, width: u16) -> u16 {
        match self {
            Row::Line(_) => 1,
            Row::Para(line) => Paragraph::new(line.clone())
                .wrap(Wrap { trim: false })
                .line_count(width.max(1))
                .max(1)
                .min(usize::from(u16::MAX)) as u16,
            Row::Input(frame) => frame.height(width),
        }
    }

    fn render(&self, buf: &mut Buffer, area: Rect, paint: Paint) {
        match self {
            Row::Line(line) => {
                buf.set_line(area.x, area.y, line, area.width);
            }
            Row::Para(line) => Paragraph::new(line.clone())
                .wrap(Wrap { trim: false })
                .render(area, buf),
            Row::Input(frame) => frame.render(buf, area, paint),
        }
    }
}

/// Draws `frame` around `rows` centered in `area`, each row taking the
/// height it needs at the inner width, and applies the color level.
pub(crate) fn render_rows(
    buf: &mut Buffer,
    area: Rect,
    paint: Paint,
    frame: &DialogFrame,
    rows: &[Row],
) {
    let inner_width = frame.inner_width(area.width);
    let body_rows = rows
        .iter()
        .map(|r| r.height(inner_width))
        .fold(0u16, u16::saturating_add);
    let body = frame.draw(buf, area, body_rows);
    let mut y = body.y;
    for row in rows {
        let h = row.height(inner_width);
        if y >= body.bottom() {
            break;
        }
        let rect = Rect::new(body.x, y, body.width, h.min(body.bottom() - y));
        row.render(buf, rect, paint);
        y += h;
    }
    paint.finish(buf);
}

fn indented(line: Line<'static>) -> Line<'static> {
    let mut spans = vec![Span::raw("   ")];
    spans.extend(line.spans);
    Line::from(spans)
}

fn action_row(items: &[ActionItem], paint: Paint) -> Row {
    Row::Para(indented(action_bar_line(items, None, None, paint)))
}

// ── The dialog ──────────────────────────────────────────────────

pub type ModelsFuture = Pin<Box<dyn Future<Output = Result<ModelsDevData, String>> + Send>>;
/// Starts one catalog load; called when the providers are submitted.
pub type ModelsLoader = Box<dyn Fn() -> ModelsFuture>;

pub struct WizardDialogOptions {
    pub theme: &'static Theme,
    pub color_level: u8,
    /// Icons before the nerd-icons section answers; normally `false`.
    pub nerd_fonts: bool,
    pub no_animation: bool,
    /// CLI providers whose binary is on PATH, by provider name.
    pub cli_available: BTreeMap<String, bool>,
    /// `None` leaves the load to the owner via
    /// [`ConfigWizardDialog::models_fetched`].
    pub models_loader: Option<ModelsLoader>,
    /// Told the nerd-icons answer the moment it is given, so settings read
    /// later in the run see it.
    pub on_nerd_fonts: Option<Box<dyn Fn(bool)>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WizardExit {
    Done(WizardResult),
    Cancelled,
    /// The models.dev catalog could not be loaded; the plain-language message.
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WizardSection {
    Welcome,
    NerdIcons,
    Providers,
}

/// The in-flight catalog load: its result channel and a handle to abort it.
struct Loading {
    result: oneshot::Receiver<Result<ModelsDevData, String>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Loading {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The widget bound to the current provider screen.
enum ScreenWidget {
    None,
    Checklist(Checklist),
    Input(TextInput),
    Select(Select),
}

enum Section {
    Welcome(WelcomeSection),
    NerdIcons(NerdIconsSection),
    Providers,
}

pub struct ConfigWizardDialog {
    opts: WizardDialogOptions,
    section: Section,
    nerd_fonts: bool,
    state: ProviderWizardState,
    widget: ScreenWidget,
    loading: Option<Loading>,
    tick: usize,
}

impl ConfigWizardDialog {
    pub fn new(opts: WizardDialogOptions) -> Self {
        let nerd_fonts = opts.nerd_fonts;
        let mut dialog = Self {
            opts,
            section: Section::Welcome(WelcomeSection::new(Instant::now())),
            nerd_fonts,
            state: ProviderWizardState::new(),
            widget: ScreenWidget::None,
            loading: None,
            tick: 0,
        };
        dialog.widget = dialog.widget_for_screen();
        dialog
    }

    pub fn section(&self) -> WizardSection {
        match self.section {
            Section::Welcome(_) => WizardSection::Welcome,
            Section::NerdIcons(_) => WizardSection::NerdIcons,
            Section::Providers => WizardSection::Providers,
        }
    }

    /// The provider screen, once that section is reached.
    pub fn screen(&self) -> Option<&ProviderScreen> {
        match self.section {
            Section::Providers => Some(&self.state.screen),
            _ => None,
        }
    }

    /// The nerd-icons answer so far.
    pub fn nerd_fonts(&self) -> bool {
        self.nerd_fonts
    }

    fn paint(&self) -> Paint {
        Paint::new(self.opts.theme, self.opts.color_level, self.nerd_fonts)
    }

    /// Feeds the catalog load's outcome; a failure ends the wizard.
    pub fn models_fetched(&mut self, result: Result<ModelsDevData, String>) -> Option<WizardExit> {
        self.loading = None;
        match result {
            Ok(data) => self.dispatch(Action::ModelsFetched(data)),
            Err(message) => Some(WizardExit::Failed(message)),
        }
    }

    /// Advances the welcome animation to `now`; true when the frame changed.
    pub fn advance_animation(&mut self, now: Instant) -> bool {
        match &mut self.section {
            Section::Welcome(welcome) => welcome.advance(now),
            _ => false,
        }
    }

    fn dispatch(&mut self, action: Action) -> Option<WizardExit> {
        let before = screen_key(&self.state.screen);
        let state = std::mem::take(&mut self.state);
        self.state = reduce(state, action);
        if screen_key(&self.state.screen) != before {
            self.widget = self.widget_for_screen();
            if self.state.screen.tag() == ScreenTag::LoadingModels {
                self.start_loading();
            }
        }
        if self.state.screen == ProviderScreen::Done {
            return Some(WizardExit::Done(WizardResult {
                entries: self.state.built_entries.clone(),
                default_provider: self.state.default_provider.clone().unwrap_or_default(),
                nerd_fonts: Some(self.nerd_fonts),
            }));
        }
        None
    }

    fn start_loading(&mut self) {
        let Some(loader) = &self.opts.models_loader else {
            return;
        };
        let future = loader();
        let (send, result) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = send.send(future.await);
        });
        self.loading = Some(Loading { result, task });
    }

    fn widget_for_screen(&self) -> ScreenWidget {
        match &self.state.screen {
            ProviderScreen::SelectingProviders { checked } => {
                let has_cli = self.opts.cli_available.values().any(|v| *v);
                let mut items = vec![ChecklistItem::header("Select API Provider(s)")];
                for p in API_PROVIDERS {
                    let mut item = ChecklistItem::option(p.display_name, p.name);
                    if let Some(icon) = p.nerd_icon {
                        item = item.with_icon(icon);
                    }
                    items.push(item);
                }
                if has_cli {
                    items.push(ChecklistItem::header(
                        "Use your coding agent's subscription",
                    ));
                    for p in CLI_PROVIDERS {
                        if self
                            .opts
                            .cli_available
                            .get(p.name)
                            .copied()
                            .unwrap_or(false)
                        {
                            let mut item = ChecklistItem::option(p.display_name, p.name);
                            if let Some(icon) = p.nerd_icon {
                                item = item.with_icon(icon);
                            }
                            items.push(item);
                        }
                    }
                }
                ScreenWidget::Checklist(
                    Checklist::new(items)
                        .with_checked(checked.iter().cloned())
                        .with_width(WIZARD_CONTENT_WIDTH),
                )
            }
            ProviderScreen::EnteringKey { provider, draft } => {
                let mut input = TextInput::masked(draft.clone());
                if let Some(placeholder) =
                    api_provider(provider).and_then(|p| p.api_key_placeholder)
                {
                    input = input.with_placeholder(placeholder);
                }
                ScreenWidget::Input(input)
            }
            ProviderScreen::PickingModel { models, .. } => {
                let options = models
                    .iter()
                    .map(|m| {
                        let label = if m.recommended {
                            format!("{}  ✦ Recommended", m.id)
                        } else {
                            m.id.clone()
                        };
                        SelectOption::new(label, m.id.clone())
                    })
                    .collect();
                ScreenWidget::Select(
                    Select::new(options)
                        .with_visible_option_count(MAX_VISIBLE_OPTIONS.min(models.len().max(1))),
                )
            }
            ProviderScreen::PickingDefault { .. } => {
                let options = self
                    .state
                    .picked_providers
                    .iter()
                    .map(|name| SelectOption::new(display_name(name), name.clone()))
                    .collect();
                ScreenWidget::Select(Select::new(options))
            }
            _ => ScreenWidget::None,
        }
    }

    fn providers_key(&mut self, key: KeyEvent) -> Option<WizardExit> {
        let ctrl_c =
            key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl_c {
            return Some(self.cancelled());
        }
        if key.code == KeyCode::Esc {
            if self.state.screen.tag() == ScreenTag::Disclaimer {
                return self.dispatch(Action::SkipDisclaimer);
            }
            return Some(self.cancelled());
        }
        match (&self.state.screen, &mut self.widget) {
            (ProviderScreen::SelectingProviders { .. }, ScreenWidget::Checklist(list)) => {
                match list.key(key) {
                    ChecklistEvent::Idle => None,
                    ChecklistEvent::Toggled(name) => self.dispatch(Action::ToggleProvider(name)),
                    ChecklistEvent::Submit(values) => {
                        let ProviderScreen::SelectingProviders { checked } = &self.state.screen
                        else {
                            return None;
                        };
                        let mut actions: Vec<Action> = checked
                            .iter()
                            .filter(|name| !values.contains(name))
                            .chain(values.iter().filter(|name| !checked.contains(*name)))
                            .map(|name| Action::ToggleProvider(name.clone()))
                            .collect();
                        actions.push(Action::SubmitProviders);
                        let mut exit = None;
                        for action in actions {
                            exit = self.dispatch(action).or(exit);
                        }
                        exit
                    }
                }
            }
            (ProviderScreen::EnteringKey { .. }, ScreenWidget::Input(input)) => {
                match input.key(key) {
                    InputEvent::Idle => None,
                    InputEvent::Changed { .. } => {
                        let text = input.text().to_string();
                        self.dispatch(Action::KeyChange(text))
                    }
                    InputEvent::Submit(text) => {
                        self.dispatch(Action::KeyChange(text));
                        self.dispatch(Action::SubmitKey)
                    }
                }
            }
            (ProviderScreen::PickingModel { models, cursor, .. }, ScreenWidget::Select(select)) => {
                let cursor = *cursor;
                let index_of = |value: &str| models.iter().position(|m| m.id == value);
                match select.key(key) {
                    SelectEvent::Idle => None,
                    SelectEvent::Moved => {
                        let delta = select
                            .focused_value()
                            .and_then(index_of)
                            .map_or(0, |i| i as isize - cursor as isize);
                        self.dispatch(Action::MoveCursor(delta))
                    }
                    SelectEvent::Submit(value) => {
                        let delta = index_of(&value).map_or(0, |i| i as isize - cursor as isize);
                        if delta != 0 {
                            self.dispatch(Action::MoveCursor(delta));
                        }
                        self.dispatch(Action::SubmitModel)
                    }
                }
            }
            (ProviderScreen::PickingDefault { cursor }, ScreenWidget::Select(select)) => {
                let cursor = *cursor;
                let picked = &self.state.picked_providers;
                let index_of = |value: &str| picked.iter().position(|p| p == value);
                match select.key(key) {
                    SelectEvent::Idle => None,
                    SelectEvent::Moved => {
                        let delta = select
                            .focused_value()
                            .and_then(index_of)
                            .map_or(0, |i| i as isize - cursor as isize);
                        self.dispatch(Action::MoveCursor(delta))
                    }
                    SelectEvent::Submit(value) => {
                        let delta = index_of(&value).map_or(0, |i| i as isize - cursor as isize);
                        if delta != 0 {
                            self.dispatch(Action::MoveCursor(delta));
                        }
                        self.dispatch(Action::SubmitDefault)
                    }
                }
            }
            (ProviderScreen::Disclaimer { .. }, _) if key.code == KeyCode::Enter => {
                self.dispatch(Action::AcceptDisclaimer)
            }
            _ => None,
        }
    }

    fn active_provider(&self) -> Option<ActiveProvider> {
        let name = self.state.screen.provider()?;
        if let Some(p) = api_provider(name) {
            return Some(ActiveProvider {
                display_name: p.display_name.to_string(),
                nerd_icon: p.nerd_icon.map(str::to_string),
            });
        }
        cli_provider(name).map(|p| ActiveProvider {
            display_name: p.display_name.to_string(),
            nerd_icon: p.nerd_icon.map(str::to_string),
        })
    }

    pub fn render(&self, frame: &mut Frame<'_>) {
        let area = frame.area();
        self.render_to(frame.buffer_mut(), area);
    }

    /// Renders into `area` of `buf` and applies the color level.
    pub fn render_to(&self, buf: &mut Buffer, area: Rect) {
        let paint = self.paint();
        match &self.section {
            Section::Welcome(welcome) => welcome.render_to(buf, area, paint),
            Section::NerdIcons(nerd) => nerd.render_to(buf, area, paint),
            Section::Providers => self.render_providers(buf, area, paint),
        }
    }

    fn render_providers(&self, buf: &mut Buffer, area: Rect, paint: Paint) {
        let theme = self.opts.theme;
        let step = step_index_from_screen(self.state.screen.tag());
        let active = self.active_provider();
        let mut top = TopBadge::new(
            wizard_crumb_pill(theme, step, paint.nerd_fonts, active.as_ref()),
            Align::Left,
        );
        top.narrow_segs = Some(wizard_crumb_pill_narrow(theme, step, paint.nerd_fonts));
        let status = (self.state.screen.tag() == ScreenTag::LoadingModels)
            .then(|| LOADING_STATUS.to_string());
        let frame = DialogFrame::new(theme.wizard.frame, WIZARD_CONTENT_WIDTH, paint)
            .with_top(top)
            .with_status(status);
        let inner_width = frame.inner_width(area.width);
        let rows = self.provider_rows(paint, inner_width);
        render_rows(buf, area, paint, &frame, &rows);
    }

    fn provider_rows(&self, paint: Paint, inner_width: u16) -> Vec<Row> {
        let theme = self.opts.theme;
        let body = Style::default();
        let bold = body.add_modifier(Modifier::BOLD);
        let text = |s: &str| Row::Para(Line::from(Span::styled(s.to_string(), body)));
        let blank = || Row::Line(Line::default());
        match (&self.state.screen, &self.widget) {
            (ProviderScreen::SelectingProviders { checked }, ScreenWidget::Checklist(list)) => {
                let mut rows = vec![
                    text("Wrap needs at least one LLM provider configured."),
                    blank(),
                ];
                let list = list.clone().with_width(inner_width);
                rows.extend(list.lines(paint).into_iter().map(Row::Para));
                rows.push(blank());
                let mut items = vec![ActionItem::new("Space", "to toggle")];
                if !checked.is_empty() {
                    items.push(ActionItem::new("⏎", "to continue").primary());
                }
                rows.push(action_row(&items, paint));
                rows
            }
            (ProviderScreen::LoadingModels, _) => {
                let line = if self.opts.no_animation {
                    LOADING_BODY.to_string()
                } else {
                    let glyph = SPINNER_FRAMES
                        [(self.tick / TICKS_PER_SPINNER_FRAME) % SPINNER_FRAMES.len()];
                    format!("{glyph} {LOADING_BODY}")
                };
                vec![text(&line)]
            }
            (ProviderScreen::EnteringKey { provider, .. }, ScreenWidget::Input(input)) => {
                let api = api_provider(provider);
                let name = api.map_or(provider.as_str(), |p| p.display_name);
                let mut rows = vec![Row::Para(Line::from(Span::styled(
                    format!("{name} API key"),
                    bold,
                )))];
                if let Some(url) = api.and_then(|p| p.api_key_url) {
                    rows.push(Row::Para(Line::from(vec![
                        Span::styled("Get one: ", body),
                        Span::styled(
                            url.to_string(),
                            Style::default().fg(paint.color(&theme.wizard.provider_link)),
                        ),
                    ])));
                }
                rows.push(blank());
                rows.push(Row::Input(input.frame(paint, None)));
                rows.push(blank());
                rows.push(action_row(
                    &[ActionItem::new("⏎", "to continue").primary()],
                    paint,
                ));
                rows
            }
            (ProviderScreen::PickingModel { provider, .. }, ScreenWidget::Select(select)) => {
                let name = api_provider(provider).map_or(provider.as_str(), |p| p.display_name);
                let mut rows = vec![
                    Row::Para(Line::from(Span::styled(format!("{name} model"), bold))),
                    blank(),
                ];
                rows.extend(select.lines(paint).into_iter().map(Row::Line));
                rows.push(blank());
                rows.push(action_row(
                    &[
                        ActionItem::new("↑↓", "to move"),
                        ActionItem::new("⏎", "to continue").primary(),
                    ],
                    paint,
                ));
                rows
            }
            (ProviderScreen::Disclaimer { .. }, _) => vec![
                Row::Para(Line::from(vec![
                    Span::styled(DISCLAIMER_HEAD, body),
                    Span::styled("claude", bold),
                    Span::styled(DISCLAIMER_TAIL, body),
                ])),
                blank(),
                action_row(
                    &[
                        ActionItem::new("⏎", "to accept").primary(),
                        ActionItem::new("Esc", "to skip this provider"),
                    ],
                    paint,
                ),
            ],
            (ProviderScreen::PickingDefault { .. }, ScreenWidget::Select(select)) => {
                let mut rows = vec![
                    Row::Para(Line::from(Span::styled(
                        "Which provider should be the default?",
                        bold,
                    ))),
                    blank(),
                ];
                rows.extend(select.lines(paint).into_iter().map(Row::Line));
                rows.push(blank());
                rows.push(action_row(
                    &[
                        ActionItem::new("↑↓", "to move"),
                        ActionItem::new("⏎", "to select").primary(),
                    ],
                    paint,
                ));
                rows
            }
            _ => Vec::new(),
        }
    }
}

impl Dialog for ConfigWizardDialog {
    type Exit = WizardExit;

    fn render(&self, frame: &mut Frame<'_>) {
        ConfigWizardDialog::render(self, frame);
    }

    fn animating(&self) -> bool {
        match &self.section {
            Section::Welcome(welcome) => !welcome.finished(),
            Section::NerdIcons(_) => false,
            Section::Providers => self.state.screen.tag() == ScreenTag::LoadingModels,
        }
    }

    fn set_tick(&mut self, tick: usize) {
        self.tick = tick;
    }

    fn key(&mut self, key: KeyEvent) -> Option<WizardExit> {
        if key.kind == KeyEventKind::Release {
            return None;
        }
        match &mut self.section {
            Section::Welcome(welcome) => match welcome.key(key)? {
                WelcomeExit::Continue => {
                    self.section = Section::NerdIcons(NerdIconsSection::new());
                    None
                }
                WelcomeExit::Cancel => Some(self.cancelled()),
            },
            Section::NerdIcons(nerd) => match nerd.key(key)? {
                NerdIconsExit::Selected(value) => {
                    self.nerd_fonts = value;
                    if let Some(sink) = &self.opts.on_nerd_fonts {
                        sink(value);
                    }
                    self.section = Section::Providers;
                    None
                }
                NerdIconsExit::Cancel => Some(self.cancelled()),
            },
            Section::Providers => self.providers_key(key),
        }
    }

    fn paste(&mut self, text: &str) {
        if let (Section::Providers, ScreenWidget::Input(input)) = (&self.section, &mut self.widget)
            && let InputEvent::Changed { .. } = input.paste(text)
        {
            let text = input.text().to_string();
            self.dispatch(Action::KeyChange(text));
        }
    }

    fn poll(&mut self) -> io::Result<Progress<WizardExit>> {
        if self.advance_animation(Instant::now()) {
            return Ok(Progress::Changed);
        }
        let Some(loading) = &mut self.loading else {
            return Ok(Progress::Idle);
        };
        match loading.result.try_recv() {
            Err(oneshot::error::TryRecvError::Empty) => Ok(Progress::Idle),
            Err(oneshot::error::TryRecvError::Closed) => {
                Err(io::Error::other("model list task stopped unexpectedly"))
            }
            Ok(result) => Ok(match self.models_fetched(result) {
                Some(exit) => Progress::Exit(exit),
                None => Progress::Changed,
            }),
        }
    }

    fn cancelled(&mut self) -> WizardExit {
        self.loading = None;
        WizardExit::Cancelled
    }
}

/// What a screen's widget is keyed on: a change rebuilds the widget.
fn screen_key(screen: &ProviderScreen) -> (ScreenTag, Option<String>) {
    (screen.tag(), screen.provider().map(str::to_string))
}

fn display_name(name: &str) -> String {
    api_provider(name)
        .map(|p| p.display_name)
        .or_else(|| cli_provider(name).map(|p| p.display_name))
        .unwrap_or(name)
        .to_string()
}
