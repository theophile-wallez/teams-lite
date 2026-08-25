/// The `User-Agent` this app's outbound requests carry, in ONE spelling. A stranger's
/// server answers a request by what it claims to be — several of the domains a sender icon
/// is fetched from 403 a client that names none — so a module building its own client for a
/// reason of its own (see `sender_icon`) must still sound like the rest of the app.
pub const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

/// Is this a read-only backend (`TEAMS_LITE_READ_ONLY=1`)?
///
/// One spelling, for the whole crate. It lived in src/bin/server.rs, where it gates every
/// write at the dispatch choke point; the LIBRARY needs the same answer now that
/// `auth::rescue` exists — an automatic interactive sign-in is an act on the user's account,
/// and a screenshot backend must no more do that than it may send a message.
///
/// Read once: the mode is a property of the process, and re-reading the environment per
/// request would let it drift mid-session.
pub fn read_only() -> bool {
    static READ_ONLY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *READ_ONLY.get_or_init(|| std::env::var("TEAMS_LITE_READ_ONLY").as_deref() == Ok("1"))
}

pub mod agent;
pub mod agent_markdown;
pub mod agent_models;
pub mod agent_persona;
pub mod agent_policy;
pub mod auth;
pub mod calendar;
pub mod calling;
pub mod changelog;
/// The chess ENGINE this machine can fetch, so a game has an opponent when no colleague does
/// (see AGENTS.md § Playing STOCKFISH). It is in the backend because the engine has to be
/// DOWNLOADED, and a browser in this app never fetches from a stranger's server.
pub mod chess_engine;
pub mod chess_sound;
pub mod custom_emoji;
pub mod gitlab;
pub mod gitlab_approval;
pub mod gitlab_ci_graph;
pub mod gitlab_mr;
pub mod gitlab_mr_write;
pub mod graph_time;
pub mod linear;
pub mod link_preview;
pub mod mail;
pub mod mail_html;
pub mod pinned_download;
pub mod png;
pub mod push;
pub mod push_policy;
pub mod restart;
pub mod retry;
pub mod seal;
pub mod sender_icon;
pub mod signin;
pub mod teams;
pub mod teams_activity;
pub mod teams_avatars;
pub mod teams_cards;
pub mod teams_chat_settings;
pub mod teams_media;
pub mod teams_members;
pub mod teams_presence;
pub mod teams_read;
pub mod teams_readstate;
pub mod teams_profiles;
pub mod teams_send;
pub mod teams_unfurl;
pub mod tracker_people;
pub mod trouter;
pub mod trouter_events;
pub mod xwindow;
pub mod store;
pub mod update;
