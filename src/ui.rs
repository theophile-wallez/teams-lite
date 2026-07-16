// TUI state + rendering (slice 3). Pure and local-first:
//   - all data is read from the Store (SQLite); this module never touches the network
//   - `App` holds view state (selection, scroll, mode, cmd+K palette)
//   - `handle_key` mutates state and returns an `Action` telling the event loop
//     what side effect to run (open conversation, backfill, quit) — the loop owns
//     the network, the UI stays pure and testable.
//
// Rendering uses ratatui 0.30. State transitions are unit-tested without a terminal.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::store::{ConversationRow, Message};

/// What the UI wants the event loop to do after handling input. The loop performs
/// the network/store side effects; the UI itself never blocks on I/O.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    None,
    Quit,
    /// Load this conversation's newest page (if not cached) + show it.
    OpenConversation(String),
    /// Scrolled to the top of the cache — fetch older history for this conversation.
    BackfillOlder(String),
    /// Send `text` to conversation `id` (compose mode confirmed with Enter).
    SendMessage { id: String, text: String },
}

/// Which pane / mode has focus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// Normal navigation: conversation list focused.
    Conversations,
    /// Message pane focused (scrolling history).
    Messages,
    /// Composing a message to send (input line at the bottom of the message pane).
    Compose,
    /// cmd+K fuzzy palette open over everything.
    Palette,
}

pub struct App {
    pub mode: Mode,
    pub conversations: Vec<ConversationRow>,
    /// index into `conversations` (list-pane selection)
    pub selected: usize,
    /// id of the conversation currently open in the message pane, if any
    pub open_id: Option<String>,
    /// messages of the open conversation, oldest -> newest (as the store returns)
    pub messages: Vec<Message>,
    /// how many lines we've scrolled up from the bottom (0 = pinned to newest)
    pub scroll_back: usize,

    // cmd+K palette state
    pub palette_query: String,
    pub palette_selected: usize,

    /// compose-mode input buffer (the message being typed)
    pub compose: String,

    pub should_quit: bool,
    pub status: String,
}

impl App {
    pub fn new(conversations: Vec<ConversationRow>) -> Self {
        Self {
            mode: Mode::Conversations,
            conversations,
            selected: 0,
            open_id: None,
            messages: Vec::new(),
            scroll_back: 0,
            palette_query: String::new(),
            palette_selected: 0,
            compose: String::new(),
            should_quit: false,
            status: "j/k naviguer · Enter ouvrir · Ctrl+K rechercher · q quitter".into(),
        }
    }

    /// Replace the conversation list (after a network sync writes to the store).
    pub fn set_conversations(&mut self, convs: Vec<ConversationRow>) {
        // keep selection stable by id when possible
        let current = self.conversations.get(self.selected).map(|c| c.id.clone());
        self.conversations = convs;
        if let Some(pos) = current.and_then(|id| self.conversations.iter().position(|c| c.id == id)) {
            self.selected = pos;
        }
        self.clamp_selection();
    }

    /// Set the messages for the currently open conversation and pin to newest.
    pub fn set_messages(&mut self, conversation_id: &str, messages: Vec<Message>) {
        if self.open_id.as_deref() == Some(conversation_id) {
            self.messages = messages;
            // keep the user's scroll position if they were reading history; otherwise pin
            let max = self.messages.len().saturating_sub(1);
            if self.scroll_back > max {
                self.scroll_back = max;
            }
        }
    }

    fn clamp_selection(&mut self) {
        if self.selected >= self.conversations.len() {
            self.selected = self.conversations.len().saturating_sub(1);
        }
    }

    /// The conversations matching the current palette query, best-first (fuzzy subsequence).
    pub fn palette_matches(&self) -> Vec<(usize, &ConversationRow)> {
        let q = self.palette_query.to_lowercase();
        let mut scored: Vec<(i64, usize, &ConversationRow)> = self
            .conversations
            .iter()
            .enumerate()
            .filter_map(|(i, c)| fuzzy_score(&c.display_name.to_lowercase(), &q).map(|s| (s, i, c)))
            .collect();
        // higher score first, then most-recent (list is already recency-sorted => stable by index)
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        scored.into_iter().map(|(_, i, c)| (i, c)).collect()
    }

    /// Handle a key press, mutating state and returning a side-effect request.
    pub fn handle_key(&mut self, key: KeyEvent) -> Action {
        // Ctrl+K toggles the palette from anywhere EXCEPT while composing (there
        // it's just text input / a no-op, so typing isn't hijacked).
        if self.mode != Mode::Compose
            && key.modifiers.contains(KeyModifiers::CONTROL)
            && key.code == KeyCode::Char('k')
        {
            self.open_palette();
            return Action::None;
        }
        match self.mode {
            Mode::Palette => self.handle_palette_key(key),
            Mode::Conversations => self.handle_list_key(key),
            Mode::Messages => self.handle_messages_key(key),
            Mode::Compose => self.handle_compose_key(key),
        }
    }

    fn open_palette(&mut self) {
        self.mode = Mode::Palette;
        self.palette_query.clear();
        self.palette_selected = 0;
    }

    fn handle_list_key(&mut self, key: KeyEvent) -> Action {
        match key.code {
            KeyCode::Char('q') => {
                self.should_quit = true;
                Action::Quit
            }
            KeyCode::Char('j') | KeyCode::Down => {
                if self.selected + 1 < self.conversations.len() {
                    self.selected += 1;
                }
                Action::None
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.selected = self.selected.saturating_sub(1);
                Action::None
            }
            KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right => self.open_selected(),
            _ => Action::None,
        }
    }

    fn open_selected(&mut self) -> Action {
        let Some(conv) = self.conversations.get(self.selected) else { return Action::None };
        let id = conv.id.clone();
        self.open_id = Some(id.clone());
        self.mode = Mode::Messages;
        self.scroll_back = 0;
        Action::OpenConversation(id)
    }

    fn handle_messages_key(&mut self, key: KeyEvent) -> Action {
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc | KeyCode::Char('h') | KeyCode::Left => {
                self.mode = Mode::Conversations;
                Action::None
            }
            KeyCode::Char('i') | KeyCode::Char('a') => {
                // enter compose mode (only meaningful if a conversation is open)
                if self.open_id.is_some() {
                    self.mode = Mode::Compose;
                    self.compose.clear();
                }
                Action::None
            }
            KeyCode::Char('j') | KeyCode::Down => {
                // scroll toward newer (reduce scroll_back)
                self.scroll_back = self.scroll_back.saturating_sub(1);
                Action::None
            }
            KeyCode::Char('k') | KeyCode::Up => {
                // scroll toward older; if we reach the top of the cache, ask for backfill
                let max = self.messages.len().saturating_sub(1);
                if self.scroll_back < max {
                    self.scroll_back += 1;
                    Action::None
                } else if let Some(id) = &self.open_id {
                    Action::BackfillOlder(id.clone())
                } else {
                    Action::None
                }
            }
            _ => Action::None,
        }
    }

    fn handle_compose_key(&mut self, key: KeyEvent) -> Action {
        match key.code {
            KeyCode::Esc => {
                // cancel compose, keep the draft discarded
                self.mode = Mode::Messages;
                self.compose.clear();
                Action::None
            }
            KeyCode::Enter => {
                let text = self.compose.trim().to_string();
                self.compose.clear();
                self.mode = Mode::Messages;
                match &self.open_id {
                    Some(id) if !text.is_empty() => Action::SendMessage { id: id.clone(), text },
                    _ => Action::None,
                }
            }
            KeyCode::Backspace => {
                self.compose.pop();
                Action::None
            }
            KeyCode::Char(c) => {
                self.compose.push(c);
                Action::None
            }
            _ => Action::None,
        }
    }

    fn handle_palette_key(&mut self, key: KeyEvent) -> Action {
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Conversations;
                Action::None
            }
            KeyCode::Backspace => {
                self.palette_query.pop();
                self.palette_selected = 0;
                Action::None
            }
            KeyCode::Char(c) => {
                self.palette_query.push(c);
                self.palette_selected = 0;
                Action::None
            }
            KeyCode::Down => {
                let n = self.palette_matches().len();
                if n > 0 && self.palette_selected + 1 < n {
                    self.palette_selected += 1;
                }
                Action::None
            }
            KeyCode::Up => {
                self.palette_selected = self.palette_selected.saturating_sub(1);
                Action::None
            }
            KeyCode::Enter => {
                let matches = self.palette_matches();
                if let Some(&(idx, _)) = matches.get(self.palette_selected) {
                    self.selected = idx;
                    return self.open_selected();
                }
                Action::None
            }
            _ => Action::None,
        }
    }

    // ---- rendering ----------------------------------------------------------

    /// Draw into a ratatui terminal. Thin wrapper so the event loop stays terse.
    pub fn draw_into(&self, terminal: &mut ratatui::DefaultTerminal) -> std::io::Result<()> {
        terminal.draw(|frame| self.draw(frame))?;
        Ok(())
    }

    pub fn draw(&self, frame: &mut Frame) {
        let area = frame.area();
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(32), Constraint::Percentage(68)])
            .split(area);

        self.draw_conversations(frame, cols[0]);
        self.draw_messages(frame, cols[1]);

        if self.mode == Mode::Palette {
            self.draw_palette(frame, area);
        }
    }

    fn draw_conversations(&self, frame: &mut Frame, area: Rect) {
        let focused = self.mode == Mode::Conversations;
        let items: Vec<ListItem> = self
            .conversations
            .iter()
            .map(|c| {
                ListItem::new(Line::from(conversation_label(c).to_string()))
            })
            .collect();
        let border = if focused { Style::new().cyan() } else { Style::new().dark_gray() };
        let list = List::new(items)
            .block(Block::default().borders(Borders::ALL).title(" Conversations ").border_style(border))
            .highlight_style(Style::new().add_modifier(Modifier::REVERSED))
            .highlight_symbol("› ");
        let mut state = ListState::default();
        if !self.conversations.is_empty() {
            state.select(Some(self.selected));
        }
        frame.render_stateful_widget(list, area, &mut state);
    }

    fn draw_messages(&self, frame: &mut Frame, area: Rect) {
        let focused = self.mode == Mode::Messages || self.mode == Mode::Compose;
        let composing = self.mode == Mode::Compose;

        // In compose mode, split off a one-line input box at the bottom.
        let (msg_area, input_area) = if composing {
            let parts = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(1), Constraint::Length(3)])
                .split(area);
            (parts[0], Some(parts[1]))
        } else {
            (area, None)
        };

        let title = self
            .open_id
            .as_ref()
            .and_then(|id| self.conversations.iter().find(|c| &c.id == id))
            .map(|c| format!(" {} ", conversation_label(c)))
            .unwrap_or_else(|| " Messages ".into());
        let border = if focused { Style::new().cyan() } else { Style::new().dark_gray() };

        let inner_h = msg_area.height.saturating_sub(2) as usize; // minus borders
        // window of messages ending `scroll_back` from the newest
        let total = self.messages.len();
        let end = total.saturating_sub(self.scroll_back);
        let start = end.saturating_sub(inner_h);
        let mut lines: Vec<Line> = Vec::new();
        for m in &self.messages[start..end] {
            let sender = Span::from(format!("{}: ", m.sender)).bold().green();
            let body = Span::from(strip_html(&m.content));
            lines.push(Line::from(vec![sender, body]));
        }
        if lines.is_empty() && self.open_id.is_some() {
            lines.push(Line::from(Span::from("(aucun message en cache — chargement…)").italic().dark_gray()));
        } else if self.open_id.is_none() {
            lines.push(Line::from(Span::from("Sélectionne une conversation (Enter).").dark_gray()));
        }

        let para = Paragraph::new(lines)
            .block(Block::default().borders(Borders::ALL).title(title).border_style(border))
            .wrap(Wrap { trim: false });
        frame.render_widget(para, msg_area);

        // compose input line
        if let Some(input_area) = input_area {
            let input = Paragraph::new(Line::from(vec![
                Span::from("› ").cyan(),
                Span::from(self.compose.clone()),
                Span::from("▎").cyan(), // cursor block
            ]))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Message (Entrée envoyer · Échap annuler) ")
                    .border_style(Style::new().cyan()),
            );
            frame.render_widget(input, input_area);
        }
    }

    fn draw_palette(&self, frame: &mut Frame, area: Rect) {
        // centered floating box, capped so it never exceeds the terminal
        let w = area.width.min(70);
        let h = area.height.min(16);
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 3;
        let popup = Rect { x, y, width: w, height: h };

        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(1)])
            .split(popup);

        frame.render_widget(ratatui::widgets::Clear, popup);
        let query = Paragraph::new(Line::from(vec![Span::from("🔍 "), Span::from(self.palette_query.clone())]))
            .block(Block::default().borders(Borders::ALL).title(" Aller à… (Ctrl+K) ").border_style(Style::new().magenta()));
        frame.render_widget(query, rows[0]);

        let matches = self.palette_matches();
        let items: Vec<ListItem> = matches
            .iter()
            .map(|(_, c)| {
                ListItem::new(Line::from(conversation_label(c).to_string()))
            })
            .collect();
        let list = List::new(items)
            .block(Block::default().borders(Borders::ALL).border_style(Style::new().magenta()))
            .highlight_style(Style::new().add_modifier(Modifier::REVERSED))
            .highlight_symbol("› ");
        let mut state = ListState::default();
        if !matches.is_empty() {
            state.select(Some(self.palette_selected.min(matches.len() - 1)));
        }
        frame.render_stateful_widget(list, rows[1], &mut state);
    }
}

/// The label to show for a conversation: its resolved name, a friendly label for
/// the self-notes thread (id `48:notes`), or a placeholder when still unresolved.
pub fn conversation_label(conv: &ConversationRow) -> &str {
    if !conv.display_name.is_empty() {
        &conv.display_name
    } else if conv.id.starts_with("48:") {
        "Notes" // note-to-self / "Vous"
    } else {
        "(sans titre)"
    }
}

/// Strip HTML tags to plain text for terminal display. Teams message content is
/// `RichText/Html` (e.g. "<p>hello <at>Bob</at></p>"). Keeps inner text, collapses
/// whitespace. Good enough for slice 3; richer rendering (mentions, links) is later.
pub fn strip_html(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    // decode the few entities Teams commonly emits
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Simple fuzzy subsequence score: all query chars must appear in order.
/// Higher = better (contiguous runs + earlier start rewarded). None = no match.
/// Empty query matches everything with a neutral score.
fn fuzzy_score(haystack: &str, query: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    let hay: Vec<char> = haystack.chars().collect();
    let mut qi = query.chars().peekable();
    let mut score = 0i64;
    let mut last_match: Option<usize> = None;
    let mut next_q = qi.next();
    for (i, &hc) in hay.iter().enumerate() {
        if let Some(qc) = next_q {
            if hc == qc {
                // reward contiguous matches and earlier positions
                score += match last_match {
                    Some(prev) if prev + 1 == i => 5, // contiguous
                    _ => 1,
                };
                if i == 0 {
                    score += 3; // prefix bonus
                }
                last_match = Some(i);
                next_q = qi.next();
            }
        } else {
            break;
        }
    }
    if next_q.is_none() { Some(score) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ConversationRow, Message};

    fn key(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
    }
    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }
    fn code(k: KeyCode) -> KeyEvent {
        KeyEvent::new(k, KeyModifiers::NONE)
    }
    fn conv(id: &str, name: &str, t: i64) -> ConversationRow {
        ConversationRow { id: id.into(), display_name: name.into(), last_message_time: t }
    }
    fn msg(seq: i64, body: &str) -> Message {
        Message {
            id: format!("m{seq}"),
            conversation_id: "c1".into(),
            seq,
            compose_time: seq,
            sender: "Alice".into(),
            content: body.into(),
        }
    }

    fn app3() -> App {
        App::new(vec![conv("c1", "Alpha", 300), conv("c2", "Bravo", 200), conv("c3", "Charlie", 100)])
    }

    #[test]
    fn strip_html_basic() {
        assert_eq!(strip_html("<p>ok je suis présent</p>"), "ok je suis présent");
        assert_eq!(strip_html("a &amp; b &lt;tag&gt;"), "a & b <tag>");
        assert_eq!(strip_html("<div>  multi   space </div>"), "multi space");
        assert_eq!(strip_html("<p>hello <at id=\"1\">Bob</at></p>"), "hello Bob");
    }

    #[test]
    fn list_navigation_wraps_bounds() {
        let mut a = app3();
        assert_eq!(a.selected, 0);
        a.handle_key(key('k')); // up at top: stays 0
        assert_eq!(a.selected, 0);
        a.handle_key(key('j'));
        a.handle_key(key('j'));
        assert_eq!(a.selected, 2);
        a.handle_key(key('j')); // down at bottom: stays 2
        assert_eq!(a.selected, 2);
    }

    #[test]
    fn enter_opens_conversation() {
        let mut a = app3();
        a.handle_key(key('j')); // select c2
        let action = a.handle_key(code(KeyCode::Enter));
        assert_eq!(action, Action::OpenConversation("c2".into()));
        assert_eq!(a.mode, Mode::Messages);
        assert_eq!(a.open_id.as_deref(), Some("c2"));
    }

    #[test]
    fn scroll_up_at_cache_top_requests_backfill() {
        let mut a = app3();
        a.handle_key(code(KeyCode::Enter)); // open c1
        a.set_messages("c1", vec![msg(1, "a"), msg(2, "b")]);
        // scroll up within cache
        assert_eq!(a.handle_key(key('k')), Action::None);
        assert_eq!(a.scroll_back, 1);
        // one more reaches the top (max = len-1 = 1) => backfill
        assert_eq!(a.handle_key(key('k')), Action::BackfillOlder("c1".into()));
    }

    #[test]
    fn escape_from_messages_returns_to_list() {
        let mut a = app3();
        a.handle_key(code(KeyCode::Enter));
        assert_eq!(a.mode, Mode::Messages);
        a.handle_key(code(KeyCode::Esc));
        assert_eq!(a.mode, Mode::Conversations);
    }

    #[test]
    fn cmdk_opens_palette_and_filters() {
        let mut a = app3();
        a.handle_key(ctrl('k'));
        assert_eq!(a.mode, Mode::Palette);
        a.handle_key(key('b')); // "b" -> Bravo
        let matches = a.palette_matches();
        assert_eq!(matches[0].1.display_name, "Bravo");
    }

    #[test]
    fn palette_enter_opens_and_selects_match() {
        let mut a = app3();
        a.handle_key(ctrl('k'));
        a.handle_key(key('c')); // Charlie
        let action = a.handle_key(code(KeyCode::Enter));
        assert_eq!(action, Action::OpenConversation("c3".into()));
        assert_eq!(a.mode, Mode::Messages);
    }

    #[test]
    fn fuzzy_matches_subsequence_not_substring() {
        // "ce" should match "Charlie" (C..e) as a subsequence
        assert!(fuzzy_score("charlie", "ce").is_some());
        assert!(fuzzy_score("charlie", "xz").is_none());
        // prefix scores higher than mid-string
        let prefix = fuzzy_score("alpha", "al").unwrap();
        let mid = fuzzy_score("balpha", "al").unwrap();
        assert!(prefix > mid);
    }

    #[test]
    fn set_conversations_keeps_selection_by_id() {
        let mut a = app3();
        a.handle_key(key('j')); // select c2
        assert_eq!(a.selected, 1);
        // list reorders (c2 jumps to top after a new message)
        a.set_conversations(vec![conv("c2", "Bravo", 400), conv("c1", "Alpha", 300), conv("c3", "Charlie", 100)]);
        // selection follows c2 to its new index
        assert_eq!(a.conversations[a.selected].id, "c2");
    }

    // ---- rendering (TestBackend: deterministic, no real terminal) ------------

    fn render(app: &App, w: u16, h: u16) -> String {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| app.draw(f)).unwrap();
        let buf = terminal.backend().buffer().clone();
        // flatten the buffer to text for content assertions
        let mut s = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                s.push_str(buf[(x, y)].symbol());
            }
            s.push('\n');
        }
        s
    }

    #[test]
    fn renders_conversation_list_and_placeholder() {
        let app = app3();
        let out = render(&app, 80, 20);
        assert!(out.contains("Conversations"), "list title missing:\n{out}");
        assert!(out.contains("Alpha"));
        assert!(out.contains("Bravo"));
        assert!(out.contains("Charlie"));
        // nothing open yet -> the message pane shows the hint
        assert!(out.contains("Sélectionne une conversation"), "placeholder missing:\n{out}");
    }

    #[test]
    fn renders_open_conversation_messages() {
        let mut app = app3();
        app.handle_key(code(KeyCode::Enter)); // open c1 (Alpha)
        app.set_messages("c1", vec![msg(1, "<p>bonjour</p>"), msg(2, "<p>ça va?</p>")]);
        let out = render(&app, 80, 20);
        // pane title = conversation name, HTML stripped in body, sender shown
        assert!(out.contains("Alpha"));
        assert!(out.contains("Alice:"));
        assert!(out.contains("bonjour"));
        assert!(out.contains("ça va?"));
        assert!(!out.contains("<p>"), "HTML should be stripped:\n{out}");
    }

    #[test]
    fn renders_palette_overlay() {
        let mut app = app3();
        app.handle_key(ctrl('k'));
        app.handle_key(key('b')); // filter to Bravo
        let out = render(&app, 80, 20);
        assert!(out.contains("Aller à"), "palette title missing:\n{out}");
        assert!(out.contains("Bravo"));
    }

    #[test]
    fn compose_flow_types_and_sends() {
        let mut a = app3();
        a.handle_key(code(KeyCode::Enter)); // open c1
        assert_eq!(a.mode, Mode::Messages);
        // 'i' enters compose
        a.handle_key(key('i'));
        assert_eq!(a.mode, Mode::Compose);
        // type "hi"
        a.handle_key(key('h'));
        a.handle_key(key('i'));
        assert_eq!(a.compose, "hi");
        // backspace + retype
        a.handle_key(code(KeyCode::Backspace));
        assert_eq!(a.compose, "h");
        a.handle_key(key('o'));
        // Enter sends and returns to Messages
        let action = a.handle_key(code(KeyCode::Enter));
        assert_eq!(action, Action::SendMessage { id: "c1".into(), text: "ho".into() });
        assert_eq!(a.mode, Mode::Messages);
        assert_eq!(a.compose, "");
    }

    #[test]
    fn compose_escape_cancels_without_sending() {
        let mut a = app3();
        a.handle_key(code(KeyCode::Enter));
        a.handle_key(key('i'));
        a.handle_key(key('x'));
        let action = a.handle_key(code(KeyCode::Esc));
        assert_eq!(action, Action::None);
        assert_eq!(a.mode, Mode::Messages);
        assert_eq!(a.compose, "");
    }

    #[test]
    fn compose_empty_message_does_not_send() {
        let mut a = app3();
        a.handle_key(code(KeyCode::Enter));
        a.handle_key(key('i'));
        // Enter with empty buffer -> no send
        let action = a.handle_key(code(KeyCode::Enter));
        assert_eq!(action, Action::None);
        assert_eq!(a.mode, Mode::Messages);
    }

    #[test]
    fn ctrl_k_is_text_in_compose_not_palette() {
        let mut a = app3();
        a.handle_key(code(KeyCode::Enter));
        a.handle_key(key('i'));
        a.handle_key(ctrl('k')); // must NOT open palette while composing
        assert_eq!(a.mode, Mode::Compose);
    }

    #[test]
    fn renders_compose_input_line() {
        let mut app = app3();
        app.handle_key(code(KeyCode::Enter));
        app.handle_key(key('i'));
        app.compose = "salut".into();
        let out = render(&app, 80, 20);
        assert!(out.contains("Message"), "compose box title missing:\n{out}");
        assert!(out.contains("salut"), "typed text missing:\n{out}");
    }

    #[test]
    fn conversation_label_handles_name_notes_and_blank() {
        // resolved name wins
        assert_eq!(conversation_label(&conv("19:x", "Leonor GROELL", 0)), "Leonor GROELL");
        // note-to-self thread (48:notes) gets a friendly label
        assert_eq!(conversation_label(&conv("48:notes", "", 0)), "Notes");
        // otherwise a placeholder
        assert_eq!(conversation_label(&conv("19:y", "", 0)), "(sans titre)");
    }
}
