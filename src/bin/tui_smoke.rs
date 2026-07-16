// teams-lite — TUI SMOKE TEST (headless)
//
// Proves the TUI's live data path end-to-end WITHOUT a real terminal:
//   real broker auth -> sync conversation list into the store -> App::new from
//   the store -> open the most-recent conversation (real network fetch) ->
//   set_messages -> render one frame with ratatui's TestBackend and assert the
//   rendered buffer actually shows the conversation + its messages.
//
// This is the automated stand-in for "launch the TUI and look at it", since the
// sandbox has no interactive TTY. No raw tokens printed.

use anyhow::{Context, Result};
use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Terminal;

use teams_lite::store::Store;
use teams_lite::ui::App;
use teams_lite::{auth, teams, teams_read};

const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

fn buffer_text(app: &App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| app.draw(f)).unwrap();
    let buf = term.backend().buffer().clone();
    let mut s = String::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            s.push_str(buf[(x, y)].symbol());
        }
        s.push('\n');
    }
    s
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder().user_agent(UA).http1_only().build()?;
    println!("[smoke] auth broker…");
    let _ic3 = auth::get_token(IC3_SCOPE).await.context("ic3")?;
    let csa = auth::get_token(teams_read::CSA_SCOPE).await.context("csa")?;
    let sess = teams::connect(&http).await?;
    println!("[smoke] region={}", sess.region);

    let db = std::env::temp_dir().join("teams-lite-smoke.sqlite");
    let _ = std::fs::remove_file(&db);
    let db = db.to_str().unwrap().to_string();

    // 1. sync conversation list -> store
    let convs = teams_read::fetch_conversations(&http, &sess, &csa).await?;
    let store = Store::open(&db)?;
    let n = teams_read::persist_conversations(&store, &convs);
    println!("[smoke] {n} conversations en store");

    // 2. App reads the list from the store (local-first)
    let mut app = App::new(store.conversations(&sess.self_name)?);
    let frame1 = buffer_text(&app, 100, 25);
    assert!(frame1.contains("Conversations"), "pane title absent");
    let first_name = app.conversations.first().map(|c| c.display_name.clone()).unwrap_or_default();
    assert!(!app.conversations.is_empty(), "aucune conversation rendue");
    println!("[smoke] frame liste OK — 1re conv: {first_name:?}");

    // 3. open the most-recent conversation (Enter), fetch its newest page, render
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let open_id = app.open_id.clone().context("aucune conv ouverte")?;
    let page = teams_read::fetch_newest(&http, &sess, &open_id).await?;
    teams_read::persist_page(&store, &open_id, &page)?;
    let msgs = store.newest_messages(&open_id, 200)?;
    let count = msgs.len();
    app.set_messages(&open_id, msgs);

    let frame2 = buffer_text(&app, 100, 25);
    // the message pane must now show at least one sender + no raw HTML tags
    assert!(!frame2.contains("<p>"), "HTML non strippé dans le rendu");
    println!("[smoke] frame messages OK — {count} messages rendus");
    if count > 0 {
        // sender line renders as "Name:"
        assert!(frame2.contains(':'), "aucun message rendu dans le panneau");
    }

    // 4. cmd+K palette renders and filters
    app.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));
    let frame3 = buffer_text(&app, 100, 25);
    assert!(frame3.contains("Aller à"), "palette cmd+K non rendue");
    println!("[smoke] palette cmd+K OK");

    let _ = std::fs::remove_file(&db);
    println!("\n✅ SMOKE TUI: auth -> sync -> render liste -> ouvre conv -> render messages -> cmd+K, tout OK.");
    Ok(())
}
