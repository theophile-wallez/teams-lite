/// The `User-Agent` this app's outbound requests carry, in ONE spelling. A stranger's
/// server answers a request by what it claims to be — several of the domains a sender icon
/// is fetched from 403 a client that names none — so a module building its own client for a
/// reason of its own (see `sender_icon`) must still sound like the rest of the app.
pub const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

pub mod agent;
pub mod agent_markdown;
pub mod agent_models;
pub mod agent_policy;
pub mod auth;
pub mod calendar;
pub mod calling;
pub mod changelog;
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
pub mod push;
pub mod push_policy;
pub mod restart;
pub mod retry;
pub mod sender_icon;
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
pub mod store;
pub mod update;
