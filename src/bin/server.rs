// teams-lite — SERVER (Rust backend, opencode model)
//
// The proven Rust core (auth broker, trouter real-time, local-first SQLite store,
// send, name resolution) exposed over a local WebSocket so the web app can drive
// it. The app never touches the network or the store directly — it speaks this
// JSON protocol:
//
//   request  (client -> server):  { "id": <n>, "method": "<m>", "params": {...} }
//   response (server -> client):  { "id": <n>, "result": <v> }  |  { "id": <n>, "error": "<msg>" }
//   event    (server -> client):  { "event": "<name>", "data": {...} }   (no id)
//
// Methods: conversations | open | backfill | set_draft | send | edit | react | notifications
//          | fetch_media | fetch_avatar | sender_icon | profile | people_by_address | presence
//          | get_settings | set_settings | set_always_available | enrich_link
//          | gitlab_approvals | gitlab_set_approval
//          | gitlab_mr_list | gitlab_mr_detail | gitlab_mr_notes | gitlab_mr_pipeline
//          | gitlab_mr_diff | gitlab_mr_upload | gitlab_mr_job_log
//          | gitlab_mr_merge | gitlab_mr_comment | gitlab_mr_delete_comment
//          | gitlab_mr_edit_comment | gitlab_mr_resolve_thread | gitlab_mr_set_state
//          | mail_folders | mail_list | mail_backfill | mail_body | mail_attachment
//          | mail_mark_read
//          | calendars | calendar_view
//          | agent_status | agent_set_mode | agent_set_tools | agent_set_provider
//          | agent_set_unrestricted
//          | agent_persona_avatar | agent_persona_save | agent_persona_remove
//          | person_override | person_overrides | set_person_name | set_person_avatar
//          | update_check | update_download | update_apply | restart_backend
// Events:  status | message | conversations_changed | notifications_changed | typing
//          | read_receipt | call | call_signal | update_available | update_progress
//          | update_restart | backend_restart
//          | mail_folders_changed | mail_list_updated | mail_list_error
//          | calendars_changed | calendar_view_updated | calendar_view_error
//          | gitlab_list_updated | gitlab_mr_updated | gitlab_read_error
//          | agent_personas_changed
//          | agent_stream | person_override_changed | settings_changed
//
// The `mail_*` methods are the READ-ONLY Outlook surface (see `mail`): the same
// broker identity carries the mailbox, and the app lists folders, reads messages and
// renders bodies. It cannot send, reply, delete or move a mail, nor mark one read IN
// THE MAILBOX — no such path exists in the crate, and `mail::tests` enforce that on
// the source. `mail_mark_read` is the one mail method that writes, and it writes one
// column of our own mirror: the marker clears in this app, and Outlook is never told
// (see `Store::mark_mail_read_locally`). Mail bodies are
// sanitized server-side and stripped of every remote reference, so displaying one
// makes no network request of its own.
//
// The `calendar_*` methods are the READ-ONLY Teams/Outlook calendar (see `calendar`),
// on the same identity and the same local-first pipeline. It cannot create, move,
// cancel, accept, decline or forward anything — again absent from the crate rather
// than merely ungated, and `calendar::tests` enforce it on the source. That matters
// as much as it does for mail: creating an event mails an invitation to every
// attendee, and answering one mails the organizer.
//
// The `agent_*` methods arm the LOCAL AGENT (see `agent`, `agent_policy`): the user
// writes `@claude <prompt>` in a thread from any Teams client, this backend runs that
// CLI on this machine, posts one message and edits it as the answer arrives — so the
// whole thread watches the reply being written. It answers only a message the USER
// wrote, only in a conversation the user opted in (the sandbox channel out of the
// box), with a read-only tool allowlist, and never from a read-only backend. See
// AGENTS.md § The local agent for the four rules and why each one is load-bearing.
//
// The `call` event is incoming-call AWARENESS only (ring/dismiss a banner) — it
// rides on the after-the-fact `Event/Call` chat system message.
//
// `call_signal` carries the RAW calling frames, forwarded verbatim, while the wire
// schema is still young (see NATIVE-CALLING.md § 8). It is a capture aid beside the
// typed `call_state`, not the feature: the app acts on `call_state` alone.
// No media is placed/answered without an explicit user action.
//
// `TEAMS_LITE_READ_ONLY=1` refuses every outward-facing method (send | edit |
// react) at the dispatch choke point — the backend's own safety catch for any
// session where the UI is driven by tooling rather than by a human. See
// `read_only`, and the "Automation safety" section of AGENTS.md.
//
// `enrich_link` turns a tracker link in a message into a rich preview card, through
// whichever integration recognizes its host (see `link_preview`): `gitlab` for merge
// requests, issues and projects, `linear` for issues, projects and documents. Both
// are READ-ONLY like mail and the calendar — a Linear API key can create and edit
// issues as the user, so `linear` sends GraphQL queries only and `linear::tests`
// enforce that on the source, as `gitlab::tests` now do for the GET-only read path.
//
// `gitlab_set_approval` was the FIRST write this app made to a tracker: it approves a
// merge request under the user's own GitLab account, or takes that approval back (see
// `gitlab_approval`). It lives in a module of its own, it is an {@link OUTWARD_METHODS}
// entry — the write token, refused read-only, blocked by the automation hook — and it
// exists because it is reversible from the same menu. `gitlab_approvals` beside it is the
// READ that tells the menu which half to offer.
//
// The `gitlab_mr_*` methods are the MERGE-REQUEST PAGE (see `gitlab_mr` for the reads,
// `gitlab_mr_write` for the writes, and AGENTS.md § The GitLab page). The reads — `list`,
// `detail`, `notes`, `pipeline`, `diff`, `job_log` — are open like every other read and answer from a durable
// response cache (`gitlab_reads`) before they ask GitLab, so the page paints from disk and
// refreshes behind itself. `upload` is the sixth read and the one that carries BYTES: a picture
// a description or a comment points at, fetched with the token the browser does not hold, so
// the page draws it without ever asking GitLab itself. The four writes — `merge`, `comment`, `delete_comment`,
// `set_state` — are {@link OUTWARD_METHODS} entries, and `gitlab_mr_merge` is the one that
// cannot be taken back.
//
// No raw tokens are ever logged or sent.

use anyhow::{Context, Result};
use base64::Engine as _;
use futures_util::{stream::FuturesUnordered, FutureExt, SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use teams_lite::store::{Message, Store};
use teams_lite::teams::Session;
use teams_lite::{
    agent, agent_markdown, agent_models, agent_persona, agent_policy, auth, calendar, calling,
    custom_emoji,
    mail, push, push_policy, retry,
    sender_icon, signin, store, teams,
    teams_activity, teams_avatars, teams_media, teams_members, teams_presence, teams_profiles,
    teams_read, teams_readstate, teams_send, trouter, trouter_events,
};
use teams_lite::{
    gitlab, gitlab_approval, gitlab_ci_graph, gitlab_mr, gitlab_mr_write, linear, link_preview,
    tracker_people,
};

/// The port the user's own backend owns: what the `teams` command and the web app
/// dial by default.
///
/// Every teams-lite port sits in one 194xx block, chosen because nothing registers
/// it and it stays below the ephemeral range (`net.ipv4.ip_local_port_range` starts
/// at 32768), so an outbound connection can never borrow it first. The full map
/// lives in AGENTS.md § Ports; keep the two in step.
const DEFAULT_PORT: u16 = 19420;
/// Where a READ-ONLY backend listens instead, unless `TEAMS_LITE_PORT` says
/// otherwise. A separate port by default so a read-only instance — the one tooling
/// is allowed to start — can never take the port the real one wants, and the two
/// can run side by side: the user keeps their live app on 19420 while an agent
/// inspects real data on 19430. They share the SQLite store safely (WAL +
/// busy_timeout, see `store::Store::open`).
const READ_ONLY_PORT: u16 = 19430;

/// How many scheduled messages the list answers with. Far above any real queue — Slack's
/// own ceiling is 30 per conversation — and it bounds a read that is otherwise unbounded
/// by anything the user does.
const MAX_SCHEDULED_LISTED: i64 = 200;
const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const UA: &str = teams_lite::USER_AGENT;
/// Give the UI ample time to connect after the server becomes ready. Authentication
/// happens before the listener binds, so this only covers local startup delays.
const INITIAL_CLIENT_GRACE: Duration = Duration::from_secs(30);
/// Once at least one UI has connected, an empty server is an orphan. Keep a short
/// grace window for UI restarts/reconnects, then terminate the backend ourselves.
const DISCONNECTED_CLIENT_GRACE: Duration = Duration::from_secs(10);

/// Settings keys (see `store::Store::{get,set}_setting`). The GitLab host plus one
/// access token per integration drive rich link previews (see `link_preview`).
const SETTING_GITLAB_HOST: &str = "gitlab_host";
const SETTING_GITLAB_TOKEN: &str = "gitlab_token";
/// A Linear personal API key. Linear is SaaS-only, so unlike GitLab it has no host
/// to configure — only whether we hold a key (see `linear`).
const SETTING_LINEAR_TOKEN: &str = "linear_token";
/// The Linear workspace that key belongs to, as `linear_workspace` last read it —
/// its url key, its team keys, and when it was read (see [`linear_workspace_json`]).
/// Cached because the page asks on every connect and neither half moves by the hour.
const SETTING_LINEAR_WORKSPACE: &str = "linear_workspace";
/// Ghost mode (`"1"` = on, anything else = off, and OFF is the default): read a
/// conversation without telling Teams. `mark_read` then only moves our LOCAL read
/// position, so the marker clears here while Teams keeps the thread unread and the
/// sender never gets a read receipt. Off by default because the normal, expected
/// behaviour of a chat client is that opening a chat reads it everywhere.
const SETTING_GHOST_MODE: &str = "ghost_mode";
/// Always available (`"1"` = on, anything else = off, and OFF is the default): keep
/// the user's own Teams status green for everybody who can see them, by registering
/// this machine as an endpoint reporting Available and refreshing it on a heartbeat
/// (see [`teams_presence::register_available_endpoint`] and `spawn_presence_heartbeat`).
///
/// It is the CONSENT half of the setting; [`SETTING_AVAILABLE_HOURS`] is the other, and
/// green at 03:00 is what made the second one necessary.
///
/// OUTWARD, which is why `set_always_available` is in {@link OUTWARD_METHODS}: the
/// green dot is what every colleague reads to decide whether to write. Off by default
/// because a status the user did not ask for is a claim about them they never made.
const SETTING_ALWAYS_AVAILABLE: &str = "always_available";
/// The hours the setting above keeps the user green, as `"08:00-19:00"` in the machine's
/// own local time — empty (or absent) for all day, which is what the switch meant before
/// it grew a window (see [`teams_presence::AvailableHours`]).
///
/// It is a separate row rather than a shape stored in the switch's own so that a window
/// SURVIVES the switch: somebody who turns the setting off in the evening and on again
/// the next morning gets the hours they set, not a blank. And the two are written together
/// by one RPC, so a stored window with the switch off can never publish anything.
const SETTING_AVAILABLE_HOURS: &str = "available_hours";
/// The IANA time zone those hours are kept in (`"Europe/Paris"`), empty for the machine's
/// own — which is the older behaviour and the default.
///
/// It is a setting because the PERSON travels and the machine does not: the always-on
/// service runs on one machine in one flat, and somebody who set 08:00-19:00 in Paris and is
/// reading this from Tokyo wants their green dot in Tokyo's morning. A zone name rather than
/// an offset, so the answer survives DST (see [`teams_presence::minute_of_day`]).
const SETTING_AVAILABLE_ZONE: &str = "available_zone";
/// Sender icons (`"0"` = off, anything else = on, and ON is the default): show the mark
/// of the organisation a mail came from, fetched from that organisation's own domain
/// (see [`sender_icon`]).
///
/// It is a setting because it is the only place this app requests something from a
/// stranger's server, and it defaults ON because the user asked for the mark — the five
/// rails in `sender_icon` are what make that defensible, not this flag. Turning it off
/// stops every such request at the dispatch point, and a read-only backend never makes
/// one whatever the setting says.
const SETTING_SENDER_ICONS: &str = "sender_icons";
/// Whether a custom emoji somebody SENDS is taken into this machine's pack as the message
/// arrives (see [`import_emoji_from_message`]). ON by default, because a colleague's
/// emoji that has to be picked out of a menu one at a time is a pack nobody fills.
///
/// It is a setting because of the one thing the pack decides: what art `:shipit:` posts
/// under the user's own name on the next send. Everything else about it is bounded by code
/// — a name the user already holds is never overwritten (`custom_emoji::take_as`), the
/// bytes must pass the same caps as an upload, and the art must come from a Teams host.
/// What the switch buys is the user's own answer to "may the people in my threads put
/// pictures in my pack at all".
const SETTING_EMOJI_AUTO_IMPORT: &str = "emoji_auto_import";
/// Whether a notification about a message in a SEALED chat carries the WORDS.
///
/// **Off by default**, which is the opposite default from the two settings above, and
/// deliberately: the user sealed that conversation, and a preview on a locked screen is the one
/// place its words would appear without them asking. The backend holds the key, so it could
/// publish them either way, and the payload is encrypted to the device (RFC 8291) — so what the
/// switch decides is a lock screen and a notification the phone keeps, not who can read the
/// message in transit.
///
/// A sealed chat still NOTIFIES with it off: it says a message arrived and nothing about what it
/// says (see [`teams_lite::push_policy`]). Silence would be worse — the reader would find out by
/// opening the app, which is what a notification exists to save them.
const SETTING_SEALED_PUSH_WORDS: &str = "sealed_push_words";
/// The id of the presence endpoint this store's backends register, generated on first
/// use and then kept. Stable ON PURPOSE, twice over: re-registering the same id is the
/// same endpoint refreshed rather than a second one, so neither the heartbeat nor the
/// two backends that share this store (the always-on service and the user's dev one)
/// can leave a trail of registrations Teams still counts as us.
const SETTING_PRESENCE_ENDPOINT_ID: &str = "presence_endpoint_id";
/// This machine's VAPID private key (base64url), generated on first use. It must
/// stay stable: every device's subscription embeds the matching public half, so a
/// new key silently stops every phone that already opted in (see
/// [`teams_lite::push::VapidKey`]).
const SETTING_PUSH_VAPID_PRIVATE: &str = "push_vapid_private";

/// Longest nickname the user may give somebody. Generous next to a real display name
/// (the longest in this tenant is 31 bytes) and small enough that a stored override
/// can never grow into something a sidebar row has to truncate to nothing.
const MAX_PERSON_NAME_BYTES: usize = 120;

/// Largest custom avatar accepted, in bytes. The picture is fetched over the same
/// WebSocket as everything else and base64 costs a third on top, so a generous photo
/// budget rather than a media one — and the app renders it at 192px at most.
const MAX_PERSON_AVATAR_BYTES: usize = 2 * 1024 * 1024;

/// The image types a custom avatar may be. Raster formats only, on purpose: these
/// bytes come back out of this app into an `<img>`, and an allowlist of four decoders
/// is a thing a reader can check at a glance. SVG is deliberately absent — it is a
/// document, not a bitmap, and an avatar has no need to be one.
const PERSON_AVATAR_TYPES: [&str; 4] =
    ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// How long a claim on a live message is kept before [`Store::prune_claims`] drops
/// it. Only there to stop two backends acting twice on the same LIVE message — a
/// double push, or one `@claude` trigger answered twice — and every policy already
/// refuses anything older than a few minutes.
const CLAIM_RETENTION: Duration = Duration::from_secs(24 * 3600);

/// The RPC methods that act OUTWARD — they change what other people see in the
/// user's real Teams account (a message posted, edited, deleted, or reacted to, or a
/// read receipt shown). Every other method only reads, or writes to the local store.
///
/// `delete` is the one entry that cannot be taken back: an edit rewrites a message
/// and a reaction can be cleared, but a deletion removes the message from the thread
/// for everybody, on every device. The UI therefore asks for a second, explicit
/// confirmation before it calls this.
///
/// `mark_read` is outward for two reasons: it clears the unread marker on every
/// device the user is signed in on, and Teams shows the new read position to the
/// other party as a "seen by" receipt. Ghost mode (see [`SETTING_GHOST_MODE`]) makes
/// it local-only, but the method can write, so the gate is on the method.
///
/// `set_always_available` publishes the user's own presence (see
/// [`SETTING_ALWAYS_AVAILABLE`]). It posts no message, but the green dot it turns on
/// is read by every colleague as a statement about where the user is — and the same
/// call is what takes it back, so both directions belong behind one gate.
/// `set_chat_muted` publishes one of the user's own chat settings: Teams stores a mute
/// as the conversation's `alerts` property, and the setting lands in every client they
/// are signed in on — their phone stops notifying them about that thread. It reaches no
/// colleague, which is why the refusal text says so plainly, but it changes the user's
/// account on every device, so it sits behind the same gate as a send. The chat's PIN
/// and HIDE are deliberately NOT here: neither write round-trips through the tenant, so
/// both stay local to this app (see `src/teams_chat_settings.rs`).
/// The four calling methods are outward for the sharpest reason in this list: a call
/// RINGS a person. `call_place` starts a device buzzing in somebody's pocket,
/// `call_accept` opens the user's own microphone to whoever is on the other end,
/// `call_hangup` ends the call for both of them (or declines it, which the caller is
/// shown), and `call_mute` publishes whether the user can be heard. None of them can
/// be taken back, and none is ever automatic: each one carries out a click the user
/// just made. `call_prepare` is the one calling method that is NOT here — it posts
/// nothing, and sits in {@link MACHINE_METHODS} with its own refusal text.
///
/// `gitlab_set_approval` is the one entry that reaches a place other than Teams: it
/// approves — or takes back the approval of — a merge request under the user's own
/// GitLab account (see [`teams_lite::gitlab_approval`]). Everybody watching the merge
/// request is told, a project rule may act on it, and it is the ONLY write this app
/// makes to a tracker; every other thing it knows about GitLab and Linear reads. So it
/// is gated exactly like a send, and it is offered only because the same call takes it
/// back: a write whose off switch cannot undo its on switch would not be here at all
/// (see `forceavailability` in `teams_lite::teams_presence`). Reading the approval
/// state (`gitlab_approvals`) stays open, like every other read.
/// `call_answer_media` is here for what it CAN carry rather than for what it usually does.
/// The service renegotiates on its own and an answer that only accepts a stream publishes
/// nothing about the user — but the same method carries an SDP, and an SDP is what offers
/// their camera or their screen. A gate that depended on reading the blob would be a gate
/// nobody could check, so it is gated as the widest thing it can do.
/// `call_offer_media` is the sharpest calling entry after `call_place`. It is what puts the
/// user's CAMERA or their SCREEN in front of everybody in a meeting — a screen more so than a
/// face, because a screen shows whatever else is on it. Nothing calls it but a click, and the
/// browser asks its own permission on top.
///
/// The six `gitlab_mr_*` entries are the merge-request PAGE's writes (see
/// [`teams_lite::gitlab_mr_write`] and AGENTS.md § The GitLab page). Each acts under the
/// user's own GitLab account and everybody watching the merge request is told, so each is
/// gated exactly like a send — and five of the six are REVERSIBLE from the same page: a
/// comment is deleted by `gitlab_mr_delete_comment`, a close is undone by a reopen, a
/// resolution by opening the thread again, and an edit by editing back (which is where a
/// Teams message edit sits: the words that were there are gone).
///
/// `gitlab_mr_merge` is the ONE entry in this list that no later call takes back, which
/// puts it beside `delete`. It lands somebody's branch in a shared repository, and a
/// project's CI may deploy from it. It is here because the user asked for the page to do
/// what GitLab's own does; what makes it defensible is that GitLab refuses a merge whose
/// `sha` is not the branch's head, so the page can only ever merge the commit it drew —
/// plus the second, explicit confirmation the UI asks for, exactly as it does before a
/// message deletion.
/// How long to wait for a meeting to grant a content-sharing session before offering the
/// section anyway. One round trip on the calling plane, plus room for the frame behind it.
const SHARING_GRANT_WAIT: std::time::Duration = std::time::Duration::from_secs(8);
/// How often to look while waiting. Short enough that the share follows the grant closely, and
/// long enough that the lock is not held in a spin.
const SHARING_GRANT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

const OUTWARD_METHODS: [&str; 23] = [
    "send",
    "edit",
    "delete",
    "react",
    "mark_read",
    "set_always_available",
    "set_chat_muted",
    "call_place",
    "call_join",
    "call_accept",
    "call_answer_media",
    "call_offer_media",
    "call_start_sharing",
    "call_stop_sharing",
    "call_hangup",
    "call_mute",
    "gitlab_set_approval",
    "gitlab_mr_merge",
    "gitlab_mr_comment",
    "gitlab_mr_delete_comment",
    "gitlab_mr_edit_comment",
    "gitlab_mr_resolve_thread",
    "gitlab_mr_set_state",
];

/// The RPC methods that act on THIS MACHINE rather than on the user's Teams account.
///
/// A second reason to need the write token, and deliberately not folded into
/// {@link OUTWARD_METHODS}: that list means "posts as the user", three tests iterate
/// it, and AGENTS.md tells every later reader that a new entry there is a Teams,
/// mail or calendar write gaining a consent gate. `repair_broker` posts nothing — it
/// restarts the Intune container — so it is gated for the other reason, and says so
/// in its own refusal text.
///
/// The `push_*` methods are here for the same reason and one of their own: a
/// subscription is a URL a client supplies, and every incoming message preview is
/// then POSTed to it. Even with [`teams_lite::push::is_supported_endpoint`] confining
/// that to the browser vendors' push services, deciding which devices a machine
/// notifies is not something a client that merely found this socket gets to do.
///
/// `set_settings` stores the integration credentials (see `link_preview`), and one
/// of them is host-pinned rather than fixed: a client that could write
/// `gitlab_host` would repoint the pin at a host it controls, and the next
/// `enrich_link` for a link on that host would hand it the user's stored GitLab
/// token. Reading the settings back stays open — it never returns a token, only
/// whether one is set.
///
/// The `agent_*` methods are the sharpest case of that reasoning. None of them posts,
/// so none belongs above — but `agent_set_mode` decides which conversations this
/// machine will later answer in the user's name, `agent_set_tools` decides what a chat
/// message may make a local agent do, and `agent_set_provider` decides which CLI a
/// chat message starts and which model reads the thread. A client that merely found
/// this socket gets to do none of it.
///
/// `agent_set_unrestricted` is the sharpest of them all: it hands the child the user's
/// own configuration — every MCP server, every tool, their own permission mode. It is
/// the one switch in this file that a stranger on the socket could turn into code
/// execution, so it is gated exactly like the others and off in a fresh store.
///
/// `set_person_name` and `set_person_avatar` are the two entries that write only to the
/// store, and they are here because of WHAT they write: the name and the face this app
/// puts on somebody's messages. A client that could set them could make a colleague's
/// post appear to come from another person — in the sidebar, in the bubble, in the
/// notification on the user's phone. Authorship is the one thing this app never
/// misstates (see the local agent's signature line in AGENTS.md), so relabelling it is
/// the user's own act and nothing that merely found this socket gets to perform it.
/// Reading the overrides back stays open: it returns what the user themselves chose.
///
/// `custom_emoji_add`, `custom_emoji_remove` and `custom_emoji_import` are the three
/// entries that write the custom emoji pack. They write only to the store, and they are
/// gated because a client that could edit the pack could post pictures this machine never
/// approved under the user's own name on the next send. Reading the pack back stays open:
/// it returns what the user themselves put in.
///
/// `agent_persona_save` and `agent_persona_remove` write the user's own CUSTOM AGENTS (see
/// [`teams_lite::agent_persona`]). They touch only the store, and they are gated for the
/// reason `agent_set_tools` is: a row here decides what a later `@bebou` in a thread the
/// user opted in will do — which CLI starts, which model reads the thread, and what
/// instruction leads the prompt. A client that could write one could put words in the mouth
/// of a program that answers as the user, so it is their own act. Reading the list back
/// stays open: it returns what they themselves made. They can never widen what an agent may
/// DO — the tool allowlist is machine-wide and has its own gate — and they can never name a
/// program, because a persona points at an entry of the static provider table.
///
/// `call_prepare` is the calling entry that posts nothing: it reserves the one call slot
/// this machine has and hands the page the relay credentials its `RTCPeerConnection`
/// needs. The credentials are why it is gated rather than open, because a client that
/// merely found this socket has no business holding them.
/// `call_subscribe` ASKS the meeting's media server for somebody's stream and publishes
/// nothing at all about the user — so it is not outward, and it is not open either: it acts
/// on the one call this machine holds.
///
/// `restart_backend` takes THIS process down and lets whatever runs it start it again (see
/// [`teams_lite::restart`], and Settings › This app). It is the sibling of `update_apply`
/// minus the new binary: every open page loses its socket for as long as the restart takes,
/// a live `@claude` reply is cut off where it stood, and the user's calls do not ring here
/// meanwhile. Nothing that merely found this socket gets to do that to the app the user is
/// reading — and `update_check`, which only ASKS GitHub whether a newer build exists,
/// deliberately stays open beside it: it changes nothing on this machine.
/// `seal_set`, `seal_off` and `seal_forget` decide whether a conversation's messages are
/// ENCRYPTED before they reach Teams, and under which passphrase (see [`teams_lite::seal`]).
/// They write only to the store, and they are gated for the reason `custom_emoji_add` is —
/// what they decide is what the next send publishes — but the consequence is sharper in both
/// directions. A client that could turn sealing OFF would make the next message go out in the
/// clear to a chat whose reader believes it is sealed; one that could turn it ON, or change the
/// passphrase, would make every message the user then posts unreadable to the colleagues they
/// are writing to. `seal_forget` is sharper still: it drops a key, and every message that key
/// sealed becomes unreadable on this machine for good.
/// `seal_reveal` is here because its ANSWER is the passphrase itself. That is the one thing in
/// this file a client is handed rather than told about, and it exists because a colleague who
/// joins the conversation next month has to be given something — so it is the user's own press,
/// never a field of a status payload. `seal_status` stays OPEN beside it: it answers WHICH
/// conversations are sealed and under which key id, and never with the key or the words.
///
/// `signin_start` / `signin_frame` / `signin_input` / `signin_cancel` serve the identity
/// broker's own sign-in window to the browser the app is read in (see [`teams_lite::signin`]
/// and SIGN-IN.md). They post nothing to Teams, so they are not outward — but each one is a
/// long way past what a client that merely found this socket may do: `signin_start`
/// authenticates as the user, `signin_frame` answers with a picture of a sign-in page, and
/// `signin_input` presses keys into it. `signin_frame` is gated as hard as the rest for that
/// reason: a read whose answer is the pixels of somebody's password field is not a read.
const MACHINE_METHODS: [&str; 30] = [
    "repair_broker",
    "signin_start",
    "signin_frame",
    "signin_input",
    "signin_cancel",
    "restart_backend",
    "update_download",
    "update_apply",
    "call_prepare",
    "call_subscribe",
    "push_subscribe",
    "push_unsubscribe",
    "push_test",
    "set_settings",
    "agent_set_mode",
    "agent_set_tools",
    "agent_set_provider",
    "agent_set_unrestricted",
    "agent_stop",
    "agent_persona_save",
    "agent_persona_remove",
    "set_person_name",
    "set_person_avatar",
    "custom_emoji_add",
    "custom_emoji_remove",
    "custom_emoji_import",
    "seal_set",
    "seal_off",
    "seal_forget",
    "seal_reveal",
];

/// How many of a conversation's newest messages `seal_set` reads to answer "does this passphrase
/// open what is already here".
///
/// A handful is enough to name the key in use and it is one indexed read: the question is "which
/// passphrase is this thread being sealed with right now", not "every key it has ever seen".
const SEAL_SCAN_DEPTH: i64 = 50;

/// What a page is told about the sealed chats on this machine: which conversations, which key
/// ids, and which one is current — and never a key or a passphrase.
///
/// It is the shape `get_settings` holds for a token: the page needs to know whether a chat is
/// sealed in order to draw a padlock and a composer hint, and it never needs the secret to do it.
fn seal_status_value(ctx: &Ctx) -> Result<Value> {
    let store = ctx.store()?;
    let conversations: Vec<Value> = store
        .sealed_conversations()?
        .into_iter()
        .map(|entry| {
            json!({
                "conversation": entry.conversation_id,
                "sealing": entry.sealing,
                "current_key_id": entry.current_key_id,
                "keys": entry
                    .keys
                    .iter()
                    .map(|k| json!({
                        "key_id": k.key_id,
                        "is_current": k.is_current,
                        "added_ms": k.added_ms,
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "conversations": conversations }))
}

/// What a {@link MACHINE_METHODS} entry actually does to the machine, for its
/// refusal text. Per method, not per class: "restarts the Intune container" would be
/// a lie about a push subscription, and a refusal nobody believes is a refusal
/// nobody reads.
fn machine_effect(method: &str) -> &'static str {
    match method {
        "repair_broker" => "restarts the Intune container on this machine",
        "signin_start" => "signs in to the user's own Entra account from this machine",
        "signin_frame" => "answers with a picture of the sign-in page open on this machine",
        "signin_input" => "presses keys into the sign-in page open on this machine",
        "signin_cancel" => "closes the sign-in window open on this machine",
        "restart_backend" => {
            "restarts this app's backend on this machine, which drops every open page's \
             connection and cuts off a local agent that is writing a reply"
        }
        "update_download" => "downloads a new build of this app onto this machine",
        "update_apply" => {
            "replaces this app's own binary on this machine, and restarts everything the \
             user's Teams account runs through"
        }
        "push_subscribe" | "push_unsubscribe" | "push_test" => {
            "changes which devices this machine sends push notifications to"
        }
        "set_settings" => "stores the integration credentials kept on this machine",
        "agent_set_mode" => {
            "decides which conversations this machine answers in the user's name, with a local \
             agent"
        }
        "agent_set_tools" => "decides what a local agent this machine runs may do",
        "agent_set_provider" => {
            "decides which coding agent this machine starts for a chat message, and which \
             model reads the thread"
        }
        "agent_set_unrestricted" => {
            "lets a local agent this machine runs use the user's own Claude Code \
             configuration — every tool it holds"
        }
        "agent_stop" => "stops a local agent this machine is running mid-answer",
        "seal_set" => {
            "decides that this machine encrypts every message it posts to a conversation, and \
             under which passphrase — so a wrong one makes every message unreadable to the \
             colleagues it is written to"
        }
        "seal_off" => {
            "stops this machine encrypting a conversation, so the next message goes out in the \
             clear to a chat whose reader believes it is sealed"
        }
        "seal_forget" => {
            "drops a passphrase this machine holds, and every message it opened becomes \
             unreadable here for good"
        }
        "seal_reveal" => "answers with a passphrase this machine holds",
        "agent_persona_save" | "agent_persona_remove" => {
            "changes the custom agents this machine answers to, and what instruction leads \
             their prompts"
        }
        "set_person_name" | "set_person_avatar" => {
            "decides the name and the face this machine puts on a colleague's messages"
        }
        "custom_emoji_add" | "custom_emoji_remove" | "custom_emoji_import" => {
            "decides which pictures this machine can post as emoji under the user's name"
        }
        "call_prepare" => {
            "reserves this machine's one call and hands out the media credentials it holds"
        }
        "call_subscribe" => {
            "asks the meeting's media server to send this machine somebody's camera or \
             shared screen"
        }
        // Unreachable while the two lists agree; the test below pins that they do.
        _ => "changes this machine",
    }
}

/// Why a method needs the write token, or `None` when it only reads or writes the
/// local store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteClass {
    /// Posts to real people as the user. See {@link OUTWARD_METHODS}.
    Outward,
    /// Changes this machine. See {@link MACHINE_METHODS}.
    Machine,
}

fn write_class(method: &str) -> Option<WriteClass> {
    if OUTWARD_METHODS.contains(&method) {
        return Some(WriteClass::Outward);
    }
    if MACHINE_METHODS.contains(&method) {
        return Some(WriteClass::Machine);
    }
    None
}

/// How often the "Always available" endpoint registration is refreshed.
///
/// Measured against the tenant: one registration keeps us Available for 300 s and is
/// gone by 330 s, because an endpoint is a claim that a client is running NOW. Two
/// minutes leaves room for a missed tick and a retry inside a window whose end is
/// visible to every colleague as the user going Offline.
const PRESENCE_HEARTBEAT: Duration = Duration::from_secs(120);

/// How often a live call is kept alive.
///
/// The service tears a call down when the client stops saying it is still there, and the
/// interval it asks for (`callKeepAliveInterval`) has not been seen on this tenant yet —
/// so this is deliberately shorter than any plausible server timeout. A keep-alive that
/// arrives too often costs one request; one that arrives too late drops the call.
const CALL_KEEPALIVE: Duration = Duration::from_secs(20);

/// How often this MACHINE asks GitHub what the rolling `latest` release names.
///
/// Two minutes, so an app somebody left open on a phone offers a build within two minutes
/// of CI publishing it — the check used to run once at startup, and an app that is never
/// restarted never saw a release again.
///
/// The number is bounded from below by a MEASURED budget: GitHub allows an unauthenticated
/// caller 60 requests an hour per IP, and a conditional request buys nothing (a `304` was
/// measured still spending one). Two minutes is 30 an hour, which is half the budget — and
/// it stays 30 however many backends this machine runs, because the fetch is claimed
/// through the store (`Store::claim_release_check`). Shortening it eats the half that
/// downloads and the compare API live on; a `403` there has no symptom except an update
/// button that stops appearing.
const RELEASE_CHECK_INTERVAL: Duration = Duration::from_secs(120);

/// The systemd unit that repairs the broker by restarting the Intune container.
/// Never run `intune-container` from here: one unit keeps the rate limit in one
/// place, counted across the health timer, this backend and the in-app button.
const BROKER_REPAIR_UNIT: &str = "teams-lite-broker-repair.service";

/// The floor between two repairs this process asks for. Shorter than the unit's own
/// limit (three an hour) so the backend refuses first and the journal names it.
const REPAIR_MIN_INTERVAL: Duration = Duration::from_secs(20 * 60);

/// How long an applied update waits for the launcher to restart the app before this
/// backend concludes that nothing will (see `Ctx::apply_update`). Several seconds
/// rather than one: the launcher stops the web server and kills this process, and a
/// loaded machine can take a moment over it.
const RESTART_GRACE: Duration = Duration::from_secs(10);

/// How long a requested restart waits before it takes this process down.
///
/// The RPC's own answer travels on the socket the restart drops, so a restart that acted at
/// once would swallow the outcome of the click that asked for it — the one frame the user is
/// waiting on. Long enough for a local WebSocket write, short enough that nothing about the
/// press feels delayed.
const RESTART_ANSWER_GRACE: Duration = Duration::from_millis(250);

/// Read-only mode (`TEAMS_LITE_READ_ONLY=1`): refuse every {@link OUTWARD_METHODS}
/// call before it can reach the network.
///
/// This exists because the backend is the LAST line of defense against an
/// accidental outward action: automated tooling (screenshot scripts, E2E-style
/// drivers, an agent debugging the UI) is meant to talk to `web/mock/server.ts`,
/// but a single missing `VITE_TEAMS_WS_URL` is enough to point it at this server
/// instead — and then a scripted keypress posts to a real colleague's chat. It
/// has happened. Anything that drives the UI without a human reading each
/// keystroke should run the backend with this flag set, so the worst outcome of a
/// misconfiguration is a refused request instead of a real message.
///
/// Read once: the mode is a property of the process, and re-reading the
/// environment per request would let it drift mid-session.
fn read_only() -> bool {
    // The library owns the answer, because `auth::rescue` needs it too: an automatic
    // interactive sign-in is an act on the user's account. One spelling, two callers.
    teams_lite::read_only()
}

/// Resolve the port to listen on: an explicit `TEAMS_LITE_PORT` wins, else
/// read-only mode moves aside to {@link READ_ONLY_PORT} and a normal backend takes
/// {@link DEFAULT_PORT}.
///
/// Pure (both inputs injected) so the precedence is unit-tested.
fn resolve_port(configured: Option<&str>, read_only: bool) -> u16 {
    if let Some(port) = configured.and_then(|v| v.trim().parse::<u16>().ok()).filter(|p| *p > 0) {
        return port;
    }
    if read_only {
        READ_ONLY_PORT
    } else {
        DEFAULT_PORT
    }
}

/// The port this process listens on, resolved once from the environment.
fn own_port() -> u16 {
    let configured = std::env::var("TEAMS_LITE_PORT").ok();
    resolve_port(configured.as_deref(), read_only())
}

/// The address this process binds, from the environment.
fn bind_addr() -> String {
    format!("127.0.0.1:{}", own_port())
}

/// Where this backend keeps the endpoint id it registers ONE trouter worker under.
///
/// An endpoint id is what the real-time service routes a live message to, and a second
/// registration of the same id REPLACES the first — the service then pushes every
/// message, typing signal and read receipt to whichever backend registered last, and
/// the other one goes silent while its reads keep working. That is not a hypothetical:
/// the staged service (19420) and the released build (19422) run side by side on this
/// machine (§ Running the released build beside the staged one), on ONE store — so an
/// id derived from the store's path alone was one id for two backends, and the user's
/// own app stopped showing a message until the page was reloaded, because the other
/// install was holding the feed.
///
/// So the id is per PORT, which is exactly what tells this machine's backends apart
/// (see the ports table in AGENTS.md), and per WORKER, because the messaging and calling
/// workers are two endpoints of their own.
///
/// EVERY port is named, the default one included, and that is deliberate: the build that
/// shares this machine may predate this fix — the released one does — and it still holds
/// the unqualified `…​.epid`. A backend that kept that name would keep losing its feed to
/// it. The cost is one fresh registration per install, once.
fn endpoint_id_path(db_path: &str, port: u16, worker: &str) -> std::path::PathBuf {
    let stem = if worker.is_empty() { "epid".to_string() } else { format!("{worker}-epid") };
    std::path::Path::new(db_path).with_extension(format!("{port}.{stem}"))
}

/// Environment variable a launcher can use to pin the write token itself (rather
/// than letting the backend generate one), so a parent process can hand the same
/// value to the backend and to the frontend it spawns.
const WRITE_TOKEN_ENV: &str = "TEAMS_LITE_WRITE_TOKEN";

/// Whether this process's token was PINNED by a parent instead of minted and published
/// here. Set once, by `write_token`; read by the startup log, which must not name a file
/// that does not hold this backend's token — and by nothing else, because the policy it
/// records lives in `write_token`.
static WRITE_TOKEN_PINNED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Whether this process has already said that a sign-in resolved no display name.
///
/// A session is re-minted every `SESSION_TTL` and after every 401, so the repair in
/// [`Ctx::directory_name`] runs again and again on a tenant that has stopped sending
/// `userDetails` — one line is the record of that, and a repeat every fifty minutes is
/// noise nobody reads.
static NAMELESS_SIGN_IN_REPORTED: AtomicBool = AtomicBool::new(false);

/// Was the token handed to us? False until [`write_token`] has resolved one.
fn write_token_pinned() -> bool {
    WRITE_TOKEN_PINNED.get().copied().unwrap_or(false)
}

/// THE WRITE LOCK.
///
/// Reading this backend is open: any local client may list conversations and read
/// history, which is what makes it useful to work against. WRITING is not — a
/// `send`/`edit`/`react` posts to real people as the user, and an automated client
/// that reached this backend by accident must not be able to do it. (It happened:
/// a screenshot script drove the real app and posted three messages to two
/// colleagues' chats.)
///
/// So every outward-facing call must present a capability token that only the
/// user's own frontends are given: the backend mints one per process and
/// publishes it to a 0600 file in the runtime directory (see
/// `write_token_path`), where `web/server.ts` and the Vite dev server read it. A
/// client that was not handed the token — an ad-hoc script, a stray
/// browser tab, an agent's driver — gets a refusal, not a message on the wire.
///
/// `None` means writes are refused outright: read-only mode.
///
/// Threat model, stated honestly: this stops ACCIDENTS, not a determined local
/// process. Anything running as the user can read the token file, exactly as it
/// can read the SQLite store. What it buys is that no client writes *without
/// having deliberately gone to fetch a secret it was never given* — and every
/// path that would do so is forbidden by AGENTS.md and blocked by
/// `.claude/hooks/guard-live-automation.sh`.
fn write_token() -> Option<&'static str> {
    static TOKEN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    TOKEN
        .get_or_init(|| {
            if read_only() {
                return None;
            }
            let pinned = std::env::var(WRITE_TOKEN_ENV)
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            // A PINNED token is never published, and that absence is what lets two
            // send-capable backends run side by side.
            //
            // The file is ONE path per machine (`write_token_path`), so a second backend
            // that published would overwrite the first one's token — and the first one's
            // frontend would then be handed a token its own backend refuses. Reads keep
            // working, so the app looks healthy while every send comes back refused: the
            // user's phone, on the always-on service, would stop being able to answer
            // anybody the moment a second instance started.
            //
            // A pinned token needs no file anyway: the parent that pinned it hands the
            // same value to the frontend it runs (see `launcher/src/backend.ts`), which is
            // the whole point of the variable.
            let _ = WRITE_TOKEN_PINNED.set(pinned.is_some());
            let token = match pinned {
                Some(token) => token,
                None => {
                    let token = mint_write_token();
                    if let Err(e) = publish_write_token(&token) {
                        // Enforce anyway. A lock that quietly opens itself when it can't
                        // publish is the failure we are fixing; a frontend that cannot
                        // send until this is resolved is loud, and recoverable.
                        eprintln!(
                            "[write-lock] could not publish the write token ({e}) — writes \
                             will be refused until a frontend can read it. Set \
                             {WRITE_TOKEN_ENV} in both the backend and the frontend to work \
                             around a read-only runtime directory."
                        );
                    }
                    token
                }
            };
            Some(token)
        })
        .as_deref()
}

/// A fresh 256-bit token, hex, from the OS CSPRNG (`uuid` v4 twice over).
fn mint_write_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Every directory the token is published to, most volatile first: the runtime
/// directory (tmpfs, wiped on logout) and the data directory.
///
/// BOTH, deliberately. A frontend does not necessarily see the same environment as
/// the backend — a service unit may have `XDG_RUNTIME_DIR` while a shell-launched
/// dev server does not — and a token only one side can find would leave the user's
/// own app unable to send. The frontend (`web/write-token.ts`) searches the same
/// list in the same order.
fn write_token_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let candidates = [
        std::env::var_os("XDG_RUNTIME_DIR"),
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share").into()),
    ];
    for candidate in candidates.into_iter().flatten() {
        let path = std::path::PathBuf::from(candidate);
        if path.is_absolute() && !dirs.contains(&path) {
            dirs.push(path);
        }
    }
    dirs.into_iter().map(|base| base.join("teams-lite")).collect()
}

/// The first place a frontend will look for the token (used for the startup log).
fn write_token_path() -> Result<std::path::PathBuf> {
    write_token_dirs()
        .into_iter()
        .next()
        .map(|dir| dir.join("write-token"))
        .context("cannot resolve a runtime or data directory for the write token")
}

/// Write the token where our frontends can read it, owner-only (0600), replacing
/// any token left behind by a previous process. Succeeds if at least one location
/// took it; reports the last error when none did.
fn publish_write_token(token: &str) -> Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let mut last_error: Option<anyhow::Error> = None;
    let mut published = 0usize;
    for dir in write_token_dirs() {
        let write_one = || -> Result<()> {
            std::fs::create_dir_all(&dir).with_context(|| format!("create dir {}", dir.display()))?;
            let path = dir.join("write-token");
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)
                .with_context(|| format!("open {}", path.display()))?;
            // An existing file keeps its old mode, so set it explicitly too.
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            file.write_all(token.as_bytes())?;
            Ok(())
        };
        match write_one() {
            Ok(()) => published += 1,
            Err(e) => last_error = Some(e),
        }
    }
    if published > 0 {
        return Ok(());
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no writable location for the write token")))
}

/// The words every "the token you presented is not mine" refusal carries.
///
/// A frontend reads them back: a page holds the token its own server handed it, and the
/// one thing that invalidates it is a backend RESTART — which the page cannot see, since
/// reads keep answering. So it re-reads the token and retries the call once when it meets
/// this phrase (`isWriteTokenRefusal` in web/src/lib/ws-client.ts), and that is safe
/// because the refusal happens here, before any network call. Keep the two spellings in
/// step; `the_token_refusal_says_what_a_frontend_looks_for` pins them.
const WRITE_TOKEN_REFUSAL: &str = "needs the write token";

/// Gate one request against the write lock. Reads always pass; an outward-facing
/// method must carry a `write_token` matching this process's own.
///
/// Pure (token injected) so the policy is unit-testable without a live backend.
fn check_write_allowed(method: &str, params: &Value, token: Option<&str>) -> Result<(), String> {
    let Some(class) = write_class(method) else {
        return Ok(());
    };
    let Some(token) = token else {
        return Err(match class {
            WriteClass::Outward => format!(
                "refused: `{method}` acts on the real Teams account and this server runs read-only \
                 (TEAMS_LITE_READ_ONLY=1). Restart it without that variable to allow writes, or \
                 point the client at web/mock/server.ts to exercise the flow."
            ),
            WriteClass::Machine => format!(
                "refused: `{method}` {}, and this server runs read-only \
                 (TEAMS_LITE_READ_ONLY=1). Tooling never changes the user's own machine — their \
                 own backend does.",
                machine_effect(method)
            ),
        });
    };
    match params.get("write_token").and_then(Value::as_str) {
        Some(presented) if presented == token => Ok(()),
        _ => Err(match class {
            WriteClass::Outward => format!(
                "refused: `{method}` {WRITE_TOKEN_REFUSAL} this backend published for the user's \
                 own frontends. A client that was not given it (an ad-hoc script, an automated \
                 driver) may read everything here, but must not act as the user — post a \
                 message, or publish their status. If you are a \
                 frontend, read the token from {WRITE_TOKEN_ENV} or from the file the backend \
                 logged at startup; if you are automation, drive web/mock/server.ts instead."
            ),
            WriteClass::Machine => format!(
                "refused: `{method}` {WRITE_TOKEN_REFUSAL} this backend published for the user's \
                 own frontends. It {} — not something a client that merely found this socket gets \
                 to do. If you are a frontend, read the token from {WRITE_TOKEN_ENV} or from the \
                 file the backend logged at startup.",
                machine_effect(method)
            ),
        }),
    }
}

/// Where a client stands with the write lock — the question every refusal above
/// answers, one click too late.
///
/// WHY IT IS ASKABLE AT ALL. A frontend holds the token the server that serves it handed
/// over (`/__write-token`, over `web/write-token.ts`), and that pairing breaks in two ways
/// neither side can see. `teams` ATTACHES to a backend that is already listening
/// (`ensureBackend` in launcher/src/backend.ts), and a backend another launcher spawned
/// carries a PINNED token — which is in no file, on purpose — so the attached instance
/// serves its page a token nothing accepts. And `TEAMS_LITE_WS_URL`, when it is already
/// set, points the page's socket at one backend while its token comes from another. In
/// both, reads answer normally and every outward and machine method is refused: the app
/// looks healthy, the composer only chimes, and the state is stated nowhere but in the
/// refusal text of whatever the user pressed. A user met it on the update button.
///
/// It leaks nothing. Any client that can ask this can present the same token to `send`
/// and read the same answer out of the refusal it gets; the token itself never travels
/// back (`the_write_lock_payload_never_carries_the_token` pins that).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteLockState {
    /// This backend gates writes, and the client presented the token it gates them
    /// with. Every method is open to it.
    Held,
    /// This backend gates writes and the client does not hold that token, so every
    /// `OUTWARD_METHODS` and `MACHINE_METHODS` call it makes will be refused.
    Foreign,
    /// `TEAMS_LITE_READ_ONLY=1`: there is no token, and no client writes. Deliberately
    /// its own state rather than `Foreign` — nothing is misconfigured, and no frontend
    /// can mend it (see the refusal text `check_write_allowed` gives that case).
    ReadOnly,
}

impl WriteLockState {
    /// The wire name. Kept identical to the union in web/src/lib/protocol.ts.
    fn tag(self) -> &'static str {
        match self {
            Self::Held => "held",
            Self::Foreign => "foreign",
            Self::ReadOnly => "read_only",
        }
    }
}

/// Resolve [`WriteLockState`] for one client. Pure (both tokens injected) so the
/// policy is unit-testable without a live backend, exactly like
/// [`check_write_allowed`], whose comparison it must keep matching.
fn write_lock_state(presented: Option<&str>, token: Option<&str>) -> WriteLockState {
    let Some(token) = token else {
        return WriteLockState::ReadOnly;
    };
    match presented {
        Some(presented) if presented == token => WriteLockState::Held,
        _ => WriteLockState::Foreign,
    }
}

/// The `write_lock_status` answer: where the client stands, and where this backend's
/// token lives.
///
/// `pinned` is what makes the answer actionable rather than merely true: a pinned token
/// was handed over by the launcher that spawned this process and was published nowhere,
/// so a `foreign` client cannot go and read the right one — another instance owns this
/// backend, and the way out is to stop it or to give this one a port of its own. An
/// unpinned one sits in the file every frontend already reads, so a `foreign` client is
/// simply holding a token from before a restart and re-reading it is the whole fix
/// (which `retryWithAFreshToken` in web/src/lib/ws-client.ts does on its own).
fn write_lock_payload(presented: Option<&str>, token: Option<&str>, pinned: bool) -> Value {
    json!({
        "state": write_lock_state(presented, token).tag(),
        "pinned": pinned,
    })
}

/// The `broker_status` event payload: what the backend thinks of the identity
/// broker, and whether it can do anything about it.
///
/// Emitted on a CHANGE of state and in every client's greeting — a phone that opens
/// the tab mid-outage has to learn about it too, and a page that reconnects after a
/// repair has to learn that the trouble is over. One shape for both.
fn broker_status_payload(repairing: bool) -> Value {
    // Resolved ONCE and handed to both readers. `broker_display()` walks all of /proc — a
    // `read_dir` plus a `cmdline` read per process — and this payload is built in the greeting of
    // every connection and inside the observer that runs from a failing token call, so doing it
    // per field paid for the whole walk twice each time.
    let display = teams_lite::xwindow::broker_display();
    let state = auth::broker_state().unwrap_or_default();
    // Only the one signature whose known cause a container restart fixes, and never
    // from a read-only backend. Not checked here: whether this host HAS an Intune
    // container. It does not need to be — a locked keyring is a containerized-Intune
    // failure, and a classic host produces `Unreachable` or `Refused` instead, both of
    // which already answer false. The repair unit re-checks anyway
    // (ConditionFileIsExecutable + its ExecCondition), so a wrong yes costs nothing.
    let can_repair = state
        .failure
        .map(|f| f.is_repairable() && !read_only())
        .unwrap_or(false);
    json!({
        "ok": state.is_ok(),
        // Whether this app can serve the broker's own sign-in for this failure. Answered
        // here rather than in the page, because all three halves of it are the backend's:
        // which failure needs a human, whether this backend may act as the user at all, and
        // whether the broker has a display to draw its window on. A hopeful `true` would
        // offer the reader a button that opens a panel nothing can ever appear in.
        "can_sign_in": can_sign_in(&state, &display),
        // What a sign-in cannot do here, in the words the reader needs, or empty. Carried on
        // this event so the banner can say WHY it is offering nothing, which is the half the
        // old dead button never had.
        "signin_blocker": signin_blocker(&state, &display),
        "signature": state.failure.map(|f| f.tag()).unwrap_or(""),
        "message": state.failure.map(|f| f.message()).unwrap_or(""),
        // The full cause chain. Useful in a bug report, and never a secret: the
        // broker's error codes carry no token (see `broker_failure` in src/auth.rs).
        "detail": state.detail,
        "consecutive_failures": state.consecutive_failures,
        "can_repair": can_repair,
        "repairing": repairing,
    })
}

/// Which broker failures a served sign-in can actually answer.
///
/// `Refused` only, and that narrowness is deliberate. It is the measured shape: the broker
/// reached AAD, AAD said `interaction_required`, and the account it holds is the one the
/// interactive request is built from (SIGN-IN.md § 1). `NoAccount` looks like the case that
/// needs a sign-in most and is NOT offered: with no account the request has nobody to name,
/// the device's enrolment is what is gone, and that is `intune-container`'s business rather
/// than a token's. Every other failure is about the broker being unreachable or asleep, where
/// a sign-in window could not be drawn anyway.
fn failure_needs_a_human(failure: Option<auth::BrokerFailure>) -> bool {
    matches!(failure, Some(auth::BrokerFailure::Refused))
}

/// Can this app serve the broker's sign-in for the state it is in?
fn can_sign_in(state: &auth::BrokerState, display: &teams_lite::xwindow::DisplayState) -> bool {
    failure_needs_a_human(state.failure)
        && !read_only()
        && matches!(display, teams_lite::xwindow::DisplayState::Ready { .. })
}

/// Why a sign-in cannot be served, when it cannot. Empty when it can, and empty when the
/// question does not arise — a failure a container restart fixes has its own remedy, and two
/// sentences offering two different repairs would leave the reader choosing between them.
fn signin_blocker(state: &auth::BrokerState, display: &teams_lite::xwindow::DisplayState) -> String {
    if !failure_needs_a_human(state.failure) || read_only() {
        return String::new();
    }
    display.refusal().unwrap_or_default()
}

/// The `signin_status` payload when no sign-in is going on.
///
/// A shape rather than `null`, so a page reads one field to decide whether to draw the panel
/// and an older backend's silence is not mistaken for a sign-in that is running.
fn signin_idle() -> Value {
    json!({
        "phase": "idle",
        "detail": "",
        "scope": "",
        "display": "",
        "waited_ms": 0,
        "window": Value::Null,
    })
}

/// Tracks established WebSocket clients. Raw TCP readiness probes do not count:
/// the lease is acquired only after the WebSocket handshake succeeds.
#[derive(Clone)]
struct ClientTracker {
    state: Arc<Mutex<ClientState>>,
}

struct ClientState {
    active: usize,
    ever_connected: bool,
    last_change: Instant,
}

impl ClientTracker {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ClientState {
                active: 0,
                ever_connected: false,
                last_change: Instant::now(),
            })),
        }
    }

    fn connect(&self) -> ClientLease {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active += 1;
        state.ever_connected = true;
        state.last_change = Instant::now();
        ClientLease {
            tracker: self.clone(),
        }
    }

    fn snapshot(&self) -> (usize, bool, Duration) {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        (
            state.active,
            state.ever_connected,
            state.last_change.elapsed(),
        )
    }
}

/// RAII keeps the active count correct through normal closes and every error path.
struct ClientLease {
    tracker: ClientTracker,
}

impl Drop for ClientLease {
    fn drop(&mut self) {
        let mut state = self.tracker.state.lock().unwrap_or_else(|e| e.into_inner());
        debug_assert!(state.active > 0, "client tracker underflow");
        state.active = state.active.saturating_sub(1);
        state.last_change = Instant::now();
    }
}

fn should_shutdown(active: usize, ever_connected: bool, idle_for: Duration) -> bool {
    if active > 0 {
        return false;
    }
    let grace = if ever_connected {
        DISCONNECTED_CLIENT_GRACE
    } else {
        INITIAL_CLIENT_GRACE
    };
    idle_for >= grace
}

/// Env escape hatch to keep the backend alive across frontend disconnects (dev /
/// standalone use): with `TEAMS_NO_IDLE_EXIT` set, the process only stops on a
/// signal (Ctrl+C), never because the last client went away. Any value counts as
/// "on" except an explicit falsey token, so both `=1` and `=true` work.
///
/// Pure helper (takes the raw value) so the parsing is unit-tested without
/// touching the process environment.
fn env_flag_enabled(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
    }
}

/// Resolve whether idle auto-shutdown is disabled, from the process environment.
fn idle_exit_disabled() -> bool {
    env_flag_enabled(std::env::var("TEAMS_NO_IDLE_EXIT").ok().as_deref())
}

async fn wait_for_idle_shutdown(clients: ClientTracker, disabled: bool) {
    // Dev/standalone: never resolve, so the caller's shutdown branch can't fire.
    // Only a signal (Ctrl+C / SIGTERM) will stop the process.
    if disabled {
        std::future::pending::<()>().await;
    }
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let (active, ever_connected, idle_for) = clients.snapshot();
        if should_shutdown(active, ever_connected, idle_for) {
            return;
        }
    }
}

/// How far the user has taken the update, and the one thing each phase needs.
///
/// One value, not a set of booleans, because the phases exclude each other and the UI
/// draws exactly one thing per phase (see web/src/components/update-button.tsx). The
/// tag is what travels on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum UpdatePhase {
    /// A newer release exists and nothing has been downloaded. Nothing happens on its
    /// own from here: the download is 130 MB, so the user asks for it.
    #[default]
    Idle,
    /// Fetching the release asset. `received` moves; the total is in the availability
    /// payload, so a client that connects mid-download can draw the bar at once.
    Downloading,
    /// Downloaded and verified, waiting for the user's second click.
    Ready,
    /// Installed, and the launcher is putting the app back up on the new build. The
    /// socket drops right after this — which is why the phase is published BEFORE the
    /// restart is asked for, or nobody would ever see it.
    Restarting,
    /// Installed, but nothing restarted the app (no launcher is listening). The new
    /// build is on disk and starts next time; saying so is the honest end state.
    Installed,
    /// The download or the install failed. `error` says how, and the button offers to
    /// try again — a failure that clears itself would hide a broken release.
    Failed,
}

impl UpdatePhase {
    /// The wire name. Kept identical to the union in web/src/lib/protocol.ts.
    fn tag(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Downloading => "downloading",
            Self::Ready => "ready",
            Self::Restarting => "restarting",
            Self::Installed => "installed",
            Self::Failed => "failed",
        }
    }
}

/// How many times a download reads the release and fetches it before it gives up.
///
/// Two, and bounded on purpose. One is not enough: the rolling `latest` asset can be
/// replaced while it is being fetched, and the second attempt — which re-reads the release
/// — is what makes that heal itself. More would hide a broken release behind a button that
/// never stops trying.
const DOWNLOAD_ATTEMPTS: usize = 2;

/// How long a failed attempt waits before the next one.
///
/// **The commonest 404 here is CI republishing `latest`, and its width is measured.** The
/// workflow DELETES the rolling release and creates it again with the asset
/// (`.github/workflows/build.yml`), so `/releases/tags/latest` and the asset URL both
/// answer 404 for the length of that one step — 6 s, 6 s and 10 s over the three runs of
/// 2026-08-07. A retry with no wait rides out nothing: it re-read the release a
/// millisecond later, inside the same hole, and the user was shown a bare `404 Not Found`
/// on a release that was whole seconds afterwards. Wider than the widest hole measured,
/// and short enough that a genuinely broken release still answers while somebody is still
/// looking at the button.
const DOWNLOAD_RETRY_WAIT: Duration = Duration::from_secs(20);

/// What GitHub says about the release right now — the answer a download starts from.
enum ReleaseNow {
    /// The asset to fetch, and the commit it was built from.
    Asset(teams_lite::update::Asset, String),
    /// This build IS the release. There is nothing to download.
    Current,
    /// GitHub could not be read, or it published no binary for this machine. Whatever the
    /// last check found stands.
    Unknown,
}

/// Everything known about a newer release, in one lock.
///
/// The availability half (`available`) is what the check found; the rest is the state
/// of installing it. They live together because a client learns both on one greeting,
/// and because two backends of the same build must not disagree about which phase the
/// user's own app is showing.
#[derive(Debug, Default)]
struct UpdateSlot {
    /// The `update_available` payload, once the check has found a newer release.
    available: Option<Value>,
    /// The release binary to fetch. Kept HERE and never sent to a client: the download
    /// is this backend's to make (the UI touches no network), and a URL a client could
    /// supply is a URL a client could substitute.
    asset: Option<teams_lite::update::Asset>,
    /// The commit the release was built from, which names the downloaded file.
    latest: String,
    /// What the update brings: the commits between this build and the release, grouped by
    /// `teams_lite::changelog`. `None` until it has been read — and it stays `None` when
    /// GitHub could not answer, which the button draws as no list rather than as no button.
    changes: Option<teams_lite::changelog::Changelog>,
    /// The release `changes` describes. The list is cached against it because
    /// `refresh_release` runs on every download attempt, and a comparison between two
    /// commits that have not moved is the same comparison.
    changes_rev: String,
    /// The downloaded build, once complete and verified.
    file: Option<std::path::PathBuf>,
    phase: UpdatePhase,
    received: u64,
    /// Why the last attempt failed, for the button to show. Empty unless `Failed`.
    error: String,
}

impl UpdateSlot {
    /// The `update_progress` payload: the phase, and the numbers that go with it.
    fn progress_json(&self) -> Value {
        json!({
            "phase": self.phase.tag(),
            "received": self.received,
            "total": self.asset.as_ref().map(|a| a.size).unwrap_or(0),
            "error": self.error,
        })
    }
}

/// Shared backend context; cloned into each connection + the trouter task.
#[derive(Clone)]
struct Ctx {
    http: reqwest::Client,
    /// broker token cache (auto-refreshes per scope before expiry)
    tokens: auth::TokenCache,
    /// the Teams session (skypetoken + endpoints); refreshed when stale
    session: Arc<tokio::sync::Mutex<SessionCell>>,
    db_path: Arc<String>,
    /// broadcast of server->client events (fan-out to every connected UI)
    events: broadcast::Sender<Value>,
    /// Everything known about a newer release: whether there is one, and how far the
    /// user has taken installing it. Cached rather than only broadcast, because a UI
    /// connects at any moment — between two passes of the release poll, or in the middle of
    /// a download it has to draw a progress bar for. See {@link UpdateSlot}.
    update: Arc<std::sync::Mutex<UpdateSlot>>,
    /// Mail folders the live poll watches (see `spawn_mail_sync`). Seeded with the
    /// inbox and extended whenever a UI opens a folder, so the poll costs one
    /// request per folder the user actually looks at rather than one per folder the
    /// mailbox happens to have.
    mail_watch: Arc<Mutex<std::collections::BTreeSet<String>>>,
    /// The calendar window the live poll re-reads (see `spawn_calendar_sync`), or
    /// `None` until a UI opens the calendar. Only the LATEST window is watched: a
    /// calendar UI shows exactly one range at a time, and re-reading the month the
    /// user navigated away from would be work nobody is looking at.
    calendar_watch: Arc<Mutex<Option<CalendarWatch>>>,
    /// When this process last asked systemd for a broker repair, so it cannot loop.
    /// See {@link REPAIR_MIN_INTERVAL} and `start_broker_repair`.
    last_repair: Arc<Mutex<Option<std::time::Instant>>>,
    /// The one interactive sign-in this backend may be serving, and nothing else.
    ///
    /// One at a time, because the broker draws one window and a second flow would fight it
    /// for the display. Its presence is also the whole authorization to serve a frame: with
    /// no live session there is no window to read and no keystroke to deliver, so this app
    /// can never be asked for a picture of the machine's screen (see [`teams_lite::signin`]).
    signin: Arc<Mutex<Option<Arc<signin::Signin>>>>,
    /// The audio-calling plane: the calling connection's own address, and the one
    /// call this machine is in. Empty and idle on a backend that does not call at all
    /// ({@link calling_available}) — see [`CallingPlane`].
    calling: Arc<Mutex<CallingPlane>>,
    /// The GitLab reads being refreshed behind the page right now, by cache key.
    ///
    /// Single-flight, and it earns its place on the hot path: the merge-request page polls
    /// its pipeline while CI runs, two open pages (a phone and a laptop) poll the same one,
    /// and every stale answer starts a refresh. Without this, one merge request under two
    /// readers would ask GitLab twice a second and earn the token a rate limit. See
    /// [`gitlab_cached`].
    gitlab_refreshing: Arc<Mutex<std::collections::BTreeSet<String>>>,
    /// The Teams people a GitLab name can resolve to, and when the list was folded.
    ///
    /// It is a cache with a window, like the GitLab reads it serves (see
    /// [`TEAMS_PEOPLE_TTL`]): building it reads every person this machine has ever been told
    /// about — 294 of them here, from 12 603 messages — and the page asks for one on every
    /// answer it hands out, pipeline poll included. What it holds is only the MATCHING keys,
    /// Teams' own names, so a rename needs no invalidation at all: the name a page DRAWS is
    /// read per answer through `Store::display_name_for_mri`. See [`teams_people_of`].
    tracker_people: Arc<Mutex<Option<(i64, Arc<tracker_people::Roster>)>>>,
    /// The agent runs this process is streaming RIGHT NOW, by `run_id`, each with the
    /// switch that stops it (see [`agent_stop`]).
    ///
    /// The one handle onto a live run: the CLI child lives in a local inside `agent::run`
    /// and is spawned `kill_on_drop`, so flipping this switch cancels the run future,
    /// drops that child and kills the CLI. `run_id` is `conversation/trigger_id`, the id
    /// every `agent_stream` frame already carries, so the page asks to stop a run by the
    /// name it already knows it by. It holds only runs THIS backend owns — a run streaming
    /// on another install is not in here, which is what `agent_stop` reports (see
    /// § Running the released build beside the staged one).
    agent_runs_inflight: Arc<Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>>,
}

/// Everything this machine knows about audio calling right now.
///
/// Deliberately ONE call: a second simultaneous call would need a second microphone
/// and a UI that can hold two, and neither exists. A call arriving while one is up is
/// left for the user's other devices to ring, which is what Teams does with a client
/// that does not answer.
#[derive(Default)]
struct CallingPlane {
    /// The calling connection's surl and registration id, once it registered. `None`
    /// means no call can start: every callback link a call publishes is built on that
    /// surl, so without it there is nothing for the service to answer to.
    channel: Option<trouter::CallingChannel>,
    /// The call in flight, if any.
    call: Option<CallSession>,
    /// Whether that connection is up RIGHT NOW. Separate from `channel` on purpose: a
    /// reconnect must be able to tell a surl that came back UNCHANGED from one that
    /// moved (a moved surl invalidates a live call's links), so the address is kept
    /// across the gap while this says the socket is not carrying anything.
    connected: bool,
    /// The relay description the service sent, and the credentials fetched for it.
    /// Cached because they outlive one call and cost a round trip each.
    relay: Option<Value>,
    relay_credentials: Option<Value>,
    /// The calling connection's task, so turning the setting off can drop the socket
    /// as well as unregister the endpoint.
    connection: Option<tokio::task::JoinHandle<()>>,
}

/// A one-to-one call, a call that rings a whole group chat, or a meeting.
///
/// All three are the same signaling; what differs is what the UI has to say. A 1:1 names
/// the person, and the other two name the CONVERSATION and then answer "who" from the
/// roster — because a group of five has no one person to put in a title.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallKind {
    Call,
    Group,
    Meeting,
}

impl CallKind {
    fn as_str(self) -> &'static str {
        match self {
            CallKind::Call => "call",
            CallKind::Group => "group",
            CallKind::Meeting => "meeting",
        }
    }
}

/// Which way a call was set up. It decides which payload ends it and which side of
/// the SDP handshake this app performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallDirection {
    Incoming,
    Outgoing,
}

impl CallDirection {
    fn as_str(self) -> &'static str {
        match self {
            CallDirection::Incoming => "incoming",
            CallDirection::Outgoing => "outgoing",
        }
    }
}

/// How far along one call is. The UI draws one thing per state, and every transition
/// is either a frame from the service or the user's own click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallPhase {
    /// Somebody is calling us and we have not answered.
    Ringing,
    /// We are calling somebody and they have not answered.
    Dialing,
    /// Answered on both sides; the media is still being negotiated.
    Connecting,
    /// Audio is flowing.
    Connected,
    /// Over. Kept for one emit so the UI can say why, then dropped.
    Ended,
}

impl CallPhase {
    fn as_str(self) -> &'static str {
        match self {
            CallPhase::Ringing => "ringing",
            CallPhase::Dialing => "dialing",
            CallPhase::Connecting => "connecting",
            CallPhase::Connected => "connected",
            CallPhase::Ended => "ended",
        }
    }
}

/// The one call this machine is in.
struct CallSession {
    /// Our correlation id for the whole call — the `X-Microsoft-Skype-Chain-ID` on
    /// every request, and the id every RPC about this call names.
    id: String,
    direction: CallDirection,
    /// A one-to-one call, or a meeting this machine joined. It changes what the UI
    /// says, what the roster means, and nothing about the signaling: a meeting is the
    /// same set of links once the join is answered.
    kind: CallKind,
    phase: CallPhase,
    /// The chat, channel or meeting thread the call belongs to, when it has one.
    conversation_id: Option<String>,
    /// Who is on the other end of a one-to-one call. A meeting and a GROUP call name the
    /// conversation here instead, because "who" is the roster.
    peer_mri: String,
    peer_name: String,
    /// Every mri this outgoing call RINGS, resolved once when the call was reserved.
    ///
    /// It is the session's rather than the placing request's because `call_place` is a
    /// second round trip: the page comes back with an SDP and nothing else, so a list
    /// rebuilt there would be a second roster fetch that could disagree with the first —
    /// and this list is who a device buzzes for. Empty for an incoming call and for a
    /// meeting, neither of which rings anybody.
    ring: Vec<String>,
    /// Everybody the meeting's roster names, us included, newest frame wins. Empty for
    /// a one-to-one call, where the peer above is the whole answer.
    roster: Vec<calling::RosterMember>,
    /// True while the meeting has us in its LOBBY: joined, and waiting for somebody
    /// inside to admit us. Not a failure and not a connection — its own state, because
    /// the user has to know nobody has let them in yet.
    in_lobby: bool,
    /// Every link the service has handed us so far, newest merged over oldest.
    links: calling::Links,
    local: calling::LocalParticipant,
    callbacks: calling::CallbackBase,
    /// The offer the caller sent, held until the page asks for it (`call_prepare`).
    offer: Option<calling::MediaContent>,
    /// Whether we told the service we are muted. The microphone is muted in the page
    /// as well — this half is what draws the crossed-out microphone for everybody
    /// else in the call.
    muted: bool,
    /// When audio started, so the UI can count the duration from one clock.
    connected_at_ms: Option<i64>,
    /// Why it ended, for the line the UI shows afterwards.
    end_reason: Option<String>,
    /// True once the service said the invitation reached no endpoint at all — the callee has
    /// no client signed in. It is set from the frame that names the CAUSE and read by the
    /// ending, which names only the symptom (`calling::invite_failed`).
    unreachable: bool,
    /// Where to answer the media offer the service last made us, if it is still open.
    ///
    /// The service renegotiates unprompted and names the link on the frame itself, so this
    /// is that frame's own link and never the merged set. It is cleared as soon as it is
    /// used: answering the same negotiation twice is not something the service asked for.
    renegotiation_answer_link: Option<String>,
    /// The sequence number of the next source request, which the service reads to order
    /// them. One counter per call, because it numbers this client's own requests.
    source_request_sequence: u64,
    /// What this MACHINE is sending beyond audio: `"camera"`, `"screen"`, or neither.
    ///
    /// It is in the session rather than in the page because two open pages share one call:
    /// a phone that reconnects mid-call has to be told the camera is on, and a button drawn
    /// from a page's own memory would say off while the meeting sees a face.
    sending: Vec<String>,
    /// The content-sharing session this endpoint holds, once a meeting has granted one.
    ///
    /// A meeting shows ONE screen at a time, so sharing is a session and not a track: the
    /// service rejects an `applicationsharing-video` section from an endpoint that is not the
    /// presenter (measured 2026-08-06). It is `None` until the user shares, and it carries the
    /// way OUT, because a share that could not be given up is not a share this app would make.
    sharing: Option<calling::ContentSharing>,
}

impl CallSession {
    /// Everybody in the meeting but us. Our own mri is dropped here rather than in the
    /// caller, so a count of "who else is here" is one answer in one place.
    fn others(&self) -> Vec<&calling::RosterMember> {
        self.roster.iter().filter(|member| member.mri != self.local.id).collect()
    }

    /// True once this call is over. `end_call_locally` marks the session before it drops
    /// it, so a request that comes back from the network reads the same answer whichever
    /// side of that emit it lands on.
    fn ended(&self) -> bool {
        self.phase == CallPhase::Ended
    }

    /// The view of this call every client gets. It carries no SDP and no
    /// credentials: those only ever leave through a token-gated method.
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "direction": self.direction.as_str(),
            "kind": self.kind.as_str(),
            "phase": self.phase.as_str(),
            "conversation_id": self.conversation_id,
            "peer": self.peer_name,
            "peer_mri": self.peer_mri,
            "muted": self.muted,
            "connected_at_ms": self.connected_at_ms,
            "end_reason": self.end_reason,
            "in_lobby": self.in_lobby,
            // Who else is in the meeting, by name, and how many of them there are.
            // Ourselves excluded: a count that includes the reader reads as one person
            // too many, and the name of the person reading is not news.
            "others": self.others().iter().map(|m| m.display_name.clone()).collect::<Vec<_>>(),
            "other_mris": self.others().iter().map(|m| m.mri.clone()).collect::<Vec<_>>(),
            "waiting_in_lobby": self.others().iter().filter(|m| m.in_lobby).count(),
            // What the other people in the meeting are PUBLISHING, so the page can ask for
            // it. The source ids in here are the only addresses a subscription has, and the
            // roster is the only place they exist (NATIVE-CALLING.md § 10.2).
            //
            // THIS ENDPOINT's own streams are excluded, and nothing else is. Subscribing to
            // our own camera would draw the user's own face as a colleague's tile, and the
            // local preview never leaves the page anyway — but the discriminator has to be the
            // ENDPOINT and not the person: one account joined from a laptop and a phone has two
            // endpoints under one mri. Excluding by mri hid a screen the user was really
            // sharing from their other device — the section was negotiated and the tile drawn,
            // and nothing was ever subscribed to (measured 2026-08-06).
            "publishing": self
                .roster
                .iter()
                .filter_map(|m| {
                    let streams: Vec<Value> = m
                        .streams
                        .iter()
                        .filter(|s| s.endpoint_id != self.local.endpoint_id)
                        .map(calling::RosterStream::json)
                        .collect();
                    if streams.is_empty() {
                        return None;
                    }
                    Some(json!({ "mri": m.mri, "name": m.display_name, "streams": streams }))
                })
                .collect::<Vec<_>>(),
            // What the user may do next, decided HERE rather than in the page: the
            // links are what make an action possible, and only this side sees them.
            // What this MACHINE is sending beyond audio, so every page agrees and a
            // reconnecting one is told rather than guessing from its own memory.
            "sending": self.sending,
            "can_accept": self.phase == CallPhase::Ringing && self.offer.is_some(),
            "can_hangup": self.phase != CallPhase::Ended,
            // New media is only accepted on an ESTABLISHED call, in the service's own words.
            // Decided here because only this side knows whether the link exists.
            "can_send_media": self.phase == CallPhase::Connected
                && self.links.media_renegotiation().is_some(),
        })
    }
}

/// The calendar window a UI currently has on screen, and over which calendars.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CalendarWatch {
    /// Canonical UTC timestamps, month-aligned (the span of
    /// [`calendar::months_covering`]) rather than the exact grid the UI drew, so the
    /// poll refreshes whole cache units.
    start: String,
    end: String,
    calendars: Vec<String>,
}

/// The session plus when it was minted, so we can rebuild it before the
/// skypetoken expires (~1 day, but we refresh conservatively).
///
/// `session` is `None` when this process has never signed in — a backend that
/// started while the identity broker was down. It serves the store's own history in
/// that state (see `Ctx::identity`), and the first successful sign-in fills the cell
/// in with no restart.
struct SessionCell {
    session: Option<Session>,
    minted: std::time::Instant,
}

const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(50 * 60);

/// One store connection owned by a long-lived task (the trouter loops), opened on
/// first use and then kept.
///
/// Opening per event was never free: attaching a connection costs ~0.5 ms (SQLite
/// parses the schema on the first statement), and it starts with an empty
/// prepared-statement cache, so every frame re-parsed its SQL. Resolving a typing
/// frame's sender went from 6.5 ms to 0.02 ms once the connection — and its cache,
/// and the `sender_mri` index — stopped being thrown away between frames.
struct TaskStore {
    db_path: Arc<String>,
    store: Option<Store>,
}

impl TaskStore {
    /// The task's connection, opened on first use. `None` when the store cannot be
    /// opened; the next event tries again rather than leaving the task permanently
    /// storeless.
    fn get(&mut self) -> Option<&Store> {
        if self.store.is_none() {
            match Store::open(&self.db_path) {
                Ok(store) => self.store = Some(store),
                Err(e) => {
                    eprintln!("[store] could not open the store: {e}");
                    return None;
                }
            }
        }
        self.store.as_ref()
    }
}

impl Ctx {
    fn store(&self) -> Result<Store> {
        Store::open(&self.db_path)
    }

    /// A connection for a long-lived task to hold onto (see [`TaskStore`]).
    /// Request handlers keep using [`Ctx::store`]: they are short-lived, and a
    /// connection per in-flight request keeps writers from serializing.
    fn task_store(&self) -> TaskStore {
        TaskStore {
            db_path: self.db_path.clone(),
            store: None,
        }
    }
    fn emit(&self, event: &str, data: Value) {
        // ignore send errors (no subscribers yet is fine)
        let _ = self.events.send(json!({ "event": event, "data": data }));
    }

    /// Ask systemd to run the broker repair unit, unless this process asked for one
    /// too recently.
    ///
    /// Refuses in read-only mode HERE, not only at the dispatch choke point: the
    /// automatic trigger never passes through `check_write_allowed`, so without this
    /// guard a read-only backend started by tooling could restart the user's
    /// container on its own.
    ///
    /// Starting a unit through `systemctl` is a child process, and that is safe:
    /// `systemctl` is only a D-Bus client, so the unit's own processes are forked by
    /// the user manager into the UNIT's cgroup, a sibling of ours. The repair
    /// therefore survives the backend restart that `teams-lite-broker-bus.path`
    /// fires seconds later when the container rewrites rootless.json — which a
    /// direct child would not, because KillMode=control-group kills our whole group.
    async fn start_broker_repair(&self, automatic: bool) -> Result<Value> {
        anyhow::ensure!(
            !read_only(),
            "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never restarts the user's \
             Intune container"
        );

        if automatic {
            let mut last = self
                .last_repair
                .lock()
                .map_err(|_| anyhow::anyhow!("repair timestamp lock poisoned"))?;
            if let Some(at) = *last {
                let waited = at.elapsed();
                if waited < REPAIR_MIN_INTERVAL {
                    let left = (REPAIR_MIN_INTERVAL - waited).as_secs() / 60;
                    eprintln!(
                        "[broker] repair already tried {}m ago — not asking again for {left}m",
                        waited.as_secs() / 60
                    );
                    return Ok(json!({ "started": false, "reason": "rate_limited" }));
                }
            }
            *last = Some(std::time::Instant::now());
        }

        eprintln!("[broker] asking systemd to run {BROKER_REPAIR_UNIT}");
        let status = tokio::process::Command::new("systemctl")
            .args(["--user", "start", "--no-block", BROKER_REPAIR_UNIT])
            // Explicit: dropping this future must never kill the client mid-enqueue.
            .kill_on_drop(false)
            .status()
            .await
            .with_context(|| format!("run systemctl to start {BROKER_REPAIR_UNIT}"))?;

        // A non-zero exit is almost always the unit's own rate limit. `--no-block`
        // only enqueues, so success says nothing about the repair itself — the
        // outcome arrives as the broker recovering, or not.
        anyhow::ensure!(
            status.success(),
            "{BROKER_REPAIR_UNIT} refused to start ({status}). Most likely its rate limit of \
             three repairs an hour; check `systemctl --user status {BROKER_REPAIR_UNIT}`."
        );
        self.emit("broker_status", broker_status_payload(true));
        Ok(json!({ "started": true }))
    }

    // ---- signing in again, from the app ---------------------------------------
    // The other half of `start_broker_repair`: that one restarts the container for the
    // failure whose cause is a locked keyring, and these serve the broker's own sign-in
    // window for the failure only a human can answer. See [`teams_lite::signin`] for what
    // is deliberately narrow about them, and SIGN-IN.md for the measurements.

    /// The scope a sign-in should acquire: the one the app is actually broken on.
    ///
    /// Not the caller's choice — a client naming a scope would be choosing what this machine
    /// authenticates for. It is the scope every live feature needs, which is the one the
    /// failure was recorded against.
    fn signin_scope() -> String {
        // The recorded failure names its own scope (`auth::BrokerState::scope`), because a
        // refusal is per RESOURCE: measured, Graph minted while the skype scope refused. Signing
        // in for a scope that was not the broken one would mint a token, clear the broker state
        // and report "sign-in works again" over a feature still dark. Empty — a state recorded
        // by an older build, or a failure with no scope — falls back to the one every live
        // feature needs.
        let recorded = auth::broker_state().map(|s| s.scope).unwrap_or_default();
        if recorded.is_empty() { teams::SKYPE_SCOPE.to_string() } else { recorded }
    }

    /// Start an interactive sign-in, and say what the reader should expect.
    async fn start_signin(&self, _params: &Value) -> Result<Value> {
        // Read the display before the lock: it walks /proc, and nothing else may happen while
        // the claim below is held. Handed to `spawn_blocking` for the same reason — a
        // `read_dir` plus a read per process is not work for an async worker.
        let display = tokio::task::spawn_blocking(teams_lite::xwindow::broker_display)
            .await
            .context("read the display the broker draws on")?;
        let watcher = self.clone();

        // Claiming the slot and starting the flow happen under ONE guard, with no await
        // between them. Two presses in the same instant would otherwise both pass the check
        // and both start a flow — and since one interactive call is out at a time
        // (`auth::interactive_gate`), the loser would sit holding a window nobody reads. A
        // sign-in already going is not replaced: the broker draws one window, and a second
        // flow would fight the first for it. A SPENT one is, so a reader whose sign-in failed
        // can start another without waiting.
        let started = {
            let mut held = self.signin.lock().map_err(|_| anyhow::anyhow!("sign-in lock poisoned"))?;
            match held.as_ref().filter(|s| s.is_live()).map(Arc::clone) {
                Some(running) => Err(running),
                None => {
                    // Synchronous: it spawns the run and returns, so nothing awaits in here.
                    let session = signin::Signin::start(&Self::signin_scope(), &display, move |_phase| {
                        // Every open page hears how it ended, and the broker's own status goes
                        // out with it: a sign-in that worked makes the banner go away, and that
                        // fact belongs to the whole app rather than to the page that pressed
                        // the button.
                        watcher.emit_signin_status();
                        watcher.emit("broker_status", broker_status_payload(false));
                    })
                    .map(Arc::new);
                    if let Ok(session) = &session {
                        *held = Some(Arc::clone(session));
                    }
                    Ok(session)
                }
            }
        };

        match started {
            Err(running) => Ok(json!({
                "started": false,
                "reason": "already_running",
                "signin": running.payload().await,
            })),
            Ok(Err(signin::Refusal(words))) => Err(anyhow::anyhow!(words)),
            Ok(Ok(session)) => {
                let payload = session.payload().await;
                eprintln!("[signin] started for {}", Self::signin_scope());
                self.emit("signin_status", payload.clone());
                Ok(json!({ "started": true, "signin": payload }))
            }
        }
    }

    /// What the app draws while a sign-in is going, and what became of the last one.
    async fn signin_status(&self) -> Result<Value> {
        Ok(self.signin_payload().await)
    }

    /// The current sign-in's payload, or the "nothing is going on" shape.
    ///
    /// Never `null`: the page reads one field to decide whether to draw the panel, and an
    /// absent object would make "no sign-in" and "an older backend" the same answer.
    async fn signin_payload(&self) -> Value {
        // The session is behind a std Mutex and its payload is async, so the guard cannot be
        // held across the await: clone the handle out and let go of the lock first.
        let session = {
            let mut held = match self.signin.lock() {
                Ok(held) => held,
                Err(_) => return signin_idle(),
            };
            // Forget a session whose outcome nobody came back for, so this cannot report a
            // sign-in from an hour ago as the current one.
            if held.as_ref().is_some_and(|s| s.is_spent()) {
                *held = None;
            }
            held.as_ref().map(Arc::clone)
        };
        match session {
            None => signin_idle(),
            Some(session) => session.payload().await,
        }
    }

    fn emit_signin_status(&self) {
        let ctx = self.clone();
        tokio::spawn(async move {
            let payload = ctx.signin_payload().await;
            ctx.emit("signin_status", payload);
        });
    }

    /// One frame of the sign-in window.
    async fn signin_frame(&self) -> Result<Value> {
        self.with_live_signin(|session| async move { session.frame().await }).await
    }

    /// A keystroke or a click into the sign-in window.
    async fn signin_input(&self, params: &Value) -> Result<Value> {
        // Parsed BEFORE the session is touched, so a malformed request is refused without
        // pressing anything: this is the one RPC whose side effect is a key going into
        // somebody's password field.
        let input = signin::parse_input(params)?;
        self.with_live_signin(|session| async move {
            match input {
                signin::Input::Key(key) => session.type_key(key).await?,
                signin::Input::Click(x, y, button) => session.click(x, y, button).await?,
            }
            Ok(json!({ "sent": true }))
        })
        .await
    }

    /// Close the sign-in window, which is how a flow is ended.
    async fn cancel_signin(&self) -> Result<Value> {
        self.with_live_signin(|session| async move {
            Ok(json!({ "closed": session.cancel().await? }))
        })
        .await
    }

    /// Run `f` against the live sign-in, or refuse.
    ///
    /// The one gate every frame and every keystroke passes: no live sign-in, nothing served.
    /// That is what keeps this from being a way to read the machine's display — the window
    /// has to be one THIS backend asked the broker to draw.
    async fn with_live_signin<F, Fut>(&self, f: F) -> Result<Value>
    where
        F: FnOnce(Arc<signin::Signin>) -> Fut,
        Fut: std::future::Future<Output = Result<Value>>,
    {
        let session = {
            let held = self.signin.lock().map_err(|_| anyhow::anyhow!("sign-in lock poisoned"))?;
            match held.as_ref() {
                Some(session) if session.is_live() => Arc::clone(session),
                _ => anyhow::bail!(
                    "no sign-in is running — press Sign in again to start one"
                ),
            }
        };
        f(session).await
    }

    // ---- the update, in the two steps the user takes -------------------------
    // See `update` for what an update IS and which installs can take one. Both steps
    // are MACHINE methods: they spend the user's bandwidth and then replace the binary
    // their whole Teams account runs through, so neither is something a client that
    // merely found this socket gets to start.

    /// Read the update state under the lock and hand back what the closure took from it.
    fn with_update<T>(&self, f: impl FnOnce(&mut UpdateSlot) -> T) -> Result<T> {
        let mut slot = self
            .update
            .lock()
            .map_err(|_| anyhow::anyhow!("update state lock poisoned"))?;
        Ok(f(&mut slot))
    }

    /// Publish the current phase to every connected UI.
    fn emit_update_progress(&self) {
        if let Ok(payload) = self.with_update(|slot| slot.progress_json()) {
            self.emit("update_progress", payload);
        }
    }

    /// Record a release the check found, tell every UI about it, and answer whether this
    /// install can replace itself.
    ///
    /// The one place the `update_available` payload is spelled, because it is published
    /// from two: the release poll (see `Ctx::poll_release`), and every download — which
    /// re-reads the release first, and must correct the size the button draws its bar
    /// against when the answer moved (see `refresh_release`).
    fn publish_release(&self, info: &teams_lite::update::UpdateInfo) -> bool {
        // What the button needs beyond the two commits: how big the download is (so the
        // bar has a total from the first frame), and whether THIS install can replace
        // itself at all — a staged service cannot, and it keeps the release link instead.
        let installable =
            info.asset.is_some() && !read_only() && teams_lite::update::self_install().is_some();
        // What the update BRINGS, when it is already known: the commits between this build
        // and the release, which the button shows on hover. Read from the slot rather than
        // taken as an argument, so this stays the one place the payload is spelled — the
        // fetch is `learn_release_changes`, and it is cached against the release it
        // describes.
        let changes = self
            .with_update(|slot| {
                if slot.changes_rev == info.latest {
                    slot.changes.clone()
                } else {
                    None
                }
            })
            .unwrap_or(None);
        let data = json!({
            "current": info.current,
            "latest": info.latest,
            "url": info.url,
            "size": info.asset.as_ref().map(|a| a.size).unwrap_or(0),
            "can_install": installable,
            "changes": changes,
        });
        let _ = self.with_update(|slot| {
            slot.available = Some(data.clone());
            slot.asset = info.asset.clone();
            slot.latest = info.latest.clone();
        });
        self.emit("update_available", data);
        installable
    }

    /// Take a download failure back, once the release it was about has moved on.
    ///
    /// Only `Failed` is ever touched: every other phase either owns a live download or is a
    /// statement the user still has to act on, and the pass that calls this never runs in
    /// one of those. The progress frame is emitted only when something really changed, so an
    /// up-to-date app is not sent one every two minutes.
    fn clear_failed_update(&self) {
        let cleared = self
            .with_update(|slot| {
                if slot.phase != UpdatePhase::Failed {
                    return false;
                }
                slot.phase = UpdatePhase::Idle;
                slot.error.clear();
                slot.received = 0;
                slot.file = None;
                true
            })
            .unwrap_or(false);
        if cleared {
            self.emit_update_progress();
        }
    }

    /// Read what the update brings, once per release, and cache it for the payload.
    ///
    /// Called BEFORE `publish_release`, because that method is where the payload is spelled
    /// and it must not be two. Cached against the release's own commit: `refresh_release`
    /// runs on every download attempt, and the list between two builds does not change
    /// while both ends stand still — so a retried download costs no extra request.
    ///
    /// Quiet on failure, and the reason is the difference between the two facts it carries:
    /// that an update EXISTS is what the button is for, and WHAT it brings is a nicety on
    /// top. A rate-limited or force-pushed comparison leaves the button with no list, never
    /// the user with no button.
    async fn learn_release_changes(&self, info: &teams_lite::update::UpdateInfo) {
        let known = self
            .with_update(|slot| slot.changes_rev == info.latest && slot.changes.is_some())
            .unwrap_or(false);
        if known {
            return;
        }
        let Some(current) = teams_lite::update::build_rev() else {
            return;
        };
        match teams_lite::update::changes(&self.http, current, &info.latest).await {
            Ok(log) => {
                let _ = self.with_update(|slot| {
                    slot.changes_rev = info.latest.clone();
                    slot.changes = Some(log);
                });
            }
            Err(e) => eprintln!("[update] what it brings could not be read: {e}"),
        }
    }

    /// Forget the release: this build IS the newest one.
    ///
    /// Reached from a download that re-read the release and found nothing newer — the user
    /// updated on another install, or CI moved the tag back onto this commit. It empties
    /// the row rather than reporting a failure, because nothing failed, and it prunes the
    /// cache for the same reason the check does: a build the release moved PAST is one
    /// nobody will run again.
    ///
    /// `latest` names this build, and the download for it is SPARED even so: another
    /// install on this machine may be a commit behind and about to install exactly that
    /// file (see [`teams_lite::update::prune_downloads`]).
    fn forget_release(&self, latest: &str) {
        let _ = self.with_update(|slot| {
            *slot = UpdateSlot::default();
        });
        teams_lite::update::prune_downloads(latest);
        self.emit("update_available", Value::Null);
    }

    /// Re-read the release, and publish what changed.
    ///
    /// **A download must always start from this, never from what the greeting carried.**
    /// `latest` is a rolling tag: CI republishes it on every push, so the asset the startup
    /// check measured is silently replaced — and this app stays up for weeks. A transfer
    /// verified against that remembered size then failed forever, with a message that
    /// blamed the network and a button whose only offer was to try the same stale number
    /// again. That is the bug this exists to make impossible.
    async fn refresh_release(&self) -> ReleaseNow {
        let Some(current) = teams_lite::update::build_rev() else {
            return ReleaseNow::Unknown;
        };
        match teams_lite::update::check(&self.http, current).await {
            Ok(Some(info)) => match info.asset.clone() {
                Some(asset) => {
                    self.learn_release_changes(&info).await;
                    self.publish_release(&info);
                    ReleaseNow::Asset(asset, info.latest)
                }
                // A release with no binary for this machine is not something to download,
                // and it is not a failure either — the row goes back to being a link. The
                // list still travels: a link the user follows is a release page they are
                // about to read, so knowing what is in it beforehand is worth as much.
                None => {
                    self.learn_release_changes(&info).await;
                    self.publish_release(&info);
                    ReleaseNow::Unknown
                }
            },
            Ok(None) => ReleaseNow::Current,
            // Offline, rate-limited, a 5xx: keep whatever the last check found. A GitHub
            // outage must not stop a download that would otherwise work.
            Err(e) => {
                eprintln!("[update] re-reading the release failed: {e} — using the last check");
                ReleaseNow::Unknown
            }
        }
    }

    /// Start downloading the release asset, and answer with the phase the caller is now
    /// in.
    ///
    /// Idempotent on purpose: the button is on a page that may be open twice, and a
    /// second click (or a second phone) must join the download in flight rather than
    /// start a second one over the same file. A previous FAILURE is the one state a
    /// click retries from.
    async fn start_update_download(&self) -> Result<Value> {
        anyhow::ensure!(
            !read_only(),
            "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never downloads a new \
             build of the user's app"
        );

        enum Decision {
            Start(teams_lite::update::Asset, String),
            Join(Value),
            Nothing,
        }
        let decision = self.with_update(|slot| match slot.phase {
            UpdatePhase::Downloading | UpdatePhase::Ready | UpdatePhase::Restarting => {
                Decision::Join(slot.progress_json())
            }
            UpdatePhase::Idle | UpdatePhase::Failed | UpdatePhase::Installed => {
                match (slot.asset.clone(), slot.latest.clone()) {
                    (Some(asset), latest) if !latest.is_empty() => {
                        slot.phase = UpdatePhase::Downloading;
                        slot.received = 0;
                        slot.error.clear();
                        slot.file = None;
                        Decision::Start(asset, latest)
                    }
                    _ => Decision::Nothing,
                }
            }
        })?;

        let (asset, latest) = match decision {
            Decision::Join(progress) => return Ok(progress),
            Decision::Nothing => anyhow::bail!(
                "there is no new build to download — this one is current, or the release \
                 published no binary for this machine"
            ),
            Decision::Start(asset, latest) => (asset, latest),
        };

        let ctx = self.clone();
        tokio::spawn(async move {
            match ctx.fetch_release_asset(asset, latest).await {
                Ok(Some(dest)) => {
                    let _ = ctx.with_update(|slot| {
                        slot.phase = UpdatePhase::Ready;
                        slot.received = slot.asset.as_ref().map(|a| a.size).unwrap_or(0);
                        slot.file = Some(dest.clone());
                    });
                    eprintln!("[update] downloaded {} — waiting for the user", dest.display());
                    ctx.emit_update_progress();
                }
                // Nothing left to download: the re-read found this build current. The row
                // empties itself, and `forget_release` has already said so.
                Ok(None) => {
                    eprintln!("[update] the release is no longer newer than this build");
                    // The re-read found this build CURRENT, so `latest` names this build's
                    // own commit — which is the one download the prune has to spare.
                    ctx.forget_release(teams_lite::update::build_rev().unwrap_or_default());
                }
                Err(e) => {
                    eprintln!("[update] download failed: {e:#}");
                    let _ = ctx.with_update(|slot| {
                        slot.phase = UpdatePhase::Failed;
                        slot.error = format!("{e:#}");
                    });
                    ctx.emit_update_progress();
                }
            }
        });

        self.with_update(|slot| slot.progress_json())
    }

    /// Fetch the release binary, re-reading the release before every attempt.
    ///
    /// `Ok(None)` means there is nothing to fetch any more, which is not a failure.
    ///
    /// Two attempts, and the second is the whole point: the asset behind the rolling
    /// `latest` tag can be replaced between the check and the click, and between the click
    /// and the last byte. Attempt one therefore starts from a FRESH read of the release
    /// rather than from what the greeting carried, and a failed attempt reads it again — so
    /// a release that moved under a transfer heals itself instead of wedging the button on a
    /// size that can never match. It stays bounded at two: a failure that retried forever
    /// would hide a genuinely broken release, which is the other half of § Updating the app.
    async fn fetch_release_asset(
        &self,
        asset: teams_lite::update::Asset,
        latest: String,
    ) -> Result<Option<std::path::PathBuf>> {
        let mut asset = asset;
        let mut latest = latest;
        for attempt in 1..=DOWNLOAD_ATTEMPTS {
            match self.refresh_release().await {
                ReleaseNow::Asset(fresh, rev) => {
                    asset = fresh;
                    latest = rev;
                }
                ReleaseNow::Current => return Ok(None),
                ReleaseNow::Unknown => {}
            }
            let dest = teams_lite::update::download_path(&latest)?;
            // Throttled to whole percent: the download is answered chunk by chunk, and a
            // frame per chunk would put thousands of events on a socket that also carries
            // the user's messages. Rebuilt per attempt, because it holds the last percent
            // it published and a second attempt starts from zero again.
            let mut last_percent = u64::MAX;
            let ctx_progress = self.clone();
            let result = teams_lite::update::download(
                &self.http,
                &asset,
                &dest,
                move |received, total| {
                    let percent = if total > 0 { received * 100 / total } else { 0 };
                    if percent == last_percent {
                        return;
                    }
                    last_percent = percent;
                    let published = ctx_progress
                        .with_update(|slot| {
                            if slot.phase != UpdatePhase::Downloading {
                                return None;
                            }
                            slot.received = received;
                            Some(slot.progress_json())
                        })
                        .ok()
                        .flatten();
                    if let Some(payload) = published {
                        ctx_progress.emit("update_progress", payload);
                    }
                },
            )
            .await;

            match result {
                Ok(()) => return Ok(Some(dest)),
                Err(e) if attempt < DOWNLOAD_ATTEMPTS => {
                    eprintln!(
                        "[update] attempt {attempt} failed: {e:#} — waiting {}s, then \
                         re-reading the release and fetching it once more",
                        DOWNLOAD_RETRY_WAIT.as_secs()
                    );
                    tokio::time::sleep(DOWNLOAD_RETRY_WAIT).await;
                }
                Err(e) => return Err(e),
            }
        }
        // Unreachable: the loop either returns or exhausts its attempts through the `Err`
        // arm above. Spelled rather than `unwrap`ed so a change to the bound cannot panic.
        anyhow::bail!("the release could not be downloaded in {DOWNLOAD_ATTEMPTS} attempts")
    }

    /// Install the downloaded build and ask the launcher to restart onto it.
    ///
    /// The order matters. The swap comes first, because it is the part that must not be
    /// lost: once it is done the new build starts next time whatever else happens. The
    /// phase is published SECOND, before the restart is asked for, because the restart
    /// takes this socket down with it — a client told afterwards would never be told.
    async fn apply_update(&self) -> Result<Value> {
        anyhow::ensure!(
            !read_only(),
            "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never replaces the \
             user's own app"
        );
        let target = teams_lite::update::self_install().context(
            "this build cannot replace itself: it was not started by the `teams` command, so \
             there is no single binary to swap. Update it the way it was installed — a staged \
             always-on service with `bin/teams-lite-service.sh update`.",
        )?;
        let downloaded = self
            .with_update(|slot| match slot.phase {
                UpdatePhase::Ready => slot.file.clone(),
                _ => None,
            })?
            .context("nothing is downloaded yet — download the update before applying it")?;

        // A failure here is REPORTED, on this machine and to every open page — it used to be
        // neither. The swap is the one step of an update that touches something outside this
        // process, so it is the step that fails for reasons nobody in the app can guess at
        // (the download deleted under it, a full disk, a directory that stopped being
        // writable): the journal keeps the whole chain for whoever reads it later, and the
        // slot carries it so the phone that pressed the button and the laptop beside it
        // agree. Before this, the page that clicked drew a failure of its own and the rest
        // of the app — and this machine — held no record of it at all.
        if let Err(e) = teams_lite::update::install_binary(&downloaded, &target) {
            let e = e.context(format!("install the new build over {}", target.display()));
            eprintln!("[update] the swap failed: {e:#}");
            let failed = self.with_update(|slot| {
                slot.phase = UpdatePhase::Failed;
                slot.error = format!("{e:#}");
                slot.progress_json()
            })?;
            self.emit("update_progress", failed);
            return Err(e);
        }
        eprintln!("[update] installed over {} — restarting", target.display());

        // The launcher listens for this on the keepalive socket it already holds
        // (launcher/src/update.ts). Nothing else can put the app back up: it owns the web
        // server and the backend child. Named for what it asks rather than for the RPC
        // that emits it, because the launcher is being told to restart — and if it is
        // gone, the swap still stands and the next start is the new build, which
        // `Installed` says out loud.
        let restarting = self.with_update(|slot| {
            slot.phase = UpdatePhase::Restarting;
            slot.error.clear();
            slot.progress_json()
        })?;
        self.emit("update_progress", restarting.clone());
        self.emit("update_restart", json!({ "binary": target.to_string_lossy() }));

        // A restart kills this process, so still being here after a few seconds means
        // the launcher never acted — it crashed, or the app is being served by
        // something that is not it. Say so rather than leaving a bubble spinning for
        // ever: the build IS installed, and it starts next time.
        let ctx = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(RESTART_GRACE).await;
            let stalled = ctx
                .with_update(|slot| {
                    if slot.phase != UpdatePhase::Restarting {
                        return None;
                    }
                    slot.phase = UpdatePhase::Installed;
                    Some(slot.progress_json())
                })
                .ok()
                .flatten();
            if let Some(payload) = stalled {
                eprintln!(
                    "[update] the new build is installed but nothing restarted the app — it \
                     will run on the next start"
                );
                ctx.emit("update_progress", payload);
            }
        });
        Ok(restarting)
    }

    /// Restart this backend on the same build, because the user asked from
    /// Settings › This app.
    ///
    /// It is `apply_update` without the new binary, and the same two shapes carry it out:
    /// a launcher re-spawns the backend it owns (its web server never goes down), and a
    /// supervised backend simply EXITS and is started again. Which one — and whether either
    /// exists — is [`teams_lite::restart`]'s decision, and a shape nobody watches is refused
    /// rather than taken down.
    ///
    /// Three things about it:
    ///
    ///   * **A live `@claude` reply is asked about first.** A run dies with this process and
    ///     nothing can resume it, so a restart leaves that message frozen until a sweep
    ///     closes it (`repair_abandoned_agent_runs`). The first ask therefore reports the
    ///     runs instead of restarting, and `force` is the user's second press — the shape
    ///     Delete and the merge already have, decided HERE because the count is a fact only
    ///     this process holds: a page knows about the runs it happened to watch, and the
    ///     common case is a run started from a phone.
    ///   * **The answer goes out before the process does.** The reply travels on the socket
    ///     this restart takes down, so both paths wait `RESTART_ANSWER_GRACE` first —
    ///     otherwise the click's own outcome is the one frame that never arrives.
    ///   * **The calling registration is taken back on the way out**, exactly as the idle
    ///     shutdown does and for its reason: Teams routes a call to the endpoints it
    ///     believes are running, and a device that does not ring is a call the user misses.
    async fn restart_backend(&self, params: &Value) -> Result<Value> {
        use teams_lite::restart::Restarter;

        let restarter = teams_lite::restart::restarter();
        anyhow::ensure!(
            restarter != Restarter::Nothing,
            teams_lite::restart::NOTHING_WOULD_RESTART_IT
        );

        let writing = live_agent_runs_here();
        if writing > 0 && !params.get("force").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(json!({ "restarted": false, "blocked": "agent", "runs": writing }));
        }

        let via = match restarter {
            Restarter::Launcher => "launcher",
            Restarter::Supervisor => "supervisor",
            Restarter::Nothing => unreachable!("refused above"),
        };
        eprintln!("[lifecycle] restarting on request — the {via} brings this backend back");

        let ctx = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(RESTART_ANSWER_GRACE).await;
            ctx.stop_calling().await;
            match restarter {
                // The launcher listens for this on the keepalive socket it already holds
                // (launcher/src/backend-restart.ts) and re-spawns the backend alone. The
                // port is what tells it the frame is about the child it owns — the same
                // check `update_restart` makes with the binary path, and for the same
                // reason: anything on this machine can open a frame on this socket.
                Restarter::Launcher => {
                    ctx.emit("backend_restart", json!({ "port": own_port() }));
                }
                // Nothing to ask: exiting IS the restart, and the supervisor starts us
                // again. SQLite runs in WAL with per-request commits, so an abrupt stop
                // loses nothing that was acknowledged (see the backend unit's own note).
                Restarter::Supervisor => std::process::exit(0),
                Restarter::Nothing => {}
            }
        });
        Ok(json!({ "restarted": true, "via": via }))
    }

    /// A valid CSA-audience token (auto-refreshed).
    async fn csa(&self) -> Result<String> {
        self.tokens.get(teams_read::CSA_SCOPE).await
    }
    /// A valid profiles-audience token (auto-refreshed).
    async fn profile(&self) -> Result<String> {
        self.tokens.get(teams_profiles::PROFILE_SCOPE).await
    }
    /// A fresh clone of the Teams session, rebuilt if the cached one is stale — or
    /// built for the first time, when this process started with the broker down.
    async fn session(&self) -> Result<Session> {
        {
            let cell = self.session.lock().await;
            if let Some(session) = &cell.session {
                if cell.minted.elapsed() < SESSION_TTL {
                    return Ok(session.clone());
                }
            }
        }
        // stale, or never established: rebuild (skypetoken from a fresh skype token
        // via the broker)
        let fresh = teams::connect(&self.http).await?;
        Ok(self.adopt_session(fresh).await)
    }

    /// Hold on to a session this process just established, and remember the account
    /// it belongs to. Returns the session as adopted, which is what every caller must
    /// go on to use — it may carry a name the sign-in itself could not resolve.
    ///
    /// The one place a session is stored, so the store's copy of the identity can
    /// never fall behind the live one — that copy is what `identity` answers from
    /// during a sign-in outage.
    ///
    /// A sign-in that came back with the account's mri but NO display name is repaired
    /// here, from the DIRECTORY — the same short-profile read every colleague's name in
    /// this app comes from (`teams_profiles::fetch_profiles`), asked for our own mri.
    /// `/v1/users/ME/properties` used to carry the name in `userDetails` and no longer
    /// sends that field at all, and an empty `self_name` is not a cosmetic loss:
    /// `teams_send::build_body` puts it in `imdisplayname`, so every message this app
    /// sent was authorless in every other teams-lite, and `Store::conversations` could
    /// not derive a 1:1's title either.
    ///
    /// **The directory rather than the store**, which was the first shape and could not
    /// answer the case this exists for. The store's own copy of a name is read off our
    /// stored messages, and the boot order is store → serve → sign in → sync — so on a
    /// FRESH store there is no message of ours yet and every send for the next
    /// `SESSION_TTL` went out authorless, which is precisely the bug. The directory
    /// answers on an empty store, it is the tenant's own spelling of the name rather
    /// than whatever a past frame happened to carry, and the token is already warm:
    /// `sign_in` and `force_refresh_auth` both resolve `PROFILE_SCOPE` immediately
    /// before this. It is BEST-EFFORT — a broker outage costs the repair and nothing
    /// else, and `Ctx::identity` then falls back to the name the store remembers.
    async fn adopt_session(&self, mut session: Session) -> Session {
        if session.self_name.trim().is_empty() && !session.self_mri.trim().is_empty() {
            if let Some(name) = self.directory_name(&session).await {
                session.self_name = name;
            }
        }
        if !read_only() {
            if let Ok(store) = self.store() {
                if let Err(e) = store.remember_self(&session.self_name, &session.self_mri) {
                    eprintln!("[auth] could not remember the account identity: {e}");
                }
            }
        }
        let mut cell = self.session.lock().await;
        cell.session = Some(session.clone());
        cell.minted = std::time::Instant::now();
        session
    }

    /// Our own display name from the directory, or None when it cannot be had.
    ///
    /// Says so in the journal ONCE per process (`NAMELESS_SIGN_IN_REPORTED`): a session is
    /// re-minted on every `SESSION_TTL` and after every 401, so a tenant that has stopped
    /// sending `userDetails` would otherwise print the same non-news some thirty times a
    /// day, for ever, on the always-on service. One line is the record; a repeat says
    /// nothing new — the rule the release poll already follows ("silence unless something
    /// moved").
    async fn directory_name(&self, session: &Session) -> Option<String> {
        let resolved: Result<Option<String>> = async {
            let token = self.tokens.get(teams_profiles::PROFILE_SCOPE).await?;
            let mris = [session.self_mri.trim().to_string()];
            let profiles =
                teams_profiles::fetch_profiles(&self.http, session, &token, &mris).await?;
            Ok(profiles
                .iter()
                .map(|p| p.display_name.trim())
                .find(|name| !name.is_empty())
                .map(String::from))
        }
        .await;
        // One report site for all three outcomes: a token this backend could not mint, a
        // directory that refused, and a directory that simply names nobody are three
        // different things to read in a journal, and each explains a message that will go
        // out without an author.
        if !NAMELESS_SIGN_IN_REPORTED.swap(true, Ordering::Relaxed) {
            match &resolved {
                Ok(Some(name)) => {
                    eprintln!("[auth] sign-in resolved no display name; the directory says {name:?}")
                }
                Ok(None) => eprintln!(
                    "[auth] sign-in resolved no display name, and the directory names nobody \
                     for this account — messages will go out without one"
                ),
                Err(e) => eprintln!(
                    "[auth] sign-in resolved no display name, and the directory could not be \
                     read: {e:#}"
                ),
            }
        }
        resolved.ok().flatten()
    }

    /// Who the user is, WITHOUT touching the network.
    ///
    /// Every local-first read needs this pair and nothing else from the session: the
    /// mri decides which stored messages are ours, and a 1:1 is titled after the
    /// other person. It used to be read through [`Ctx::session`], which is why a
    /// broker outage made `conversations`, `open` and `backfill` fail on a store that
    /// held every message — the app the user opened during an outage said the backend
    /// was gone rather than showing their history.
    ///
    /// So the live session answers when there is one, at any age (an identity does not
    /// expire — only the skypetoken beside it does), and the store's own copy answers
    /// otherwise. A stale session is never rebuilt here: a rebuild reaches the broker,
    /// and a broker that is down would then cost every read its D-Bus timeout.
    ///
    /// A store synced before anything remembered an identity is covered too: its own
    /// one-to-one thread ids name the account (`Store::derived_self`), and what is
    /// derived is written down, so the derivation runs once rather than per read.
    async fn identity(&self) -> Result<store::SelfIdentity> {
        // A live session answers — UNLESS its sign-in resolved no mri at all. Signing in
        // reads the identity best-effort (see `fetch_self_identity` in src/teams.rs), so
        // one unparseable answer from `/v1/users/ME/properties` yields a session with both
        // halves empty, and that session is then cached for SESSION_TTL. An empty mri is
        // not a missing name but a WRONG answer to "which stored messages are ours": no
        // row is `is_self`, so the user's own messages are drawn as a colleague's, `delete`
        // refuses their own message, push sends them their own words, and
        // `OTHER_PARTY_MRI` titles a 1:1 after them. The store's copy is the same pair
        // from the last sign-in that did resolve one, which is what this fallback is for.
        if let Some(session) = self.session.lock().await.session.as_ref() {
            if !session.self_mri.trim().is_empty() {
                return Ok(store::SelfIdentity {
                    name: session.self_name.to_string(),
                    mri: session.self_mri.to_string(),
                });
            }
        }
        let store = self.store()?;
        if let Some(me) = store.remembered_self()? {
            return Ok(me);
        }
        let derived = store.derived_self()?.context(
            "not signed in, and this store cannot say whose it is — \
             sign-in has to work at least once before its history can be read",
        )?;
        eprintln!("[offline] read the account identity back out of the stored history");
        if !read_only() {
            if let Err(e) = store.remember_self(&derived.name, &derived.mri) {
                eprintln!("[offline] could not record the derived identity: {e}");
            }
        }
        Ok(derived)
    }

    /// Force-refresh every credential the read/send paths depend on: the IC3, CSA,
    /// profile, and Graph (SharePoint file downloads) broker tokens, and the Teams
    /// session (skypetoken). Called after an unexpected 401, whose cause may be any
    /// of these, so we refresh them all rather than guess.
    async fn force_refresh_auth(&self) -> Result<Session> {
        let _ = self.tokens.refresh(IC3_SCOPE).await;
        let _ = self.tokens.refresh(teams_read::CSA_SCOPE).await;
        let _ = self.tokens.refresh(teams_profiles::PROFILE_SCOPE).await;
        let _ = self.tokens.refresh(teams_media::GRAPH_SCOPE).await;
        let fresh = teams::connect(&self.http).await?;
        Ok(self.adopt_session(fresh).await)
    }

    /// A valid Microsoft Graph token, for the read-only mail and calendar surfaces
    /// (they share one scope, and therefore one cache entry and one refresh).
    async fn graph(&self) -> Result<String> {
        self.tokens.get(mail::MAIL_SCOPE).await
    }

    /// Mark a mail folder as one the live poll should watch.
    fn watch_mail_folder(&self, folder_id: &str) {
        if folder_id.is_empty() {
            return;
        }
        if let Ok(mut watch) = self.mail_watch.lock() {
            watch.insert(folder_id.to_string());
        }
    }

    /// Mark the calendar window the live poll should re-read, replacing whatever it
    /// watched before.
    fn watch_calendar(&self, watch: CalendarWatch) {
        if let Ok(mut slot) = self.calendar_watch.lock() {
            *slot = Some(watch);
        }
    }

    /// Run a Graph (mail or calendar) operation under the shared retry policy.
    ///
    /// The Graph sibling of [`Ctx::retry_on_auth`]: `op` gets a freshly-read Graph
    /// token per attempt, and a 401 refreshes THAT token only — the Teams session
    /// and its skypetoken are unrelated to the mailbox, so refreshing them here
    /// would be noise (and would rebuild a session for nothing).
    async fn retry_graph<T, F, Fut>(&self, op: F) -> Result<T>
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let attempt = || async {
            let token = self.graph().await?;
            op(token).await
        };
        let on_auth = || async {
            eprintln!("[auth] 401 from Graph — refreshing the Graph token before retry");
            self.tokens.refresh(mail::MAIL_SCOPE).await.map(|_| ())
        };
        retry::with_retry(retry::RetryPolicy::default(), Some(on_auth), attempt).await
    }

    /// Run a network operation under the shared retry policy (see `retry`).
    ///
    /// `op` receives a fresh session + csa token on each attempt (re-read from
    /// the cache, so a refresh between attempts is picked up). The policy:
    ///   - 401  -> force-refresh every credential, then retry (once);
    ///   - 429/5xx/timeout/dropped connection -> back off and retry;
    ///   - 400/403/404/parse/etc. -> fail fast (retrying can't help).
    /// This is the single reactive safety net over the time-based token cache.
    async fn retry_on_auth<T, F, Fut>(&self, op: F) -> Result<T>
    where
        F: Fn(Session, String) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        self.retry_on_auth_with(retry::RetryPolicy::default(), op).await
    }

    /// [`Ctx::retry_on_auth`] with the policy named by the caller.
    ///
    /// It exists for the one operation here that CREATES something: a `send` retried
    /// after a lost answer posts the message twice (see [`retry::RetryPolicy::auth_only`]).
    async fn retry_on_auth_with<T, F, Fut>(&self, policy: retry::RetryPolicy, op: F) -> Result<T>
    where
        F: Fn(Session, String) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let attempt = || async {
            let session = self.session().await?;
            let csa = self.csa().await?;
            op(session, csa).await
        };
        let on_auth = || async {
            eprintln!("[auth] 401 — refreshing credentials before retry");
            self.force_refresh_auth().await.map(|_| ())
        };
        retry::with_retry(policy, Some(on_auth), attempt).await
    }
}

/// The trouter's credential source: hands it a freshly-valid session (rebuilt if
/// stale) and ic3 token (auto-refreshed via the cache) before every reconnection,
/// so the real-time feed keeps working past the ~1h broker-token lifetime.
impl trouter::CredentialProvider for Ctx {
    async fn credentials(&self) -> Result<trouter::Credentials> {
        let session = self.session().await?;
        let ic3 = self.tokens.get(IC3_SCOPE).await?;
        Ok(trouter::Credentials { session, ic3 })
    }
}

/// Open the store once at boot to create/upgrade its schema, refresh the query
/// planner's statistics, and run the one-shot legacy cleanups.
///
/// Only a failure to open the store is fatal (nothing works without it); a
/// cleanup that fails is logged and skipped, since it only affects how legacy
/// history renders.
///
/// `allow_writes` is false in read-only mode, and then NOTHING here runs beyond
/// opening the store: no cleanups (they rewrite and delete message rows) and no
/// statistics refresh (`PRAGMA optimize` writes too). A read-only backend is the one
/// tooling is allowed to start against the user's REAL store — while the user's own
/// backend is live on it — so silently migrating their history from under them is
/// exactly the class of surprise `TEAMS_LITE_READ_ONLY=1` exists to prevent. The flag
/// therefore covers the LOCAL store, not just outward sends.
///
/// The schema migration inside [`Store::open`] is deliberately NOT gated: it is
/// additive, and without it the file cannot be read at all.
fn prepare_store(db_path: &str, allow_writes: bool) -> Result<()> {
    let store = Store::open(db_path)?;
    if !allow_writes {
        eprintln!(
            "[store] read-only mode (TEAMS_LITE_READ_ONLY=1): skipping the statistics refresh \
             and the one-shot cleanups — the user's rows are never rewritten"
        );
        return Ok(());
    }
    if let Err(e) = store.optimize() {
        eprintln!("[store] could not refresh statistics: {e}");
    }
    match store.cleanups_pending() {
        Ok(true) => run_legacy_cleanups(&store),
        Ok(false) => {}
        Err(e) => eprintln!("[cleanup] could not read the cleanup revision: {e}"),
    }
    // A claim only stops two backends acting twice on the same live message, so a
    // day-old one is dead weight. Cheap and unconditional (a keyed range delete),
    // unlike the one-shot cleanups above.
    let claims_before = now_ms() - CLAIM_RETENTION.as_millis() as i64;
    if let Err(e) = store.prune_claims(claims_before) {
        eprintln!("[store] could not prune old live-message claims: {e}");
    }
    Ok(())
}

/// Heal history that older builds persisted in a shape the UI can no longer make
/// sense of. Every pass rewrites rows IN PLACE and is idempotent, so it only has
/// to run once per store — and it must, because each one scans every message body.
/// [`Store::cleanups_pending`] gates them on `CLEANUP_REVISION`, recorded here
/// once the pass completes, so later boots skip the scans entirely.
fn run_legacy_cleanups(store: &Store) {
    // The Teams activity streams (`48:notifications`, `48:mentions`,
    // `48:threads`) are system feeds, not chats. Older builds mis-persisted them
    // as conversations full of empty-content bubbles under a raw MRI-URL title;
    // purge that junk so it stops showing in the sidebar. Going forward they are
    // routed to the notifications surface and never re-persisted as chats (see
    // `spawn_realtime` and `persist_conversations`).
    for feed in [
        teams_activity::NOTIFICATIONS_THREAD,
        teams_activity::MENTIONS_THREAD,
        teams_activity::THREADS_THREAD,
    ] {
        if let Err(e) = store.delete_conversation(feed) {
            eprintln!("[cleanup] could not purge {feed}: {e}");
        }
    }
    // Channel posts that an older live feed filed under a `;messageid=` deep-link id
    // are moved back into their channel, and the pseudo-conversations those ids
    // created are removed from the chat list.
    match store.reparent_thread_link_messages() {
        Ok((moved, dropped, rows)) if moved > 0 || dropped > 0 || rows > 0 => eprintln!(
            "[cleanup] channel threads: re-filed {moved} post(s), dropped {dropped} duplicate(s), \
             removed {rows} phantom conversation(s)"
        ),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not re-file channel thread posts: {e}"),
    }
    // Older builds also stored control/system frames (typing/presence pushes
    // and ThreadActivity member/topic changes) as chat bubbles — the bare
    // `notifications.skype.net` URLs and raw `<partlist>`/`<addmember>` XML.
    // Ingestion now drops them (see `teams_read::parse_message`); clear the
    // ones already persisted so existing chats read clean.
    match store.purge_control_frames() {
        Ok(n) if n > 0 => eprintln!("[cleanup] removed {n} legacy control-frame message(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not purge control frames: {e}"),
    }
    // Call/meeting events that older builds stored as raw XML are upgraded in
    // place into structured `system_event` rows, so they render as a centered
    // "Call ended" line instead of a wall of machine XML.
    match store.convert_legacy_call_events() {
        Ok(n) if n > 0 => eprintln!("[cleanup] upgraded {n} legacy call-event message(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not convert call events: {e}"),
    }
    // Meeting-recording notices that older builds stored as raw `<URIObject>`
    // bubbles are upgraded in place into a media video card (final recording)
    // or removed (the in-progress notices Teams also posts).
    match store.convert_legacy_call_recordings() {
        Ok((up, del)) if up > 0 || del > 0 => {
            eprintln!("[cleanup] recordings: upgraded {up}, removed {del} in-progress notice(s)")
        }
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not convert call recordings: {e}"),
    }
    // `ThreadActivity` frames (a member added, a message pinned) that older builds
    // stored as a bubble of raw JSON become a centered system line; the ones we
    // cannot label are removed.
    match store.convert_legacy_thread_activities() {
        Ok((up, del)) if up > 0 || del > 0 => {
            eprintln!("[cleanup] thread activities: upgraded {up}, removed {del}")
        }
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not convert thread activities: {e}"),
    }
    // Adaptive/connector cards stored as the raw `SWIFT.1` URIObject — which reads
    // as "Card - access it on … cards.unsupported" in the bubble and in the sidebar
    // — are upgraded into a structured card attachment.
    match store.convert_legacy_cards() {
        Ok(n) if n > 0 => eprintln!("[cleanup] upgraded {n} legacy card message(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not convert cards: {e}"),
    }
    // Rows whose author is a raw contacts URL or MRI (an older fallback for frames
    // with no `imdisplayname`) get a blank sender, so the UI resolves a real name
    // from `sender_mri` instead of printing a URL.
    match store.blank_identity_senders() {
        Ok(n) if n > 0 => eprintln!("[cleanup] blanked {n} identity-URL sender(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not blank identity senders: {e}"),
    }
    // Typing/presence frames stored with an empty body render as a blank bubble with
    // no author. Removed LAST, so every pass above has had its chance to turn a row
    // that only LOOKS payload-less (a recording, a card, a thread activity) into
    // something renderable first.
    match store.purge_payloadless_control_frames() {
        Ok(n) if n > 0 => eprintln!("[cleanup] removed {n} payload-less control frame(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not purge payload-less control frames: {e}"),
    }
    // Only claim the revision once the passes above have had their turn: a store
    // whose cleanup errored out retries on the next boot rather than staying
    // half-healed forever.
    if let Err(e) = store.mark_cleanups_done() {
        eprintln!("[cleanup] could not record the cleanup revision: {e}");
    }
}

/// Warm the token caches the read and send paths use, then establish the Teams
/// session and remember the account it belongs to.
///
/// Called once at boot and never again: the trouter re-asks for credentials before
/// every connection attempt (`Ctx::credentials`), which is what rebuilds a session
/// after this one failed or went stale. A failure here is NOT fatal — see the comment
/// in `main` on the boot order.
async fn sign_in(ctx: &Ctx) -> Result<Session> {
    ctx.tokens.get(IC3_SCOPE).await.context("ic3 token")?;
    ctx.tokens.get(teams_read::CSA_SCOPE).await.context("csa token")?;
    ctx.tokens.get(teams_profiles::PROFILE_SCOPE).await.context("profile token")?;
    let session = teams::connect(&ctx.http).await?;
    Ok(ctx.adopt_session(session).await)
}

#[tokio::main]
async fn main() -> Result<()> {
    // CLAIM THE PORT FIRST, before anything with a side effect.
    //
    // The listener used to be bound at the very end, after authentication, the store
    // migrations and the trouter registration. A second backend started by hand
    // therefore did all of that — including rewriting rows in the shared store, and
    // registering the SAME endpoint id with the real-time service, which silently
    // stole the live feed from the instance already running — and only then died on
    // "address already in use".
    //
    // Binding here turns that into an immediate, obvious failure. Nothing is served
    // yet: `accept()` runs at the end of this function, so a client that connects
    // during authentication simply waits in the listen backlog, which is strictly
    // better than being refused.
    let addr = bind_addr();
    let listener = TcpListener::bind(&addr).await.with_context(|| {
        format!(
            "bind {addr} — another teams-lite backend already owns this port. \
             Stop it first (systemctl --user stop teams-lite-backend), or give this \
             one a port of its own with TEAMS_LITE_PORT."
        )
    })?;

    // ARM THE WRITE LOCK NEXT, before anything that can block.
    //
    // Minting the token also PUBLISHES it (see `write_token`), and the file is the one
    // place a frontend reads it from — so until this line runs, that file still holds the
    // token of the process this one replaced. A page that reconnects inside that window
    // picks the dead token up and every send it makes is refused, silently: reads keep
    // working, so the app looks healthy while the composer only chimes.
    //
    // The window used to be the whole of sign-in, which on this machine is a D-Bus call
    // to a broker whose keyring re-locks — seconds, sometimes tens of them. And a
    // reconnecting page really is served in it: the port is bound above, so the relay in
    // `web/server.ts` opens the page's socket at once and the page then asks its own
    // server for the token (`loadWriteToken` in web/src/lib/store.ts).
    //
    // Publishing here closes the window: the file names this process before anything can
    // reach it. The frontend still recovers from a refusal on its own — the token may go
    // stale for other reasons, and a lock nobody can re-read is a lock that needs a
    // reload — but it no longer has to.
    match write_token() {
        None => eprintln!("[write-lock] read-only: {OUTWARD_METHODS:?} are refused"),
        // A pinned token is in no file, on purpose: the parent that pinned it hands the
        // same value to its own frontend, and publishing would overwrite the token of
        // the other backend sharing this machine (see `write_token`).
        Some(_) if write_token_pinned() => eprintln!(
            "[write-lock] armed: {OUTWARD_METHODS:?} require the token pinned by our \
             parent in {WRITE_TOKEN_ENV} — nothing was published"
        ),
        Some(_) => match write_token_path() {
            Ok(path) => eprintln!(
                "[write-lock] armed: {OUTWARD_METHODS:?} require the token at {}",
                path.display()
            ),
            Err(e) => eprintln!("[write-lock] armed: token published nowhere ({e})"),
        },
    }

    let http = reqwest::Client::builder().user_agent(UA).http1_only().build()?;
    let tokens = auth::TokenCache::new();

    // THE STORE OPENS BEFORE SIGN-IN, and sign-in may fail without ending the process.
    //
    // Everything this app shows is local: the store holds every message, mail and
    // event it has ever synced, and the read paths answer from it. Authentication used
    // to come first and to be fatal, so the ~18-hourly broker outage — a re-locked
    // container keyring, an expired PRT — took the whole backend down at boot. systemd
    // restarted it every five minutes, each start died on the same token, and the app
    // the user opened said "Backend lost" in front of a store full of their history.
    //
    // So the order is store, then serve, then sign in: an outage now costs the LIVE
    // feed and every network read, which is what it really costs. The trouter asks for
    // credentials before every connection attempt and backs off, so nothing here polls
    // the broker itself — the first successful attempt fills the session in and the app
    // catches up with no restart.
    let db_path = data_db_path()?;
    eprintln!("[ok] store {db_path}");
    // Creates the schema, applies pending migrations and indexes, refreshes stale
    // planner statistics, and heals legacy rows — all once per boot. A read-only
    // backend skips the healing: it must not rewrite the user's rows.
    prepare_store(&db_path, !read_only())?;

    let (events_tx, _) = broadcast::channel::<Value>(256);
    let ctx = Ctx {
        http,
        tokens,
        session: Arc::new(tokio::sync::Mutex::new(SessionCell {
            session: None,
            minted: std::time::Instant::now(),
        })),
        db_path: Arc::new(db_path.clone()),
        events: events_tx,
        update: Arc::new(std::sync::Mutex::new(UpdateSlot::default())),
        mail_watch: Arc::new(Mutex::new(std::collections::BTreeSet::new())),
        calendar_watch: Arc::new(Mutex::new(None)),
        last_repair: Arc::new(Mutex::new(None)),
        signin: Arc::new(Mutex::new(None)),
        calling: Arc::new(Mutex::new(CallingPlane::default())),
        gitlab_refreshing: Arc::new(Mutex::new(std::collections::BTreeSet::new())),
        tracker_people: Arc::new(Mutex::new(None)),
        agent_runs_inflight: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };

    // Watch the broker, and react once per CHANGE of state (see `observe_broker`).
    //
    // This is what turns "no chats, and nothing says why" into a banner the user can
    // act on. Two reactions: tell every connected client, and — for the one signature
    // whose known cause is a locked container keyring — ask for a repair, at most
    // once every REPAIR_MIN_INTERVAL.
    let watcher = ctx.clone();
    auth::observe_broker(move |state| {
        match state.failure {
            None => eprintln!("[broker] sign-in works again"),
            Some(failure) => eprintln!(
                "[broker] {} ({} in a row) — {}",
                failure.message(),
                state.consecutive_failures,
                state.detail
            ),
        }
        watcher.emit("broker_status", broker_status_payload(false));

        if state.failure.is_some_and(|f| f.is_repairable()) && !read_only() {
            // Spawned, not awaited: the observer runs inside whatever token call just
            // failed, and that caller must not wait on a container restart.
            let repairer = watcher.clone();
            tokio::spawn(async move {
                if let Err(e) = repairer.start_broker_repair(true).await {
                    eprintln!("[broker] could not start the repair: {e:#}");
                }
            });
        }
    });

    // Sign in — AFTER the observer, so a failure at boot reaches every client that
    // connects and asks for a repair when the signature is the repairable one, exactly
    // as a failure hours later does.
    eprintln!("teams-lite server — authenticating (broker)…");
    match sign_in(&ctx).await {
        Ok(session) => eprintln!("[ok] region={} self={:?}", session.region, session.self_name),
        Err(e) => match ctx.identity().await {
            Ok(me) => eprintln!(
                "[offline] sign-in failed, serving stored history as {:?} — \
                 the live feed reconnects on its own ({e:#})",
                me.name
            ),
            // Nothing signed in on this machine yet, so the store is empty too. Stay
            // up regardless: the socket is what carries the reason to the app, and a
            // process that exits leaves the user with "Backend lost" instead.
            Err(_) => eprintln!(
                "[offline] sign-in failed and this machine has never signed in — \
                 there is nothing stored to show yet ({e:#})"
            ),
        },
    }

    // real-time: run the trouter, persist each live message, broadcast an event.
    spawn_realtime(ctx.clone(), db_path);

    // calling: a second trouter connection, registered as the web client registers
    // it, so the user's calls ring here too (see `spawn_calling`).
    spawn_calling(ctx.clone());

    // mail: poll whichever folders a client opens (read-only, and idle until one
    // does — see `spawn_mail_sync`).
    spawn_mail_sync(ctx.clone());

    // calendar: poll whichever window a client is looking at (read-only, and idle
    // until one opens the calendar — see `spawn_calendar_sync`).
    spawn_calendar_sync(ctx.clone());

    // presence: keep the user's own status green, but ONLY while they asked for it
    // (off by default, and never in read-only mode — see `spawn_presence_heartbeat`).
    spawn_presence_heartbeat(ctx.clone());

    // the local agent: a run does not survive this process, so anything left in flight
    // by the process before us is a message frozen mid-answer in a thread. Drop the
    // markers of runs whose process is gone, then sweep for the replies to close.
    clear_dead_agent_run_markers();
    spawn_agent_run_repair(ctx.clone());

    // best-effort, and for the whole life of the process: has the rolling `latest` tag
    // moved off this build? An app left open for weeks has to be able to notice.
    spawn_release_poll(ctx.clone());

    eprintln!("[ok] server ws://{addr} — ready");
    // Read once at boot: a machine that answers a chat message with the user's own
    // configuration must say so in its own journal, not only in a browser menu.
    let unrestricted = match ctx.store() {
        Ok(store) => store
            .get_setting(agent::SETTING_UNRESTRICTED)
            .ok()
            .flatten()
            .is_some_and(|value| agent::unrestricted_from_setting(Some(&value))),
        Err(_) => false,
    };
    log_agent_backends(unrestricted);
    let clients = ClientTracker::new();
    let no_idle_exit = idle_exit_disabled();
    if no_idle_exit {
        eprintln!("[lifecycle] TEAMS_NO_IDLE_EXIT set — staying alive until terminated (Ctrl+C)");
    }
    let idle_shutdown = wait_for_idle_shutdown(clients.clone(), no_idle_exit);
    tokio::pin!(idle_shutdown);

    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = &mut idle_shutdown => {
                eprintln!("[lifecycle] no UI clients remain — shutting down");
                // Stop being a device the user's calls ring on, before the process that
                // would answer is gone. The registration would expire on its own within
                // the hour, and every call offered inside that hour is one they miss:
                // Teams routes to the endpoints it believes are running.
                ctx.stop_calling().await;
                return Ok(());
            }
        };
        // A transient accept() error (e.g. fd pressure) must not take down the
        // whole server — log it and keep serving. Propagating it here would
        // exit the process and leave every connected UI reconnecting to nothing.
        let (stream, _peer) = match accepted {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[accept] transient error: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let ctx = ctx.clone();
        let clients = clients.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_conn(ctx, stream, clients).await {
                eprintln!("[conn] fin: {e}");
            }
        });
    }
}

/// Ceiling on ONE request frame read off a UI socket, and the same number the relay in
/// web/server.ts uses for the traffic it forwards. tungstenite's own defaults are 16 MiB
/// per frame and 64 MiB per message, which a send carrying pictures walks straight into:
/// a single 10 MiB image is already 13.33 MiB once base64-encoded, and a message's whole
/// allowance (`teams_send::MAX_IMAGES_TOTAL_BYTES`, 30 MiB) is 40 MiB. A frame over the
/// limit is a protocol error, so the connection would be DROPPED rather than the send
/// refused with a sentence — which is the failure the caps in `teams_send::parse_images`
/// exist to state.
const MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;

/// Handle one UI connection: answer requests + forward broadcast events.
async fn serve_conn(ctx: Ctx, stream: tokio::net::TcpStream, clients: ClientTracker) -> Result<()> {
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(MAX_REQUEST_BYTES),
        max_frame_size: Some(MAX_REQUEST_BYTES),
        ..Default::default()
    };
    let ws = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await?;
    let _client_lease = clients.connect();
    let (mut write, mut read) = ws.split();
    let mut events_rx = ctx.events.subscribe();
    let mut requests = FuturesUnordered::new();

    // greet with current status
    let hello = json!({ "event": "status", "data": "connected" });
    write.send(WsMessage::Text(hello.to_string().into())).await?;

    // If the startup update check already found a newer release, tell this UI right
    // away — it may have connected after the one-shot broadcast fired, so it would
    // otherwise never hear about it. The phase goes with it whenever it is not the
    // untouched one: a page that opens (or a phone that reconnects) in the middle of a
    // download has to draw the progress bar it is already in, and one that opens after
    // an apply has to say the app is coming back.
    let pending_update = ctx
        .update
        .lock()
        .ok()
        .map(|slot| (slot.available.clone(), slot.phase, slot.progress_json()));
    if let Some((available, phase, progress)) = pending_update {
        if let Some(data) = available {
            let ev = json!({ "event": "update_available", "data": data });
            write.send(WsMessage::Text(ev.to_string().into())).await?;
        }
        if phase != UpdatePhase::Idle {
            let ev = json!({ "event": "update_progress", "data": progress });
            write.send(WsMessage::Text(ev.to_string().into())).await?;
        }
    }

    // Say how sign-in is doing, on every fresh connection. The state event is
    // otherwise emitted only on a CHANGE, so a phone that opens the tab in the middle
    // of an outage would see an empty app and no reason for it — and a page that
    // reconnects after a repair would keep showing a banner for trouble that is over.
    // Only when there is something to say: a backend that has never failed stays
    // quiet, so this cannot raise a banner by accident.
    if auth::broker_state().is_some_and(|s| !s.is_ok()) {
        let ev = json!({ "event": "broker_status", "data": broker_status_payload(false) });
        write.send(WsMessage::Text(ev.to_string().into())).await?;
    }

    // And say whether a sign-in is going on right now, for the same reason and with the same
    // rule: only when there is one. A sign-in is exactly the moment a reader switches device
    // — they press it on the laptop and pick up the phone for the Authenticator — so a page
    // that connects mid-flow has to be able to draw the panel it never started.
    {
        let signin = ctx.signin_payload().await;
        if signin["phase"] != "idle" {
            let ev = json!({ "event": "signin_status", "data": signin });
            write.send(WsMessage::Text(ev.to_string().into())).await?;
        }
    }

    loop {
        tokio::select! {
            // incoming requests from the UI
            maybe = read.next() => {
                let Some(msg) = maybe else { break };
                match msg? {
                    WsMessage::Text(t) => {
                        let req: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                        let id = req.get("id").cloned().unwrap_or(json!(0));
                        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
                        let params = req.get("params").cloned().unwrap_or(Value::Null);
                        let request_ctx = ctx.clone();
                        requests.push(async move {
                            let reply = match dispatch(&request_ctx, &method, &params).await {
                                Ok(result) => json!({ "id": id, "result": result }),
                                // `{e:#}` — the WHOLE chain, cause included, which is what
                                // the journal prints everywhere else in this backend.
                                // `to_string()` gives the outermost context alone, and the
                                // outermost context is the part the caller already knew: a
                                // failed update said "install the new build over
                                // /home/…/teams-bin" and threw away the reason it could not,
                                // so the one sentence the user was shown named the target
                                // and nothing they could act on. Every surface that reports
                                // a refusal — the composer, the approval menu, the update row
                                // — reads this string, and each of them is the only place
                                // that failure is ever stated.
                                Err(e) => json!({ "id": id, "error": format!("{e:#}") }),
                            };
                            WsMessage::Text(reply.to_string().into())
                        }.boxed());
                    }
                    WsMessage::Ping(p) => { write.send(WsMessage::Pong(p)).await.ok(); }
                    WsMessage::Close(_) => break,
                    _ => {}
                }
            }
            // events pushed from the backend (trouter, sync) -> this UI
            ev = events_rx.recv() => {
                match ev {
                    Ok(v) => { write.send(WsMessage::Text(v.to_string().into())).await?; }
                    Err(broadcast::error::RecvError::Lagged(_)) => {} // dropped some events, keep going
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            Some(reply) = requests.next(), if !requests.is_empty() => {
                write.send(reply).await?;
            }
        }
    }
    Ok(())
}

/// Route a request method to backend logic and return its JSON result.
async fn dispatch(ctx: &Ctx, method: &str, params: &Value) -> Result<Value> {
    // The write lock, at the single choke point every request passes through —
    // rather than trusting each handler, or each client, to check. Reads are
    // unaffected. See `write_token` / `check_write_allowed`.
    if let Err(refusal) = check_write_allowed(method, params, write_token()) {
        // Say it in the journal too, and say it every time. The client is told, but the
        // user reads a chat app rather than a socket: "my message did not go out" left no
        // trace on this machine at all, which is precisely the shape of failure that
        // cannot be diagnosed after the fact. The method, never the token.
        eprintln!("[write-lock] refused `{method}`");
        anyhow::bail!(refusal);
    }
    match method {
        "ping" => Ok(json!("pong")),

        // Whether the client that asked holds this backend's write token (see
        // `write_lock_state`). Open, and it must stay open: it is the one question whose
        // answer a frontend otherwise learns only from an action it already took — and
        // gating it behind the very token it asks about would answer nobody.
        "write_lock_status" => {
            let presented = params.get("write_token").and_then(Value::as_str);
            let state = write_lock_state(presented, write_token());
            // Say it here too, for the same reason a refusal is logged: the user reads a
            // chat app, and "every send comes back refused" left no trace on the machine
            // that could tell a broken instance from a broken account.
            if state == WriteLockState::Foreign {
                eprintln!(
                    "[write-lock] a client asked with a token that is not mine — its writes \
                     will be refused"
                );
            }
            Ok(write_lock_payload(presented, write_token(), write_token_pinned()))
        }
        // Restart the Intune container, through its own systemd unit, because the
        // container's login keyring re-locks and the broker then answers every token
        // call with NoReply. The only RPC with an effect outside the store and the
        // network: token-gated as a MACHINE method, refused read-only, and refused
        // again inside the primitive so the automatic caller inherits both.
        "repair_broker" => ctx.start_broker_repair(false).await,

        // Sign in again, from here. The remedy for the failure a container restart cannot
        // fix: the broker asks a human, and this brings its own window to whichever browser
        // the app is being read in (see [`teams_lite::signin`] and SIGN-IN.md). Four MACHINE
        // methods — one signs in as the user, one answers with a picture of a sign-in page,
        // one presses keys into it, one closes it.
        "signin_start" => ctx.start_signin(params).await,
        "signin_status" => ctx.signin_status().await,
        "signin_frame" => ctx.signin_frame().await,
        "signin_input" => ctx.signin_input(params).await,
        "signin_cancel" => ctx.cancel_signin().await,

        // The update, in the two steps the user takes: fetch the release binary, then
        // put it in place and restart onto it (see `Ctx::start_update_download` /
        // `Ctx::apply_update`, and `update` for what an update is). MACHINE methods
        // both: the first spends the user's bandwidth, the second replaces the program
        // their account runs through.
        "update_download" => ctx.start_update_download().await,
        "update_apply" => ctx.apply_update().await,

        // Ask GitHub, now, whether `latest` names a different commit — the poll's own pass,
        // on the user's ask rather than on the clock (see `Ctx::check_release_now`). OPEN
        // like every other read: it changes nothing on this machine, it publishes nothing
        // about the user, and it is the same request the poll already makes every two
        // minutes.
        "update_check" => ctx.check_release_now().await,

        // Restart this backend, through whatever runs it. A MACHINE method: it takes the
        // process every open page is talking to down, so it is the user's own click and
        // nothing a client that merely found the socket may ask for.
        "restart_backend" => ctx.restart_backend(params).await,

        // ---- push notifications (see src/push.rs) ------------------------------
        // What an installed web app needs to receive a notification while it is
        // closed. Only `push_status` reads; the other three are MACHINE methods,
        // because they decide which devices this machine notifies.

        // The subscription key the page needs and what this backend already knows.
        // Read-only, and the one arm that generates the VAPID key pair — a page that
        // asks the question is a page about to subscribe.
        "push_status" => {
            let store = ctx.store()?;
            push_status_json(&store)
        }

        // Remember this device. Idempotent: the page re-registers on every launch,
        // which is how a rotated subscription heals itself.
        "push_subscribe" => {
            let subscription = push::Subscription {
                endpoint: param_str(params, "endpoint")?,
                p256dh: param_str(params, "p256dh")?,
                auth: param_str(params, "auth")?,
            };
            // Validate BEFORE storing: a subscription that cannot be encrypted to,
            // or that points somewhere other than a browser vendor's push service,
            // must fail here rather than in a delivery task at 3 a.m.
            subscription.validate()?;
            let label = params
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .chars()
                .take(80)
                .collect::<String>();
            let store = ctx.store()?;
            store.put_push_subscription(
                &subscription.endpoint,
                &subscription.p256dh,
                &subscription.auth,
                &label,
                now_ms(),
            )?;
            eprintln!("[push] a device subscribed ({} total)", store.push_subscriptions()?.len());
            push_status_json(&store)
        }

        // Forget this device — the user turning notifications off on it.
        "push_unsubscribe" => {
            let endpoint = param_str(params, "endpoint")?;
            let store = ctx.store()?;
            let removed = store.delete_push_subscription(&endpoint)?;
            let mut status = push_status_json(&store)?;
            status["removed"] = json!(removed);
            Ok(status)
        }

        // Push one notification to every subscribed device, so the user can prove
        // the chain works without waiting for a colleague to write to them.
        "push_test" => {
            let notification = push::Notification {
                title: "teams-lite".to_string(),
                body: "Notifications are working on this device.".to_string(),
                url: "/".to_string(),
                tag: "teams-lite-test".to_string(),
            };
            let report = deliver_push(ctx, &notification, 60).await?;
            Ok(json!({ "delivered": report.delivered, "failed": report.failed, "errors": report.errors }))
        }

        // ---- the local agent (see src/agent.rs and src/agent_policy.rs) --------
        // What answers an `@claude` / `@opencode` message the USER writes, by running
        // that CLI on this machine and streaming its answer into the thread. Only
        // `agent_status` reads; the other three are MACHINE methods, because they
        // decide where this machine answers as the user, what it may run, and which
        // program and model it starts.

        // Which backends exist here, which conversations are opted in, what an agent
        // may do, and where it runs.
        "agent_status" => {
            let store = ctx.store()?;
            agent_status_json(&store)
        }

        // Opt one conversation in or out. The sandbox channel starts opted in because
        // AGENTS.md pre-authorizes a send there; every other conversation is off until
        // it is named here, and that is the consent gate for this whole feature.
        "agent_set_mode" => {
            let conversation = param_str(params, "conversation")?;
            let mode = agent_policy::Mode::parse(&param_str(params, "mode")?);
            let store = ctx.store()?;
            let modes = store.get_setting(agent_policy::SETTING_MODES)?;
            store.set_setting(
                agent_policy::SETTING_MODES,
                &agent_policy::with_mode(modes.as_deref(), &conversation, mode),
            )?;
            eprintln!("[agent] {conversation} is now `{}`", mode.as_str());
            agent_status_json(&store)
        }

        // Replace the tool allowlist. Deliberately a WHOLE list rather than an
        // add/remove pair: what an agent may do should be readable in one place, and
        // a client that widens it has to say what the full answer is.
        "agent_set_tools" => {
            let tools: Vec<String> = params
                .get("tools")
                .and_then(Value::as_array)
                .context("missing param: tools (an array of tool names)")?
                .iter()
                .filter_map(|tool| tool.as_str())
                .map(|tool| tool.trim().to_string())
                .filter(|tool| !tool.is_empty())
                .collect();
            let store = ctx.store()?;
            store.set_setting(agent::SETTING_TOOLS, &serde_json::to_string(&tools)?)?;
            eprintln!("[agent] the tool allowlist is now {tools:?}");
            agent_status_json(&store)
        }

        // Enable or disable one AI provider, choose the model it runs, and make it the
        // DEFAULT one. Every half is optional, so the UI can flip a switch without
        // restating the model.
        //
        // A provider this machine holds is enabled out of the box (see
        // `agent_policy::Providers`), so this method is how the user narrows the set —
        // and disabling one means its prefix stops answering anywhere, which is why it
        // is gated like the other two.
        "agent_set_provider" => {
            let name = param_str(params, "provider")?;
            let backend = agent_policy::backend_named(&name)
                .with_context(|| format!("no such provider: {name}"))?;
            let store = ctx.store()?;
            let stored = store.get_setting(agent_policy::SETTING_PROVIDERS)?;
            let mut providers = agent_policy::Providers::parse(stored.as_deref());
            if let Some(enabled) = params.get("enabled").and_then(Value::as_bool) {
                providers.set_enabled(backend.name, enabled);
            }
            // An absent `model` leaves the stored choice alone; an empty one clears it,
            // which is how the UI goes back to the CLI's own default.
            if let Some(model) = params.get("model").and_then(Value::as_str) {
                let model = model.trim();
                if model.is_empty() {
                    providers.set_model(backend.name, None);
                } else {
                    anyhow::ensure!(
                        agent_policy::is_valid_model(model),
                        "`{model}` is not a model name (letters, digits and . _ : / - only, \
                         and never leading with `-`)"
                    );
                    providers.set_model(backend.name, Some(model));
                }
            }
            store.set_setting(agent_policy::SETTING_PROVIDERS, &providers.to_json())?;
            // Make this provider the default: the one a surface with room for a single
            // row offers (a message's "…" menu). There is always exactly one, so the way
            // to move it is to name the other provider — clearing it would leave none.
            if let Some(default) = params.get("default").and_then(Value::as_bool) {
                anyhow::ensure!(
                    default,
                    "a machine has exactly one default provider: name the other one \
                     instead of clearing this one"
                );
                store.set_setting(agent_policy::SETTING_DEFAULT_PROVIDER, backend.name)?;
                eprintln!("[agent] {} is now the default provider", backend.name);
            }
            eprintln!(
                "[agent] {} is now {} on model {}",
                backend.name,
                if providers.is_enabled(backend.name) { "enabled" } else { "disabled" },
                providers.model(backend.name).unwrap_or_else(|| "<the CLI's default>".into())
            );
            agent_status_json(&store)
        }

        // Run the agent on the user's OWN Claude Code configuration instead of this
        // app's allowlist — every MCP server it holds, every tool, their own permission
        // mode. Off in a fresh store, and the user asks for it from the same menu.
        //
        // The journal says which way it went, because this is the one setting here that
        // decides whether a chat message can run a program that writes.
        "agent_set_unrestricted" => {
            let on = params
                .get("unrestricted")
                .and_then(Value::as_bool)
                .context("missing param: unrestricted (a boolean)")?;
            let store = ctx.store()?;
            store.set_setting(agent::SETTING_UNRESTRICTED, if on { "1" } else { "0" })?;
            eprintln!(
                "[agent] the agent now runs {}",
                if on {
                    "on the USER'S OWN configuration — every tool their settings allow"
                } else {
                    "on this app's read-only allowlist"
                }
            );
            agent_status_json(&store)
        }

        // Stop a run this backend is streaming, mid-answer. The user pressed Stop on the
        // live bubble; the run finalizes with the answer so far and a "stopped by you"
        // note (see `agent_run_to_completion`), so the reply is kept, not lost.
        //
        // It only reaches a run THIS process owns: the registry is per-process, and the
        // agent path is single-backend in the real deployment (a phone reaches 19420
        // through the relay). A run streaming on the other install (19422) is simply not
        // here, and `stopped: false` says so rather than pretending. It does not edit the
        // message itself — flipping the switch is all it does, and the run's own
        // finalization writes the body, so there is no double-edit to race.
        "agent_stop" => {
            let run_id = param_str(params, "run_id")?;
            let stopped = match ctx.agent_runs_inflight.lock().unwrap().get(&run_id) {
                Some(stop) => {
                    let _ = stop.send(true);
                    true
                }
                None => false,
            };
            if stopped {
                eprintln!("[agent] stopping {run_id} — the user asked");
            }
            Ok(json!({ "stopped": stopped }))
        }

        // One custom agent's face, or empty strings when it has none — the shape
        // `custom_emoji_image` already has, so the page's own blob cache needed no new
        // idea. Kept out of the list above because ten faces is megabytes and a list is
        // asked for on every connect.
        "agent_persona_avatar" => {
            let name = param_str(params, "name")?;
            let store = ctx.store()?;
            match store.agent_persona_avatar(&name)? {
                Some((content_type, bytes)) => Ok(json!({
                    "content_type": content_type,
                    "data_base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                })),
                None => Ok(json!({ "content_type": "", "data_base64": "" })),
            }
        }

        // Create or change one custom agent. The name is the address and the primary key,
        // so it is checked against the reserved provider names and the ones already taken
        // (`agent_persona::check_name`) — but only when the row is NEW: an edit of `bebou`
        // must not be refused because `bebou` exists.
        //
        // Every field a client sends is normalized rather than trusted, and the provider
        // MUST resolve: a persona that named an unknown one would be a row the user can see
        // and never summon.
        "agent_persona_save" => {
            let name = param_str(params, "name")?.trim().to_lowercase();
            let backend = param_str(params, "backend")?;
            let store = ctx.store()?;
            let existing = store.agent_personas()?;
            if agent_persona::named(&existing, &name).is_none() {
                let taken: Vec<String> = existing.iter().map(|p| p.name.clone()).collect();
                agent_persona::check_name(&name, &taken)?;
            }
            let backend = agent_policy::backend_named(&backend).ok_or_else(|| {
                anyhow::anyhow!(
                    "`{backend}` is not an AI provider this machine knows — pick {}",
                    agent_policy::BACKENDS
                        .iter()
                        .map(|b| b.name)
                        .collect::<Vec<_>>()
                        .join(" or ")
                )
            })?;
            let text = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or_default();
            let persona = agent_persona::Persona {
                label: agent_persona::normalize_label(text("label"), &name),
                name,
                backend,
                model: agent_persona::normalize_model(Some(text("model"))),
                preprompt: agent_persona::normalize_preprompt(text("preprompt")),
                avatar: None,
                added_ms: 0,
                updated_ms: 0,
            };
            // THREE answers, not two, and the difference is what stops an edit of a
            // preprompt from silently deleting the face: absent LEAVES the picture alone,
            // `""` clears it, and bytes replace it.
            let avatar = match params.get("avatar_base64").and_then(Value::as_str) {
                None => None,
                Some("") => Some(None),
                Some(encoded) => {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(encoded.trim())
                        .context("that picture is not valid base64")?;
                    let measured = agent_persona::measure_avatar(&bytes)?;
                    Some(Some((measured, bytes)))
                }
            };
            store.set_agent_persona(
                &persona,
                avatar.as_ref().map(|face| {
                    face.as_ref().map(|(measured, bytes)| {
                        (measured.content_type.as_str(), bytes.as_slice(), measured.width, measured.height)
                    })
                }),
                now_ms(),
            )?;
            ctx.emit("agent_personas_changed", json!({}));
            eprintln!("[agent] saved the custom agent @{} ({})", persona.name, backend.name);
            agent_status_json(&store)
        }

        // Forget one custom agent. `@bebou` is a plain word again from the next message on,
        // and a reply it already posted still renders under its own name: that is read back
        // out of the message's own signature, never out of this table.
        "agent_persona_remove" => {
            let name = param_str(params, "name")?.trim().to_lowercase();
            let store = ctx.store()?;
            let removed = store.remove_agent_persona(&name)?;
            if removed {
                ctx.emit("agent_personas_changed", json!({}));
                eprintln!("[agent] removed the custom agent @{name}");
            }
            agent_status_json(&store)
        }

        // full conversation list — LOCAL-FIRST: answer instantly from the SQLite
        // cache (0 network round-trips), then sync from the network in the
        // background and emit `conversations_changed` if anything new arrived.
        "conversations" => {
            // The identity, never the session: this must answer from the store while
            // sign-in is broken (see `Ctx::identity`).
            let self_name = ctx.identity().await?.name;
            let rows = {
                let store = ctx.store()?;
                store.conversations(&self_name)?
            };
            // background sync (does not block the response = instant startup)
            sync_csa_bg(ctx.clone());
            Ok(conversations_json(&rows))
        }

        // team/channel tree — LOCAL-FIRST, exactly like `conversations`: answer
        // instantly from the SQLite cache, then sync from the network in the
        // background and emit `channels_changed` if the tree changed. One CSA
        // fetch backs both lists, so this triggers the same shared sync.
        "channels" => {
            let rows = {
                let store = ctx.store()?;
                store.channels()?
            };
            sync_csa_bg(ctx.clone());
            Ok(channels_json(&rows))
        }

        // open a conversation — LOCAL-FIRST: answer instantly from the SQLite
        // cache (0 network round-trips), then refresh from the network in the
        // background and emit `messages_updated` if anything new arrived.
        "open" => {
            let conv = param_str(params, "conversation")?;
            // The self identity tags each cached message with is_self. It never
            // touches the network (see `Ctx::identity`), so the cached page answers
            // during a sign-in outage as well as it does live. The MRI is the reliable
            // signal; the name is the fallback.
            let me = ctx.identity().await?;
            let (self_name, self_mri) = (me.name, me.mri);
            // Held open until the page is serialized below: a reaction states the names
            // of the people behind it, which is a store read (see `reactions_value`).
            let store = ctx.store()?;
            let (cached, has_more) = newest_history_page(&store, &conv)?;
            // background refresh (does not block the response = instant switch)
            let ctx_bg = ctx.clone();
            let conv_bg = conv.clone();
            let self_name_bg = self_name.clone();
            let self_mri_bg = self_mri.clone();
            let had_more = has_more;
            tokio::spawn(async move {
                let http = ctx_bg.http.clone();
                let conv_op = conv_bg.clone();
                let page = ctx_bg
                    .retry_on_auth(move |session, _csa| {
                        let http = http.clone();
                        let conv = conv_op.clone();
                        async move { teams_read::fetch_newest(&http, &session, &conv).await }
                    })
                    .await;
                if let Ok(page) = page {
                    let after = {
                        if let Ok(store) = ctx_bg.store() {
                            let inserted = teams_read::persist_page(&store, &conv_bg, &page).unwrap_or(0);
                            // Serialized while the store is still open: a message states
                            // who reacted to it, and that is a store read.
                            newest_history_page(&store, &conv_bg)
                                .ok()
                                .filter(|(_, has_more)| inserted > 0 || *has_more != had_more)
                                .map(|(msgs, has_more)| {
                                    let value = messages_value(
                                        &msgs,
                                        &self_name_bg,
                                        &self_mri_bg,
                                        Some(&store),
                                    );
                                    (value, has_more)
                                })
                        } else {
                            None
                        }
                    };
                    if let Some((messages, has_more)) = after {
                        // something changed vs the cache we already returned
                        ctx_bg.emit("messages_updated", json!({
                            "conversation": conv_bg,
                            "messages": messages,
                            "has_more": has_more
                        }));
                    }
                } else if let Err(e) = page {
                    // The background network refresh failed (e.g. auth couldn't be
                    // recovered). Tell the UI so it can show a real error instead
                    // of the misleading "No messages yet." empty state.
                    ctx_bg.emit(
                        "messages_error",
                        json!({ "conversation": conv_bg, "error": e.to_string() }),
                    );
                }
            });
            Ok(messages_json(&cached, &self_name, &self_mri, has_more, Some(&store)))
        }

        // older page for scroll-up
        "backfill" => {
            let conv = param_str(params, "conversation")?;
            let before_seq = params
                .get("before_seq")
                .and_then(Value::as_i64)
                .context("missing param: before_seq")?;
            // Before the store is opened, so the page below can be serialized while it is
            // still open: a reaction states who is behind it, which is a store read.
            let me = ctx.identity().await?;
            let (self_name, self_mri) = (me.name, me.mri);
            {
                let store = ctx.store()?;
                let (cached, cached_has_more) = cached_history_page(&store, &conv, before_seq)?;
                if !cached.is_empty() {
                    return Ok(messages_json(
                        &cached,
                        &self_name,
                        &self_mri,
                        cached_has_more,
                        Some(&store),
                    ));
                }
                if !cached_has_more {
                    return Ok(messages_json(&[], &self_name, &self_mri, false, Some(&store)));
                }
            }

            let before_ms = {
                let store = ctx.store()?;
                store
                    .oldest_cursor(&conv)?
                    .0
                    .and_then(|cursor| cursor.parse::<i64>().ok())
            };
            let http = ctx.http.clone();
            let conv_op = conv.clone();
            let page = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let conv = conv_op.clone();
                    async move {
                        teams_read::fetch_messages_page(
                            &http,
                            &session,
                            &conv,
                            before_ms,
                            teams_read::DEFAULT_PAGE_SIZE,
                        )
                        .await
                    }
                })
                .await?;
            let store = ctx.store()?;
            teams_read::persist_backfill_page(&store, &conv, &page)?;
            let has_more = store.oldest_cursor(&conv)?.1;
            Ok(messages_json(
                &page.messages,
                &self_name,
                &self_mri,
                has_more,
                Some(&store),
            ))
        }

        // Persist unsent composer text locally. This never touches the network.
        // Proxy one hosted-content media object (inline chat image or a shared
        // file) with the session credentials, streaming the bytes back to the UI
        // base64-encoded. The browser cannot fetch these URLs itself — they need
        // the skypetoken — and the UI never touches the network directly, so this
        // keeps images/attachments flowing through the same WebSocket protocol as
        // everything else. The URL is host-checked (see `teams_media`) before the
        // token is ever attached, so an untrusted URL can never exfiltrate it.
        "fetch_media" => {
            let url = param_str(params, "url")?;
            let http = ctx.http.clone();
            // Two hosting schemes: legacy AMS / chatService objects carry the
            // skypetoken; modern OneDrive/SharePoint chat files need a Graph bearer
            // token instead. Route by host, and reject a URL on neither allowlist
            // before any token is attached, so an untrusted URL can never leak one.
            let media = if teams_media::is_allowed_media_url(&url) {
                ctx.retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let url = url.clone();
                    async move { teams_media::fetch_media(&http, &session, &url).await }
                })
                .await?
            } else if teams_media::is_sharepoint_url(&url) {
                let tokens = ctx.tokens.clone();
                ctx.retry_on_auth(move |_session, _csa| {
                    let http = http.clone();
                    let url = url.clone();
                    let tokens = tokens.clone();
                    async move {
                        let graph = tokens.get(teams_media::GRAPH_SCOPE).await?;
                        teams_media::fetch_sharepoint_media(&http, &graph, &url).await
                    }
                })
                .await?
            } else {
                anyhow::bail!("media host not allowed");
            };
            let data = base64::engine::general_purpose::STANDARD.encode(&media.bytes);
            Ok(json!({ "content_type": media.content_type, "data_base64": data }))
        }

        // Proxy a real profile photo (a person, or a Teams "team" group) back to
        // the UI, which can't hold the credentials. The id is charset-validated in
        // `teams_avatars` before it is put on the URL, and the request only ever
        // targets a fixed Microsoft host. A subject with no photo answers `found:
        // false` so the UI falls back to tinted initials (and can negative-cache).
        "fetch_avatar" => {
            let kind_str = param_str(params, "kind")?;
            let kind = teams_avatars::AvatarKind::from_wire(&kind_str)
                .with_context(|| format!("unknown avatar kind: {kind_str}"))?;
            let id = param_str(params, "id")?;
            anyhow::ensure!(
                teams_avatars::is_valid_avatar_id(&id),
                "malformed avatar id"
            );
            // A face the USER gave this person wins, and answers without the network:
            // Teams holds no such picture, so there is nothing up there to ask. Doing
            // it HERE rather than at each render site is what makes one override cover
            // the sidebar, the header, the bubble stack, the mention list, the "seen
            // by" row and the card at once — every one of them already asks this RPC.
            if kind == teams_avatars::AvatarKind::User {
                if let Some(o) = ctx.store().ok().and_then(|s| s.person_override(&id).ok().flatten())
                {
                    if !o.avatar_bytes.is_empty() {
                        let data =
                            base64::engine::general_purpose::STANDARD.encode(&o.avatar_bytes);
                        return Ok(json!({
                            "found": true,
                            "content_type": o.avatar_content_type,
                            "data_base64": data,
                        }));
                    }
                }
            }
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let media = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let id = id.clone();
                    async move {
                        // The photo endpoints take the profile-audience token, not
                        // the CSA one `retry_on_auth` supplies. Read it fresh each
                        // attempt so a 401 refresh in between is picked up.
                        let profile = tokens.get(teams_profiles::PROFILE_SCOPE).await?;
                        teams_avatars::fetch_avatar(&http, &session, &profile, kind, &id).await
                    }
                })
                .await?;
            match media {
                Some(media) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&media.bytes);
                    Ok(json!({
                        "found": true,
                        "content_type": media.content_type,
                        "data_base64": data,
                    }))
                }
                None => Ok(json!({ "found": false })),
            }
        }

        // The mark of an ORGANISATION that mails the user, for a sender the Teams
        // directory cannot name (see `sender_icon`, which holds the rails, and
        // `people_by_address`, which is what names a colleague instead).
        //
        // This is the only method that requests something from a server nobody here
        // configured, so four things happen before the network:
        //   - the domain is reduced to its registrable form, so a per-recipient
        //     subdomain cannot carry a reader's identity out to the sender;
        //   - the store answers if this domain was ever asked — including a remembered
        //     "it has none", so a server is asked once per organisation, not per mail;
        //   - a read-only backend refuses: an automation must not touch a stranger's
        //     server on the user's behalf;
        //   - the user's own switch is honoured (`SETTING_SENDER_ICONS`).
        // A domain with no usable icon answers `found: false`, and the UI keeps the
        // tinted initials it already draws from the same domain.
        "sender_icon" => {
            let domain = sender_icon::registrable_domain(&param_str(params, "domain")?);
            anyhow::ensure!(sender_icon::is_fetchable_domain(&domain), "not a sender domain");
            let store = ctx.store()?;

            if let Some(cached) = store.sender_icon(&domain)? {
                return Ok(sender_icon_json(cached.as_ref()));
            }
            if read_only() {
                return Ok(sender_icon_json(None));
            }
            anyhow::ensure!(sender_icons_enabled(&store)?, "sender icons are turned off");

            let icon = sender_icon::fetch_icon(&domain).await.unwrap_or(None);
            store.put_sender_icon(&domain, icon.as_ref(), now_ms())?;
            Ok(sender_icon_json(icon.as_ref()))
        }

        "set_draft" => {
            let conv = param_str(params, "conversation")?;
            let text = param_str(params, "text")?;
            let store = ctx.store()?;
            store.set_draft(&conv, &text)?;
            Ok(json!({ "saved": true }))
        }

        // What the user decided to call somebody, and the face they gave them. Teams
        // holds neither — a colleague's name and photo are theirs to set — so this is
        // a purely LOCAL override, and the one thing in the store no sync can supply.
        //
        // Reading it back is open: it returns the user's own decision, plus the name
        // the directory actually holds, so the app can show both. That second half is
        // the point. A rename that erased the real name everywhere would leave the user
        // unable to tell who a message is from, so the card that offers the rename is
        // also the place that keeps stating who Teams says this is.
        "person_override" => {
            let mri = param_str(params, "mri")?;
            anyhow::ensure!(
                teams_profiles::is_person_mri(&mri),
                "a person override needs a person MRI"
            );
            let store = ctx.store()?;
            let o = store.person_override(&mri)?;
            Ok(json!({
                "mri": mri,
                "display_name": o.as_ref().map(|o| o.display_name.clone()).unwrap_or_default(),
                "has_avatar": o.as_ref().is_some_and(|o| !o.avatar_bytes.is_empty()),
                // The name Teams itself holds for this person, from the messages we
                // already store — never overridden, so the UI can always say who this
                // really is next to the name the user chose.
                "teams_name": store.teams_display_name_for_mri(&mri)?.unwrap_or_default(),
            }))
        }

        // Every override the user set, so a settings pane can list and undo them
        // without hunting for each person in a thread.
        "person_overrides" => {
            let store = ctx.store()?;
            let overrides = store.person_overrides()?;
            let list: Vec<Value> = overrides
                .into_iter()
                .map(|o| {
                    let teams_name =
                        store.teams_display_name_for_mri(&o.mri).ok().flatten().unwrap_or_default();
                    json!({
                        "mri": o.mri,
                        "display_name": o.display_name,
                        "has_avatar": o.has_avatar,
                        "updated_at": o.updated_at,
                        "teams_name": teams_name,
                    })
                })
                .collect();
            Ok(json!({ "overrides": list }))
        }

        // Rename one person, or with an empty/absent `name`, put their real name back.
        // The face they were given is untouched: the two halves are independent, so
        // undoing a rename never silently drops a picture.
        "set_person_name" => {
            let mri = param_str(params, "mri")?;
            anyhow::ensure!(
                teams_profiles::is_person_mri(&mri),
                "a person override needs a person MRI"
            );
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
            anyhow::ensure!(
                name.len() <= MAX_PERSON_NAME_BYTES,
                "that name is too long ({} bytes, max {MAX_PERSON_NAME_BYTES})",
                name.len()
            );
            // A control character would let a name break the line it is rendered on,
            // and a name is drawn in a dozen places that each assume one line.
            anyhow::ensure!(
                !name.chars().any(char::is_control),
                "a name cannot contain control characters"
            );
            let store = ctx.store()?;
            store.set_person_name(&mri, Some(name).filter(|n| !n.is_empty()), now_ms())?;
            ctx.emit("person_override_changed", json!({ "mri": mri }));
            Ok(json!({ "saved": true }))
        }

        // Give one person a face, or with absent `data_base64`, take it back. The name
        // they were given is untouched, for the same reason as above.
        "set_person_avatar" => {
            let mri = param_str(params, "mri")?;
            anyhow::ensure!(
                teams_profiles::is_person_mri(&mri),
                "a person override needs a person MRI"
            );
            let store = ctx.store()?;
            match params.get("data_base64").and_then(|v| v.as_str()) {
                None | Some("") => store.set_person_avatar(&mri, None, now_ms())?,
                Some(data) => {
                    let content_type = param_str(params, "content_type")?;
                    // An image and nothing else. These bytes come back out of this app
                    // as an avatar `<img>`, so a body typed `text/html` would be a
                    // script the user pasted into their own page.
                    anyhow::ensure!(
                        PERSON_AVATAR_TYPES.contains(&content_type.as_str()),
                        "an avatar must be a PNG, JPEG, GIF or WebP image"
                    );
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .context("avatar data is not valid base64")?;
                    anyhow::ensure!(!bytes.is_empty(), "an avatar cannot be empty");
                    anyhow::ensure!(
                        bytes.len() <= MAX_PERSON_AVATAR_BYTES,
                        "that picture is too large ({} bytes, max {MAX_PERSON_AVATAR_BYTES})",
                        bytes.len()
                    );
                    store.set_person_avatar(&mri, Some((&content_type, &bytes)), now_ms())?;
                }
            }
            ctx.emit("person_override_changed", json!({ "mri": mri }));
            Ok(json!({ "saved": true }))
        }

        // The custom emoji pack this machine holds. Returns the list without the art
        // itself, so a picker can show what is available before asking for the bytes.
        "custom_emoji" => {
            let store = ctx.store()?;
            let emoji = store.custom_emoji()?;
            let list: Vec<Value> = emoji
                .into_iter()
                .map(|e| {
                    json!({
                        "name": e.name,
                        "alias_of": e.alias_of,
                        "content_type": e.content_type,
                        "width": e.width,
                        "height": e.height,
                        "source": e.source,
                        "added_ms": e.added_ms,
                    })
                })
                .collect();
            Ok(json!({ "emoji": list }))
        }

        // The art for one custom emoji, or empty strings when there is none.
        "custom_emoji_image" => {
            let name = param_str(params, "name")?;
            let store = ctx.store()?;
            let art = store.custom_emoji_art(&name)?;
            match art {
                Some((content_type, bytes)) => {
                    let data_base64 =
                        base64::engine::general_purpose::STANDARD.encode(&bytes);
                    Ok(json!({
                        "content_type": content_type,
                        "data_base64": data_base64,
                    }))
                }
                None => Ok(json!({
                    "content_type": "",
                    "data_base64": "",
                })),
            }
        }

        // The full pack, with the art base64-encoded. This is what another machine
        // imports, so a pack travels with its pictures.
        "custom_emoji_export" => {
            let store = ctx.store()?;
            let emoji = store.custom_emoji()?;
            let list: Vec<Value> = emoji
                .iter()
                .map(|e| {
                    export_row(e, |name| {
                        store
                            .custom_emoji_art(name)
                            .ok()
                            .flatten()
                            .map(|(_, bytes)| {
                                base64::engine::general_purpose::STANDARD.encode(&bytes)
                            })
                            .unwrap_or_default()
                    })
                })
                .collect();
            Ok(json!({ "emoji": list }))
        }

        // Add one custom emoji to the pack, or fail with a reason. The name must be
        // free, the art must pass the type and size checks, and exactly one source
        // must be present.
        "custom_emoji_add" => {
            let name = param_str(params, "name")?;
            let source = param_str(params, "source")?;
            anyhow::ensure!(
                custom_emoji::is_valid_name(&name),
                "an emoji name may hold lowercase letters, numbers, dashes and underscores"
            );

            let store = ctx.store()?;
            let existing = store.custom_emoji()?;
            let name_taken = existing.iter().any(|e| e.name == name || e.alias_of == name);
            anyhow::ensure!(!name_taken, "If your emoji name is taken, choose another.");

            let alias_of = params.get("alias_of").and_then(|v| v.as_str()).map(str::to_string);
            let url = params.get("url").and_then(|v| v.as_str());
            let media_url = params.get("media_url").and_then(|v| v.as_str());
            let data_base64 = params.get("data_base64").and_then(|v| v.as_str());

            let sources = [
                alias_of.is_some(),
                url.is_some(),
                media_url.is_some(),
                data_base64.is_some(),
            ]
            .iter()
            .filter(|&&b| b)
            .count();
            anyhow::ensure!(sources == 1, "exactly one source must be present");

            if let Some(alias) = alias_of.as_deref() {
                store.set_custom_emoji(&name, None, Some(alias), &source, now_ms())?;
            } else if let Some(url) = url {
                let host = sender_icon::extract_host(url)
                    .ok_or_else(|| anyhow::anyhow!("URL has no host"))?;
                let domain = sender_icon::registrable_domain(&host);
                let media = sender_icon::fetch_raster(url, custom_emoji::MAX_CUSTOM_EMOJI_BYTES)
                    .await?
                    .ok_or_else(|| {
                        anyhow::anyhow!("Could not fetch a raster image from that URL")
                    })?;

                let (content_type, width, height) = custom_emoji::measure_art(&media.bytes)?;

                let source_with_domain = format!("url:{}", domain);
                store.set_custom_emoji(
                    &name,
                    Some((content_type, &media.bytes, width, height)),
                    None,
                    &source_with_domain,
                    now_ms(),
                )?;
            } else if let Some(media_url) = media_url {
                anyhow::ensure!(
                    teams_media::is_allowed_media_url(media_url),
                    "Only Teams-hosted media URLs are allowed"
                );

                let session = ctx.session().await?;
                // Ask for the bytes as they were uploaded, not the rendition the message
                // names: AMS answers `views/imgo` with a still JPEG for an animated GIF
                // (see `custom_emoji::original_art_url`). A pack entry is kept for good, so
                // storing the still frame would outlive the message it was taken from.
                let art_url = custom_emoji::original_art_url(media_url);
                let media = teams_media::fetch_media(&ctx.http, &session, &art_url).await?;

                let (content_type, width, height) = custom_emoji::measure_art(&media.bytes)?;

                store.set_custom_emoji(
                    &name,
                    Some((content_type, &media.bytes, width, height)),
                    None,
                    "message",
                    now_ms(),
                )?;
            } else if let Some(data) = data_base64 {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .context("emoji data is not valid base64")?;
                // The type and the size are read from the BYTES, not from what the caller
                // said about them: this is the path the Add Emoji dialog uses, so it was
                // the one place the 512 px cap and the "never SVG" rule were a UI
                // courtesy rather than a store invariant.
                let (content_type, width, height) = custom_emoji::measure_art(&bytes)?;

                store.set_custom_emoji(
                    &name,
                    Some((content_type, &bytes, width, height)),
                    None,
                    &source,
                    now_ms(),
                )?;
            }

            ctx.emit("custom_emoji_changed", json!({}));
            Ok(json!({ "added": true }))
        }

        // Remove one custom emoji from the pack. Returns whether it existed.
        "custom_emoji_remove" => {
            let name = param_str(params, "name")?;
            let store = ctx.store()?;
            let removed = store.remove_custom_emoji(&name)?;
            ctx.emit("custom_emoji_changed", json!({}));
            Ok(json!({ "removed": removed }))
        }

        // ---- A SEALED chat (see `teams_lite::seal` and AGENTS.md § A sealed chat) ----

        // Which conversations this machine holds a passphrase for, and which of them it is
        // SEALING. OPEN, like `get_settings`: it answers which chats are sealed and under which
        // key id, and never with a key or a passphrase — the one question a page must be able to
        // ask before it draws a padlock or a composer hint.
        "seal_status" => Ok(seal_status_value(&ctx)?),

        // Set — or generate — the passphrase a conversation is sealed with, and start sealing.
        //
        // Additive: every key already held is kept and stops being current, so the messages it
        // sealed still open. That is what makes a rotation, and a colleague changing the
        // passphrase, cost nothing that is already in the thread.
        //
        // It ANSWERS with whether that passphrase opens the sealed messages the thread already
        // holds. That is the sharpest failure this feature has: two people each set a DIFFERENT
        // passphrase, every message each posts is unreadable to the other, and without this
        // nobody is told — both see locked rows and each believes the other's app is broken.
        "seal_set" => {
            let conversation = param_str(params, "conversation")?;
            // A CHANNEL is not sealable in v1, for the reason a channel holds no game of chess:
            // its history is drawn as threads, and a sealed post there would have to answer a
            // different question about where the padlock sits. Refused here rather than left to
            // behave oddly.
            anyhow::ensure!(
                !teams_read::is_channel_thread_id(&conversation),
                "a channel cannot be sealed yet — this is for a chat"
            );
            // Absent means GENERATE one, which is what the dialog offers first: a passphrase the
            // app made carries its own entropy and does not lean on the KDF for safety.
            let generated = params.get("passphrase").is_none();
            let passphrase = match params.get("passphrase") {
                Some(value) => {
                    let raw = value.as_str().context("passphrase must be a string")?;
                    teams_lite::seal::check_passphrase(raw)?
                }
                None => teams_lite::seal::generate_passphrase(),
            };
            let key = teams_lite::seal::derive(&passphrase, &conversation).context("derive the key")?;
            let store = ctx.store()?;
            // WHICH keys the messages already in the thread were sealed with, read before the
            // write so the answer describes what the reader is walking into.
            let in_use = store.seal_key_ids_in_use(&conversation, SEAL_SCAN_DEPTH)?;
            let opens_existing = in_use.is_empty() || in_use.contains(&key.id_hex());
            store.add_seal_key(&conversation, &key, &passphrase, now_ms())?;
            // The journal records the key id and never the passphrase, for the reason no other
            // secret in this file is ever logged.
            eprintln!(
                "[seal] {conversation} now seals under {} ({} keys already used here)",
                key.id_hex(),
                in_use.len()
            );
            ctx.emit("seal_changed", json!({ "conversation": conversation }));
            let mut answer = seal_status_value(&ctx)?;
            answer["conversation"] = json!(conversation);
            answer["key_id"] = json!(key.id_hex());
            answer["opens_existing"] = json!(opens_existing);
            answer["key_ids_in_use"] = json!(in_use);
            // The passphrase travels back ONLY when this machine invented it, so the dialog can
            // show the user what to give their colleagues. One the user typed is one they already
            // have.
            if generated {
                answer["passphrase"] = json!(passphrase);
            }
            Ok(answer)
        }

        // Stop sealing NEW messages, and KEEP every key. A chat that stops being sealed is still
        // full of sealed messages, and dropping the passphrase would make every one of them
        // unreadable — which is the one act here nothing takes back (that is `seal_forget`).
        "seal_off" => {
            let conversation = param_str(params, "conversation")?;
            let store = ctx.store()?;
            let stopped = store.stop_sealing(&conversation)?;
            if stopped {
                eprintln!("[seal] {conversation} no longer seals new messages");
                ctx.emit("seal_changed", json!({ "conversation": conversation }));
            }
            let mut answer = seal_status_value(&ctx)?;
            answer["stopped"] = json!(stopped);
            Ok(answer)
        }

        // Forget one key. Every message it sealed becomes unreadable on this machine, for good —
        // so the UI asks twice, the way a deletion does.
        "seal_forget" => {
            let conversation = param_str(params, "conversation")?;
            let key_id = param_str(params, "key_id")?;
            let store = ctx.store()?;
            let forgotten = store.forget_seal_key(&conversation, &key_id)?;
            if forgotten {
                eprintln!("[seal] {conversation} forgot {key_id}: its messages are unreadable here");
                ctx.emit("seal_changed", json!({ "conversation": conversation }));
            }
            let mut answer = seal_status_value(&ctx)?;
            answer["forgotten"] = json!(forgotten);
            Ok(answer)
        }

        // The passphrase behind one key, for the user's own press and nothing else.
        //
        // It exists because a colleague who joins the conversation in March has to be GIVEN
        // something, and a passphrase this app cannot show again would force a rotation of the
        // whole chat to share it. It is no wider a secret than the derived key in the same row —
        // either one opens every message — which is why it is a press rather than a field of
        // `seal_status`.
        "seal_reveal" => {
            let conversation = param_str(params, "conversation")?;
            let key_id = param_str(params, "key_id")?;
            let store = ctx.store()?;
            let passphrase = store
                .seal_passphrase(&conversation, &key_id)?
                .context("this machine holds no passphrase for that key")?;
            Ok(json!({ "passphrase": passphrase }))
        }

        // Import a pack exported from another machine. Each entry is validated like
        // `custom_emoji_add`; entries that fail are skipped, and the count of what was
        // added is returned. A pack with one bad row still imports the rest.
        "custom_emoji_import" => {
            let emoji_list = params
                .get("emoji")
                .and_then(|v| v.as_array())
                .ok_or_else(|| anyhow::anyhow!("emoji array is required"))?;

            let store = ctx.store()?;
            let mut added = 0;
            let mut errors = Vec::new();

            for entry in import_order(emoji_list) {
                let name = entry
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("name is required"))?;

                if !custom_emoji::is_valid_name(name) {
                    errors.push(format!("{}: invalid name", name));
                    continue;
                }

                let existing = store.custom_emoji()?;
                if existing.iter().any(|e| e.name == name || e.alias_of == name) {
                    errors.push(format!("{}: name taken", name));
                    continue;
                }

                match import_entry(entry) {
                    Some(ImportEntry::Alias(alias)) => {
                        match store.set_custom_emoji(name, None, Some(alias), "import", now_ms()) {
                            Ok(_) => added += 1,
                            Err(e) => errors.push(format!("{}: {}", name, e)),
                        }
                    }
                    Some(ImportEntry::Art(data)) => {
                        let bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
                            Ok(b) => b,
                            Err(_) => {
                                errors.push(format!("{}: invalid base64", name));
                                continue;
                            }
                        };

                        // A pack file is a file: the type and the size it states about a row
                        // are as unchecked as anything else in it, so the bytes are measured.
                        let measured = custom_emoji::measure_art(&bytes);
                        let (content_type, width, height) = match measured {
                            Ok(measured) => measured,
                            Err(e) => {
                                errors.push(format!("{}: {}", name, e));
                                continue;
                            }
                        };

                        match store.set_custom_emoji(
                            name,
                            Some((content_type, &bytes, width, height)),
                            None,
                            "import",
                            now_ms(),
                        ) {
                            Ok(_) => added += 1,
                            Err(e) => errors.push(format!("{}: {}", name, e)),
                        }
                    }
                    // Neither art nor an alias: an export writes such a row for a name whose
                    // picture it could not read back, and there is nothing here to write.
                    None => {}
                }
            }

            ctx.emit("custom_emoji_changed", json!({}));

            if added == 0 && !errors.is_empty() {
                anyhow::bail!("failed to import: {}", errors.join(", "));
            }

            Ok(json!({ "added": added }))
        }

        // send a message
        "send" => {
            let conv = param_str(params, "conversation")?;
            let text = param_str(params, "text")?;
            let reply_to = params.get("reply_to").map(parse_reply_to).transpose()?;
            let content_html = params
                .get("content_html")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            // Every picture the composer holds, in the order the user pasted them. The
            // count and the combined size are refused here, before anything is uploaded —
            // and so is the single-`image` shape an older page sends, because dropping it
            // silently would post the caption alone and answer that it worked.
            let images = teams_send::parse_send_images(params)?;
            // Who the message @mentions. The body carries an index per mention and this
            // list says who each index names, so Teams notifies them (see
            // `teams_send::Mention`). Validated before anything leaves this machine.
            let mentions = params
                .get("mentions")
                .map(teams_send::parse_mentions)
                .transpose()?
                .unwrap_or_default();
            // When Teams is to deliver it, if not now. It rides in this method's params
            // exactly as the pictures and the mentions do: `send` is already an
            // OUTWARD_METHODS entry, the consent is the user's own click on Schedule, and
            // one POST is the whole feature — the service holds the message and posts it
            // at that moment, so nothing on this machine has to be running then.
            let scheduled_ms = teams_send::parse_scheduled_time(params)?;
            // The post's TITLE, where a channel post has one. It rides in this method's
            // params for the reason the pictures and the moment do — `send` is already the
            // OUTWARD_METHODS entry, and the title is part of the message it posts, not a
            // second action. A reply is refused one here (see `parse_subject`).
            let subject = teams_send::parse_subject(params)?;

            // Custom emoji: read the pack's art for each code in the outbound body, so
            // the `:shipit:` codes become Teams' own inline emoji markup with the bytes
            // uploaded to AMS. A failed upload propagates: the send fails, the composer
            // shows it, and nothing is posted (CLAUDE.md § Sending messages and the brief
            // § 5.4). The agent's answer passes an empty list, so its words are not our pack.
            let (content_html, emoji_art) = match content_html.as_ref() {
                Some(html) => (Some(html.clone()), custom_emoji_art_in(&ctx, html)),
                None => (None, Vec::new()),
            };

            // The key this conversation SEALS with, or None where it is not sealed (§ A sealed
            // chat). It is read here, once, rather than inside the retry closure: an auth
            // retry must re-seal with the SAME key, and a passphrase the user changed between
            // the two attempts would otherwise post a message under a key nobody else holds.
            //
            // FAIL-CLOSED: a store this backend cannot read refuses the send rather than
            // posting in the clear to a chat whose reader believes it is sealed.
            let seal_key = ctx
                .store()
                .context("this chat may be sealed and the store cannot be read")?
                .current_seal_key(&conv)
                .context("read this chat's seal key")?;
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let send_conv = conv.clone();
            // A POST that creates a message is the one call here that must NOT be
            // retried on a lost answer: Teams has no idempotency key for it, so a
            // second attempt posts the message a second time — which is the duplicate
            // a reader watching a slow send hammer Enter really got. A refused
            // credential is still refreshed and retried, because that one created
            // nothing (see `retry::RetryPolicy::auth_only`).
            let sent = ctx
                .retry_on_auth_with(retry::RetryPolicy::auth_only(), move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let conv = send_conv.clone();
                    let text = text.clone();
                    let reply_to = reply_to.clone();
                    let content_html = content_html.clone();
                    let images = images.clone();
                    let emoji_art = emoji_art.clone();
                    let mentions = mentions.clone();
                    let subject = subject.clone();
                    let seal_key = seal_key.clone();
                    async move {
                        let ic3 = tokens.get(IC3_SCOPE).await?;
                        let (rewritten_html, emoji_ids) = if !emoji_art.is_empty() {
                            teams_send::resolve_custom_emoji(
                                &http,
                                &session,
                                &ic3,
                                &conv,
                                content_html.as_deref().unwrap_or(""),
                                &emoji_art,
                            )
                            .await?
                        } else {
                            (content_html.clone().unwrap_or_default(), Vec::new())
                        };
                        teams_send::send_message(
                            &http,
                            &session,
                            &ic3,
                            &conv,
                            &text,
                            reply_to.as_ref(),
                            if rewritten_html.is_empty() {
                                content_html.as_deref()
                            } else {
                                Some(&rewritten_html)
                            },
                            &images,
                            &emoji_ids,
                            &mentions,
                            scheduled_ms,
                            subject.as_deref(),
                            seal_key.as_ref(),
                        )
                        .await
                    }
                })
                .await?;
            // The network accepted the message, so the persisted draft is no
            // longer needed. Never turn a successful send into an apparent
            // failure if this best-effort cleanup hits a transient SQLite error;
            // the UI also retries the same idempotent clear after the response.
            if let Err(e) = ctx.store().and_then(|store| store.set_draft(&conv, "")) {
                eprintln!("[draft] could not clear sent draft for {conv}: {e}");
            }
            Ok(json!({ "sent": true, "message_id": sent.id }))
        }

        // edit one of our own messages in place. The network PUT replaces the
        // message resource; we then update the local row and broadcast the new
        // content so open UIs reflect the edit immediately (both clients merge
        // live messages by id), without waiting for the trouter echo.
        "edit" => {
            let conv = param_str(params, "conversation")?;
            let message_id = param_str(params, "message_id")?;
            let text = param_str(params, "text")?;
            // The RICH body, exactly as `send` takes one, and used INSTEAD of escaping the
            // text. It is what lets a message whose body is MARKUP be rewritten at all: a game
            // of chess keeps one player's whole record in one message and edits it on every
            // move (see web/src/lib/chess-wire.ts), and that record is a paragraph plus the
            // signed line the other machine reads back. Escaped as plain text it would come
            // back as characters rather than as that line, so the game would stop replaying —
            // the message would still be there and every reader would have lost the board.
            //
            // It is the same trust boundary the send already draws: a client supplies the body
            // of its own message either way, and this method is the same OUTWARD_METHODS entry
            // it was. What it does NOT gain is a mention (the list travels on a send, and an
            // agent's own edit builds its own), a title (read from the store, never a client's)
            // or a way past the seal — all three are below, unchanged.
            let content_html = params
                .get("content_html")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .map(|html| html.trim().to_string())
                .filter(|html| !html.is_empty());

            // Custom emoji: the edit path escapes the plain text — or takes the rich body as
            // it is — then runs the same substitution over it that a send does. So an emoji
            // survives an edit.
            let escaped = match content_html.as_deref() {
                Some(html) => html.to_string(),
                None => teams_send::escape_html(text.trim()),
            };
            let emoji_art = custom_emoji_art_in(&ctx, &escaped);

            // The TITLE the post already has, carried through the edit. Measured against
            // the tenant (2026-08-23, `examples/channel_subject_probe.rs`): an edit ASSIGNS
            // `properties`, so one that did not restate the subject deleted the line above
            // the body — for everybody in the thread, on a rewrite of one word. It comes
            // from THIS machine's own store rather than from the client, so an edit can
            // never retitle a post either.
            let subject = ctx
                .store()
                .ok()
                .and_then(|store| store.get_message(&conv, &message_id).ok().flatten())
                .map(|m| m.thread_subject)
                .filter(|s| !s.is_empty());

            // The key this conversation seals with. An edit is a whole new body, so it has to
            // be sealed exactly as the send was — and FAIL-CLOSED for the send's own reason: a
            // rewrite that quietly went out in the clear would publish, to everybody, the words
            // of a message the reader had sealed.
            let seal_key = ctx
                .store()
                .context("this chat may be sealed and the store cannot be read")?
                .current_seal_key(&conv)
                .context("read this chat's seal key")?;

            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let edit_conv = conv.clone();
            let edit_id = message_id.clone();
            let edit_text = text.clone();
            let final_html = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let conv = edit_conv.clone();
                    let message_id = edit_id.clone();
                    let text = edit_text.clone();
                    let emoji_art = emoji_art.clone();
                    let subject = subject.clone();
                    let seal_key = seal_key.clone();
                    let escaped = match content_html.as_deref() {
                        Some(html) => html.to_string(),
                        None => teams_send::escape_html(text.trim()),
                    };
                    async move {
                        let ic3 = tokens.get(IC3_SCOPE).await?;
                        let (rewritten_html, _emoji_ids) = if !emoji_art.is_empty() {
                            teams_send::resolve_custom_emoji(
                                &http,
                                &session,
                                &ic3,
                                &conv,
                                &escaped,
                                &emoji_art,
                            )
                            .await?
                        } else {
                            (escaped.clone(), Vec::new())
                        };
                        // A plain edit of the user's OWN message carries no mention: the
                        // RPC takes text, and a mention needs a span the text has no way to
                        // hold. The composer's mentions travel on the send.
                        // What it ANSWERS with is what it really posted — the sealed
                        // envelope in a sealed chat — and that is what the local row gets.
                        let posted = teams_send::edit_message(
                            &http,
                            &session,
                            &conv,
                            &message_id,
                            &text,
                            Some(&rewritten_html),
                            &[],
                            subject.as_deref(),
                            seal_key.as_ref(),
                        )
                        .await?;
                        Ok::<_, anyhow::Error>(posted)
                    }
                })
                .await?;

            let (self_name, self_mri) = {
                let session = ctx.session().await?;
                (session.self_name.to_string(), session.self_mri.to_string())
            };
            // Update the local row with the SAME body we sent — the rewritten html with the
            // emoji markup, and in a SEALED chat the envelope rather than the words. That is
            // what `edit_message` answers with, for exactly this reason: storing the plaintext
            // would leave this machine the only one in the thread that reads the message as
            // never having been sealed, so the padlock would go and `msg_reader` would have
            // nothing to open.
            if let Ok(store) = ctx.store() {
                if let Some(updated) = store.update_message_content(&conv, &message_id, &final_html)? {
                    ctx.emit("message", message_json(&updated, &self_name, &self_mri, Some(&store)));
                }
            }
            Ok(json!({ "edited": true }))
        }

        // delete one of our own messages. IRREVERSIBLE and outward: the message leaves
        // the thread for everybody, on every device, and no later call brings it back
        // (which is why the UI confirms before calling this).
        //
        // Teams keeps the message row and flags it, so we do the same locally rather
        // than dropping it: the row is marked deleted and re-broadcast, and the UI
        // paints the same "You deleted this message" placeholder an inbound deletion
        // produces — immediately, without waiting for the trouter echo.
        "delete" => {
            let conv = param_str(params, "conversation")?;
            let message_id = param_str(params, "message_id")?;

            let (self_name, self_mri) = {
                let session = ctx.session().await?;
                (session.self_name.to_string(), session.self_mri.to_string())
            };
            // Only the user's OWN message, and refused before the network. Teams
            // itself lets a team owner delete a colleague's channel post; this app
            // never offers that, so a request for one is a bug or a rogue client
            // rather than an intention to honour.
            let stored = ctx
                .store()
                .ok()
                .and_then(|store| store.get_message(&conv, &message_id).ok().flatten());
            anyhow::ensure!(
                may_delete(stored.as_ref(), &self_name, &self_mri),
                "refused: only your own message can be deleted"
            );

            let http = ctx.http.clone();
            let delete_conv = conv.clone();
            let delete_id = message_id.clone();
            ctx.retry_on_auth(move |session, _csa| {
                let http = http.clone();
                let conv = delete_conv.clone();
                let message_id = delete_id.clone();
                async move {
                    teams_send::delete_message(&http, &session, &conv, &message_id).await
                }
            })
            .await?;

            if let Ok(store) = ctx.store() {
                if let Some(updated) = store.mark_message_deleted(&conv, &message_id)? {
                    ctx.emit("message", message_json(&updated, &self_name, &self_mri, Some(&store)));
                }
            }
            Ok(json!({ "deleted": true }))
        }

        // react to a message with an emoji (Teams "emotion"), or toggle ours off.
        // `key` is the emotion the user picked (e.g. "like", "heart"). Teams keeps
        // one reaction per user per message, so we toggle: clicking our current
        // reaction removes it; any other key replaces it. After the network PUT we
        // optimistically update the local row and broadcast it (both clients merge
        // by id), so the reaction shows immediately without waiting for the echo.
        //
        // One of the user's OWN emoji arrives as `emoji` — the name in their pack —
        // rather than as a key, because a custom key names the AMS object the art was
        // uploaded to and that object does not exist until this handler has made it. So
        // the page never guesses a key: it names the emoji, and the key is minted here
        // from what the upload answered. `key` still carries an EXISTING custom
        // reaction verbatim, which is how one is toggled back off without a second
        // upload of the same picture.
        "react" => {
            let conv = param_str(params, "conversation")?;
            let message_id = param_str(params, "message_id")?;
            let picked_emoji = params
                .get("emoji")
                .and_then(|v| v.as_str())
                .filter(|name| !name.is_empty())
                .map(str::to_string);
            let key = match picked_emoji {
                Some(_) => String::new(),
                None => param_str(params, "key")?,
            };

            let (self_name, self_mri) = {
                let session = ctx.session().await?;
                (session.self_name.to_string(), session.self_mri.to_string())
            };

            // A custom emoji reaction uploads the art first, exactly as a send does, and
            // the key is the object's own URL. Picking from the pack is always an ADD:
            // the key names one upload, so it can never be the key already on the
            // message — removing is done from the chip, which hands its key back. Which is
            // why the toggle is read INSIDE the other branch: on this one it is a store read
            // whose answer nothing can use.
            let (reaction_key, on) = if let Some(name) = picked_emoji.as_deref() {
                let (_content_type, bytes) = ctx
                    .store()?
                    .custom_emoji_art(name)?
                    .with_context(|| format!("custom emoji not found: {name}"))?;
                let ic3 = ctx.tokens.get(IC3_SCOPE).await?;
                let http = ctx.http.clone();
                let conv_clone = conv.clone();
                let name_clone = name.to_string();
                let object_url = ctx
                    .retry_on_auth(move |session, _csa| {
                        let http = http.clone();
                        let conv = conv_clone.clone();
                        let name = name_clone.clone();
                        let bytes = bytes.clone();
                        let ic3 = ic3.clone();
                        async move {
                            teams_send::upload_ams_object_url(
                                &http, &session, &ic3, &conv, &name, &bytes,
                            )
                            .await
                        }
                    })
                    .await?;
                // The name travels beside the art: a reaction is how most custom emoji
                // reach a colleague, and without a name there is nothing for their pack
                // to hold it under (see `custom_reaction_key`).
                (custom_emoji::custom_reaction_key(&object_url, name), true)
            } else {
                // Decide the toggle from what we currently hold: same key -> off.
                let current_key = ctx
                    .store()
                    .ok()
                    .and_then(|store| store.get_message(&conv, &message_id).ok().flatten())
                    .and_then(|m| teams_lite::store::my_reaction_key(&m.reactions, &self_mri));
                (key.clone(), current_key.as_deref() != Some(key.as_str()))
            };

            let http = ctx.http.clone();
            let react_conv = conv.clone();
            let react_id = message_id.clone();
            let react_key = reaction_key.clone();
            ctx.retry_on_auth(move |session, _csa| {
                let http = http.clone();
                let conv = react_conv.clone();
                let message_id = react_id.clone();
                let key = react_key.clone();
                async move {
                    teams_send::set_reaction(&http, &session, &conv, &message_id, &key, on).await
                }
            })
            .await?;

            // Optimistic local update: reflect our own reaction now.
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if let Ok(store) = ctx.store() {
                let key_arg = if on { Some(reaction_key.as_str()) } else { None };
                if let Some(updated) =
                    store.set_my_reaction(&conv, &message_id, &self_mri, key_arg, now_ms)?
                {
                    ctx.emit("message", message_json(&updated, &self_name, &self_mri, Some(&store)));
                }
            }
            Ok(json!({ "reacted": on }))
        }

        // Mark a conversation or channel read — what a client calls when the user
        // opens an unread thread, so the marker actually clears instead of coming
        // back on every sync (Teams owns the unread flag; nothing here used to move
        // it). Two halves, in this order:
        //
        //   1. OUTWARD, unless Ghost mode is on: publish our own consumption horizon
        //      (see `teams_readstate::set_consumption_horizon`). Teams then reports the
        //      thread as read to every device the user owns, and shows the sender a
        //      read receipt. This is why the method is in OUTWARD_METHODS.
        //   2. LOCAL, always: move our own read position in the store, which is what
        //      clears the marker instantly — and what holds it clear in Ghost mode,
        //      where step 1 never runs and the CSA sync keeps saying "unread".
        //
        // The network write comes first: a failure must leave the thread unread rather
        // than claim a read state Teams does not have. Callers treat this as
        // best-effort (a failed mark is retried by the next open).
        "mark_read" => {
            let conv = param_str(params, "conversation")?;
            let ghost = {
                let store = ctx.store()?;
                ghost_mode(&store)?
            };

            if !ghost {
                let Some(message_id) = ctx.store()?.newest_message_id(&conv)? else {
                    // Nothing on screen means nothing to declare as read. Not an
                    // error: an empty thread has no unread marker either.
                    return Ok(json!({ "read": false, "ghost": false }));
                };
                let http = ctx.http.clone();
                let horizon_conv = conv.clone();
                let read_time_ms = now_ms();
                ctx.retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let conv = horizon_conv.clone();
                    let message_id = message_id.clone();
                    async move {
                        teams_readstate::set_consumption_horizon(
                            &http,
                            &session,
                            &conv,
                            &message_id,
                            read_time_ms,
                        )
                        .await
                    }
                })
                .await?;
            }

            // Emit the list events only on a real change, so a re-open of an
            // already-read thread does not spin the UI's refresh loop.
            let (moved, is_channel) = {
                let store = ctx.store()?;
                (store.mark_thread_read(&conv, ghost)?, store.is_channel(&conv).unwrap_or(false))
            };
            if moved {
                if is_channel {
                    ctx.emit("channels_changed", json!({}));
                } else {
                    ctx.emit("conversations_changed", json!({}));
                }
            }
            Ok(json!({ "read": true, "ghost": ghost }))
        }

        // Mute or unmute one chat IN TEAMS. The one chat setting this app publishes:
        // Teams keeps a mute as the conversation's `alerts` property, and a write of it
        // is reported back by the same CSA payload the sidebar is built from (see
        // src/teams_chat_settings.rs for the measurement, and for why the pin and the
        // hide stay local). OUTWARD, so it is gated like a send — the setting reaches
        // every client the user is signed in on.
        "set_chat_muted" => {
            let conv = param_str(params, "conversation")?;
            let muted = params.get("muted").and_then(Value::as_bool).unwrap_or(false);
            // A channel's notifications are a different setting with a different shape
            // (store::ChannelAlerts has four states, not two), so this refuses one
            // rather than writing a chat property to a thread that has none.
            if ctx.store()?.is_channel(&conv).unwrap_or(false) {
                anyhow::bail!("set_chat_muted: {conv} is a channel, not a chat");
            }
            let http = ctx.http.clone();
            let target = conv.clone();
            ctx.retry_on_auth(move |session, _csa| {
                let http = http.clone();
                let conv = target.clone();
                async move {
                    teams_lite::teams_chat_settings::set_chat_muted(&http, &session, &conv, muted)
                        .await
                }
            })
            .await?;
            // Teams took it, so reflect it now instead of waiting for the next sync —
            // which will overwrite this column with the value we just published.
            if ctx.store()?.set_conversation_muted(&conv, muted)? {
                ctx.emit("conversations_changed", json!({}));
            }
            Ok(json!({ "muted": muted }))
        }

        // Notifications panel — the three Teams activity streams, one per tab:
        // `48:notifications` (Activity: reactions / mentions / replies),
        // `48:mentions` (@Mentions), and `48:threads` (Following). None is a
        // chat: each is fetched fresh from Teams (which holds the server-side
        // read state), decoded into structured notifications, and returned keyed
        // by tab. No local cache — the feeds are small and refresh on
        // `notifications_changed`. The three fetches run concurrently.
        "notifications" => {
            let limit = params
                .get("limit")
                .and_then(Value::as_u64)
                .map(|n| n.clamp(1, 100) as u32)
                .unwrap_or(teams_activity::DEFAULT_NOTIFICATIONS_LIMIT);
            let http = ctx.http.clone();
            let (activity, mentions, following) = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    async move {
                        let fetch = |stream| teams_activity::fetch_activity_stream(&http, &session, stream, limit);
                        tokio::try_join!(
                            fetch(teams_activity::NOTIFICATIONS_THREAD),
                            fetch(teams_activity::MENTIONS_THREAD),
                            fetch(teams_activity::THREADS_THREAD),
                        )
                    }
                })
                .await?;
            // The actor's name comes live off the activity feed, so it never passed
            // through the store's own name resolution — apply the user's nicknames
            // here, or a renamed colleague would be the one place still showing their
            // directory name.
            let store = ctx.store().ok();
            let nick = |mri: &str| -> Option<String> {
                let mri = mri.trim();
                if mri.is_empty() {
                    return None;
                }
                store.as_ref()?.person_override(mri).ok().flatten().and_then(|o| {
                    Some(o.display_name).filter(|n| !n.is_empty())
                })
            };
            Ok(json!({
                "activity": feed_json(&activity, &nick),
                "mentions": feed_json(&mentions, &nick),
                "following": feed_json(&following, &nick),
            }))
        }

        // Read receipts ("seen by") for a conversation: every OTHER member's read
        // position, fetched from the dedicated `consumptionhorizons` thread
        // sub-resource. A pure READ — our own horizon is written by `mark_read` and
        // nowhere else. Best-effort: a thread with receipts disabled (tenant policy),
        // too many members (Teams stops tracking past ~20), or a transient failure
        // yields an empty list rather than an error, so the UI simply shows no
        // "seen by" avatars. Channels are skipped (they are large multi-party
        // threads that don't carry per-member receipts). The horizons refresh
        // live via the `read_receipt` event (see `spawn_realtime`).
        "read_receipts" => {
            let conv = param_str(params, "conversation")?;
            // The identity, never the session: the fetch below is already best-effort
            // (`unwrap_or_default`), so reading it through the session would be the one
            // thing in this handler that turns a sign-in outage into an error.
            let me = ctx.identity().await?;
            let (self_name, self_mri) = (me.name, me.mri);
            let is_channel = {
                let store = ctx.store()?;
                teams_read::is_channel_thread_id(&conv) || store.is_channel(&conv).unwrap_or(false)
            };
            if is_channel {
                return Ok(json!({ "receipts": [] }));
            }
            let http = ctx.http.clone();
            let conv_op = conv.clone();
            let horizons = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let conv = conv_op.clone();
                    async move {
                        teams_readstate::fetch_consumption_horizons(&http, &session, &conv).await
                    }
                })
                .await
                .unwrap_or_default();
            let store = ctx.store()?;
            Ok(read_receipts_json(&store, &conv, &horizons, &self_name, &self_mri))
        }

        // The people a message in this conversation can @mention, most relevant first.
        // A pure READ: the roster GET (src/teams_members.rs) and the short-profile
        // lookup that names it, both of which this app already does elsewhere.
        //
        // Two sources, because neither covers both thread kinds: the thread's roster
        // (complete for a chat, just us for a channel) and everybody who has written
        // in the conversation (the only source a channel has, and the one that carries
        // the names we already hold). Whoever is still nameless — a chat member who
        // never wrote — is resolved in one batch against the directory.
        //
        // Best-effort by contract: a roster Teams refuses, or a directory that answers
        // nothing, leaves a shorter list rather than an error, because a composer with
        // no suggestions still sends messages.
        "members" => {
            let conv = param_str(params, "conversation")?;
            let members: Vec<Value> = thread_mentionable_people(ctx, &conv)
                .await?
                .into_iter()
                .map(|person| json!({ "mri": person.mri, "name": person.name }))
                .collect();
            Ok(json!({ "members": members }))
        }

        // Read the non-secret view of the app settings: the configured GitLab host,
        // whether each integration's token is stored, and whether Ghost mode is on. A
        // raw token is NEVER returned — it is write-only from the UI's perspective,
        // matching the "no raw tokens are ever sent" rule.
        "get_settings" => {
            let store = ctx.store()?;
            settings_json(&store)
        }

        // Persist app settings (partial update). Only keys present in `params`
        // are written, so the UI can save the host without resending a token, save one
        // integration's token without touching the other's, and flip Ghost mode
        // without touching either. An explicit `""` clears that token. Returns the
        // same non-secret view as `get_settings` so the UI updates in one round-trip.
        "set_settings" => {
            let store = ctx.store()?;
            if let Some(host) = params.get("gitlab_host").and_then(Value::as_str) {
                store.set_setting(SETTING_GITLAB_HOST, host.trim())?;
            }
            for (param, key) in [
                ("gitlab_token", SETTING_GITLAB_TOKEN),
                ("linear_token", SETTING_LINEAR_TOKEN),
            ] {
                if let Some(token) = params.get(param).and_then(Value::as_str) {
                    store.set_setting(key, token.trim())?;
                }
            }
            // A new Linear key may name another workspace, so the one this machine cached
            // is forgotten rather than left to age out (see LINEAR_WORKSPACE_TTL). Left in
            // place, a reference would be addressed at the workspace of a key that is gone
            // for up to six hours.
            if params.get("linear_token").and_then(Value::as_str).is_some() {
                store.set_setting(SETTING_LINEAR_WORKSPACE, "")?;
            }
            // Ghost mode is stored as "1"/"0" so the settings table stays one
            // string-to-string map (see `ghost_mode`, which only trusts "1").
            if let Some(ghost) = params.get("ghost_mode").and_then(Value::as_bool) {
                store.set_setting(SETTING_GHOST_MODE, if ghost { "1" } else { "0" })?;
            }
            // Sender icons: the switch that decides whether this app ever requests
            // anything from a domain that mails the user (see `sender_icon`). Stored the
            // same way, and read by `sender_icons_enabled`, which trusts anything but
            // "0" — the feature is on unless it was turned off.
            if let Some(icons) = params.get("sender_icons").and_then(Value::as_bool) {
                store.set_setting(SETTING_SENDER_ICONS, if icons { "1" } else { "0" })?;
            }
            // Auto-import: whether a colleague's custom emoji joins the pack as its
            // message arrives. Stored and read the same way — on unless turned off.
            if let Some(auto) = params.get("emoji_auto_import").and_then(Value::as_bool) {
                store.set_setting(SETTING_EMOJI_AUTO_IMPORT, if auto { "1" } else { "0" })?;
            }
            // Whether a notification about a SEALED chat carries the words. OFF unless turned on,
            // which is the reverse of the two above — see `SETTING_SEALED_PUSH_WORDS`.
            if let Some(words) = params.get("sealed_push_words").and_then(Value::as_bool) {
                store.set_setting(SETTING_SEALED_PUSH_WORDS, if words { "1" } else { "0" })?;
            }
            settings_json(&store)
        }

        // Turn "Always available" on or off (see SETTING_ALWAYS_AVAILABLE).
        //
        // OUTWARD in both directions, and its own method rather than a key of
        // `set_settings`, for two reasons: it talks to the presence service instead of
        // writing a row, and it changes what every colleague sees. As an
        // OUTWARD_METHODS entry it needs the write token and a read-only backend
        // refuses it outright.
        //
        // The network write comes first and the setting is stored only once it
        // succeeded, so a switch that reads "on" always means Teams was actually told.
        // Turning it ON registers the endpoint immediately (the heartbeat then keeps
        // it alive); turning it OFF removes the registration, and the user's status
        // goes back to whatever Teams computes on its own.
        //
        // The call also carries the HOURS (`from`/`to`, both or neither — see
        // {@link available_hours_param}), and what it publishes is what the schedule says
        // about THIS minute rather than the switch alone: turning the setting on at 03:00
        // with 08:00-19:00 set withdraws instead of registering, because that is the state
        // the user just asked for. The heartbeat then registers when the morning comes.
        "set_always_available" => {
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .context("`enabled` must be true or false")?;
            let hours = available_hours_param(params)?;
            let zone = available_zone_param(params)?;
            let minute = teams_presence::minute_of_day(chrono::Utc::now(), zone);
            let publish = teams_presence::should_publish(enabled, hours, minute);
            publish_presence(&ctx, publish).await?;
            let store = ctx.store()?;
            store.set_setting(
                SETTING_AVAILABLE_HOURS,
                &hours.map(|window| window.as_setting()).unwrap_or_default(),
            )?;
            store.set_setting(
                SETTING_AVAILABLE_ZONE,
                zone.map(|zone| zone.name()).unwrap_or_default(),
            )?;
            store.set_setting(SETTING_ALWAYS_AVAILABLE, if enabled { "1" } else { "0" })?;
            settings_json(&store)
        }

        // ---- audio calling ------------------------------------------------
        // Six methods, and the split between them IS the consent design:
        //   `call_status`  reads state, and is the only open one.
        //   `call_prepare` reserves the one call and hands out the media credentials.
        //   `call_place` / `call_accept` / `call_hangup` / `call_mute` reach a person.
        // There is no method that turns calling on: this backend registers as a device
        // the user's calls ring on the way every client they signed in on does (see
        // {@link calling_available}), and what reaches a person is `call_place`.
        // See `teams_lite::calling` and NATIVE-CALLING.md.

        // What this machine can do about calls, and what call it is in. Open, because
        // it returns no SDP and no credentials — only what the UI has to draw.
        "call_status" => Ok(ctx.call_state_payload()),

        // Everything the page needs to build one `RTCPeerConnection`, and the
        // reservation of the single call this machine holds.
        //
        // Two shapes, one per direction: `conversation` starts an outgoing call (and
        // returns nothing to answer yet), `call_id` prepares to answer the call that
        // is ringing (and returns the caller's own offer). The ICE servers are why
        // this is gated: they carry the relay credentials this backend holds.
        "call_prepare" => {
            // A meeting: reserve the call against the address the caller named — the link
            // the calendar holds, or the meeting's own thread from the chat list. Its own
            // shape rather than a flag, because what comes back differs — a join has no
            // offer to answer, and no person to name.
            if let Some(meeting) = meeting_address(params)? {
                let (session, endpoint_id, surl) = {
                    let (endpoint_id, surl) = {
                        let plane = ctx.calling.lock().unwrap();
                        let channel = plane.channel.as_ref().filter(|_| plane.connected).context(
                            "call_prepare: calling is not connected yet — turn it on in \
                             Settings, then try again",
                        )?;
                        (channel.endpoint_id.clone(), channel.surl.clone())
                    };
                    (ctx.session().await?, endpoint_id, surl)
                };
                // The meeting's title. From the calendar it is passed by whoever clicked
                // Join, because that is the only place it exists: a join link carries no
                // subject, and the caller is holding the event it came from. From the CHAT
                // LIST the thread has a name of its own, so the store answers and no title
                // is minted twice — which is also what makes two open pages agree.
                let subject = params
                    .get("subject")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        let thread = meeting.thread_id.as_deref()?;
                        let title = ctx.store().ok()?.conversation_context(thread, "").ok()?;
                        Some(title).filter(|title| !title.trim().is_empty())
                    })
                    .unwrap_or_else(|| "Meeting".to_string());
                let call_id = uuid::Uuid::new_v4().to_string();
                let call = CallSession {
                    id: call_id.clone(),
                    direction: CallDirection::Outgoing,
                    kind: CallKind::Meeting,
                    // Joining, not ringing: nobody has to pick up.
                    phase: CallPhase::Connecting,
                    // A short link names no thread; the service resolves it from the
                    // meeting code, and the conversation this call belongs to is then
                    // whatever the service says rather than something we guessed.
                    conversation_id: meeting.thread_id.clone(),
                    peer_mri: String::new(),
                    peer_name: subject,
                    // A join rings nobody.
                    ring: Vec::new(),
                    roster: Vec::new(),
                    in_lobby: false,
                    links: calling::Links::default(),
                    local: ctx.local_participant(&session, &endpoint_id),
                    callbacks: calling::CallbackBase {
                        surl,
                        session_id: uuid::Uuid::new_v4().to_string(),
                        cause_id: short_cause_id(),
                    },
                    offer: None,
                    muted: false,
                    connected_at_ms: None,
                    end_reason: None,
            unreachable: false,
                    renegotiation_answer_link: None,
                    source_request_sequence: 0,
                    sending: Vec::new(),
                    sharing: None,
                };
                {
                    let mut plane = ctx.calling.lock().unwrap();
                    if plane.call.as_ref().is_some_and(|c| c.phase != CallPhase::Ended) {
                        anyhow::bail!(
                            "call_prepare: this machine is already in a call — leave it first"
                        );
                    }
                    plane.call = Some(call);
                }
                ctx.emit_call_state();
                return Ok(json!({
                    "call_id": call_id,
                    "ice_servers": ctx.call_ice_servers().await,
                }));
            }
            let ringing_id = params.get("call_id").and_then(Value::as_str);
            match ringing_id {
                // Answering: hand back the offer that is already ringing.
                Some(call_id) => {
                    let offer = {
                        let plane = ctx.calling.lock().unwrap();
                        let call = plane
                            .call
                            .as_ref()
                            .filter(|c| c.id == call_id && c.phase == CallPhase::Ringing)
                            .context("call_prepare: that call is not ringing")?;
                        call.offer.clone().context("call_prepare: that call carried no offer")?
                    };
                    Ok(json!({
                        "call_id": call_id,
                        "offer_sdp": offer.blob,
                        "ice_servers": ctx.call_ice_servers().await,
                    }))
                }
                // Placing: reserve the call and resolve who to ring.
                None => {
                    let conversation = param_str(params, "conversation")?;
                    let (session, endpoint_id) = {
                        let endpoint_id = ctx
                            .calling
                            .lock()
                            .unwrap()
                            .channel
                            .as_ref()
                            .map(|c| c.endpoint_id.clone())
                            .context(
                                "call_prepare: calling is not connected yet — turn it on in \
                                 Settings, then try again",
                            )?;
                        (ctx.session().await?, endpoint_id)
                    };
                    // Who to ring: the roster, minus us. One person is a one-to-one call;
                    // several is a GROUP call, which rings every one of them at once and
                    // is the same POST (`calling::invitation_payload`). What a group needs
                    // beyond that already exists: the service mixes the voices, the page
                    // keeps one `<audio>` per remote stream, and "who is in it" is the
                    // roster a meeting already answers from.
                    let http = ctx.http.clone();
                    let target = conversation.clone();
                    let roster = ctx
                        .retry_on_auth(move |session, _csa| {
                            let http = http.clone();
                            let conversation = target.clone();
                            async move {
                                teams_members::fetch_thread_members(&http, &session, &conversation)
                                    .await
                            }
                        })
                        .await
                        .unwrap_or_default();
                    let ring: Vec<String> = roster
                        .iter()
                        .map(|p| p.mri.clone())
                        .filter(|mri| mri != &session.self_mri && mri.starts_with("8:"))
                        .collect();
                    if ring.is_empty() {
                        anyhow::bail!(
                            "call_prepare: nobody to ring in {conversation} — a call needs at \
                             least one other person in the conversation"
                        );
                    }
                    if ring.len() > MAX_GROUP_CALL_PEOPLE {
                        anyhow::bail!(
                            "call_prepare: {conversation} has {} other people — this app rings \
                             at most {MAX_GROUP_CALL_PEOPLE} at once",
                            ring.len()
                        );
                    }
                    let kind =
                        if ring.len() == 1 { CallKind::Call } else { CallKind::Group };
                    // A 1:1 call names the person; a group names the CONVERSATION, because
                    // five people have no one name and the roster is what answers "who".
                    let peer_mri =
                        if kind == CallKind::Call { ring[0].clone() } else { String::new() };
                    // The store first, because it is where the user's own nickname for
                    // that person lives (see `person_overrides`): a call has to name
                    // them the way every other surface does.
                    let peer_name = if kind == CallKind::Call {
                        ctx.store()?
                            .display_name_for_mri(&peer_mri)?
                            .into_iter()
                            .chain(
                                roster
                                    .iter()
                                    .find(|p| p.mri == peer_mri)
                                    .map(|p| p.display_name.clone()),
                            )
                            .find(|name| !name.trim().is_empty())
                            .unwrap_or_default()
                    } else {
                        let title = ctx.store()?.conversation_context(&conversation, "")?;
                        if title.trim().is_empty() { "Group call".to_string() } else { title }
                    };
                    let surl = ctx
                        .calling
                        .lock()
                        .unwrap()
                        .channel
                        .as_ref()
                        .map(|c| c.surl.clone())
                        .context("call_prepare: the calling connection went away")?;

                    let call_id = uuid::Uuid::new_v4().to_string();
                    let call = CallSession {
                        id: call_id.clone(),
                        direction: CallDirection::Outgoing,
                        kind,
                        phase: CallPhase::Dialing,
                        conversation_id: Some(conversation.clone()),
                        peer_mri,
                        peer_name,
                        ring,
                        links: calling::Links::default(),
                        local: ctx.local_participant(&session, &endpoint_id),
                        callbacks: calling::CallbackBase {
                            surl,
                            session_id: uuid::Uuid::new_v4().to_string(),
                            cause_id: short_cause_id(),
                        },
                        offer: None,
                        roster: Vec::new(),
                        in_lobby: false,
                        muted: false,
                        connected_at_ms: None,
                        end_reason: None,
            unreachable: false,
                        renegotiation_answer_link: None,
                        source_request_sequence: 0,
                        sending: Vec::new(),
                        sharing: None,
                    };
                    {
                        let mut plane = ctx.calling.lock().unwrap();
                        if plane.call.as_ref().is_some_and(|c| c.phase != CallPhase::Ended) {
                            anyhow::bail!(
                                "call_prepare: this machine is already in a call — hang up first"
                            );
                        }
                        plane.call = Some(call);
                    }
                    // The UI shows "calling…" from here, before the offer exists: the
                    // microphone prompt happens next and the user must see why.
                    ctx.emit_call_state();
                    Ok(json!({
                        "call_id": call_id,
                        "ice_servers": ctx.call_ice_servers().await,
                        // Whether this call is between exactly TWO people, which decides how
                        // the page negotiates a camera and a screen: the real client reserves
                        // both sections in the first offer of a one-to-one and adds them
                        // mid-call in a conference (NATIVE-CALLING.md § 10.8). The kind is
                        // decided here — the ring list is what says how many people it
                        // reaches — so the page is told rather than guessing from an id.
                        "one_to_one": kind == CallKind::Call,
                    }))
                }
            }
        }

        // Place the call: ONE POST carrying our offer (NATIVE-CALLING.md § 2.3).
        //
        // This is the method that makes a device buzz in somebody's pocket, so it
        // carries out exactly one click and nothing else. A failure ends the
        // reservation rather than leaving the UI on "calling…" forever.
        "call_place" => {
            let call_id = param_str(params, "call_id")?;
            let sdp = param_str(params, "sdp")?;
            let (local, callbacks, to, thread) = {
                let plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_ref()
                    .filter(|c| c.id == call_id)
                    .context("call_place: no such call — call_prepare first")?;
                (
                    call.local.clone(),
                    call.callbacks.clone(),
                    call.ring.clone(),
                    call.conversation_id.clone(),
                )
            };
            if to.is_empty() {
                anyhow::bail!("call_place: that call rings nobody — call_prepare first");
            }
            let session = ctx.session().await?;
            let ic3 = ctx.tokens.get(IC3_SCOPE).await?;
            let placed = calling::place_call(
                &ctx.http,
                &session,
                &ic3,
                &local,
                &to,
                thread.as_deref(),
                &calling::MediaContent::sdp(sdp),
                &callbacks,
                &call_id,
            )
            .await;
            match placed {
                Ok(placed) => {
                    let held = {
                        let mut plane = ctx.calling.lock().unwrap();
                        match plane.call.as_mut().filter(|c| c.id == call_id && !c.ended()) {
                            Some(call) => {
                                call.links.merge(&placed.links);
                                true
                            }
                            None => false,
                        }
                    };
                    if !held {
                        // The user hung up while this POST was in flight, so the invite is
                        // out and the reservation is gone: a device is buzzing for a call
                        // nothing here holds, and the answer's own links are the only way
                        // to take it back.
                        ctx.hang_up_orphan("call_place", &local, &placed.links).await;
                        return Ok(json!({ "call_id": call_id, "cancelled": true }));
                    }
                    ctx.emit_call_state();
                    Ok(json!({ "call_id": call_id, "links": placed.links.names() }))
                }
                Err(e) => {
                    ctx.end_call_locally("CallEndReasonPlaceFailed").await;
                    Err(e)
                }
            }
        }

        // Join a meeting: ONE POST, and it carries the microphone
        // (NATIVE-CALLING.md § 2.3a). The answer names every link the meeting offers —
        // leave, mute, admit — and whether we are in its lobby.
        //
        // Outward, like placing a call: everybody already in the meeting sees the user
        // arrive, and their microphone is opened to all of them. A join rings nobody,
        // which is the only difference in what it does to other people.
        "call_join" => {
            let call_id = param_str(params, "call_id")?;
            let sdp = param_str(params, "sdp")?;
            // The same address the reservation named, in either shape (see
            // `meeting_address`): a calendar link, or the meeting's own chat thread.
            let meeting = meeting_address(params)
                .context("call_join")?
                .context("call_join: no meeting named — pass join_url or meeting_thread")?;
            let (local, callbacks) = {
                let plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_ref()
                    .filter(|c| c.id == call_id && c.kind == CallKind::Meeting)
                    .context("call_join: no such meeting — call_prepare first")?;
                (call.local.clone(), call.callbacks.clone())
            };
            let session = ctx.session().await?;
            let ic3 = ctx.tokens.get(IC3_SCOPE).await?;

            let joined = match calling::join_meeting(
                &ctx.http,
                &session,
                &ic3,
                &local,
                &meeting,
                &callbacks,
                &call_id,
                Some(&calling::MediaContent::sdp(sdp)),
            )
            .await
            {
                Ok(joined) => joined,
                Err(e) => {
                    ctx.end_call_locally("CallEndReasonJoinFailed").await;
                    return Err(e);
                }
            };
            // The meeting is joined. Its links are held before anything else, so an
            // ending always has somewhere to post — and the lobby is a state of its own,
            // because the one thing the user has to know is that nobody has let them in.
            let held = {
                let mut plane = ctx.calling.lock().unwrap();
                match plane.call.as_mut().filter(|c| c.id == call_id && !c.ended()) {
                    Some(call) => {
                        call.links.merge(&joined.links);
                        if calling::lobby_state_in_frame(&joined.raw)
                            == Some(calling::LobbyState::Waiting)
                        {
                            call.in_lobby = true;
                        }
                        true
                    }
                    None => false,
                }
            };
            if !held {
                // The user left while this POST was in flight, so the meeting holds a
                // participant this machine no longer has: leave it, on the links the answer
                // carried (see `call_place`).
                ctx.hang_up_orphan("call_join", &local, &joined.links).await;
                return Ok(json!({ "call_id": call_id, "cancelled": true }));
            }
            ctx.emit_call_state();
            // What the answer granted. `activeModalities.call` is the audio leg, and it
            // is normally ABSENT here: the leg is created after the answer, and the
            // `conversationUpdate` frames that follow a second later do carry it
            // (measured). So this line is a record of the answer, not a verdict on the
            // media — that is `getStats` in the browser, which `bun run join-live`
            // reports.
            eprintln!(
                "[calling] joined the meeting: audio_leg_in_answer={} lobby={} links={}",
                joined.raw.pointer("/activeModalities/call").is_some_and(|c| !c.is_null()),
                calling::lobby_state_in_frame(&joined.raw) == Some(calling::LobbyState::Waiting),
                joined.links.names().len()
            );
            Ok(json!({ "call_id": call_id, "links": joined.links.names() }))
        }

        // Answer the ringing call with our own SDP.
        //
        // One POST where the service gave us an `accept` link — the acceptance
        // carries the answer, which is what the web client does — and a plain
        // `mediaAnswer` where it did not.
        "call_accept" => {
            let call_id = param_str(params, "call_id")?;
            let sdp = param_str(params, "sdp")?;
            let (local, callbacks, accept, media_answer) = {
                let plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_ref()
                    .filter(|c| c.id == call_id)
                    .context("call_accept: no such call")?;
                (
                    call.local.clone(),
                    call.callbacks.clone(),
                    call.links.accept().map(str::to_string),
                    call.links.media_answer().map(str::to_string),
                )
            };
            let answer = calling::MediaContent::sdp(sdp);
            let (url, payload) = match (accept, media_answer) {
                (Some(url), _) => (url, calling::acceptance_payload(&local, &answer, &callbacks)),
                (None, Some(url)) => {
                    (url, calling::media_answer_payload(&local, &answer, &callbacks, &[calling::MODALITY_AUDIO]))
                }
                (None, None) => {
                    ctx.end_call_locally("CallEndReasonNoAcceptLink").await;
                    anyhow::bail!("call_accept: the invite carried no link to answer on")
                }
            };
            match ctx.post_call_signal(&url, &payload).await {
                Ok(response) => {
                    let links = calling::Links::collect(&response);
                    let held = {
                        let mut plane = ctx.calling.lock().unwrap();
                        match plane.call.as_mut().filter(|c| c.id == call_id && !c.ended()) {
                            Some(call) => {
                                call.links.merge(&links);
                                call.phase = CallPhase::Connected;
                                call.connected_at_ms = Some(now_ms());
                                true
                            }
                            None => false,
                        }
                    };
                    if !held {
                        // The user hung up while the acceptance was in flight, so the caller
                        // is now in a call with a machine that holds nothing: end it on the
                        // links the acceptance answered with (see `call_place`).
                        ctx.hang_up_orphan("call_accept", &local, &links).await;
                        return Ok(json!({ "call_id": call_id, "cancelled": true }));
                    }
                    ctx.emit_call_state();
                    Ok(json!({ "call_id": call_id }))
                }
                Err(e) => {
                    ctx.end_call_locally("CallEndReasonAcceptFailed").await;
                    Err(e)
                }
            }
        }

        // Answer a media offer the service made mid-call.
        //
        // This is the other half of `media_renegotiation_from_frame`: the service offers the
        // sections it is willing to send — a colleague's shared screen, a camera — and this
        // is where the page's answer to that offer goes back. Two things about it:
        //
        // * the link is the OFFER'S OWN, taken off the frame that carried it and cleared
        //   here, because a negotiation is answered once and an older link answers nothing;
        // * `modalities` is what the page says the answer really carries. It is checked
        //   against a small list rather than passed through, so a client cannot declare the
        //   user's camera on a body that does not offer it.
        "call_answer_media" => {
            let call_id = param_str(params, "call_id")?;
            let sdp = param_str(params, "sdp")?;
            let modalities = param_modalities(params)?;
            let (local, callbacks, url) = {
                let mut plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_mut()
                    .filter(|c| c.id == call_id && c.phase != CallPhase::Ended)
                    .context("call_answer_media: no such call")?;
                let url = call
                    .renegotiation_answer_link
                    .take()
                    .context("call_answer_media: no media offer is waiting for an answer")?;
                (call.local.clone(), call.callbacks.clone(), url)
            };
            let answer = calling::MediaContent::sdp(sdp);
            let names: Vec<&str> = modalities.iter().map(String::as_str).collect();
            let payload = calling::media_answer_payload(&local, &answer, &callbacks, &names);
            let response = ctx.post_call_signal(&url, &payload).await?;
            {
                let links = calling::Links::collect(&response);
                let mut plane = ctx.calling.lock().unwrap();
                if let Some(call) = plane.call.as_mut().filter(|c| c.id == call_id) {
                    call.links.merge(&links);
                }
            }
            eprintln!("[calling] answered a media renegotiation: modalities={modalities:?}");
            // The whole structure of what was posted. The service refuses an answer with
            // `SdpParsingFailure` and names no line, so this is the only way to see which one
            // it means. Keys, candidates and SSRCs are dropped (`calling::sdp_structure`).
            if std::env::var("TEAMS_LITE_SDP_DEBUG").is_ok() {
                for line in calling::sdp_structure(&answer.blob) {
                    eprintln!("[sdp] {line}");
                }
            }
            Ok(json!({ "call_id": call_id }))
        }

        // Become the PRESENTER of the meeting's content-sharing session.
        //
        // A meeting shows one screen at a time, so a share is a session before it is a track:
        // measured on 2026-08-06, a meeting rejected an `applicationsharing-video` section
        // outright — no mid, no label, a zeroed port — from an endpoint that had not asked for
        // one. The client asks first (`startContentSharingAsync`), POSTing a `contentSharing`
        // blob to the `addModality` link, and only then offers the section.
        //
        // "One at a time" is a rule about the MEETING, never a reason to refuse the user: the
        // session changes hands, and the service takes the old share down (see below).
        //
        // It is an `OUTWARD_METHODS` entry because it announces to everybody in the meeting
        // that this endpoint is about to show them something, and because the section that
        // follows carries whatever is on the user's screen.
        "call_start_sharing" => {
            let call_id = param_str(params, "call_id")?;
            let (local, callbacks, url, correlation_id, displacing) = {
                let plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_ref()
                    .filter(|c| c.id == call_id && !c.ended())
                    .context("call_start_sharing: no such call")?;
                if call.phase != CallPhase::Connected {
                    anyhow::bail!(
                        "call_start_sharing: this call is not connected yet — a modality is \
                         added to a live conversation"
                    );
                }
                if call.sharing.is_some() {
                    anyhow::bail!("call_start_sharing: this call already holds a sharing session");
                }
                // A share TAKES the role off whoever holds it, and that is the feature rather
                // than an accident. Measured 2026-08-06 against a colleague's real share: the
                // service granted the role — `role = "presenter"` in our own roster entry — and
                // then offered their `applicationsharing-video` section at PORT 0, so their
                // screen stopped arriving. That IS what "a meeting shows one screen at a time"
                // means, and it is what real Teams does when somebody presses Share while a
                // colleague presents: the new share displaces the old one, and no client asks
                // first. This handler used to REFUSE while anybody else was sharing, which cost
                // the user the one action they came for in the very state they wanted it in.
                //
                // Whether it takes one is only READ, for the journal: the service does the
                // displacing, and nothing here posts at a colleague's session.
                let displacing = call.roster.iter().any(|member| {
                    member.streams.iter().any(calling::RosterStream::is_shared_screen)
                });
                let url = call.links.add_modality().map(str::to_string).context(
                    "call_start_sharing: this call has no addModality link — the service names \
                     it on the conversation",
                )?;
                (
                    call.local.clone(),
                    call.callbacks.clone(),
                    url,
                    uuid::Uuid::new_v4().to_string(),
                    displacing,
                )
            };
            if displacing {
                // One line, and no name in it: a colleague's name is theirs, and what this
                // record is for is that a share of theirs stopped because of a press here.
                eprintln!(
                    "[calling] asking for the sharing session while somebody else presents — \
                     the service takes their share down, as it does for every Teams client"
                );
            }
            let payload = calling::content_sharing_payload(&local, &callbacks, &correlation_id);
            // The reservation goes in FIRST, so the frame that grants the session has somewhere
            // to land: it can arrive before this POST has even answered.
            {
                let mut plane = ctx.calling.lock().unwrap();
                if let Some(call) = plane.call.as_mut().filter(|c| c.id == call_id) {
                    call.sharing = Some(calling::ContentSharing {
                        correlation_id: correlation_id.clone(),
                        session_id: None,
                        leave: None,
                    });
                }
            }
            let response = ctx.post_call_signal(&url, &payload).await?;
            // The answer carries `{}` — measured — so the session is not in it. It is read off
            // the `addModalitySuccess` FRAME, and this WAITS for that frame: the client's own
            // `start` returns a deferred the frame resolves, and a section offered before the
            // service has registered the presenter is a section it rejects.
            let granted = ctx.await_sharing_session(&call_id).await;
            if !granted {
                eprintln!(
                    "[calling] the meeting never granted the sharing session — answer links={:?}",
                    calling::Links::collect(&response).names()
                );
            }
            Ok(json!({ "call_id": call_id, "can_stop": granted }))
        }

        // Give the sharing session back.
        //
        // Outward for the same reason as the start, and gated the same way: the meeting is
        // told this endpoint has stopped presenting. It is deliberately forgiving — a session
        // the service never named a way out of is dropped locally rather than kept for ever,
        // because the alternative is a call that can never share again.
        "call_stop_sharing" => {
            let call_id = param_str(params, "call_id")?;
            let held = {
                let mut plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_mut()
                    .filter(|c| c.id == call_id)
                    .context("call_stop_sharing: no such call")?;
                let held = call.sharing.take();
                (held, call.local.clone(), call.callbacks.clone())
            };
            let (session, local, callbacks) = held;
            let Some(session) = session else {
                return Ok(json!({ "call_id": call_id, "told_service": false }));
            };
            let told = match &session.leave {
                Some(url) => {
                    let payload = calling::content_sharing_leave_payload(&local, &callbacks);
                    match ctx.post_call_signal(url, &payload).await {
                        Ok(_) => true,
                        Err(e) => {
                            eprintln!("[calling] the sharing session would not close: {e:#}");
                            false
                        }
                    }
                }
                None => false,
            };
            eprintln!("[calling] gave the sharing session up: told_service={told}");
            Ok(json!({ "call_id": call_id, "told_service": told }))
        }

        // OFFER new media on a call that is already up: the user's camera, or their screen.
        //
        // The call was negotiated with audio alone, so either one is a section that does not
        // exist yet — which the service only accepts on an ESTABLISHED call, in its own words:
        // "media renegotiation can only be performed on an established call". The link is the
        // `mediaRenegotiation` one it handed us on the acceptance.
        //
        // `sending` is what the page says it is turning on, and it is recorded here so
        // `call_state` can say so to every client: a second page must not draw a camera
        // button as off while this machine is sending.
        "call_offer_media" => {
            let call_id = param_str(params, "call_id")?;
            let sdp = param_str(params, "sdp")?;
            let modalities = param_modalities(params)?;
            let sending = param_str_list(params, "sending");
            let (local, callbacks, url) = {
                let plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_ref()
                    .filter(|c| c.id == call_id)
                    .context("call_offer_media: no such call")?;
                if call.phase != CallPhase::Connected {
                    anyhow::bail!(
                        "call_offer_media: this call is not connected yet — the service \
                         refuses new media on a call that is not established"
                    );
                }
                let url = call
                    .links
                    .media_renegotiation()
                    .map(str::to_string)
                    .context(
                        "call_offer_media: this call has no renegotiation link — the service \
                         names it on the acceptance",
                    )?;
                (call.local.clone(), call.callbacks.clone(), url)
            };
            let offer = calling::MediaContent::sdp(sdp);
            let names: Vec<&str> = modalities.iter().map(String::as_str).collect();
            let payload = calling::media_offer_payload(&local, &offer, &callbacks, &names);
            let response = ctx.post_call_signal(&url, &payload).await?;
            {
                let links = calling::Links::collect(&response);
                let mut plane = ctx.calling.lock().unwrap();
                if let Some(call) = plane.call.as_mut().filter(|c| c.id == call_id) {
                    call.links.merge(&links);
                    call.sending = sending.clone();
                }
            }
            ctx.emit_call_state();
            eprintln!(
                "[calling] offered media: modalities={modalities:?} sending={sending:?} \
                 sections={}",
                calling::media_sections(&offer.blob).join(" | ")
            );
            // The ANSWER may be in this response or arrive on our `mediaAnswer` callback —
            // the service has done both for other negotiations. Handing back whichever is
            // here lets the page apply it without waiting for a frame that may not come.
            let answer = calling::media_answer_from_frame(&response).map(|m| m.blob);
            // The answer that came WITH the response, stated the same way as the one that
            // arrives on a frame: which sections the service took and which it refused. A
            // rejected one is the difference between a screen the meeting shows and a
            // capture the page has to release, and it was invisible here.
            if let Some(answer) = &answer {
                eprintln!(
                    "[calling] the offer was answered at once: {}",
                    calling::media_sections(answer).join(" | ")
                );
            }
            Ok(json!({ "call_id": call_id, "answer_sdp": answer }))
        }

        // Ask the meeting's media server to put somebody's stream on one of our sections.
        //
        // It publishes NOTHING about the user — it is a request to receive — which is why it
        // is a `MACHINE_METHODS` entry rather than an outward one. The two links it may go
        // to both arrive on the `callAcceptance` frame, and the newer one is preferred
        // because that is what the client's own configuration does on this tenant.
        "call_subscribe" => {
            let call_id = param_str(params, "call_id")?;
            let mid = param_str(params, "mid")?;
            let source_id = params
                .get("source_id")
                .and_then(Value::as_i64)
                .context("call_subscribe: source_id is required")?;
            let stream_msid = param_str(params, "stream_msid")?;
            let fmt_params = params
                .get("fmt_params")
                .and_then(Value::as_str)
                .unwrap_or(calling::DEFAULT_VIDEO_FMTP)
                .to_string();
            let (url, modern, sequence) = {
                let mut plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_mut()
                    .filter(|c| c.id == call_id && c.phase != CallPhase::Ended)
                    .context("call_subscribe: no such call")?;
                call.source_request_sequence += 1;
                let sequence = call.source_request_sequence;
                // The newer link first. Neither is in the join answer — both arrive on the
                // acceptance — so a call that has not been accepted yet has nothing to ask.
                match (
                    call.links.apply_channel_parameters().map(str::to_string),
                    call.links.control_video_streaming().map(str::to_string),
                ) {
                    (Some(url), _) => (url, true, sequence),
                    (None, Some(url)) => (url, false, sequence),
                    (None, None) => anyhow::bail!(
                        "call_subscribe: this call has no link to subscribe on — the service \
                         names them on the acceptance, so there is nothing to ask yet"
                    ),
                }
            };
            let request =
                calling::SourceRequest { mid, source_id, stream_msid, fmt_params };
            let payload = calling::source_request_payload(&request, sequence, modern);
            ctx.post_call_signal(&url, &payload).await?;
            // What was ASKED for. The service sends a meeting's video only to a client that
            // asks, so a subscription that never goes out is a tile that never fills — and it
            // left no trace on this machine at all.
            eprintln!(
                "[calling] subscribed: source={} on mid={} seq={} (modern={modern})",
                request.source_id, request.mid, sequence
            );
            Ok(json!({ "call_id": call_id, "source_id": source_id }))
        }

        // End the call — or decline it, when it is still ringing.
        //
        // Both are one method because they are one intention ("I am not on this
        // call") and because the UI shows one button. Which payload goes out depends
        // on the phase: a caller who is declined is told so, and a call that was up
        // ends for both sides.
        "call_hangup" => {
            let call_id = param_str(params, "call_id")?;
            let (local, url, declining) = {
                let plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_ref()
                    .filter(|c| c.id == call_id)
                    .context("call_hangup: no such call")?;
                let declining =
                    call.direction == CallDirection::Incoming && call.phase == CallPhase::Ringing;
                let url = if declining {
                    call.links.reject().or_else(|| call.links.hangup())
                } else {
                    call.links.hangup()
                };
                (call.local.clone(), url.map(str::to_string), declining)
            };
            // Tell the other side first, then drop it locally: the local drop is what
            // stops the microphone, and it must happen even if the POST fails.
            let told = match url {
                Some(url) => {
                    let payload = if declining {
                        calling::rejection_payload(&local)
                    } else {
                        calling::hangup_payload(&local)
                    };
                    match ctx.post_call_signal(&url, &payload).await {
                        Ok(_) => true,
                        Err(e) => {
                            eprintln!("[calling] the hangup did not reach the service: {e:#}");
                            false
                        }
                    }
                }
                None => {
                    eprintln!("[calling] no link to hang up on — dropping the call locally");
                    false
                }
            };
            ctx.end_call_locally(if declining {
                "CallEndReasonDeclined"
            } else {
                "CallEndReasonHangup"
            })
            .await;
            Ok(json!({ "call_id": call_id, "told_service": told }))
        }

        // Publish whether the user can be heard.
        //
        // The page has already stopped sending audio; this is the half everybody else
        // in the call sees. It is outward for that reason: it states something about
        // the user to the person they are talking to.
        "call_mute" => {
            let call_id = param_str(params, "call_id")?;
            let muted = params
                .get("muted")
                .and_then(Value::as_bool)
                .context("`muted` must be true or false")?;
            let (local, url) = {
                let plane = ctx.calling.lock().unwrap();
                let call = plane
                    .call
                    .as_ref()
                    .filter(|c| c.id == call_id)
                    .context("call_mute: no such call")?;
                let url = if muted { call.links.mute() } else { call.links.unmute() };
                (call.local.clone(), url.map(str::to_string))
            };
            // The local state moves whatever the service says: the microphone is
            // already off, and the UI must never claim the user is live when they are
            // not.
            {
                let mut plane = ctx.calling.lock().unwrap();
                if let Some(call) = plane.call.as_mut().filter(|c| c.id == call_id) {
                    call.muted = muted;
                }
            }
            ctx.emit_call_state();
            let told = match url {
                Some(url) => ctx
                    .post_call_signal(&url, &calling::mute_payload(&local, muted))
                    .await
                    .inspect_err(|e| eprintln!("[calling] the mute did not reach the service: {e:#}"))
                    .is_ok(),
                None => false,
            };
            Ok(json!({ "call_id": call_id, "muted": muted, "told_service": told }))
        }

        // Enrich a tracker link with metadata (title, state, assignee, …) so the
        // UI can render a rich preview card instead of a bare URL. Each
        // integration answers for its own host, with its configured token read
        // from the store (see `link_preview`). Best-effort: an unrecognized or
        // private link yields `metadata: null` (the UI shows the plain link);
        // only a transient failure errors.
        "enrich_link" => {
            let url = param_str(params, "url")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let metadata = link_preview::enrich(&ctx.http, &settings, &url).await?;
            // A card names people too — a merge request's author, an issue's — so it names
            // them the way the GitLab page does: the colleague this app knows, with their
            // Teams face. Nothing is cached here, so there is nothing to keep current.
            let mut answer = json!({ "metadata": metadata });
            with_teams_people(ctx, &mut answer);
            Ok(answer)
        }

        // The Linear workspace this machine's key belongs to: how its issues are
        // addressed, and which team keys an identifier can really name. A READ, ungated
        // like `enrich_link`, and it carries no key — only what a reader needs to turn a
        // bare `ENG-123` written in a message, an agent's answer or a merge request's
        // description into a link to that issue (see AGENTS.md § A tracker REFERENCE in the words).
        //
        // GitLab needs no counterpart: its host is configured, so `!42` is addressed from
        // the settings the page already holds. Linear's workspace is not configured
        // anywhere — Linear is SaaS and the key names the workspace — so it is read once
        // and cached, which is the whole reason this method exists.
        "linear_workspace" => linear_workspace(ctx).await,

        // Every message Teams is still HOLDING for this account, soonest first — the whole
        // of "see all scheduled messages".
        //
        // An ORDINARY READ, ungated, and it makes no network request at all: a scheduled
        // send comes back in the ordinary history, so the store already holds every one of
        // them (the same rows the history leaves out until their moment passes). The page
        // names each one's conversation from the list it already has, so nothing about a
        // thread is resolved twice.
        "scheduled_messages" => {
            let me = ctx.identity().await?;
            let store = ctx.store()?;
            let held = store.scheduled_messages(MAX_SCHEDULED_LISTED)?;
            let messages: Vec<Value> = held
                .iter()
                .map(|m| message_json(m, &me.name, &me.mri, Some(&store)))
                .collect();
            Ok(json!({ "messages": messages }))
        }

        // The approval state of one merge request: who has approved it, how many
        // approvals it still wants, and whether the user's own is among them. A READ,
        // so it is ungated like `enrich_link` — and it is what lets the message's own
        // menu offer the right half of the toggle instead of guessing. `approval: null`
        // when the URL is not a merge request on the configured host, or the token
        // cannot see it (the UI then offers nothing).
        "gitlab_approvals" => {
            let url = param_str(params, "url")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let approval = gitlab_approval::fetch(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &url,
            )
            .await?;
            // Who approved is one more list of people on this page, so it is named the same
            // way the rest of it is.
            let mut answer =
                json!({ "approval": approval, "token_set": settings.gitlab_token.is_some() });
            with_teams_people(ctx, &mut answer);
            Ok(answer)
        }

        // Give, or take back, the user's own approval of a merge request. THE one write
        // this app makes to a tracker (see src/gitlab_approval.rs and AGENTS.md § The
        // trackers): everything else about GitLab and Linear reads.
        //
        // It is an `OUTWARD_METHODS` entry because it acts under the user's GitLab
        // account and everybody watching the merge request is told — a rule may even let
        // it merge — so it needs the write token, a read-only backend refuses it, and the
        // automation hook refuses a command line that names the endpoint. What makes it
        // acceptable at all is that it is REVERSIBLE from the same menu: `approved:
        // false` is GitLab's own `/unapprove`.
        "gitlab_set_approval" => {
            let url = param_str(params, "url")?;
            let approved = params
                .get("approved")
                .and_then(Value::as_bool)
                .context("`approved` must be true or false")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let approval = gitlab_approval::set(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &url,
                approved,
            )
            .await?;
            // The page reads the approval state as part of one merge request's detail, so
            // an approval given from there makes that detail wrong the moment it lands.
            if let Some((project_path, iid)) = gitlab_merge_request_of(&url, &settings.gitlab_host) {
                forget_gitlab_merge_request(ctx, &project_path, iid);
            }
            let mut answer = json!({ "approval": approval, "token_set": true });
            with_teams_people(ctx, &mut answer);
            Ok(answer)
        }

        // ---- the merge-request page: reads ------------------------------------
        //
        // Every one of these answers from the durable response cache FIRST and refreshes
        // behind the page (see `gitlab_cached`), which is what makes the surface feel
        // local: a re-opened merge request paints from disk, and the fresh copy arrives on
        // a `gitlab_mr_updated` event a moment later. All four are ordinary reads, so none
        // is gated — but each needs the user's token, because "what can I see" is a
        // question about an account (see `gitlab_mr::require_token`).

        // The merge requests that are NOT merged, for the sidebar. `scope` and `state` are
        // closed sets in the Rust type, so a client cannot widen the query into one the
        // page never offers — in particular it can never ask for merged ones.
        "gitlab_mr_list" => {
            let query = gitlab_list_query(params)?;
            let refresh = params.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            // Whether this machine holds a token at all travels with the answer, and it is
            // read HERE rather than from the settings by the page. Two reasons, and the
            // second is the load-bearing one: the read is the thing that needs the token,
            // so the honest place to report it is beside its result — and it must not be
            // derived from a cached payload, since a token can be added or removed while
            // one sits in the store.
            //
            // With no token the list is not asked for at all: the answer is an EMPTY list
            // that says so, rather than a refusal the user would read as a failure.
            let token_set = {
                let store = ctx.store()?;
                link_preview_settings(&store)?.gitlab_token.is_some()
            };
            if !token_set {
                return Ok(json!({
                    "scope": query.scope.as_str(),
                    "state": query.state.as_str(),
                    "items": [],
                    "truncated": false,
                    "token_set": false,
                }));
            }
            let mut list = gitlab_cached(
                ctx,
                query.cache_key(),
                GITLAB_LIST_TTL,
                refresh,
                GitLabRead::List(query),
            )
            .await?;
            if let Some(object) = list.as_object_mut() {
                object.insert("token_set".to_string(), json!(true));
            }
            Ok(list)
        }

        // One merge request in full: the header, the description, the branches, the people
        // and the head pipeline as the detail body states it.
        "gitlab_mr_detail" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let refresh = params.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            gitlab_cached(
                ctx,
                gitlab_mr::cache_key(&project_path, iid, "detail"),
                GITLAB_DETAIL_TTL,
                refresh,
                GitLabRead::Detail { project_path, iid },
            )
            .await
        }

        // The comment thread. Discussions in GitLab's own order, threads and standalone
        // comments told apart, and each note saying whether the user themselves wrote it —
        // which is what decides whether a deletion is offered.
        "gitlab_mr_notes" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let refresh = params.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            gitlab_cached(
                ctx,
                gitlab_mr::cache_key(&project_path, iid, "notes"),
                GITLAB_NOTES_TTL,
                refresh,
                GitLabRead::Notes { project_path, iid },
            )
            .await
        }

        // What the merge request CHANGED, for the Changes section. `depth` picks between the
        // modern `/diffs` — one page, and whatever GitLab chose to expand — and the older
        // `/changes?access_raw_diffs=true`, which expands everything and costs half a
        // megabyte on a big merge request. It is a closed Rust set, so a client can never
        // widen it into a third endpoint (see `gitlab_mr::DiffDepth`), and the expanded read
        // is the reader's own ask: `listed` is what opening the section costs.
        "gitlab_mr_diff" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let refresh = params.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            let depth = gitlab_diff_depth(params)?;
            gitlab_cached(
                ctx,
                gitlab_mr::cache_key(&project_path, iid, depth.cache_kind()),
                GITLAB_DIFF_TTL,
                refresh,
                GitLabRead::Diff { project_path, iid, depth },
            )
            .await
        }

        // The head pipeline and its jobs. THE live read: the page repeats it while CI is
        // running, so its cache window is seconds rather than half a minute — long enough
        // that two open pages cost one request, short enough that a job turning green shows
        // up when it happens.
        "gitlab_mr_pipeline" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let refresh = params.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            gitlab_cached(
                ctx,
                gitlab_mr::cache_key(&project_path, iid, "pipeline"),
                GITLAB_PIPELINE_TTL,
                refresh,
                GitLabRead::Pipeline { project_path, iid },
            )
            .await
        }

        // One PICTURE a description or a comment points at. An ordinary read, like every
        // other one on this page — and the reason it exists at all is the promise those reads
        // are written under: nothing on this page is fetched from GitLab BY THE BROWSER. An
        // upload is served to a session or a token (measured: 404 to everything else), so the
        // bytes come through here exactly as a Teams inline image and a colleague's face do,
        // and the page draws a local blob.
        //
        // It is addressed by PRIMITIVES — the project, GitLab's own secret for the file, the
        // file's name — never by a URL a client assembled, so the token cannot be aimed
        // anywhere this app did not spell (`gitlab_mr::UploadRef::parse` checks each part).
        // Not cached in `gitlab_reads`: the page holds the bytes as a blob for as long as it
        // draws them, and a megabyte of base64 per screenshot is not what that table is for.
        "gitlab_mr_upload" => {
            let upload = gitlab_mr::UploadRef::parse(
                &gitlab_project_path_param(params)?,
                &param_str(params, "secret")?,
                &param_str(params, "filename")?,
            )?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let picture = gitlab_mr::fetch_upload(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &upload,
            )
            .await?;
            Ok(json!({
                "content_type": picture.content_type,
                "data_base64": base64::engine::general_purpose::STANDARD.encode(&picture.bytes),
            }))
        }

        // ONE job's LOG, for the page a job card opens. The biggest read here and the one whose
        // freshness swings widest: while the job runs it is polled like the pipeline, and the
        // moment it stops it never changes again — which is why its window is decided by the
        // answer rather than stated here (see `GitLabTtl`). The job is addressed by its own id,
        // as GitLab addresses one; the merge request travels so the entry sits under its prefix.
        "gitlab_mr_job_log" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let job_id = gitlab_job_id(params)?;
            let refresh = params.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            gitlab_cached(
                ctx,
                gitlab_mr::cache_key(&project_path, iid, &gitlab_mr::job_cache_kind(job_id)),
                GitLabTtl::JobLog,
                refresh,
                GitLabRead::JobLog { project_path, iid, job_id },
            )
            .await
        }

        // ---- the merge-request page: the four writes -------------------------
        //
        // Each is an `OUTWARD_METHODS` entry: the write token, refused by a read-only
        // backend, and the automation hook refuses a command line that names the endpoint.
        // Each carries out one click the user just made, each drops the cache of the merge
        // request it changed, and each reports GitLab's own words on a refusal.

        // MERGE the branch. The one write in this app that no later call takes back, which
        // is why the `sha` the page drew travels with it: GitLab refuses a merge whose sha
        // is not the branch's head, so a merge request that moved since the reader looked
        // is refused rather than landed. The UI asks twice before it calls.
        "gitlab_mr_merge" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let sha = param_str(params, "sha")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let result = gitlab_mr_write::merge(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &gitlab_mr_write::MergeRequest {
                    project_path: project_path.clone(),
                    iid,
                    sha,
                    squash: params.get("squash").and_then(Value::as_bool).unwrap_or(false),
                    remove_source_branch: params
                        .get("remove_source_branch")
                        .and_then(Value::as_bool),
                },
            )
            .await?;
            forget_gitlab_merge_request(ctx, &project_path, iid);
            Ok(json!({ "merge": result }))
        }

        // COMMENT on it — a new comment, a reply into the thread `discussion_id` names, or a
        // new thread on the DIFF LINE `position` names. Everybody watching the merge request
        // is told, under the user's own name, so this is gated like a send and is only ever
        // called from their own Enter.
        //
        // The three are one method because they are one act: the same people are told, the
        // same deletion undoes it, and only where GitLab files the words differs. A position
        // is built from primitives here (see `gitlab_diff_anchor`) so a client can never hand
        // GitLab a field this app does not know it is sending.
        "gitlab_mr_comment" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let body = param_str(params, "body")?;
            let discussion = params
                .get("discussion_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
            let anchor = gitlab_diff_anchor(params)?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let note = gitlab_mr_write::comment(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &project_path,
                iid,
                discussion.as_deref(),
                anchor.as_ref(),
                &body,
            )
            .await?;
            forget_gitlab_merge_request(ctx, &project_path, iid);
            // The comment the page adds at once, so it arrives wearing the same face as the
            // ones it lands beside — the note it is drawn from is the user's own.
            let mut answer = json!({ "note": note });
            with_teams_people(ctx, &mut answer);
            Ok(answer)
        }

        // DELETE one of the user's OWN comments — the undo that makes the comment above
        // acceptable. Whose comment it is, is read from GitLab BEFORE the deletion and
        // matched on the account's own id: GitLab would let a maintainer remove a
        // colleague's note, and this app never offers that (the same rule that refuses to
        // delete a Teams message that is not the user's own).
        "gitlab_mr_delete_comment" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let note_id = params
                .get("note_id")
                .and_then(Value::as_u64)
                .context("`note_id` must be a number")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            require_own_gitlab_note(ctx, &settings, &project_path, iid, note_id, "delete")
                .await?;
            gitlab_mr_write::delete_comment(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &project_path,
                iid,
                note_id,
            )
            .await?;
            forget_gitlab_merge_request(ctx, &project_path, iid);
            Ok(json!({ "deleted": note_id }))
        }

        // EDIT one of the user's OWN comments. Whose comment it is, is read from GitLab
        // BEFORE the write and matched on the account's own id — the same rail the deletion
        // above carries, and for its reason: GitLab would refuse a colleague's note anyway,
        // and this app must not lean on somebody else's refusal to keep a promise of its own.
        //
        // It is not fully reversible: an edit can be edited back, but the words that were
        // there are gone (see `gitlab_mr_write::edit_comment`). That is where a Teams message
        // edit sits, so it is offered the same way — one press, on the user's own words.
        "gitlab_mr_edit_comment" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let note_id = params
                .get("note_id")
                .and_then(Value::as_u64)
                .context("`note_id` must be a number")?;
            let body = param_str(params, "body")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            require_own_gitlab_note(ctx, &settings, &project_path, iid, note_id, "edit").await?;
            let note = gitlab_mr_write::edit_comment(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &project_path,
                iid,
                note_id,
                &body,
            )
            .await?;
            forget_gitlab_merge_request(ctx, &project_path, iid);
            let mut answer = json!({ "note": note });
            with_teams_people(ctx, &mut answer);
            Ok(answer)
        }

        // RESOLVE a thread, or open it again. Each direction is the other's undo, which is
        // what makes this an ordinary gated write — the shape the approval already has.
        //
        // Nobody's ownership is in question here: GitLab lets anybody who can comment resolve
        // a thread, and that is the point of the feature. So there is no read before the
        // write, and a thread that cannot be resolved at all — a standalone comment — is
        // refused by GitLab in its own words rather than by a guess made here.
        "gitlab_mr_resolve_thread" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let discussion_id = param_str(params, "discussion_id")?;
            let resolved = params
                .get("resolved")
                .and_then(Value::as_bool)
                .context("`resolved` must say which way the thread goes")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let resolved = gitlab_mr_write::set_thread_resolved(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &project_path,
                iid,
                &discussion_id,
                resolved,
            )
            .await?;
            forget_gitlab_merge_request(ctx, &project_path, iid);
            Ok(json!({ "discussion_id": discussion_id, "resolved": resolved }))
        }

        // CLOSE or REOPEN it. Each direction is the other's undo, which is what makes this
        // an ordinary gated write rather than a second irreversible one.
        "gitlab_mr_set_state" => {
            let (project_path, iid) = gitlab_merge_request_params(params)?;
            let requested = param_str(params, "change")?;
            let change = gitlab_mr_write::StateChange::from_str(&requested)
                .context("`change` must be \"close\" or \"reopen\"")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let state = gitlab_mr_write::set_state(
                &ctx.http,
                &settings.gitlab_host,
                settings.gitlab_token.as_deref(),
                &project_path,
                iid,
                change,
            )
            .await?;
            forget_gitlab_merge_request(ctx, &project_path, iid);
            Ok(json!({ "state": state }))
        }

        // One person's directory card — name, job title, department, email, work
        // location — for the card the UI shows on hovering a sender or an @mention.
        // `found` is false when the directory has nothing for this identity (a
        // service account, a removed guest), so the UI can fall back to the name it
        // already has. Only PERSON mris are accepted; a channel/team mri is refused
        // rather than sent upstream.
        "profile" => {
            let mri = param_str(params, "mri")?;
            anyhow::ensure!(teams_profiles::is_person_mri(&mri), "not a person mri");
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let profiles = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let mris = vec![mri.clone()];
                    async move {
                        // The short-profile endpoint takes the profile-audience
                        // token, not the CSA one `retry_on_auth` supplies.
                        let profile = tokens.get(teams_profiles::PROFILE_SCOPE).await?;
                        teams_profiles::fetch_profiles(&http, &session, &profile, &mris).await
                    }
                })
                .await?;
            Ok(match profiles.into_iter().next() {
                Some(p) => profile_json(&p),
                None => json!({ "found": false }),
            })
        }

        // The people behind a batch of MAIL ADDRESSES — the same directory card as
        // `profile`, asked with an address instead of an mri. This is what puts a real
        // face on a mail: a message names its sender and its recipients by address,
        // and a photo is addressed by mri. An address the directory does not know (an
        // external sender, a distribution list, a shared mailbox) is simply absent
        // from the answer, so the UI keeps its tinted initials rather than guessing.
        // READ-ONLY, like every other mail-facing method.
        "people_by_address" => {
            let addresses = address_batch(params)?;
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let people = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let addresses = addresses.clone();
                    async move {
                        let profile = tokens.get(teams_profiles::PROFILE_SCOPE).await?;
                        teams_profiles::fetch_profiles_by_address(
                            &http, &session, &profile, &addresses,
                        )
                        .await
                    }
                })
                .await?;
            Ok(json!({
                "people": people
                    .iter()
                    .map(|(address, p)| {
                        let mut entry = profile_json(p);
                        entry["address"] = json!(address);
                        entry
                    })
                    .collect::<Vec<Value>>(),
            }))
        }

        // Live presence ("Available", "Busy", "In a meeting", "Offline", …) for one
        // or more people, read the same way the Teams client reads it. Volatile by
        // nature, so it is never cached server-side: every call hits the presence
        // service and the UI decides how long to trust the answer. A person the
        // service has no answer for is simply absent from the result.
        "presence" => {
            let mris = presence_mris(params)?;
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let presences = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let mris = mris.clone();
                    async move {
                        let profile = tokens.get(teams_profiles::PROFILE_SCOPE).await?;
                        teams_presence::fetch_presence(&http, &session, &profile, &mris).await
                    }
                })
                .await?;
            Ok(json!({
                "presences": presences.iter().map(presence_json).collect::<Vec<Value>>(),
            }))
        }

        // ---- mail (READ-ONLY Outlook surface, see `mail`) --------------------
        //
        // Every method below reads the mailbox, and only `mail_mark_read` writes
        // anything at all — one column of our OWN mirror, never the mailbox. None of
        // them is in `OUTWARD_METHODS`, because none can act on the mailbox: there is
        // no send/reply/delete/move/mark-as-read anywhere in the crate (`mail::tests`
        // enforce it). What the write lock protects is Teams; what protects the
        // mailbox is that the capability does not exist.

        // The mail folder list — LOCAL-FIRST like `conversations`: answer instantly
        // from SQLite, then sync from Graph in the background and emit
        // `mail_folders_changed` if any folder's name or counts moved.
        //
        // Except on a COLD store, where "local-first" would mean handing back an
        // empty mailbox: there is nothing to be instant about, so the first call
        // waits for the network. Without this, the very first time Mail is opened the
        // sidebar would come up empty and only fill in on a second visit.
        "mail_folders" => {
            let rows = {
                let store = ctx.store()?;
                store.mail_folders()?
            };
            if !rows.is_empty() {
                sync_mail_folders_bg(ctx.clone());
                return Ok(json!(rows.iter().map(mail_folder_json).collect::<Vec<Value>>()));
            }

            let http = ctx.http.clone();
            let folders = ctx
                .retry_graph(move |token| {
                    let http = http.clone();
                    async move { mail::fetch_folders(&http, &token).await }
                })
                .await?;
            let store = ctx.store()?;
            mail::persist_folders(&store, &folders)?;
            // The inbox is what the unread badge counts, so it joins the live poll
            // as soon as the mailbox is known.
            if let Some(inbox) = folders.iter().find(|f| f.well_known == "Inbox") {
                ctx.watch_mail_folder(&inbox.id);
            }
            let rows = store.mail_folders()?;
            Ok(json!(rows.iter().map(mail_folder_json).collect::<Vec<Value>>()))
        }

        // A folder's newest page — LOCAL-FIRST: the cached page answers immediately
        // (0 network round-trips on a re-open), then a background fetch reconciles
        // it against the server and emits `mail_list_updated` when anything moved.
        // Opening a folder also puts it under the live poll.
        "mail_list" => {
            let folder = param_str(params, "folder")?;
            let limit = page_limit(params, mail::DEFAULT_PAGE_SIZE);
            ctx.watch_mail_folder(&folder);

            let (cached, has_more, never_synced) = {
                let store = ctx.store()?;
                let page = store.mail_page(&folder, None, limit as i64)?;
                let has_more = mail_has_more_older(&store, &folder, &page)?;
                // An empty page with no recorded frontier means this folder has never
                // been fetched — as opposed to a folder we know to be empty.
                let never_synced = page.is_empty() && store.mail_frontier(&folder)?.0.is_empty();
                (page, has_more, never_synced)
            };

            // Cold folder: wait for the network rather than answering "no mail", which
            // a client cannot tell apart from an empty folder (see `mail_folders`).
            if never_synced {
                refresh_mail_folder(ctx, &folder, limit).await?;
                let store = ctx.store()?;
                let page = store.mail_page(&folder, None, limit as i64)?;
                let has_more = mail_has_more_older(&store, &folder, &page)?;
                return Ok(mail_list_json(&page, has_more));
            }

            // Background refresh: never blocks the response, so switching folders is
            // instant once the folder has been seen at least once.
            let ctx_bg = ctx.clone();
            let folder_bg = folder.clone();
            tokio::spawn(async move {
                match refresh_mail_folder(&ctx_bg, &folder_bg, limit).await {
                    Ok(true) => emit_mail_list(&ctx_bg, &folder_bg),
                    Ok(false) => {}
                    Err(e) => ctx_bg.emit(
                        "mail_list_error",
                        json!({ "folder": folder_bg, "error": e.to_string() }),
                    ),
                }
            });
            Ok(mail_list_json(&cached, has_more))
        }

        // Older mail for scroll-up. Answers from the cache when it already holds the
        // page, else fetches it — the same shape as the chat `backfill`.
        "mail_backfill" => {
            let folder = param_str(params, "folder")?;
            let before = param_str(params, "before")?;
            let limit = page_limit(params, mail::DEFAULT_PAGE_SIZE);

            let (cached, frontier) = {
                let store = ctx.store()?;
                (
                    store.mail_page(&folder, Some(&before), limit as i64)?,
                    store.mail_frontier(&folder)?,
                )
            };
            if !cached.is_empty() {
                let has_more = mail_has_more_older(&ctx.store()?, &folder, &cached)?;
                return Ok(mail_list_json(&cached, has_more));
            }
            // Nothing cached older than `before`: if the server has nothing either,
            // say so instead of asking it again.
            if !frontier.1 {
                return Ok(mail_list_json(&[], false));
            }

            let http = ctx.http.clone();
            let folder_op = folder.clone();
            let before_op = before.clone();
            let page = ctx
                .retry_graph(move |token| {
                    let http = http.clone();
                    let folder = folder_op.clone();
                    let before = before_op.clone();
                    async move { mail::fetch_older(&http, &token, &folder, &before, limit).await }
                })
                .await?;
            let store = ctx.store()?;
            mail::persist_headers(&store, &page)?;
            mail::persist_frontier(&store, &folder, &page, limit)?;
            let rows = store.mail_page(&folder, Some(&before), limit as i64)?;
            let has_more = mail_has_more_older(&store, &folder, &rows)?;
            Ok(mail_list_json(&rows, has_more))
        }

        // One mail's rendered body. Cached after the first read, so re-opening a
        // mail — or reading it offline — costs nothing.
        //
        // The HTML handed back is inert and self-contained: scripts, styles, frames
        // and forms removed, remote images dropped and counted, inline images
        // embedded as data URIs (see `mail_html`). The UI still renders it inside a
        // sandboxed iframe under a `default-src 'none'` CSP.
        "mail_body" => {
            let id = param_str(params, "id")?;
            if let Some(row) = ctx.store()?.mail_message(&id)? {
                if row.body_loaded {
                    return Ok(mail_body_json(&row));
                }
            }

            let http = ctx.http.clone();
            let id_op = id.clone();
            let fetched = ctx
                .retry_graph(move |token| {
                    let http = http.clone();
                    let id = id_op.clone();
                    async move { mail::fetch_body(&http, &token, &id).await }
                })
                .await?;
            let store = ctx.store()?;
            // The fetch carried the header too, so a mail reached by a DEEP LINK —
            // one that was never in a list — becomes a proper row here instead of a
            // body with no sender or subject. Its folder is watched from now on, so
            // the poll keeps it current like any other.
            if let Some(header) = &fetched.header {
                mail::persist_headers(&store, std::slice::from_ref(header))?;
                ctx.watch_mail_folder(&header.folder_id);
            }
            mail::persist_body(&store, &id, &fetched)?;
            match store.mail_message(&id)? {
                Some(row) if row.body_loaded => Ok(mail_body_json(&row)),
                // No row: the mail exists on the server but Graph gave us nothing we
                // could key it by. Return the body alone rather than failing the open.
                _ => Ok(json!({
                    "html": fetched.body.html,
                    "blocked_remote_images": fetched.body.blocked_remote_images,
                    "truncated": fetched.body.truncated,
                    "attachments": serde_json::from_str::<Value>(
                        &mail::attachments_json(&fetched.attachments)
                    ).unwrap_or_else(|_| json!([])),
                    "header": Value::Null,
                })),
            }
        }

        // Clear one mail's unread marker — HERE, and nowhere else.
        //
        // What a client calls when the user opens an unread mail, so the marker
        // actually clears instead of standing over a mail they have read. The write
        // lands on our own `local_read` column (see `Store::mark_mail_read_locally`)
        // and goes no further: Graph is never told, so Outlook keeps the mail unread
        // on the user's phone and its sender is shown nothing. That is the whole
        // point — the mailbox stays read-only, and the app still behaves like a mail
        // client.
        //
        // NOT an `OUTWARD_METHODS` entry, deliberately: that list means "other people
        // see it", and nobody but the user sees this. If marking a mail read in the
        // MAILBOX is ever wanted, it is a deliberate feature — its own consent gate,
        // its own entry in that list — never a widening of this one.
        //
        // A read-only backend refuses it, for the same reason `deliver_push` and
        // `publish_presence` refuse before the network: a screenshot script or an
        // automated driver opening mail must not clear the user's own unread markers.
        "mail_mark_read" => {
            let id = param_str(params, "id")?;
            if read_only() {
                return Ok(json!({ "read": false, "moved": false }));
            }
            // Only a real change emits, so re-opening a mail that is already read does
            // not spin the UI's refresh loop.
            if let Some(folder) = ctx.store()?.mark_mail_read_locally(&id)? {
                emit_mail_list(ctx, &folder);
                ctx.emit("mail_folders_changed", json!({}));
                return Ok(json!({ "read": true, "moved": true }));
            }
            Ok(json!({ "read": true, "moved": false }))
        }

        // One attachment's bytes, base64 over the same WebSocket as every other
        // proxied media object. The browser cannot fetch these itself (they need the
        // Graph token), and the UI never touches the network directly.
        "mail_attachment" => {
            let message_id = param_str(params, "message_id")?;
            let attachment_id = param_str(params, "attachment_id")?;
            let http = ctx.http.clone();
            let attachment = ctx
                .retry_graph(move |token| {
                    let http = http.clone();
                    let message_id = message_id.clone();
                    let attachment_id = attachment_id.clone();
                    async move {
                        mail::fetch_attachment(&http, &token, &message_id, &attachment_id).await
                    }
                })
                .await?;
            let data = base64::engine::general_purpose::STANDARD.encode(&attachment.bytes);
            Ok(json!({
                "content_type": attachment.content_type,
                "name": attachment.name,
                "data_base64": data,
            }))
        }

        // ---- calendar (READ-ONLY Teams/Outlook surface, see `calendar`) -------
        //
        // Both methods below only read, and neither is in `OUTWARD_METHODS` because
        // neither can act on a calendar: there is no create/update/delete/accept/
        // decline/cancel/forward path anywhere in the crate (`calendar::tests`
        // enforce it). What the write lock protects is Teams; what protects the
        // calendar is that the capability does not exist.

        // The calendar list — LOCAL-FIRST like `mail_folders`, and cold-start-aware
        // for the same reason: answering an empty list on the first call would leave
        // the UI with nothing to show and no way to tell that apart from a mailbox
        // with no calendars.
        "calendars" => {
            let rows = ctx.store()?.calendars()?;
            if !rows.is_empty() {
                sync_calendars_bg(ctx.clone());
                return Ok(json!(rows.iter().map(calendar_json).collect::<Vec<Value>>()));
            }
            let calendars = fetch_calendars(ctx).await?;
            let store = ctx.store()?;
            calendar::persist_calendars(&store, &calendars)?;
            let rows = store.calendars()?;
            Ok(json!(rows.iter().map(calendar_json).collect::<Vec<Value>>()))
        }

        // Every event in a window — LOCAL-FIRST: a month already synced answers from
        // SQLite with no network at all (0 round-trips when navigating back to it),
        // then a background refresh reconciles it and emits `calendar_view_updated`
        // if anything moved. A window whose months have never been read waits for the
        // network instead, because "no events" and "not fetched yet" look identical
        // on a calendar grid — and the second one would render as a free week.
        //
        // Opening a window also makes it the one the live poll watches.
        "calendar_view" => {
            let start = param_str(params, "start")?;
            let end = param_str(params, "end")?;
            // Months, not the requested window: the sync unit is a calendar month, so
            // a week straddling two of them is still a cache hit. See the
            // `calendar` module doc.
            let months = calendar::months_covering(&start, &end);
            let (Some(first), Some(last)) = (months.first(), months.last()) else {
                anyhow::bail!("calendar_view needs a start before its end, both ISO 8601 UTC");
            };
            let (span_start, span_end) = (first.start(), last.end());

            // Which calendars: whatever the client asked for, else every one we know
            // (resolving them from the network if this is a cold store, so the first
            // calendar_view of a session does not come back empty).
            let calendars = match param_str_list(params, "calendars") {
                ids if !ids.is_empty() => ids,
                _ => {
                    let known = ctx.store()?.calendars()?;
                    if known.is_empty() {
                        let fetched = fetch_calendars(ctx).await?;
                        calendar::persist_calendars(&ctx.store()?, &fetched)?;
                        fetched.into_iter().map(|c| c.id).collect()
                    } else {
                        known.into_iter().map(|c| c.id).collect()
                    }
                }
            };

            ctx.watch_calendar(CalendarWatch {
                start: span_start.clone(),
                end: span_end.clone(),
                calendars: calendars.clone(),
            });

            let fully_synced = {
                let store = ctx.store()?;
                let mut synced = true;
                for calendar_id in &calendars {
                    for month in &months {
                        if !store.calendar_month_synced(calendar_id, &month.key())? {
                            synced = false;
                            break;
                        }
                    }
                    if !synced {
                        break;
                    }
                }
                synced
            };

            if !fully_synced {
                refresh_calendar_span(ctx, &calendars, &months).await?;
            } else {
                let ctx_bg = ctx.clone();
                let calendars_bg = calendars.clone();
                let months_bg = months.clone();
                tokio::spawn(async move {
                    match refresh_calendar_span(&ctx_bg, &calendars_bg, &months_bg).await {
                        Ok(true) => emit_calendar_view(&ctx_bg),
                        Ok(false) => {}
                        Err(e) => ctx_bg.emit(
                            "calendar_view_error",
                            json!({ "error": e.to_string() }),
                        ),
                    }
                });
            }

            let events = ctx.store()?.calendar_events(&start, &end, &calendars)?;
            Ok(calendar_view_json(&events, &start, &end))
        }

        other => anyhow::bail!("unknown method: {other}"),
    }
}

/// A bounded page size from `params.limit`, defaulting to `default`. Clamped so a
/// client cannot ask Graph for an unbounded page.
fn page_limit(params: &Value, default: u32) -> u32 {
    params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 100) as u32)
        .unwrap_or(default)
}

/// Whether a folder has mail older than the page just read.
///
/// True when the server is known to hold more (`has_more_older`) OR the page stops
/// short of the oldest row we hold locally — the latter is what makes scrolling a
/// long cached folder work without a network round-trip per page.
fn mail_has_more_older(
    store: &Store,
    folder_id: &str,
    page: &[teams_lite::store::MailMessageRow],
) -> Result<bool> {
    let (oldest_held, server_has_more) = store.mail_frontier(folder_id)?;
    match page.last() {
        // An empty page: only the server can still have something.
        None => Ok(server_has_more),
        Some(last) => Ok(server_has_more || last.received > oldest_held),
    }
}

/// Refresh a folder's newest window from Graph and reconcile it into the store.
///
/// Returns whether anything changed (so the caller only emits an event when it
/// did). The window is re-read in full rather than asked for incrementally, which is
/// what lets [`Store::prune_mail_window`] notice mail deleted or moved in real
/// Outlook — see [`mail::POLL_WINDOW`].
async fn refresh_mail_folder(ctx: &Ctx, folder_id: &str, limit: u32) -> Result<bool> {
    let http = ctx.http.clone();
    let folder = folder_id.to_string();
    let window = limit.max(mail::POLL_WINDOW);
    let page = ctx
        .retry_graph(move |token| {
            let http = http.clone();
            let folder = folder.clone();
            async move { mail::fetch_newest(&http, &token, &folder, window).await }
        })
        .await?;

    let store = ctx.store()?;
    let changed = mail::persist_headers(&store, &page)? > 0;
    mail::persist_frontier(&store, folder_id, &page, window)?;
    let pruned = match (page.last(), page.iter().map(|h| h.id.clone()).collect::<Vec<_>>()) {
        (Some(oldest), ids) => store.prune_mail_window(folder_id, &oldest.received, &ids)?,
        (None, _) => 0,
    };
    Ok(changed || pruned > 0)
}

/// Broadcast a folder's current newest page to every connected UI.
fn emit_mail_list(ctx: &Ctx, folder_id: &str) {
    let Ok(store) = ctx.store() else { return };
    let Ok(page) = store.mail_page(folder_id, None, mail::DEFAULT_PAGE_SIZE as i64) else {
        return;
    };
    let has_more = mail_has_more_older(&store, folder_id, &page).unwrap_or(false);
    let mut payload = mail_list_json(&page, has_more);
    payload["folder"] = json!(folder_id);
    ctx.emit("mail_list_updated", payload);
}

/// Sync the mail folder list from Graph in the background, emitting
/// `mail_folders_changed` when any folder's metadata moved. Best-effort: mail is a
/// secondary surface, so a failure is logged and the cached list stands.
///
/// Also the point at which the inbox joins the live poll: whatever folder the user
/// browses, the inbox is the one whose unread count the UI badges.
fn sync_mail_folders_bg(ctx: Ctx) {
    tokio::spawn(async move {
        let http = ctx.http.clone();
        let folders = ctx
            .retry_graph(move |token| {
                let http = http.clone();
                async move { mail::fetch_folders(&http, &token).await }
            })
            .await;
        match folders {
            Ok(folders) => {
                // Whatever the user reads first, the inbox is always worth watching:
                // it is where new mail lands and what the badge counts.
                if let Some(inbox) = folders.iter().find(|f| f.well_known == "Inbox") {
                    ctx.watch_mail_folder(&inbox.id);
                }
                let changed = ctx
                    .store()
                    .and_then(|store| mail::persist_folders(&store, &folders));
                match changed {
                    Ok(true) => ctx.emit("mail_folders_changed", json!({})),
                    Ok(false) => {}
                    Err(e) => eprintln!("[mail] could not persist folders: {e}"),
                }
            }
            Err(e) => eprintln!("[mail] folder sync failed: {e:#}"),
        }
    });
}

/// How often the watched mail folders are re-read. Mail is not chat: a minute of
/// latency on a new mail is unremarkable, and this is one request per watched
/// folder.
const MAIL_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// The mail live loop: re-read each watched folder's newest window on a timer and
/// broadcast what changed.
///
/// This is a poll, not a push. Trouter is registered against the Teams registrar and
/// carries no mailbox traffic, and Graph's change notifications need a public
/// webhook — neither is available to a local-first app, so the honest mechanism is a
/// cheap periodic read (see the `mail` module doc).
///
/// LAZY BY DESIGN: the watch set starts empty, so this loop makes NO requests until
/// a client actually opens the mail surface (`mail_folders` triggers the folder sync,
/// `mail_list` registers the folder it opened). A user who only ever uses chat pays
/// nothing for mail at all. Once
/// Mail has been opened, the poll keeps its folders and the unread badge current for
/// the rest of the session.
fn spawn_mail_sync(ctx: Ctx) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(MAIL_POLL_INTERVAL).await;
            let folders: Vec<String> = match ctx.mail_watch.lock() {
                Ok(watch) => watch.iter().cloned().collect(),
                Err(_) => continue,
            };
            for folder in folders {
                match refresh_mail_folder(&ctx, &folder, mail::POLL_WINDOW).await {
                    Ok(true) => {
                        emit_mail_list(&ctx, &folder);
                        // Counts moved with the mail, so refresh the folder list too.
                        sync_mail_folders_bg(ctx.clone());
                    }
                    Ok(false) => {}
                    // A transient failure is not worth telling the UI about: the
                    // cached list is still valid and the next tick retries.
                    Err(e) => eprintln!("[mail] poll of a watched folder failed: {e:#}"),
                }
            }
        }
    });
}

/// Serialize a mail folder for the sidebar.
fn mail_folder_json(folder: &teams_lite::store::MailFolderRow) -> Value {
    json!({
        "id": folder.id,
        // The UI shows `well_known` when set (stable English) and falls back to the
        // mailbox's own, localized name for a user folder.
        "display_name": folder.display_name,
        "well_known": folder.well_known,
        "total_count": folder.total_count,
        "unread_count": folder.unread_count,
        "position": folder.position,
    })
}

/// Serialize one mail's list fields. The body is never included here — see
/// `mail_body`.
fn mail_header_json(mail: &teams_lite::store::MailMessageRow) -> Value {
    let addresses = |raw: &str| serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!([]));
    json!({
        "id": mail.id,
        "folder_id": mail.folder_id,
        "conversation_id": mail.conversation_id,
        "subject": mail.subject,
        "from": { "name": mail.from_name, "address": mail.from_address },
        "to": addresses(&mail.to_addresses),
        "cc": addresses(&mail.cc_addresses),
        "received": mail.received,
        // The effective state: read in the mailbox, or read here (see
        // `MailMessageRow::is_read` and `mail_mark_read`). One field, because a client
        // has one marker to draw and no decision to make about it.
        "is_read": mail.is_read(),
        "has_attachments": mail.has_attachments,
        "importance": mail.importance,
        "preview": mail.preview,
    })
}

fn mail_list_json(page: &[teams_lite::store::MailMessageRow], has_more: bool) -> Value {
    json!({
        "messages": page.iter().map(mail_header_json).collect::<Vec<Value>>(),
        "has_more": has_more,
    })
}

/// Serialize a cached body, including what the sanitizer had to remove so the UI can
/// explain a mail that is not rendered in full.
///
/// The mail's `header` rides along so opening `/m/<id>` cold — a deep link, a
/// reload, a restored tab — renders the subject, sender and recipients without a
/// second round-trip. A client that already has the header from its list simply
/// ignores it.
fn mail_body_json(mail: &teams_lite::store::MailMessageRow) -> Value {
    json!({
        "html": mail.body_html,
        "blocked_remote_images": mail.blocked_remote_images,
        "truncated": mail.body_truncated,
        "attachments": serde_json::from_str::<Value>(&mail.attachments)
            .unwrap_or_else(|_| json!([])),
        "header": mail_header_json(mail),
    })
}

// ---- calendar (READ-ONLY, see `calendar`) ----------------------------------

/// Read the mailbox's calendars from Graph under the shared retry policy.
async fn fetch_calendars(ctx: &Ctx) -> Result<Vec<calendar::Calendar>> {
    let http = ctx.http.clone();
    ctx.retry_graph(move |token| {
        let http = http.clone();
        async move { calendar::fetch_calendars(&http, &token).await }
    })
    .await
}

/// Sync the calendar list from Graph in the background, emitting
/// `calendars_changed` when any calendar's name, colour or order moved. Best-effort:
/// the calendar is a secondary surface, so a failure is logged and the cached list
/// stands.
fn sync_calendars_bg(ctx: Ctx) {
    tokio::spawn(async move {
        match fetch_calendars(&ctx).await {
            Ok(calendars) => {
                let changed = ctx
                    .store()
                    .and_then(|store| calendar::persist_calendars(&store, &calendars));
                match changed {
                    Ok(true) => ctx.emit("calendars_changed", json!({})),
                    Ok(false) => {}
                    Err(e) => eprintln!("[calendar] could not persist calendars: {e}"),
                }
            }
            Err(e) => eprintln!("[calendar] calendar sync failed: {e:#}"),
        }
    });
}

/// Re-read a contiguous span of calendar-months from Graph and reconcile it into the
/// store, for every calendar in `calendars`. Returns whether anything changed, so the
/// caller only emits an event when it did.
///
/// ONE request per calendar covering the whole span, rather than one per
/// (calendar, month): a month grid reaches into three calendar months, and three
/// sequential round-trips per calendar would be plainly visible on the first paint.
/// The results are then split back into months, because a month is the unit the
/// store records as synced and the unit it reconciles.
///
/// Reconciling means pruning: an event held locally that the fresh read does not
/// list has been deleted, moved out of the window, or had its whole series removed in
/// real Outlook, and must disappear here too (see `Store::prune_calendar_window`).
async fn refresh_calendar_span(
    ctx: &Ctx,
    calendars: &[String],
    months: &[calendar::Month],
) -> Result<bool> {
    let (Some(first), Some(last)) = (months.first(), months.last()) else {
        return Ok(false);
    };
    let (span_start, span_end) = (first.start(), last.end());

    let mut changed = false;
    for calendar_id in calendars {
        let http = ctx.http.clone();
        let id = calendar_id.clone();
        let (from, to) = (span_start.clone(), span_end.clone());
        let view = ctx
            .retry_graph(move |token| {
                let http = http.clone();
                let (id, from, to) = (id.clone(), from.clone(), to.clone());
                async move { calendar::fetch_view(&http, &token, &id, &from, &to).await }
            })
            .await?;
        if view.truncated {
            // Never a silent truncation: a short month reads as a quiet one.
            eprintln!(
                "[calendar] {calendar_id} {span_start}..{span_end} has more events than one \
                 sync reads; the view is incomplete"
            );
        }

        let store = ctx.store()?;
        changed |= calendar::persist_events(&store, &view.events)? > 0;
        for month in months {
            let (month_start, month_end) = (month.start(), month.end());
            // The ids this month is allowed to keep, decided by the SAME overlap rule
            // the store's range query uses — see `calendar::overlaps`.
            let keep: Vec<String> = view
                .events
                .iter()
                .filter(|e| calendar::overlaps(e, &month_start, &month_end))
                .map(|e| e.id.clone())
                .collect();
            // A truncated read is not authoritative about what is absent, so it must
            // not prune: it would delete events it simply did not get to.
            if !view.truncated {
                changed |= store
                    .prune_calendar_window(calendar_id, &month_start, &month_end, &keep)?
                    > 0;
                store.mark_calendar_month_synced(calendar_id, &month.key())?;
            }
        }
    }
    Ok(changed)
}

/// Broadcast the currently watched calendar window to every connected UI.
fn emit_calendar_view(ctx: &Ctx) {
    let Some(watch) = ctx.calendar_watch.lock().ok().and_then(|w| w.clone()) else {
        return;
    };
    let Ok(store) = ctx.store() else { return };
    let Ok(events) = store.calendar_events(&watch.start, &watch.end, &watch.calendars) else {
        return;
    };
    ctx.emit(
        "calendar_view_updated",
        calendar_view_json(&events, &watch.start, &watch.end),
    );
}

/// How often the watched calendar window is re-read. Slower than mail: a meeting
/// moved five minutes ago is worth knowing about, a meeting moved five seconds ago is
/// not worth a request every few seconds — and this is one request per visible
/// calendar.
const CALENDAR_POLL_INTERVAL: Duration = Duration::from_secs(120);

/// The calendar live loop: re-read the window a UI is looking at on a timer and
/// broadcast it when it changed.
///
/// A poll, not a push, for the same reason mail polls: trouter carries no calendar
/// traffic, and Graph's change notifications need a public webhook.
///
/// LAZY BY DESIGN: the watch starts empty, so this loop makes NO requests until a
/// client opens the calendar. A user who only ever chats pays nothing for it.
fn spawn_calendar_sync(ctx: Ctx) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(CALENDAR_POLL_INTERVAL).await;
            let Some(watch) = ctx.calendar_watch.lock().ok().and_then(|w| w.clone()) else {
                continue;
            };
            let months = calendar::months_covering(&watch.start, &watch.end);
            match refresh_calendar_span(&ctx, &watch.calendars, &months).await {
                Ok(true) => emit_calendar_view(&ctx),
                Ok(false) => {}
                // A transient failure is not worth telling the UI about: the cached
                // window is still valid and the next tick retries.
                Err(e) => eprintln!("[calendar] poll of the watched window failed: {e:#}"),
            }
        }
    });
}

/// Serialize one calendar for the sidebar.
fn calendar_json(calendar: &teams_lite::store::CalendarRow) -> Value {
    json!({
        "id": calendar.id,
        "name": calendar.name,
        "hex_color": calendar.hex_color,
        "is_default": calendar.is_default,
        "can_edit": calendar.can_edit,
        "position": calendar.position,
    })
}

/// Serialize one event. `attendees` and `categories` are stored as JSON and pass
/// straight through — nothing in the backend looks inside them.
fn calendar_event_json(event: &teams_lite::store::CalendarEventRow) -> Value {
    let array = |raw: &str| serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!([]));
    json!({
        "id": event.id,
        "calendar_id": event.calendar_id,
        "subject": event.subject,
        "preview": event.preview,
        "start": event.start_utc,
        "end": event.end_utc,
        "is_all_day": event.is_all_day,
        "is_cancelled": event.is_cancelled,
        "is_organizer": event.is_organizer,
        "organizer": { "name": event.organizer_name, "address": event.organizer_address },
        "location": event.location,
        "join_url": event.join_url,
        "web_link": event.web_link,
        "show_as": event.show_as,
        "response": event.response,
        "series": event.series,
        "recurrence": event.recurrence,
        "importance": event.importance,
        "sensitivity": event.sensitivity,
        "categories": array(&event.categories),
        "attendees": array(&event.attendees),
        "attendee_count": event.attendee_count,
        "has_attachments": event.has_attachments,
        "reminder_minutes": event.reminder_minutes,
    })
}

/// A window of events plus the window itself, so a client can tell a late-arriving
/// `calendar_view_updated` for a month it has navigated away from apart from one for
/// the month it is showing.
fn calendar_view_json(
    events: &[teams_lite::store::CalendarEventRow],
    start: &str,
    end: &str,
) -> Value {
    json!({
        "start": start,
        "end": end,
        "events": events.iter().map(calendar_event_json).collect::<Vec<Value>>(),
    })
}

fn parse_reply_to(value: &Value) -> Result<teams_send::ReplyTo> {
    Ok(teams_send::ReplyTo {
        compose_time: value
            .get("compose_time")
            .and_then(Value::as_i64)
            .context("missing param: reply_to.compose_time")?,
        sender: param_str(value, "sender")?,
        sender_mri: value
            .get("sender_mri")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        preview: param_str(value, "preview")?,
        before: param_str(value, "before")?,
        after: param_str(value, "after")?,
    })
}

/// The people a `presence` request asks about: either a single `mri` or an `mris`
/// array. Every entry must be a person mri, and the batch is capped, so nothing
/// unbounded or unexpected is ever forwarded to the presence service.
fn presence_mris(params: &Value) -> Result<Vec<String>> {
    let mris: Vec<String> = match params.get("mris") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => vec![param_str(params, "mri")?],
    };
    anyhow::ensure!(!mris.is_empty(), "missing param: mri");
    anyhow::ensure!(
        mris.len() <= teams_presence::MAX_BATCH,
        "too many mris in one presence request"
    );
    anyhow::ensure!(
        mris.iter().all(|m| teams_profiles::is_person_mri(m)),
        "not a person mri"
    );
    Ok(mris)
}

/// The mail addresses of a `people_by_address` request. Every entry must be a
/// plain, single address: the batch is bounded, and anything that is not one is
/// refused here rather than sent upstream.
fn address_batch(params: &Value) -> Result<Vec<String>> {
    let addresses: Vec<String> = match params.get("addresses") {
        Some(Value::Array(items)) => {
            items.iter().filter_map(Value::as_str).map(str::to_string).collect()
        }
        _ => vec![param_str(params, "address")?],
    };
    anyhow::ensure!(!addresses.is_empty(), "missing param: address");
    anyhow::ensure!(
        addresses.len() <= teams_profiles::MAX_BATCH,
        "too many addresses in one request"
    );
    anyhow::ensure!(
        addresses.iter().all(|a| teams_profiles::is_mail_address(a)),
        "not a mail address"
    );
    Ok(addresses)
}

/// Wire shape of a person's directory card (see the `profile` method).
fn profile_json(p: &teams_profiles::Profile) -> Value {
    json!({
        "found": true,
        "mri": p.mri,
        "object_id": p.object_id,
        "display_name": p.display_name,
        "given_name": p.given_name,
        "surname": p.surname,
        "email": p.email,
        "user_principal_name": p.user_principal_name,
        "job_title": p.job_title,
        "department": p.department,
        "company_name": p.company_name,
        "office_location": p.office_location,
        "tenant_name": p.tenant_name,
        "user_type": p.user_type,
    })
}

/// Wire shape of one person's presence (see the `presence` method).
fn presence_json(p: &teams_presence::Presence) -> Value {
    json!({
        "mri": p.mri,
        "availability": p.availability,
        "activity": p.activity,
        "last_active_ms": p.last_active_ms,
        "out_of_office": p.out_of_office,
        "out_of_office_note": p.out_of_office_note,
        "note": p.note,
    })
}

fn param_str(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .with_context(|| format!("missing param: {key}"))
}

/// What one entry of an imported pack asks to be written: the art it carries, the name it
/// aliases, or nothing at all.
///
/// It is a function of its own because `alias_of` is a plain string whose EMPTY value means
/// "this row is art" — `custom_emoji_export` writes `""` on every picture — so a branch
/// taken on `Some("")` sent every picture down the ALIAS path, where the store rightly
/// refuses a row that is neither art nor an alias. A whole pack then imported nothing, and
/// the round-trip test passed because it decided this for itself instead of asking here.
/// One place reads that sentinel now: `import_order` asks the same question.
#[derive(Debug, PartialEq, Eq)]
enum ImportEntry<'a> {
    Art(&'a str),
    Alias(&'a str),
}

fn import_entry(entry: &Value) -> Option<ImportEntry<'_>> {
    if let Some(alias) = nonempty_str(entry, "alias_of") {
        return Some(ImportEntry::Alias(alias));
    }
    nonempty_str(entry, "data_base64").map(ImportEntry::Art)
}

/// A string field of `entry` that says something. An exported pack writes `""` for the half
/// of a row it does not use, so "absent" and "empty" mean the same thing here.
fn nonempty_str<'a>(entry: &'a Value, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

/// The pack's art for every custom emoji code in `html`, in first-appearance order.
///
/// Both outbound paths need it — a send and an edit — and one copy each was one chance
/// each to drift: an emoji that survives a send but not an edit is exactly what the
/// code-is-the-wire-format design (AGENTS.md § Custom emoji) exists to prevent. A code the
/// pack does not hold is simply absent, so `substitute_codes` leaves it as the text it is,
/// and a store this backend cannot open costs the art and never the message.
fn custom_emoji_art_in(ctx: &Ctx, html: &str) -> Vec<teams_send::EmojiArt> {
    let Ok(store) = ctx.store() else {
        return Vec::new();
    };
    custom_emoji::codes_in_body(html)
        .into_iter()
        .filter_map(|code| {
            let (content_type, bytes) = store.custom_emoji_art(&code).ok().flatten()?;
            Some(teams_send::EmojiArt { name: code, content_type, bytes })
        })
        .collect()
}

/// One row of `custom_emoji_export`, and the only place that shape is spelled.
///
/// `art` answers the base64 of the emoji's own bytes, and an ALIAS carries `""` — the
/// sentinel `import_entry` reads to tell the two kinds apart, which makes the export and
/// the import two halves of one contract. It is a function rather than an inline `map`
/// because the test that pins the round trip has to drive THIS shape: it hand-rolled the
/// mapping once and stayed green while the export dropped the very field the import needs.
fn export_row(emoji: &custom_emoji::CustomEmoji, art: impl FnOnce(&str) -> String) -> Value {
    let data_base64 = if emoji.alias_of.is_empty() {
        art(&emoji.name)
    } else {
        String::new()
    };
    json!({
        "name": emoji.name,
        "alias_of": emoji.alias_of,
        "content_type": emoji.content_type,
        "data_base64": data_base64,
        "width": emoji.width,
        "height": emoji.height,
    })
}

/// A custom emoji pack's entries in the order they can be IMPORTED: art first, aliases
/// second, each half in the order the file gave them.
///
/// An alias may only name art the pack already holds, and `custom_emoji_export` sorts by
/// NAME — so `ship`, the alias of `shipit`, arrived first and was refused every time a
/// pack was exported and read back in. The order the file lists them in is not something
/// the importer can rely on either way, since another machine wrote it.
fn import_order(entries: &[Value]) -> Vec<&Value> {
    let (aliases, art): (Vec<&Value>, Vec<&Value>) = entries
        .iter()
        .partition(|entry| matches!(import_entry(entry), Some(ImportEntry::Alias(_))));
    art.into_iter().chain(aliases).collect()
}

/// WHICH meeting a `call_prepare` / `call_join` is about, in either way one can be named.
///
/// A meeting has two addresses and they come from two surfaces the user actually has:
/// `join_url` is the link a CALENDAR event carries, and `meeting_thread` is the meeting's own
/// conversation from the CHAT LIST — where a meeting the user was invited to already sits,
/// with no link anywhere in it (this tenant's invitations carry the short `/meet/{code}`
/// shape, and that code lives in the calendar event alone). Both parse to one
/// [`calling::MeetingJoin`], so everything downstream knows one address type.
///
/// `Ok(None)` means the caller named neither, which is how the placing branch of
/// `call_prepare` is told apart from the joining one. A value that IS named and does not
/// parse is an error rather than a fallthrough: a join that quietly became a call would ring
/// people instead of walking into a meeting.
fn meeting_address(params: &Value) -> Result<Option<calling::MeetingJoin>> {
    if let Some(join_url) = params.get("join_url").and_then(Value::as_str) {
        return calling::MeetingJoin::from_join_url(join_url).map(Some).context(
            "that is not a Teams meeting link — this app joins a meeting from its own join \
             link and nothing else",
        );
    }
    if let Some(thread) = params.get("meeting_thread").and_then(Value::as_str) {
        return calling::MeetingJoin::from_thread_id(thread).map(Some).context(
            "that conversation is not a meeting — only a meeting's own thread can be joined, \
             and a group chat is called instead",
        );
    }
    Ok(None)
}

/// How many people one call may ring at once.
///
/// A group call is the same POST as a 1:1 (`calling::invitation_payload`), so nothing in the
/// protocol imposes this — what does is that every one of them is a device buzzing in
/// somebody's pocket, and a mis-click on a 60-person thread cannot be taken back. Twenty is
/// the size Teams itself stops tracking a thread's read receipts at, which is a fair line
/// between a group and a broadcast. Above it the user still has real Teams, which is where a
/// meeting for that many people belongs.
const MAX_GROUP_CALL_PEOPLE: usize = 20;

/// The modalities a media answer declares, checked against the four the service names.
///
/// It is a check rather than a pass-through because a modality is a CLAIM about what the
/// user's machine is sending: `ScreenSharer` says their screen is on the wire. A client that
/// could write anything here could make that claim on a body that does not carry it, and the
/// service would believe the words. `audio` is the floor — an answer that declares nothing
/// declares the call's own modality, which is the one this app has always had.
fn param_modalities(params: &Value) -> Result<Vec<String>> {
    const KNOWN: [&str; 4] = [
        calling::MODALITY_AUDIO,
        calling::MODALITY_VIDEO,
        calling::MODALITY_SCREEN_SHARER,
        calling::MODALITY_SCREEN_VIEWER,
    ];
    let asked = param_str_list(params, "modalities");
    if asked.is_empty() {
        return Ok(vec![calling::MODALITY_AUDIO.to_string()]);
    }
    for name in &asked {
        if !KNOWN.iter().any(|known| known.eq_ignore_ascii_case(name)) {
            anyhow::bail!("{name:?} is not a modality this app negotiates");
        }
    }
    Ok(asked)
}

/// An optional array-of-strings parameter, empty when absent, not an array, or made
/// only of blanks. Callers treat "empty" as "no filter", so a malformed value
/// degrades to the unfiltered result rather than to an error.
fn param_str_list(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Build the non-secret view of the app settings for the UI: the configured
/// GitLab host (falling back to the default), whether each integration's token is
/// stored, and whether Ghost mode is on. A raw token is deliberately never included —
/// the UI only needs to know it is set, never its value.
fn settings_json(store: &Store) -> Result<Value> {
    let settings = link_preview_settings(store)?;
    let hours = available_hours(store)?;
    // Whether the status is green THIS minute, which is a fact only this process holds: it
    // owns the clock the heartbeat acts on, and the zone the window is kept in. So the page
    // is told rather than left to work it out (the reading `mentions_me` already takes), and
    // the heartbeat says so again when the hours turn.
    let available_now = presence_intent(store, chrono::Utc::now())?.unwrap_or(false);
    Ok(json!({
        "gitlab_host": settings.gitlab_host,
        "gitlab_token_set": settings.gitlab_token.is_some(),
        "linear_token_set": settings.linear_token.is_some(),
        "ghost_mode": ghost_mode(store)?,
        "always_available": always_available(store)?,
        "available_from": hours.map(|h| teams_presence::format_hhmm(h.from)),
        "available_to": hours.map(|h| teams_presence::format_hhmm(h.to)),
        // The zone by NAME, so the pane can say whose morning those hours are — `null` is
        // this machine's own, which is what an install that never set one keeps.
        "available_zone": available_zone(store)?.map(|zone| zone.name().to_string()),
        "available_now": available_now,
        "sender_icons": sender_icons_enabled(store)?,
        "emoji_auto_import": emoji_auto_import_enabled(store)?,
        // Whether a notification about a SEALED chat carries the words. Off unless the user
        // turned it on (see `SETTING_SEALED_PUSH_WORDS`).
        "sealed_push_words": store.get_setting(SETTING_SEALED_PUSH_WORDS)?.as_deref() == Some("1"),
    }))
}

/// How long a cached Linear workspace stands before it is read again.
///
/// Wide on purpose: a workspace's url key never moves and a team is added a few times
/// a year, so what the window buys is that the page's ask on every connect is answered
/// from disk. A team added inside it costs exactly one thing — a reference to that
/// team's key stays the text it is until the window turns, which is the same direction
/// every other unknown in this app fails in.
const LINEAR_WORKSPACE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// The wire shape of `linear_workspace`, which is also the cached one: the workspace
/// (or `null`, for a machine with no key or a key Linear refused) and the moment it was
/// read.
///
/// `null` is cached as deliberately as an answer is. Without it, a machine that holds no
/// Linear key would ask Linear on every connect — and the reading a page takes from it is
/// the same either way: a bare `ENG-123` stays plain text until something says otherwise.
fn linear_workspace_json(workspace: Option<&linear::Workspace>, read_at_ms: i64) -> Value {
    json!({ "workspace": workspace, "read_at_ms": read_at_ms })
}

/// The cached workspace answer, when one is there and still inside its window.
///
/// `Some(value)` is an answer to publish as it stands; `None` means "read Linear". A
/// stored value that no longer parses reads as absent, because the only thing to do with
/// one is to read again.
fn fresh_linear_workspace(store: &Store, now_ms: i64) -> Result<Option<Value>> {
    let Some(raw) = store.get_setting(SETTING_LINEAR_WORKSPACE)? else {
        return Ok(None);
    };
    let Ok(cached) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let read_at_ms = cached.get("read_at_ms").and_then(Value::as_i64).unwrap_or(0);
    let age_ms = now_ms.saturating_sub(read_at_ms);
    let fresh = read_at_ms > 0 && age_ms < LINEAR_WORKSPACE_TTL.as_millis() as i64;
    Ok(fresh.then_some(cached))
}

/// Answer `linear_workspace`: the cached workspace while it is fresh, and otherwise
/// what Linear says now.
///
/// A read that FAILED falls back to whatever was last stored, however old: a url key
/// from this morning addresses every issue just as well, and the alternative is a page
/// that draws no chip because Linear was slow once. With nothing stored, the failure is
/// the answer — a reference then stays the text it is, which is what it was before.
async fn linear_workspace(ctx: &Ctx) -> Result<Value> {
    let now = now_ms();
    let (settings, cached) = {
        let store = ctx.store()?;
        (link_preview_settings(&store)?, fresh_linear_workspace(&store, now)?)
    };
    if let Some(cached) = cached {
        return Ok(cached);
    }
    match linear::fetch_workspace(&ctx.http, settings.linear_token.as_deref()).await {
        Ok(workspace) => {
            let answer = linear_workspace_json(workspace.as_ref(), now);
            // Best-effort: a store that will not take the answer costs the cache, never
            // the answer.
            if let Ok(store) = ctx.store() {
                let _ = store.set_setting(SETTING_LINEAR_WORKSPACE, &answer.to_string());
            }
            Ok(answer)
        }
        Err(err) => {
            match ctx.store().ok().and_then(|store| stored_linear_workspace(&store)) {
                Some(stale) => {
                    eprintln!("[linear] workspace read failed, serving the stored one: {err:#}");
                    Ok(stale)
                }
                None => Err(err),
            }
        }
    }
}

/// The stored workspace answer whatever its age, for the one caller that wants a stale
/// one: a read that failed.
fn stored_linear_workspace(store: &Store) -> Option<Value> {
    store
        .get_setting(SETTING_LINEAR_WORKSPACE)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

/// Is "Always available" on? Off unless the stored value is exactly `"1"`, so a
/// missing, empty or malformed setting reads as off — and the safe default of a
/// setting that publishes the user's own status is that it publishes nothing.
fn always_available(store: &Store) -> Result<bool> {
    Ok(store.get_setting(SETTING_ALWAYS_AVAILABLE)?.as_deref() == Some("1"))
}

/// The hours the switch above keeps the user green, or `None` for all day (see
/// [`SETTING_AVAILABLE_HOURS`]).
fn available_hours(store: &Store) -> Result<Option<teams_presence::AvailableHours>> {
    Ok(store
        .get_setting(SETTING_AVAILABLE_HOURS)?
        .as_deref()
        .and_then(teams_presence::AvailableHours::parse_setting))
}

/// The zone those hours are kept in, or `None` for this machine's own (see
/// [`SETTING_AVAILABLE_ZONE`]).
fn available_zone(store: &Store) -> Result<Option<chrono_tz::Tz>> {
    Ok(store
        .get_setting(SETTING_AVAILABLE_ZONE)?
        .as_deref()
        .and_then(teams_presence::parse_zone))
}

/// What this backend should do about the user's own status at `minute_of_day`:
///
/// * `None` — the switch is off, so there is nothing to publish and nothing to take back
///   (the RPC that turned it off already withdrew the registration). This is what the
///   heartbeat did on every tick before the setting had hours, and it is why an install
///   that never turned the setting on makes no presence request at all.
/// * `Some(true)` — inside the hours: register, and keep registering, because a
///   registration expires ([`PRESENCE_HEARTBEAT`]).
/// * `Some(false)` — the switch is on and the hours are not: withdraw, once.
///
/// The INSTANT is a parameter rather than a clock read, so the whole decision — the zone
/// included — is testable: 01:00Z is 03:00 in Paris and 10:00 in Tokyo, and which of those
/// the window is compared against is the one thing this feature can get silently wrong.
fn presence_intent(store: &Store, now: chrono::DateTime<chrono::Utc>) -> Result<Option<bool>> {
    if !always_available(store)? {
        return Ok(None);
    }
    let minute = teams_presence::minute_of_day(now, available_zone(store)?);
    Ok(Some(teams_presence::should_publish(true, available_hours(store)?, minute)))
}

/// The window a `set_always_available` call carries: both ends, or neither.
///
/// A HALF window is refused rather than half-applied — "from 08:00" with no end reads
/// equally as "all day from 8" and as "8 until whenever", so the caller has to say which.
/// Both absent, or both `null`, is all day: the setting as it was before it grew hours,
/// which is what keeps an older page working against this backend.
fn available_hours_param(params: &Value) -> Result<Option<teams_presence::AvailableHours>> {
    let hour = |key: &str| {
        params.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
    };
    match (hour("from"), hour("to")) {
        (None, None) => Ok(None),
        (Some(from), Some(to)) => Ok(Some(teams_presence::AvailableHours::parse_pair(from, to)?)),
        _ => anyhow::bail!(
            "`from` and `to` are a pair: send both hours, or neither to be available all day"
        ),
    }
}

/// The zone a `set_always_available` call carries: an IANA name, or nothing for the
/// machine's own.
///
/// A name the database does not hold is REFUSED rather than quietly ignored: the whole point
/// of the setting is that the hours are somebody's own morning, and a typo silently answered
/// with this machine's zone publishes their status at hours nobody chose.
fn available_zone_param(params: &Value) -> Result<Option<chrono_tz::Tz>> {
    let Some(name) =
        params.get("zone").and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
    else {
        return Ok(None);
    };
    teams_presence::parse_zone(name)
        .with_context(|| format!("`zone` is not an IANA time zone: {name}"))
        .map(Some)
}

/// The presence endpoint id this store's backends register, minted once and then
/// kept (see [`SETTING_PRESENCE_ENDPOINT_ID`]).
fn presence_endpoint_id(store: &Store) -> Result<String> {
    if let Some(id) = store.get_setting(SETTING_PRESENCE_ENDPOINT_ID)?.filter(|id| !id.is_empty()) {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    store.set_setting(SETTING_PRESENCE_ENDPOINT_ID, &id)?;
    Ok(id)
}

/// Wire shape of a sender icon: the same `{ found, content_type, data_base64 }` as
/// `fetch_avatar`, so the UI's avatar path needs no new case. `None` — no icon, or the
/// feature held back — answers `found: false`, which is the tinted initials the mail
/// list already draws from the same domain.
fn sender_icon_json(icon: Option<&teams_media::Media>) -> Value {
    match icon {
        Some(icon) => json!({
            "found": true,
            "content_type": icon.content_type,
            "data_base64": base64::engine::general_purpose::STANDARD.encode(&icon.bytes),
        }),
        None => json!({ "found": false }),
    }
}

/// Are sender icons on? On unless the stored value is exactly `"0"`. The opposite
/// default from every other switch here, and deliberately: the user asked for the mark,
/// and what makes the request defensible is the set of rails in [`sender_icon`] rather
/// than a flag they would have to find first.
fn sender_icons_enabled(store: &Store) -> Result<bool> {
    Ok(store.get_setting(SETTING_SENDER_ICONS)?.as_deref() != Some("0"))
}

/// Is the emoji auto-import on? On unless the stored value is exactly `"0"`, the same
/// reading `sender_icons_enabled` takes and for the same reason — the user asked for the
/// behaviour, and what bounds it is the code around it (see [`SETTING_EMOJI_AUTO_IMPORT`]).
fn emoji_auto_import_enabled(store: &Store) -> Result<bool> {
    Ok(store.get_setting(SETTING_EMOJI_AUTO_IMPORT)?.as_deref() != Some("0"))
}

/// Whether a notification about a sealed chat may carry the WORDS.
///
/// OFF unless the user turned it on — the reverse of every other switch read this way, and the
/// reverse on purpose: a store this backend cannot read must not publish the words of a sealed
/// conversation to a lock screen on the strength of a failed read.
fn sealed_push_words(ctx: &Ctx) -> bool {
    ctx.store()
        .ok()
        .and_then(|store| store.get_setting(SETTING_SEALED_PUSH_WORDS).ok())
        .flatten()
        .as_deref()
        == Some("1")
}

/// Is Ghost mode on? Off unless the stored value is exactly `"1"`, so a missing,
/// empty or malformed setting reads as off — the safe default is the one the user
/// expects from a chat client (opening a chat reads it on Teams too).
fn ghost_mode(store: &Store) -> Result<bool> {
    Ok(store.get_setting(SETTING_GHOST_MODE)?.as_deref() == Some("1"))
}

/// Read what the link-preview integrations need from the store: the GitLab host
/// (falling back to the default) and one token per provider. A stored empty
/// string means "no token", which is how the UI clears one.
fn link_preview_settings(store: &Store) -> Result<link_preview::Settings> {
    let token = |key: &str| -> Result<Option<String>> {
        Ok(store.get_setting(key)?.filter(|t| !t.is_empty()))
    };
    Ok(link_preview::Settings {
        gitlab_host: store
            .get_setting(SETTING_GITLAB_HOST)?
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| gitlab::DEFAULT_HOST.to_string()),
        gitlab_token: token(SETTING_GITLAB_TOKEN)?,
        linear_token: token(SETTING_LINEAR_TOKEN)?,
    })
}

// ---- the merge-request page's read cache ------------------------------------
//
// Four reads, one mechanism: answer from `gitlab_reads` at once, and when that answer is
// older than its own window, refresh behind the page and broadcast the fresh one. The page
// therefore never waits on GitLab for something it has seen before, which is what makes
// switching between merge requests feel local — and a backend restart costs nothing,
// because the cache is on disk.
//
// The windows differ by what a stale answer COSTS, not by how expensive the read is:

/// A list of merge requests moves when somebody opens or closes one, which is minutes
/// apart. A minute of staleness in the sidebar is invisible; the row the user clicks is
/// re-read as a detail anyway.
const GITLAB_LIST_TTL: Duration = Duration::from_secs(60);
/// A detail carries the state a MERGE is offered from, so it is worth less staleness than
/// the list — and GitLab refuses a merge on a stale `sha` regardless, so this window
/// decides how often the page corrects itself rather than whether it can be wrong.
const GITLAB_DETAIL_TTL: Duration = Duration::from_secs(30);
/// A comment thread is a conversation: half a minute behind is a chat client's own
/// tolerance, and posting one refreshes it immediately anyway.
const GITLAB_NOTES_TTL: Duration = Duration::from_secs(30);
/// THE live one. A running pipeline changes every few seconds and the page polls it, so the
/// window is short enough that a job turning green is seen when it happens — and long
/// enough that two open pages, or a page and a phone, cost ONE request between them.
const GITLAB_PIPELINE_TTL: Duration = Duration::from_secs(5);
/// THE BIG one, and the one that moves least. A diff changes only when somebody PUSHES to
/// the branch, which is minutes or hours apart, and the expanded read is half a megabyte on
/// a large merge request — so this is the longest window on the page. It matters little
/// either way: a push moves the `sha` the detail carries within 30 s, and the reader's own
/// Reload asks for a fresh one.
const GITLAB_DIFF_TTL: Duration = Duration::from_secs(120);
/// A job's log while the job is still RUNNING: the live one, beside the pipeline's own and for
/// its reason — a reader watching a job work wants the line that just arrived.
const GITLAB_JOB_LOG_LIVE_TTL: Duration = Duration::from_secs(5);
/// A job's log once the job has FINISHED. A settled log never changes again — a retry is a new
/// job with a new id, so it is a different cache entry — which is why this window is a day
/// rather than a minute: re-opening a red job costs nothing, and this is the biggest read on
/// the page (up to 1 MiB, against a diff's half). Only an ERASE can falsify it, which is a
/// manual act on GitLab's side, and the reader's own Reload asks again.
const GITLAB_JOB_LOG_SETTLED_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a cached GitLab answer stays fresh.
///
/// Four of the six reads have a window that is a constant, and they say so by being one
/// ([`From<Duration>`]). A job's LOG is the one whose window depends on the answer itself: the
/// same read is the liveliest on the page while a job runs and final the moment it stops, and
/// only the payload knows which. Deciding it from a client's claim would be the same answer
/// with a way to get it wrong.
#[derive(Clone, Copy)]
enum GitLabTtl {
    Fixed(Duration),
    JobLog,
}

impl From<Duration> for GitLabTtl {
    fn from(window: Duration) -> Self {
        Self::Fixed(window)
    }
}

impl GitLabTtl {
    /// The window this cached answer is fresh for.
    ///
    /// A payload that does not say whether its job finished is read as UNFINISHED — the live
    /// window — because an answer from an older build must not be cached for a day on the
    /// strength of a field it never carried.
    fn window(self, cached: &Value) -> Duration {
        match self {
            Self::Fixed(window) => window,
            Self::JobLog => {
                if cached.get("complete").and_then(Value::as_bool).unwrap_or(false) {
                    GITLAB_JOB_LOG_SETTLED_TTL
                } else {
                    GITLAB_JOB_LOG_LIVE_TTL
                }
            }
        }
    }
}

/// One read of the merge-request page, and everything needed to make it again.
///
/// It exists so the CACHED path and the REFRESH path cannot drift: a background refresh
/// re-runs this exact value, so what lands in the cache is what the handler would have
/// answered. Cheap to clone (two strings at most), which is what lets a stale answer be
/// returned and refreshed in the same breath.
#[derive(Clone)]
enum GitLabRead {
    List(gitlab_mr::ListQuery),
    Detail { project_path: String, iid: u64 },
    Notes { project_path: String, iid: u64 },
    Pipeline { project_path: String, iid: u64 },
    Diff { project_path: String, iid: u64, depth: gitlab_mr::DiffDepth },
    /// ONE job's log. The merge request travels for the cache prefix alone — GitLab addresses a
    /// job by its own id — so a write to the merge request drops its jobs' logs with everything
    /// else about it.
    JobLog { project_path: String, iid: u64, job_id: u64 },
}

impl GitLabRead {
    /// Make the read against GitLab and return the JSON the page gets.
    async fn fetch(&self, ctx: &Ctx) -> Result<Value> {
        let settings = {
            let store = ctx.store()?;
            link_preview_settings(&store)?
        };
        let host = settings.gitlab_host.as_str();
        let token = settings.gitlab_token.as_deref();
        Ok(match self {
            Self::List(query) => {
                json!(gitlab_mr::fetch_list(&ctx.http, host, token, *query).await?)
            }
            Self::Detail { project_path, iid } => {
                json!(gitlab_mr::fetch_detail(&ctx.http, host, token, project_path, *iid).await?)
            }
            Self::Notes { project_path, iid } => {
                json!(gitlab_mr::fetch_discussions(&ctx.http, host, token, project_path, *iid).await?)
            }
            // The pipeline is TWO reads, and the second one cannot fail the first. GitLab's
            // REST jobs endpoint carries neither `needs` nor the pipeline's stage ORDER — it
            // answers newest first, which is reverse stage order — so both are read over
            // GraphQL afterwards (`gitlab_ci_graph`) and attached in place. A GitLab that will
            // not answer costs the dependency mode and leaves the stages ordered by the jobs'
            // own ids.
            Self::Pipeline { project_path, iid } => {
                let mut view =
                    gitlab_mr::fetch_pipeline(&ctx.http, host, token, project_path, *iid).await?;
                gitlab_ci_graph::attach(
                    &ctx.http,
                    host,
                    token,
                    project_path,
                    *iid,
                    &mut view,
                )
                .await;
                json!(view)
            }
            Self::Diff { project_path, iid, depth } => {
                json!(
                    gitlab_mr::fetch_diff(&ctx.http, host, token, project_path, *iid, *depth)
                        .await?
                )
            }
            Self::JobLog { project_path, job_id, .. } => {
                json!(
                    gitlab_mr::fetch_job_log(&ctx.http, host, token, project_path, *job_id).await?
                )
            }
        })
    }

    /// The event a fresh answer is broadcast on, and what identifies it there.
    ///
    /// A LIST goes out on its own event because the sidebar is what listens for it, and it
    /// names the query so a page showing another filter ignores it. The other three name
    /// the merge request and which read arrived, so an open page can replace one panel
    /// without touching the rest.
    fn event(&self) -> (&'static str, Value) {
        match self {
            Self::List(query) => (
                "gitlab_list_updated",
                json!({ "scope": query.scope.as_str(), "state": query.state.as_str() }),
            ),
            Self::Detail { project_path, iid } => (
                "gitlab_mr_updated",
                json!({ "project_path": project_path, "iid": iid, "kind": "detail" }),
            ),
            Self::Notes { project_path, iid } => (
                "gitlab_mr_updated",
                json!({ "project_path": project_path, "iid": iid, "kind": "notes" }),
            ),
            Self::Pipeline { project_path, iid } => (
                "gitlab_mr_updated",
                json!({ "project_path": project_path, "iid": iid, "kind": "pipeline" }),
            ),
            // The DEPTH is part of the kind, so a page showing the expanded diff is never
            // handed the plain one — which holds fewer patches — a moment after asking.
            Self::Diff { project_path, iid, depth } => (
                "gitlab_mr_updated",
                json!({
                    "project_path": project_path,
                    "iid": iid,
                    "kind": depth.cache_kind(),
                }),
            ),
            // WHICH job is in the payload's own `job.id`, so the kind names the READ. A page
            // watching one job's log ignores a frame about another for that reason, exactly as
            // the list ignores a frame about another filter.
            Self::JobLog { project_path, iid, .. } => (
                "gitlab_mr_updated",
                json!({ "project_path": project_path, "iid": iid, "kind": "job" }),
            ),
        }
    }
}

/// Answer one GitLab read: from the cache when it holds one, then refresh behind the page.
///
/// - A cached answer is returned WHATEVER its age, so the page paints at once.
/// - When that answer is older than `ttl`, a refresh runs in the background and the fresh
///   copy is broadcast. Nothing is awaited, so a slow GitLab never holds the page up.
/// - With nothing cached — a cold store, a filter never used — the read is awaited, because
///   answering "there is nothing" would be indistinguishable from an empty tracker.
/// - `refresh: true` is the user's own Reload: it awaits a fresh read and replaces the row.
async fn gitlab_cached(
    ctx: &Ctx,
    key: String,
    ttl: impl Into<GitLabTtl>,
    refresh: bool,
    read: GitLabRead,
) -> Result<Value> {
    let ttl = ttl.into();
    let mut value = None;
    if !refresh {
        let cached = {
            let store = ctx.store()?;
            store.gitlab_read(&key, now_ms())?
        };
        // An unparseable payload is treated as no payload: a build that changed a field's
        // shape must not serve the old one for a minute.
        if let Some((payload, age)) = cached {
            if let Ok(parsed) = serde_json::from_str::<Value>(&payload) {
                if age > ttl.window(&parsed).as_millis() as i64 {
                    let ctx_bg = ctx.clone();
                    let key_bg = key.clone();
                    let read_bg = read.clone();
                    tokio::spawn(async move {
                        gitlab_refresh_behind_the_page(&ctx_bg, key_bg, read_bg).await;
                    });
                }
                value = Some(parsed);
            }
        }
    }
    let mut value = match value {
        Some(value) => value,
        None => gitlab_fetch_and_cache(ctx, &key, &read).await?,
    };
    // The LAST thing that happens to any answer, on both paths, and never before the cache:
    // who these people are in Teams is local and current, and a copy of it frozen on disk
    // would outlive a rename.
    with_teams_people(ctx, &mut value);
    Ok(value)
}

/// How long a folded roster of Teams people is reused before it is built again.
///
/// The window's cost is one thing only: a colleague whose FIRST message this machine has
/// ever stored is drawn as a stranger on the GitLab page for up to a minute. Its benefit is
/// that opening a merge request — four reads at once — reads 294 people once instead of four
/// times, and that a pipeline poll every 6 s costs nothing. The same trade, and the same
/// minute, as the merge-request list's own window.
const TEAMS_PEOPLE_TTL: Duration = Duration::from_secs(60);

/// Add to one GitLab answer, in place, who each of its people is in Teams.
///
/// Called on every payload the page is handed — the four reads above, and the note a comment
/// write hands back — so a colleague wears one face and one name everywhere in this app. The
/// resolution itself is `tracker_people`; what lives here is where its two halves come from:
/// the roster to match a real name against, and each matched person's CURRENT display name,
/// which is [`store::Store::display_name_for_mri`] — the same read every other name in this
/// app goes through, so the user's own nickname wins here exactly as it does in a chat.
///
/// It cannot fail the read. A face and a nicer name are what this adds; a store that cannot
/// be opened costs them and leaves GitLab's own words, which is what the page drew before
/// this existed.
///
/// Both reads are LAZY, which is what keeps it off the hot path: the roster is built on the
/// first person the payload holds, and the store is opened on the first person who really
/// resolves. A pipeline — THE live read, polled every few seconds while CI runs — names
/// nobody at all, so it costs nothing here.
fn with_teams_people(ctx: &Ctx, value: &mut Value) {
    let mut roster: Option<Arc<tracker_people::Roster>> = None;
    let mut store: Option<Store> = None;
    // One lookup per distinct name, not per row: a hundred merge requests are written by a
    // couple of dozen people, and a comment thread by fewer.
    let mut resolved: std::collections::HashMap<String, Option<tracker_people::TeamsPerson>> =
        std::collections::HashMap::new();
    tracker_people::annotate(value, &mut |name| {
        if let Some(known) = resolved.get(name) {
            return known.clone();
        }
        let person = (|| {
            if roster.is_none() {
                roster = teams_people_of(ctx);
            }
            let mri = roster.as_ref()?.mri_for(name)?;
            if store.is_none() {
                store = ctx.store().ok();
            }
            let display = store.as_ref()?.display_name_for_mri(mri).ok().flatten()?;
            Some(tracker_people::TeamsPerson { mri: mri.to_string(), name: display })
        })();
        resolved.insert(name.to_string(), person.clone());
        person
    });
}

/// The folded roster of Teams people, from the cache when it is fresh enough.
///
/// `None` when the store cannot be read, which costs the identities and nothing else.
fn teams_people_of(ctx: &Ctx) -> Option<Arc<tracker_people::Roster>> {
    {
        let cached = ctx.tracker_people.lock().unwrap();
        if let Some((built, roster)) = cached.as_ref() {
            if now_ms().saturating_sub(*built) < TEAMS_PEOPLE_TTL.as_millis() as i64 {
                return Some(roster.clone());
            }
        }
    }
    let people = ctx.store().ok()?.named_people().ok()?;
    let roster = Arc::new(tracker_people::Roster::from_people(people));
    *ctx.tracker_people.lock().unwrap() = Some((now_ms(), roster.clone()));
    Some(roster)
}

/// Make one read, store it, and hand it back.
async fn gitlab_fetch_and_cache(ctx: &Ctx, key: &str, read: &GitLabRead) -> Result<Value> {
    let value = read.fetch(ctx).await?;
    // A read that could not be stored is still a read the page can have: the cache is a
    // performance feature, and failing the request over it would trade a working page for
    // a faster one.
    if let Ok(store) = ctx.store() {
        if let Err(e) = store.put_gitlab_read(key, &value.to_string(), now_ms()) {
            eprintln!("[gitlab] the answer for {key} could not be cached: {e:#}");
        }
    }
    Ok(value)
}

/// Refresh one read behind the page and broadcast the result — once per key at a time.
///
/// Single-flight through [`Ctx::gitlab_refreshing`]: two pages polling one pipeline, or one
/// page whose poll overlaps a slow answer, cost ONE request between them. A refusal is
/// broadcast too, on `gitlab_read_error`, because a page that keeps painting a stale answer
/// with no word is a page telling the user everything is fine.
async fn gitlab_refresh_behind_the_page(ctx: &Ctx, key: String, read: GitLabRead) {
    if !ctx.gitlab_refreshing.lock().unwrap().insert(key.clone()) {
        return;
    }
    let outcome = gitlab_fetch_and_cache(ctx, &key, &read).await;
    ctx.gitlab_refreshing.lock().unwrap().remove(&key);

    match outcome {
        Ok(mut value) => {
            // The same last step the handler's own answer takes: an event carries the page's
            // whole payload, so a fresh copy that skipped this would replace every face and
            // every Teams name with GitLab's own a moment after they were drawn.
            with_teams_people(ctx, &mut value);
            let (event, mut data) = read.event();
            if let (Some(object), Some(payload)) = (data.as_object_mut(), value.as_object()) {
                for (field, value) in payload {
                    object.insert(field.clone(), value.clone());
                }
            }
            ctx.emit(event, data);
        }
        Err(e) => ctx.emit("gitlab_read_error", json!({ "key": key, "error": e.to_string() })),
    }
}

/// Drop everything cached about one merge request, and tell every open page to re-read it.
///
/// Called by all four writes and by an approval: each makes the detail, the comments and
/// the pipeline wrong in the same instant, and a page that painted the stale copy back
/// would report the opposite of what the user just did. The list is deliberately NOT
/// dropped — it is a different read, and re-fetching a hundred rows because one row moved
/// is the cost the shared prefix exists to avoid; its own window closes within the minute.
fn forget_gitlab_merge_request(ctx: &Ctx, project_path: &str, iid: u64) {
    if let Ok(store) = ctx.store() {
        if let Err(e) = store.forget_gitlab_reads(&gitlab_mr::cache_prefix(project_path, iid)) {
            eprintln!("[gitlab] the cache of {project_path}!{iid} could not be dropped: {e:#}");
        }
    }
    ctx.emit(
        "gitlab_mr_updated",
        json!({ "project_path": project_path, "iid": iid, "kind": "stale" }),
    );
}

/// Which merge requests a list read asks for, from a client's params.
///
/// Both halves default rather than fail: a page that asked for nothing gets the sidebar's
/// own default — every open merge request the token can see — and a name outside the closed
/// set is refused rather than forwarded to GitLab as a query parameter.
fn gitlab_list_query(params: &Value) -> Result<gitlab_mr::ListQuery> {
    let scope = match params.get("scope").and_then(Value::as_str) {
        Some(name) => gitlab_mr::ListScope::from_str(name)
            .with_context(|| format!("unknown scope: {name}"))?,
        None => gitlab_mr::ListScope::All,
    };
    let state = match params.get("state").and_then(Value::as_str) {
        Some(name) => gitlab_mr::ListState::from_str(name)
            .with_context(|| format!("a merge-request list is opened or closed, not {name}"))?,
        None => gitlab_mr::ListState::Opened,
    };
    Ok(gitlab_mr::ListQuery { scope, state })
}

/// Which of the two diff reads a client asked for.
///
/// Defaults to the cheap one rather than failing, because that is what opening the Changes
/// section costs — and a name outside the closed set is refused rather than forwarded, since
/// it decides which GitLab endpoint the user's token reaches.
fn gitlab_diff_depth(params: &Value) -> Result<gitlab_mr::DiffDepth> {
    match params.get("depth").and_then(Value::as_str) {
        Some(name) => gitlab_mr::DiffDepth::from_str(name)
            .with_context(|| format!("a diff is listed or raw, not {name}")),
        None => Ok(gitlab_mr::DiffDepth::Listed),
    }
}

/// Longest project path accepted from a client. GitLab's own limit on a full path is 255
/// characters, so anything longer names nothing there.
const MAX_PROJECT_PATH_BYTES: usize = 255;

/// WHICH project a call is about, checked for shape.
///
/// The host is never in these params — it comes from the user's own settings and every
/// endpoint is built from [`gitlab::api_base`] — so this cannot repoint the token. What it
/// checks is that the path is a path: `gitlab::encode_path` would percent-encode a whole
/// URL into one harmless segment, but a request built from junk earns a 404 nobody can read,
/// and refusing it here says what was wrong instead.
fn gitlab_project_path_param(params: &Value) -> Result<String> {
    let project_path = param_str(params, "project_path")?.trim().to_string();
    anyhow::ensure!(!project_path.is_empty(), "`project_path` must name a project");
    anyhow::ensure!(
        project_path.len() <= MAX_PROJECT_PATH_BYTES,
        "`project_path` is longer than any GitLab project path"
    );
    anyhow::ensure!(
        !project_path.starts_with('/')
            && !project_path.ends_with('/')
            && !project_path.contains("//")
            && !project_path.contains("..")
            && !project_path.contains(':')
            && !project_path.chars().any(char::is_whitespace),
        "`project_path` must be a project path like \"group/sub/project\""
    );
    Ok(project_path)
}

/// WHICH merge request a call is about: a project path and an iid, checked for shape.
fn gitlab_merge_request_params(params: &Value) -> Result<(String, u64)> {
    let project_path = gitlab_project_path_param(params)?;
    let iid = params
        .get("iid")
        .and_then(Value::as_u64)
        .filter(|iid| *iid > 0)
        .context("`iid` must be the merge request's number")?;
    Ok((project_path, iid))
}

/// WHICH job a log read is about, checked for shape.
///
/// A job id becomes a path segment, so it is read as a NUMBER rather than forwarded as a
/// string: the rule the iid above already follows, and what stops a client from steering this
/// read at another endpoint of the project it names.
fn gitlab_job_id(params: &Value) -> Result<u64> {
    params
        .get("job_id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .context("`job_id` must be the job's own id")
}

/// Refuse a note that is not the user's OWN, before anything is written to it.
///
/// Whose comment it is comes from GITLAB — read now, matched on the account's own id — and
/// never from what the client claimed. GitLab would let a maintainer delete or edit a
/// colleague's note; this app never offers that, exactly as it refuses to delete a Teams
/// message that is not the user's own. `act` is the word the refusal uses, so a reader is told
/// which act was refused rather than a generic sentence covering two.
///
/// One place for two writes: the deletion and the edit make the same promise, and a second
/// copy of this check is a second chance to get it wrong.
async fn require_own_gitlab_note(
    ctx: &Ctx,
    settings: &link_preview::Settings,
    project_path: &str,
    iid: u64,
    note_id: u64,
    act: &str,
) -> Result<()> {
    let discussions = gitlab_mr::fetch_discussions(
        &ctx.http,
        &settings.gitlab_host,
        settings.gitlab_token.as_deref(),
        project_path,
        iid,
    )
    .await?;
    let mine = discussions
        .discussions
        .iter()
        .flat_map(|discussion| discussion.notes.iter())
        .find(|note| note.id == note_id)
        .map(|note| note.mine);
    match mine {
        Some(true) => Ok(()),
        Some(false) => anyhow::bail!(
            "that comment is somebody else's — this app only {act}s what the user wrote \
             themselves"
        ),
        None => anyhow::bail!("that comment is no longer on the merge request"),
    }
}

/// WHERE on a diff a comment hangs, out of the `position` a client sent — or `None` when it
/// sent none, which is an ordinary comment on the merge request.
///
/// Every field is checked here rather than trusted, and the shape is built from primitives:
/// the client names a file, two line numbers and a side, and the backend spells the position
/// (and the line codes inside it) itself. So no client can hand GitLab a `position` key this
/// app does not know it is sending — the same reason `gitlab_merge_request_params` refuses a
/// project path that is really a URL.
fn gitlab_diff_anchor(params: &Value) -> Result<Option<gitlab_mr_write::DiffAnchor>> {
    let Some(position) = params.get("position").filter(|v| v.is_object()) else {
        return Ok(None);
    };
    let refs = position.get("refs").filter(|v| v.is_object()).context(
        "a comment on a diff line needs the commits that diff is of — reload the changes",
    )?;
    let sha = |key: &str| -> Result<String> {
        let value = param_str(refs, key)?.trim().to_string();
        anyhow::ensure!(!value.is_empty(), "`{key}` must name a commit");
        Ok(value)
    };
    Ok(Some(gitlab_mr_write::DiffAnchor {
        refs: gitlab_mr::DiffRefs {
            base_sha: sha("base_sha")?,
            head_sha: sha("head_sha")?,
            start_sha: sha("start_sha")?,
        },
        // A file has one path or two, and either may be absent — an added file has no old
        // path and a deleted one has no new path. The write refuses a position with neither.
        new_path: position.get("new_path").and_then(Value::as_str).unwrap_or_default().to_string(),
        old_path: position.get("old_path").and_then(Value::as_str).unwrap_or_default().to_string(),
        line: gitlab_diff_anchor_line(position.get("line"))?
            .context("a comment on a diff line needs the line it hangs on")?,
        // A range's own START. Absent for a comment about one line, which is the common case
        // and is not a range of one (see `gitlab_mr_write::DiffAnchor`).
        start: gitlab_diff_anchor_line(position.get("start"))?,
    }))
}

/// One end of such a position: where the line sits in each file, and which side it is on.
fn gitlab_diff_anchor_line(value: Option<&Value>) -> Result<Option<gitlab_mr_write::AnchorLine>> {
    let Some(value) = value.filter(|v| v.is_object()) else {
        return Ok(None);
    };
    let number = |key: &str| -> Result<u64> {
        value
            .get(key)
            .and_then(Value::as_u64)
            .filter(|line| *line > 0)
            .with_context(|| format!("`{key}` must be the line's place in that file"))
    };
    let side = param_str(value, "side")?;
    Ok(Some(gitlab_mr_write::AnchorLine {
        old: number("old")?,
        new: number("new")?,
        // A closed set: a side decides which line numbers the position may state, and GitLab
        // refuses one whose numbers do not match the line it names.
        side: gitlab_mr_write::LineSide::from_str(&side)
            .with_context(|| format!("a diff line is on the old side, the new one or both, not {side}"))?,
    }))
}

/// The merge request one URL names on the configured host, through the read path's own
/// parser — so an approval given from a chat message can drop that merge request's cache
/// without a second host check living here.
fn gitlab_merge_request_of(url: &str, gitlab_host: &str) -> Option<(String, u64)> {
    match gitlab::parse_url(url, gitlab_host)? {
        gitlab::Resource::MergeRequest { project_path, iid } => Some((project_path, iid)),
        gitlab::Resource::Issue { .. } | gitlab::Resource::Project { .. } => None,
    }
}

/// Resolve the persistent SQLite path, following the XDG Base Directory spec:
/// `$XDG_DATA_HOME/teams-lite/teams-lite.sqlite`, falling back to
/// `~/.local/share/teams-lite/teams-lite.sqlite`.
///
/// This MUST be a durable location. The store is the local-first cache — its
/// entire value (instant open, offline history) depends on surviving restarts
/// and reboots. The temp dir is often a tmpfs that's wiped on reboot, which
/// silently defeats local-first (every conversation reloads from the network
/// after a reboot), so we never put it there. The parent dir is created if
/// missing.
fn data_db_path() -> Result<String> {
    // XDG spec: a relative $XDG_DATA_HOME is invalid and must be ignored.
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")))
        .context("cannot resolve a data directory: neither XDG_DATA_HOME nor HOME is set")?;
    let dir = base.join("teams-lite");
    std::fs::create_dir_all(&dir).with_context(|| format!("create data dir {}", dir.display()))?;
    dir.join("teams-lite.sqlite")
        .into_os_string()
        .into_string()
        .map_err(|p| anyhow::anyhow!("data path is not valid UTF-8: {p:?}"))
}

/// Serialize one activity stream for the UI: the decoded notifications plus the
/// unread count (derived from Teams' own read-state) so the panel can badge it.
///
/// `nickname` answers with the name the user gave an actor, or None when they gave
/// none. Passed in rather than looked up here so one store read serves all three
/// streams, and so this stays a pure function of what it is given.
fn feed_json(
    items: &[teams_activity::Notification],
    nickname: &dyn Fn(&str) -> Option<String>,
) -> Value {
    let unread = items.iter().filter(|n| !n.is_read).count();
    json!({
        "unread": unread,
        "items": items
            .iter()
            .map(|n| json!({
                "id": n.id,
                "activity_type": n.activity_type,
                "activity_subtype": n.activity_subtype,
                "actor_name": nickname(&n.actor_mri).unwrap_or_else(|| n.actor_name.clone()),
                "actor_mri": n.actor_mri,
                "source_thread_id": n.source_thread_id,
                "source_message_id": n.source_message_id,
                "source_thread_topic": n.source_thread_topic,
                "preview": n.preview,
                "timestamp": n.timestamp_ms,
                "count": n.count,
                "is_read": n.is_read
            }))
            .collect::<Vec<_>>()
    })
}

fn conversations_json(rows: &[teams_lite::store::ConversationRow]) -> Value {
    json!(rows
        .iter()
        .map(|c| json!({
            "id": c.id,
            "name": c.display_name,
            "last_message_time": c.last_message_time,
            "kind": c.kind.as_str(),
            "last_message_preview": c.last_message_preview,
            "last_message_sender": c.last_message_sender,
            "last_message_from_me": c.last_message_from_me,
            "is_read": c.is_read,
            "is_ghost_read": c.is_ghost_read,
            "is_muted": c.is_muted,
            "is_pinned": c.is_pinned,
            "is_hidden": c.is_hidden,
            "thread_type": c.thread_type,
            "draft": c.draft,
            "avatar_mri": c.avatar_mri,
            "picture_url": c.picture_url
        }))
        .collect::<Vec<_>>())
}

/// Serialize the channel tree for the UI. A flat list, pre-sorted by the store
/// (team, General-first, then name); the web client groups it into team → channel
/// sections. `team_id`/`team_name` are denormalized onto each row so the grouping
/// needs no second lookup.
fn channels_json(rows: &[teams_lite::store::ChannelRow]) -> Value {
    json!(rows
        .iter()
        .map(|c| json!({
            "id": c.id,
            "team_id": c.team_id,
            "team_name": c.team_name,
            "team_group_id": c.team_group_id,
            "name": c.display_name,
            "is_general": c.is_general,
            "is_shown": c.is_shown,
            "is_pinned": c.is_pinned,
            "team_collapsed": c.team_collapsed,
            "last_message_time": c.last_message_time,
            "last_message_preview": c.last_message_preview,
            "last_message_sender": c.last_message_sender,
            "last_message_from_me": c.last_message_from_me,
            "is_read": c.is_read,
            "alerts": c.alerts.as_str(),
            "is_ghost_read": c.is_ghost_read,
            "draft": c.draft
        }))
        .collect::<Vec<_>>())
}

/// Decide whether a message is ours. We match on the sender's MRI (reliable —
/// it's a stable per-user identifier) whenever both sides have one. We fall back
/// to comparing display names only for legacy rows stored before we captured the
/// MRI, where `sender_mri` is empty.
fn is_self(m: &Message, self_name: &str, self_mri: &str) -> bool {
    if !self_mri.is_empty() && !m.sender_mri.is_empty() {
        return m.sender_mri == self_mri;
    }
    !self_name.is_empty() && m.sender == self_name
}

/// Whether the `delete` RPC may act on this stored row: only on the user's OWN
/// message, judged by the same rule the UI shows a bubble as ours with
/// ([`is_self`]). A message this store does not hold (`None`) is allowed through —
/// Teams is the authority, and refusing a message we simply never synced would break
/// a legitimate deletion.
///
/// This exists because Teams is MORE permissive than this app: a team owner may
/// delete a colleague's channel post there. The app offers no such action, so a
/// request for one is refused here rather than sent.
fn may_delete(stored: Option<&Message>, self_name: &str, self_mri: &str) -> bool {
    match stored {
        Some(m) => is_self(m, self_name, self_mri),
        None => true,
    }
}

fn messages_value(
    msgs: &[Message],
    self_name: &str,
    self_mri: &str,
    store: Option<&Store>,
) -> Value {
    json!(msgs
        .iter()
        .map(|m| message_json(m, self_name, self_mri, store))
        .collect::<Vec<_>>())
}

/// Decode a message's stored attachments (a JSON array string) back into a JSON
/// value for the wire. A legacy/blank/malformed value degrades to an empty array
/// so a single bad row can never break a whole page's serialization.
fn attachments_value(m: &Message) -> Value {
    serde_json::from_str(&m.attachments).unwrap_or_else(|_| json!([]))
}

/// Decode a message's stored @mentions (a JSON array string) for the wire, so the
/// UI can map each mention span's `itemid` back to the person it names — and show
/// their card on hover. A legacy/blank/malformed value degrades to an empty array
/// so one bad row can never break serialization.
fn mentions_value(m: &Message) -> Value {
    serde_json::from_str(&m.mentions).unwrap_or_else(|_| json!([]))
}

/// Decode a message's structured system event (a JSON object string) for the wire,
/// or `null` when the message is a normal chat message (empty `system_event`) or
/// the stored value is malformed. The UI renders a centered system line when this
/// is present (see `web/src/components/call-event-line.tsx`).
///
/// Two `kind`s ride this field:
///   - `call` — `{event:"ended|missed|started", duration_seconds, participant_count,
///     participants[], participant_mris[], meeting?}`;
///   - `thread_activity` — `{event:"member_added|pinned|unpinned", time_ms,
///     actor_mri, members[], member_mris[]}`, where `members` holds display names
///     index-aligned with `member_mris` (a name may be empty: resolve it from the MRI).
/// A UI that does not know a `kind` should render nothing for it rather than the
/// raw payload; new kinds are added here, never inferred from `content`.
fn system_event_value(m: &Message) -> Value {
    if m.system_event.is_empty() {
        return Value::Null;
    }
    serde_json::from_str(&m.system_event).unwrap_or(Value::Null)
}

/// Decode a message's stored reactions into the wire shape the UIs render: one
/// `{ "key", "count", "mine", "users" }` per emotion that has at least one user,
/// with `mine` true when our own MRI is among them. A legacy / blank / malformed
/// value degrades to an empty array so one bad row can never break serialization.
///
/// `users` says WHO reacted, in the order Teams listed them (reaction time), so a
/// reader can point at a chip and learn whose emoji it is. Each entry carries the
/// name and nothing else — a reaction is not a person card, and an MRI on the wire
/// would be one more place a page could name somebody its own way. Which entry is
/// OURS travels per user rather than being inferred from the aggregate `mine`: the
/// page says "You" where we are among the reactors, and it cannot know which of
/// several names that is.
///
/// The name is [`Store::display_name_for_mri`] — the one ladder, so a person the
/// user renamed is named here exactly as they are above their own bubbles. With no
/// store (a unit test, a caller that holds none) the names come out empty, which is
/// the same state as a reactor this machine has never seen write: the page then
/// counts them instead of naming them.
fn reactions_value(m: &Message, self_mri: &str, store: Option<&Store>) -> Value {
    let parsed: Value = serde_json::from_str(&m.reactions).unwrap_or_else(|_| json!([]));
    let Some(list) = parsed.as_array() else {
        return json!([]);
    };
    let out: Vec<Value> = list
        .iter()
        .filter_map(|e| {
            let key = e.get("key").and_then(Value::as_str)?;
            let users = e.get("users").and_then(Value::as_array)?;
            // ponytail: one indexed name lookup per reactor, uncached. A page of
            // history is a few dozen of them; a cache earns its place when a
            // measurement says so.
            let people: Vec<Value> = users
                .iter()
                .filter_map(|u| u.get("mri").and_then(Value::as_str))
                .map(|mri| {
                    let mine = !self_mri.is_empty() && teams_lite::store::same_user(mri, self_mri);
                    let name = store
                        .and_then(|s| s.display_name_for_mri(mri).ok().flatten())
                        .unwrap_or_default();
                    json!({ "name": name, "mine": mine })
                })
                .collect();
            if people.is_empty() {
                return None;
            }
            let mine = people.iter().any(|p| p["mine"] == json!(true));
            Some(json!({ "key": key, "count": people.len(), "mine": mine, "users": people }))
        })
        .collect();
    json!(out)
}

fn messages_json(
    msgs: &[Message],
    self_name: &str,
    self_mri: &str,
    has_more: bool,
    store: Option<&Store>,
) -> Value {
    json!({
        "messages": messages_value(msgs, self_name, self_mri, store),
        "has_more": has_more
    })
}

fn newest_history_page(store: &Store, conversation_id: &str) -> Result<(Vec<Message>, bool)> {
    let mut messages = store.newest_messages(
        conversation_id,
        i64::from(teams_read::DEFAULT_PAGE_SIZE) + 1,
    )?;
    let has_cached_more = messages.len() > teams_read::DEFAULT_PAGE_SIZE as usize;
    if has_cached_more {
        let extra = messages.len() - teams_read::DEFAULT_PAGE_SIZE as usize;
        messages.drain(..extra);
    }
    let network_has_more = store.oldest_cursor(conversation_id)?.1;
    Ok((messages, has_cached_more || network_has_more))
}

/// Return one older page from SQLite before using the network frontier. Reading
/// one extra row lets us report `has_more` exactly when all known history is
/// local; the persisted frontier covers history that still needs a network fetch.
fn cached_history_page(
    store: &Store,
    conversation_id: &str,
    before_seq: i64,
) -> Result<(Vec<Message>, bool)> {
    let mut messages = store.messages_before(
        conversation_id,
        before_seq,
        i64::from(teams_read::DEFAULT_PAGE_SIZE) + 1,
    )?;
    let has_cached_more = messages.len() > teams_read::DEFAULT_PAGE_SIZE as usize;
    if has_cached_more {
        let extra = messages.len() - teams_read::DEFAULT_PAGE_SIZE as usize;
        messages.drain(..extra);
    }
    let network_has_more = store.oldest_cursor(conversation_id)?.1;
    Ok((messages, has_cached_more || network_has_more))
}

/// Serialize a conversation's read receipts for the wire: one entry per OTHER
/// member (our own horizon is dropped — we never show our own read state), each
/// carrying the reader's MRI, a resolved display name, and the id of the last
/// message they have read. The UI anchors a small avatar to that message.
///
/// Names are resolved locally from stored messages (network-free), exactly like
/// the typing indicator. For a 1:1 where the other party has read but never
/// posted, that lookup misses, so we fall back to the conversation's other-party
/// name when there is a single unresolved member. An MRI that still resolves to
/// nothing is passed through with an empty name; the UI shows a neutral avatar.
fn read_receipts_json(
    store: &Store,
    conversation_id: &str,
    horizons: &[teams_readstate::ConsumptionHorizon],
    self_name: &str,
    self_mri: &str,
) -> Value {
    let others: Vec<&teams_readstate::ConsumptionHorizon> = horizons
        .iter()
        .filter(|h| !teams_lite::store::same_user(&h.mri, self_mri))
        .collect();
    let single_other = others.len() == 1;
    let receipts: Vec<Value> = others
        .iter()
        .map(|h| {
            let mut name = store
                .display_name_for_mri(&h.mri)
                .ok()
                .flatten()
                .unwrap_or_default();
            if name.is_empty() && single_other {
                name = store
                    .other_party_name(conversation_id, self_name)
                    .ok()
                    .flatten()
                    .unwrap_or_default();
            }
            json!({
                "member_mri": h.mri,
                "member": name,
                "last_read_message_id": h.last_read_message_id,
                "read_time_ms": h.read_time_ms,
            })
        })
        .collect();
    json!({ "receipts": receipts })
}

/// How many people the `members` method offers. A mention list is a menu, not a
/// directory: past this many the user types a name rather than reads the list, and one
/// directory batch ([`teams_profiles::MAX_BATCH`]) then names everybody who needs it.
const MAX_MENTION_MEMBERS: usize = 100;

/// Merge a thread's roster with the people who have written in it into one mention
/// list, and say who still needs a name.
///
/// Order is usefulness: the recent contributors first, in the order the store gave
/// them (newest message first), then the rest of the roster. We are never in the list
/// — a mention of oneself notifies nobody.
///
/// Returns the candidates and the MRIs among them that carry no name yet, capped to
/// one directory batch. Pure, so the merge is unit-tested without a tenant.
fn mention_candidates(
    roster: &[teams_members::ThreadMember],
    senders: &[(String, String)],
    self_mri: &str,
) -> (Vec<teams_members::ThreadMember>, Vec<String>) {
    let mut people: Vec<teams_members::ThreadMember> = Vec::new();
    let mut push = |mri: &str, name: &str| {
        if people.len() >= MAX_MENTION_MEMBERS
            || !teams_profiles::is_person_mri(mri)
            || teams_lite::store::same_user(mri, self_mri)
        {
            return;
        }
        match people.iter_mut().find(|p| teams_lite::store::same_user(&p.mri, mri)) {
            // A name from either source wins over no name at all.
            Some(known) if known.display_name.is_empty() => {
                known.display_name = name.trim().to_string();
            }
            Some(_) => {}
            None => people.push(teams_members::ThreadMember {
                mri: mri.to_string(),
                display_name: name.trim().to_string(),
            }),
        }
    };
    for (mri, name) in senders {
        push(mri, name);
    }
    for member in roster {
        push(&member.mri, &member.display_name);
    }
    let unnamed: Vec<String> = people
        .iter()
        .filter(|person| person.display_name.is_empty())
        .map(|person| person.mri.clone())
        .take(teams_profiles::MAX_BATCH)
        .collect();
    (people, unnamed)
}

/// Everybody a message in one conversation may @mention, named, most relevant first.
///
/// A pure READ: the roster GET (src/teams_members.rs) and the short-profile lookup that
/// names it, both of which this app already does elsewhere.
///
/// Two sources, because neither covers both thread kinds: the thread's roster (complete
/// for a chat, just us for a channel) and everybody who has written in the conversation
/// (the only source a channel has, and the one that carries the names we already hold).
/// Whoever is still nameless — a chat member who never wrote — is resolved in one batch
/// against the directory.
///
/// Best-effort by contract: a roster Teams refuses, or a directory that answers nothing,
/// leaves a shorter list rather than an error, because a composer with no suggestions
/// still sends messages.
///
/// Two callers, one list, and that is the point: it is what the `members` method offers
/// the composer, and it is the ONLY set of people an agent's answer can mention (see
/// [`agent_policy::reply_body`]). A machine and a person can name the same people.
async fn thread_mentionable_people(
    ctx: &Ctx,
    conversation_id: &str,
) -> Result<Vec<agent_markdown::Mentionable>> {
    let self_mri = ctx.session().await?.self_mri.to_string();
    let http = ctx.http.clone();
    let roster_conv = conversation_id.to_string();
    let roster = ctx
        .retry_on_auth(move |session, _csa| {
            let http = http.clone();
            let conv = roster_conv.clone();
            async move { teams_members::fetch_thread_members(&http, &session, &conv).await }
        })
        .await
        .unwrap_or_default();

    let (mut people, unnamed) = {
        let store = ctx.store()?;
        let senders = store.thread_senders(conversation_id, MAX_MENTION_MEMBERS as i64)?;
        mention_candidates(&roster, &senders, &self_mri)
    };
    if !unnamed.is_empty() {
        let session = ctx.session().await?;
        if let Ok(profile) = ctx.profile().await {
            if let Ok(names) =
                teams_profiles::fetch_names(&ctx.http, &session, &profile, &unnamed).await
            {
                for person in people.iter_mut() {
                    if let Some(name) = names.get(&person.mri) {
                        person.display_name = name.clone();
                    }
                }
            }
        }
    }
    // Somebody we cannot name is somebody the user cannot pick out of a list, and
    // somebody an answer cannot write either, so they are left out rather than offered
    // as an MRI.
    Ok(people
        .into_iter()
        .filter(|person| !person.display_name.is_empty())
        .map(|person| agent_markdown::Mentionable {
            mri: person.mri,
            name: person.display_name,
        })
        .collect())
}

/// Serialize one message for the wire.
///
/// `message_type` is the Teams `messagetype` verbatim (`Text`, `RichText/Html`,
/// `RichText/Media_Card`, …), snake_cased like the other wire keys. A front-end
/// needs it to know that a `Text` body is PLAIN text and must be escaped rather
/// than parsed as HTML (otherwise `Vec<String>` renders as `Vec`). Empty for legacy
/// rows stored before the column existed — treat empty as "unknown", i.e. keep the
/// previous HTML behaviour.
///
/// `mentions_me` is the one fact about a message that only this side can answer: the
/// page never learns the user's own MRI, so it cannot read the resolved mention list
/// for itself. It is resolved by [`push_policy::mentions_user`], the same function the
/// delivery policy reads, so a mention means one thing in this app — and it is what
/// lets the page apply the user's own per-channel notification setting rather than
/// chiming at every post in every channel (see `shouldNotify` in
/// web/src/lib/protocol.ts). Absent from an older backend, and the reader then treats
/// it as "not known" and notifies, because a mention nobody is told about is the worse
/// failure.
fn message_json(m: &Message, self_name: &str, self_mri: &str, store: Option<&Store>) -> Value {
    json!({
        "id": m.id, "conversation_id": m.conversation_id, "seq": m.seq,
        "compose_time": m.compose_time, "sender": m.sender, "sender_mri": m.sender_mri,
        "message_type": m.message_type,
        "content": m.content,
        "attachments": attachments_value(m),
        "mentions": mentions_value(m),
        "reactions": reactions_value(m, self_mri, store),
        "system_event": system_event_value(m),
        "is_self": is_self(m, self_name, self_mri),
        "mentions_me": push_policy::mentions_user(&m.mentions, self_mri),
        "thread_root_id": m.thread_root_id,
        "thread_subject": m.thread_subject,
        "deleted": m.deleted,
        // WHEN Teams is holding this one for, 0 for every message that was sent at once.
        // It rides on every message because the LIVE path needs it: a scheduled send comes
        // back on the feed like any other frame, and a page that merged it would draw
        // tomorrow's message in today's thread — the very thing the store's own read
        // excludes (see `Message::scheduled_time`).
        "scheduled_time": m.scheduled_time,
        // How this body reached the reader: absent for an ordinary message, "opened" for one
        // this machine unsealed, and "locked" / "newer" / "damaged" for one it could not (see
        // `store::MessageSeal`). "opened" is deliberately said out loud: a padlock beside a
        // message the reader CAN read is how they learn the chat is sealed at all.
        //
        // A locked message's `content` is EMPTY above rather than the token — the store keeps
        // the ciphertext on disk, so a passphrase added tomorrow still opens it, and no page,
        // preview or notification is ever handed base64.
        "seal": m.seal.wire(),
        // WHICH passphrase is missing, for the one state that names one. It is a key id and
        // never a key: it is what lets the app say which passphrase to ask a colleague for,
        // instead of "this message cannot be read".
        "seal_key_id": m.seal.key_id()
    })
}

/// Build the `call` real-time event for a live message that is a call system
/// event, or `None` when the message is not one (or is our own outgoing call,
/// which we never ring for).
///
/// This is incoming-call *awareness*, not a call itself: Teams posts an
/// `Event/Call` message to a conversation when a call starts/ends there, and the
/// backend already turns that into a structured `system_event` (see
/// [`teams_read::parse_call_event`]). We ride entirely on that already-parsed,
/// already-tested payload — no new wire parsing — and surface it as an ephemeral
/// signal (like `typing`) so a UI can raise/dismiss an incoming-call banner. The
/// system line is still stored and broadcast as a normal `message` alongside it.
///
/// - `started` rings (unless we started the call ourselves);
/// - `ended`/`missed` dismiss any banner the UI is showing for that conversation
///   (emitted even for our own call, since dismissal is keyed by conversation).
///
/// It does NOT place, answer, or carry media — the client has no media stack, and
/// answering would be a real action performed as the user.
fn call_event_json(m: &Message, self_name: &str, self_mri: &str) -> Option<Value> {
    let event: Value = serde_json::from_str(&m.system_event).ok()?;
    if event.get("kind").and_then(Value::as_str) != Some("call") {
        return None;
    }
    // A meeting-thread call marker (`parse_call_event`'s JSON shape) is surfaced as
    // a "Call started" line, but it is awareness noise rather than a personal
    // incoming call — no caller identity, and it can arrive in backfill — so it
    // must never raise OR clear the incoming-call banner.
    if event.get("meeting").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let kind = event
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("ended");
    // Never ring for a call we started ourselves (the `started` frame carries us
    // as the sender). We still surface `ended`/`missed` so the banner clears.
    if kind == "started" && is_self(m, self_name, self_mri) {
        return None;
    }
    Some(json!({
        "conversation_id": m.conversation_id,
        "event": kind,
        "caller": m.sender,
        "caller_mri": m.sender_mri,
        "participants": event.get("participants").cloned().unwrap_or_else(|| json!([])),
        "participant_mris": event.get("participant_mris").cloned().unwrap_or_else(|| json!([])),
        "participant_count": event.get("participant_count").cloned().unwrap_or_else(|| json!(0)),
    }))
}

/// Sync the chat list AND the channel tree from the network in the background:
/// one CSA fetch feeds both. Persist each, emit `conversations_changed` and/or
/// `channels_changed` only when something actually changed, then resolve 1:1
/// names. This keeps the `conversations`/`channels` requests off the network path
/// (local-first startup).
///
/// Persisting channels also HEALS any channel row that leaked into the chat list:
/// a channel post arriving live (before the first CSA sync) upserts a conversation
/// row by id, and `persist_channels` deletes it. When healing happens we must emit
/// `conversations_changed` too so the sidebar drops the stray chat entry.
fn sync_csa_bg(ctx: Ctx) {
    tokio::spawn(async move {
        let http = ctx.http.clone();
        let (convs, teams) = match ctx
            .retry_on_auth(|session, csa| {
                let http = http.clone();
                async move { teams_read::fetch_csa(&http, &session, &csa).await }
            })
            .await
        {
            Ok(c) => c,
            // Say so. This is the sync that fills the chat list and the channel tree,
            // so a silent return is a sidebar that stays empty with nothing in the
            // journal to explain it — which is exactly how a locked keyring read as
            // "the app is broken" for a whole morning.
            Err(e) => {
                eprintln!("[sync] conversation list refresh failed: {e:#}");
                return;
            }
        };
        let (chats_changed, channels_changed) = {
            if let Ok(store) = ctx.store() {
                let inserted = teams_read::persist_conversations(&store, &convs);
                let (changed, healed) = teams_read::persist_channels(&store, &teams);
                // A healed leak removes a row from the chat list, so it is also a
                // conversations change.
                (inserted > 0 || healed > 0, changed > 0)
            } else {
                return;
            }
        };
        if chats_changed {
            ctx.emit("conversations_changed", json!({}));
        }
        if channels_changed {
            ctx.emit("channels_changed", json!({}));
        }
        // resolve 1:1 names in the background (emits conversations_changed itself)
        resolve_names_bg(ctx, convs);
    });
}

/// Resolve 1:1 display names in the background and emit conversations_changed.
fn resolve_names_bg(ctx: Ctx, convs: Vec<teams_read::Conversation>) {
    tokio::spawn(async move {
        let to_resolve: Vec<(String, String)> = convs
            .iter()
            .filter(|c| c.is_one_on_one && !c.is_empty && c.title.is_empty() && !c.other_member_mri.is_empty())
            .map(|c| (c.id.clone(), c.other_member_mri.clone()))
            .collect();
        if to_resolve.is_empty() {
            return;
        }
        let mris: Vec<String> = to_resolve.iter().map(|(_, m)| m.clone()).collect();
        let session = match ctx.session().await { Ok(s) => s, Err(_) => return };
        let profile = match ctx.profile().await { Ok(t) => t, Err(_) => return };
        if let Ok(names) = teams_profiles::fetch_names(&ctx.http, &session, &profile, &mris).await {
            if let Ok(store) = ctx.store() {
                let mut changed = false;
                for (conv_id, mri) in &to_resolve {
                    if let Some(name) = names.get(mri) {
                        // Only a real name change counts: re-resolving to the
                        // same name must not emit `conversations_changed`, or the
                        // UI's refresh loop would run forever (a 1:1's network
                        // title stays blank, so it is "resolvable" on every sync).
                        if store.upsert_conversation(conv_id, name, 0).unwrap_or(false) {
                            changed = true;
                        }
                    }
                }
                if changed {
                    ctx.emit("conversations_changed", json!({}));
                }
            }
        }
    });
}

/// Publish — or withdraw — our own "Available" endpoint. The one network half of
/// {@link SETTING_ALWAYS_AVAILABLE}, shared by the RPC, the heartbeat and the restore
/// on startup, so all three speak to the presence service through one place.
///
/// Refuses in read-only mode HERE, not only at the dispatch choke point: the heartbeat
/// and the restore never pass through `check_write_allowed`, and a backend that
/// screenshot tooling started must not tell the user's colleagues they are available.
///
/// The presence-audience token is read fresh on every attempt (like the presence READ
/// path reads the profile one) because it is not the CSA token `retry_on_auth` hands
/// the closure, and a 401 must retry with a refreshed one.
async fn publish_presence(ctx: &Ctx, available: bool) -> Result<()> {
    anyhow::ensure!(
        !read_only(),
        "read-only mode: this backend never publishes the user's own presence"
    );
    let endpoint_id = presence_endpoint_id(&ctx.store()?)?;
    let http = ctx.http.clone();
    let tokens = ctx.tokens.clone();
    ctx.retry_on_auth(move |session, _csa| {
        let http = http.clone();
        let tokens = tokens.clone();
        let endpoint_id = endpoint_id.clone();
        async move {
            let token = tokens.get(teams_presence::PRESENCE_SCOPE).await?;
            if available {
                teams_presence::register_available_endpoint(&http, &session, &token, &endpoint_id)
                    .await
            } else {
                teams_presence::remove_endpoint(&http, &session, &token, &endpoint_id).await
            }
        }
    })
    .await
}

/// Keep the user's own status green while {@link SETTING_ALWAYS_AVAILABLE} is on.
///
/// A heartbeat rather than one call, because an endpoint registration expires (see
/// {@link PRESENCE_HEARTBEAT}) — and the first tick runs immediately, which is what
/// restores the setting after a restart. The always-on service restarts whenever the
/// broker bus moves or a staged update lands, and a setting that only took effect
/// while a human was clicking it would lapse without anybody seeing why.
///
/// Two backends may share this store; both refresh the SAME endpoint id, so Teams
/// counts one endpoint however many of ours are running (see
/// {@link SETTING_PRESENCE_ENDPOINT_ID}).
///
/// It is also what turns the HOURS ({@link SETTING_AVAILABLE_HOURS}) into a status,
/// because nobody is clicking anything at 08:00 or at 19:00. The asymmetry between the
/// two edges is the registration's own: it EXPIRES, so being green has to be said again
/// every tick, while going Offline is said ONCE — a DELETE every two minutes all night
/// would be 700 pointless requests a day and a journal full of them.
fn spawn_presence_heartbeat(ctx: Ctx) {
    if read_only() {
        return;
    }
    tokio::spawn(async move {
        // What this backend last told the service, so the withdrawal at the end of the
        // hours happens once and the page is told only when the answer really turns.
        // `None` while the switch is off — nothing has been said and nothing is owed.
        let mut published: Option<bool> = None;
        loop {
            let intent = ctx
                .store()
                .ok()
                .and_then(|store| presence_intent(&store, chrono::Utc::now()).ok())
                // A store this tick could not open says nothing, which is the switch-off
                // reading: this loop must never publish on a failed read.
                .flatten();
            match intent {
                // The switch is off: the RPC that turned it off already withdrew the
                // registration, so this tick has nothing to say.
                None => published = None,
                Some(want) if want || published != Some(false) => {
                    match publish_presence(&ctx, want).await {
                        Ok(()) => {
                            // Only on a turn, and only after the service took it: this is
                            // what keeps a Settings pane open across 19:00 from claiming a
                            // green dot nobody can see (see `available_now`).
                            if published != Some(want) {
                                if let Ok(store) = ctx.store() {
                                    if let Ok(settings) = settings_json(&store) {
                                        ctx.emit("settings_changed", settings);
                                    }
                                }
                            }
                            published = Some(want);
                        }
                        // Transient by nature (a broker that re-locked, a 429): the next
                        // tick retries, and the only cost of a miss is the status falling
                        // back to what Teams computes.
                        Err(e) => eprintln!(
                            "[presence] {} the Available endpoint failed: {e:#}",
                            if want { "refreshing" } else { "withdrawing" }
                        ),
                    }
                }
                // Outside the hours, and the service has already been told.
                Some(_) => {}
            }
            tokio::time::sleep(PRESENCE_HEARTBEAT).await;
        }
    });
}

/// Watch the rolling `latest` release for the whole life of the process, and tell the UI
/// when it names a commit this build is not.
///
/// **It repeats, and that is the feature.** It used to run exactly once, at startup, which
/// meant an app left open — which is what this app is, on a phone, for weeks — never
/// learned about anything CI published after it booted. The update button appeared only if
/// a release happened to be newer at the moment the backend came up, so the usual way to
/// see one was to restart the thing the button exists to restart.
///
/// Best-effort by design: a dev build (no embedded commit), no network, or a rate-limited
/// API all end a pass quietly — it must never affect startup or the running app.
fn spawn_release_poll(ctx: Ctx) {
    let Some(current) = teams_lite::update::build_rev() else {
        // Built from source: nothing meaningful to compare against, so we never
        // nag developers running a local build.
        return;
    };
    tokio::spawn(async move {
        // `interval` fires its first tick immediately, so the startup check this replaces
        // still happens at startup.
        let mut ticks = tokio::time::interval(RELEASE_CHECK_INTERVAL);
        loop {
            ticks.tick().await;
            // The outcome is the button's business (see `Ctx::check_release_now`): a pass
            // on the clock has nobody waiting on an answer, and it has already published
            // whatever moved.
            let _ = ctx.release_pass(current, ReleaseAsk::Poll).await;
        }
    });
}

/// Whether a pass of the release watch may spend a GitHub request, and on whose behalf.
///
/// The two differ in exactly one respect — whether the machine's slot has to be free — and
/// that difference is the whole reason a button exists beside the clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReleaseAsk {
    /// The two-minute clock (`spawn_release_poll`). It asks only when nothing on this
    /// machine has asked inside the interval.
    Poll,
    /// The user pressed **Check for updates**. It takes the slot whatever the timestamp
    /// says, because an answer up to two minutes old is not what they pressed for.
    User,
}

/// What one pass found, for the caller that has to report it. The poll drops it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReleaseOutcome {
    /// A newer build exists, and the update row is already offering it.
    Available,
    /// This build IS the newest one.
    Current,
    /// The pass stood aside: the user has already pressed something and a download owns
    /// the payload.
    Busy,
    /// Nothing could be compared — a build made from source, GitHub naming no commit we
    /// can read, or no stored answer yet on a backend that never fetches.
    Unknown,
    /// The request itself failed, in GitHub's own words (or the transport's).
    Failed(String),
}

impl Ctx {
    /// One pass of the release watch: read what `latest` names, compare it with this
    /// build, and publish only what CHANGED.
    ///
    /// Shared by the clock and by the user's own **Check for updates**, so there is one
    /// spelling of "is there a newer build" rather than two that drift — `ask` carries the
    /// single difference between them (see [`ReleaseAsk`]).
    ///
    /// Four rules, and each is pinned by a test:
    ///
    ///   * **One request per MACHINE, not per backend.** The answer is the same for every
    ///     process here, so it is fetched under a claim and shared through the store
    ///     ([`Store::claim_release_check`], which carries the measured budget this obeys).
    ///     A backend that loses the claim still learns the new release on this same pass,
    ///     because it reads the stored answer rather than its own.
    ///   * **Silence unless something moved.** A client hears `update_available` when the
    ///     release changes and never on a pass that found the same one, so a page open for
    ///     a week is not sent one event every two minutes — and the journal keeps one line
    ///     per release rather than 720 a day. The OUTCOME is returned either way: the user
    ///     who pressed the button has to be told there is nothing new, which is the one
    ///     answer an event cannot carry.
    ///   * **A download owns the payload while it runs.** Every phase but `Idle` means the
    ///     user has pressed something, and the asset a bar is drawn against is re-read by
    ///     the download itself (`refresh_release`). A pass that overwrote it mid-transfer
    ///     would move the total under the bar.
    ///   * **A request the USER asked for and could not make is a failure, never a verdict.**
    ///     The poll falls back to the stored answer and says one line to the journal; a
    ///     manual check reports what went wrong instead, because "you are up to date" on
    ///     the strength of a read that failed is the one answer it must not give.
    async fn release_pass(&self, current: &str, ask: ReleaseAsk) -> ReleaseOutcome {
        // What a pass must stand aside for is a download that OWNS the payload:
        // `Downloading` (a pass would move the total under the bar), `Ready` (it would
        // forget the file the user is one click from installing), `Restarting`, and
        // `Installed` — that row is asking to be restarted, and a pass that emptied it would
        // take the sentence away.
        //
        // **`FAILED` IS NOT ONE OF THEM**, and reading it as one made the watch DEAF.
        // Measured 2026-08-07: a download 404ed inside CI's own delete-and-recreate window,
        // the phase stayed `Failed`, and eleven minutes and five polls after `latest` was
        // whole again this backend had still never mentioned it. Nothing owns anything in
        // that state — the only thing the row had left to offer was retrying a download of a
        // build the tag had already moved past.
        if !matches!(
            self.with_update(|slot| slot.phase),
            Ok(UpdatePhase::Idle | UpdatePhase::Failed)
        ) {
            return ReleaseOutcome::Busy;
        }
        // A read-only backend never takes the claim: it is a screenshot backend, it cannot
        // install anything, and holding the machine's slot would delay by up to one
        // interval the discovery by the app that CAN act on it. It still reads the stored
        // answer, so its UI says what the app's does.
        let mut failure = None;
        if !read_only() && self.claim_release_read(ask) {
            match teams_lite::update::fetch_release(&self.http).await {
                Ok(Some(release)) => self.remember_release(&release),
                // GitHub answered and named no commit we could read: nothing to store, and
                // the previous answer stands rather than being erased by an unreadable one.
                Ok(None) => {}
                // Reached-but-failed or offline. One line, never a reason to drop what we
                // already knew — and kept, for the caller that has somebody waiting on it.
                Err(e) => {
                    eprintln!("[update] check skipped: {e}");
                    failure = Some(format!("{e}"));
                }
            }
        }
        if let (ReleaseAsk::User, Some(why)) = (ask, failure) {
            return ReleaseOutcome::Failed(why);
        }
        let Some(release) = self.stored_release() else { return ReleaseOutcome::Unknown };
        match teams_lite::update::compare(&release, current) {
            Some(info) => {
                let known = self.with_update(|slot| slot.latest.clone()).unwrap_or_default();
                if known == info.latest {
                    return ReleaseOutcome::Available;
                }
                // The release MOVED, so a failure from the last one is over: it was about a
                // build the tag has already passed, and its reason named a 404 that is no
                // longer true. Taken back here rather than left for the user to press
                // through, which is what the pass being allowed to run while `Failed` is for.
                self.clear_failed_update();
                // What it brings, before it is announced: the payload is spelled once, in
                // `publish_release`, so the list has to be known by the time it runs or the
                // first thing every client hears would carry no list.
                self.learn_release_changes(&info).await;
                let installable = self.publish_release(&info);
                eprintln!(
                    "[update] a newer build is available ({} -> {}){}",
                    info.current,
                    info.latest,
                    if installable {
                        " — installable from the app"
                    } else {
                        " — update it the way it was installed"
                    }
                );
                ReleaseOutcome::Available
            }
            // This build IS the release. Empty the row if it was offering one — the user
            // updated on another install, or CI moved the tag back onto this commit — but
            // stay SILENT when it was not, or an up-to-date app would be sent a null every
            // two minutes.
            //
            // The PRUNE runs either way, and deliberately: a build the release moved past
            // is worthless, and the one left in the cache may have been downloaded by an
            // EARLIER process, which this slot knows nothing about.
            //
            // It spares the download for `latest` — which here is this build's own commit —
            // because the process that put it there may be ANOTHER install on this machine,
            // a commit behind and one click from installing it. This backend's own phase
            // guards nothing on its behalf: a phase is per process and this cache is per
            // machine (see `update::prune_downloads`).
            None => {
                if self.with_update(|slot| slot.available.is_some()).unwrap_or(false) {
                    self.forget_release(&release.rev);
                } else {
                    teams_lite::update::prune_downloads(&release.rev);
                }
                ReleaseOutcome::Current
            }
        }
    }

    /// The `update_check` RPC: the pass above, on the user's own ask, reported back to the
    /// control they pressed.
    ///
    /// The row in the sidebar still appears (or empties) on its own, because the pass
    /// publishes exactly what a poll publishes — this answer is what the BUTTON says, and
    /// the one thing the events cannot carry is "there is nothing new", which is the
    /// commonest outcome of pressing it.
    async fn check_release_now(&self) -> Result<Value> {
        // A build made from source has no commit to compare, so there is nothing to ask
        // GitHub about — the same reason the poll never starts in that build. Said rather
        // than silently answered "up to date": one is a fact, the other a guess.
        let Some(current) = teams_lite::update::build_rev() else {
            return Ok(json!({ "outcome": "unsupported" }));
        };
        Ok(match self.release_pass(current, ReleaseAsk::User).await {
            ReleaseOutcome::Available => json!({ "outcome": "available" }),
            ReleaseOutcome::Current => json!({ "outcome": "current" }),
            ReleaseOutcome::Busy => json!({ "outcome": "busy" }),
            ReleaseOutcome::Unknown => json!({ "outcome": "unknown" }),
            ReleaseOutcome::Failed(error) => json!({ "outcome": "failed", "error": error }),
        })
    }

    /// Take the machine's release-check slot, or find that another backend has it.
    /// A store that cannot answer is read as "not ours", so a failure costs one pass
    /// rather than turning the poll into a per-backend one.
    ///
    /// The user's own ask takes the slot whatever its timestamp says — they pressed the
    /// button to learn where they stand NOW, and a two-minute-old answer is not that. It
    /// still MOVES the timestamp, so the clock's next pass stands down: one request for the
    /// press, not one for the press and one for the tick behind it.
    fn claim_release_read(&self, ask: ReleaseAsk) -> bool {
        let now = now_ms();
        let free_since = match ask {
            ReleaseAsk::Poll => now - RELEASE_CHECK_INTERVAL.as_millis() as i64,
            ReleaseAsk::User => now,
        };
        self.store()
            .and_then(|store| store.claim_release_check(now, free_since))
            .unwrap_or(false)
    }

    /// Write the machine's answer down, for every other backend's next pass.
    fn remember_release(&self, release: &teams_lite::update::Release) {
        if let (Ok(json), Ok(store)) = (serde_json::to_string(release), self.store()) {
            let _ = store.set_setting(teams_lite::update::SETTING_RELEASE, &json);
        }
    }

    /// The machine's last answer, whoever fetched it. `None` before the first successful
    /// read, and on a stored value this build cannot parse — an older shape is treated as
    /// no answer rather than guessed at.
    fn stored_release(&self) -> Option<teams_lite::update::Release> {
        let stored =
            self.store().ok()?.get_setting(teams_lite::update::SETTING_RELEASE).ok()??;
        serde_json::from_str(&stored).ok()
    }
}

// ---- push notifications --------------------------------------------------------
// The delivery side of src/push.rs: the machine's VAPID identity, the status the
// Settings pane shows, and the two paths that actually push — the `push_test` RPC
// and every live message the policy accepts.

/// Wall-clock milliseconds, the store's timestamp unit.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// This machine's VAPID identity, generated on first use and then loaded.
///
/// Generate-once-then-load, never per process: a device's subscription embeds the
/// public half, so a fresh key pair would silently stop every phone that already
/// opted in. A stored key that no longer parses is replaced — it cannot be used for
/// anything, and refusing to push forever is worse than asking the devices to
/// subscribe again.
fn vapid_key(store: &Store) -> Result<push::VapidKey> {
    if let Some(stored) = store.get_setting(SETTING_PUSH_VAPID_PRIVATE)? {
        match push::VapidKey::from_private_base64url(&stored) {
            Ok(key) => return Ok(key),
            Err(e) => eprintln!("[push] the stored VAPID key is unusable ({e}) — generating a new one"),
        }
    }
    let key = push::VapidKey::generate();
    store.set_setting(SETTING_PUSH_VAPID_PRIVATE, &key.private_base64url())?;
    eprintln!("[push] generated this machine's VAPID key pair");
    Ok(key)
}

/// What the Settings pane needs to show the notification state, and what a page
/// needs to subscribe.
///
/// `supported: false` in read-only mode: that backend never pushes (see
/// [`deliver_push`]), so a page must not offer a switch that would do nothing.
fn push_status_json(store: &Store) -> Result<Value> {
    if read_only() {
        return Ok(json!({
            "supported": false,
            "reason": "this backend runs read-only (TEAMS_LITE_READ_ONLY=1) and never pushes",
            "public_key": "",
            "devices": [],
        }));
    }
    let key = vapid_key(store)?;
    let devices: Vec<Value> = store
        .push_subscriptions()?
        .into_iter()
        .map(|row| {
            json!({
                // The endpoint is the client's own handle on its subscription — how a
                // page recognizes ITS device in the list. It is not a secret the page
                // does not already hold.
                "endpoint": row.endpoint,
                "label": row.label,
                "created_ms": row.created_ms,
                "last_ok_ms": row.last_ok_ms,
                "last_error": row.last_error,
            })
        })
        .collect();
    Ok(json!({
        "supported": true,
        "public_key": key.public_base64url(),
        "devices": devices,
    }))
}

/// The outcome of pushing one notification to every subscribed device.
#[derive(Debug, Default)]
struct PushReport {
    delivered: usize,
    failed: usize,
    /// One line per failure, for the caller that asked (the in-app test button).
    errors: Vec<String>,
}

/// Encrypt one notification to every subscribed device and POST it.
///
/// Refuses outright in read-only mode. That mode exists so tooling can drive the
/// real store without acting on the user, and buzzing their phone from a screenshot
/// script is exactly the kind of action it forbids — the check is here, not only at
/// the dispatch gate, because live delivery never passes through the gate.
///
/// A subscription the push service reports as gone is deleted: the app was
/// uninstalled or the browser rotated it, and retrying it costs a request per
/// message forever.
async fn deliver_push(
    ctx: &Ctx,
    notification: &push::Notification,
    ttl_secs: u32,
) -> Result<PushReport> {
    if read_only() {
        anyhow::bail!(
            "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never notifies the user's \
             devices"
        );
    }
    let store = ctx.store()?;
    let key = vapid_key(&store)?;
    let payload = serde_json::to_vec(notification)?;
    let mut report = PushReport::default();

    for row in store.push_subscriptions()? {
        let subscription = push::Subscription {
            endpoint: row.endpoint.clone(),
            p256dh: row.p256dh,
            auth: row.auth,
        };
        let outcome = push::deliver(&ctx.http, &key, &subscription, &payload, ttl_secs).await;
        match outcome {
            Ok(push::Outcome::Delivered) => {
                report.delivered += 1;
                store.mark_push_delivery(&row.endpoint, now_ms(), "")?;
            }
            Ok(push::Outcome::Gone) => {
                report.failed += 1;
                report.errors.push("a device's subscription expired and was removed".to_string());
                eprintln!("[push] a subscription is gone — forgetting the device");
                store.delete_push_subscription(&row.endpoint)?;
            }
            Ok(push::Outcome::Failed(reason)) => {
                report.failed += 1;
                eprintln!("[push] delivery failed: {reason}");
                store.mark_push_delivery(&row.endpoint, now_ms(), &reason)?;
                report.errors.push(reason);
            }
            Err(e) => {
                // A transport error (no network, TLS, a malformed stored key). Same
                // treatment: record it and move to the next device.
                let reason = e.to_string();
                report.failed += 1;
                eprintln!("[push] delivery failed: {reason}");
                store.mark_push_delivery(&row.endpoint, now_ms(), &reason)?;
                report.errors.push(reason);
            }
        }
    }
    Ok(report)
}

/// Notify the user's devices about one live message, if the policy says it deserves
/// it (see [`push_policy::notification_for`]).
///
/// Fire-and-forget: the trouter loop must never wait on the network, so the whole
/// delivery runs in its own task. Claiming the message in the store first is what
/// keeps the two send-capable backends that share this store from both pushing it.
fn push_live_message(
    ctx: &Ctx,
    store: &Store,
    message: &Message,
    is_channel: bool,
    from_me: bool,
    self_mri: &str,
) {
    if read_only() || !push_subscriptions_exist(store) {
        return;
    }
    let context = store.conversation_context(&message.conversation_id, self_mri).unwrap_or_default();
    // A channel is gated on the user's own Teams notification setting for it, so the
    // placement carries that setting. An unreadable store answers with Teams'
    // default rather than with silence.
    let placement = if is_channel {
        let alerts = store
            .channel_alerts(&message.conversation_id)
            .unwrap_or(teams_lite::store::ChannelAlerts::MentionsOnly);
        push_policy::Placement::Channel { title: &context, alerts }
    } else {
        push_policy::Placement::Chat { title: &context }
    };
    // The notification names the sender, and this `message` is the frame that just
    // arrived rather than a row read back through the store, so its `sender` has not
    // been through the nickname resolution every read applies. Do it here: the phone
    // in the user's pocket is the LAST place a rename should fail to hold, because it
    // is the one surface they cannot correct by looking again.
    let renamed = store
        .person_override(&message.sender_mri)
        .ok()
        .flatten()
        .map(|o| o.display_name)
        .filter(|n| !n.is_empty())
        .map(|display_name| Message { sender: display_name, ..message.clone() });
    let message = renamed.as_ref().unwrap_or(message);
    let Some(notification) =
        push_policy::notification_for(
            message,
            &placement,
            self_mri,
            from_me,
            now_ms(),
            sealed_push_words(ctx),
        )
    else {
        return;
    };
    let dedupe_key = format!("{}/{}", message.conversation_id, message.id);
    match store.claim_once(&dedupe_key, now_ms()) {
        Ok(true) => {}
        // Another backend on this store already pushed it.
        Ok(false) => return,
        Err(e) => {
            eprintln!("[push] could not claim {dedupe_key}: {e}");
            return;
        }
    }
    let ctx = ctx.clone();
    tokio::spawn(async move {
        match deliver_push(&ctx, &notification, push::MESSAGE_TTL_SECS).await {
            Ok(report) if report.failed > 0 => {
                eprintln!("[push] {} delivered, {} failed", report.delivered, report.failed);
            }
            Ok(_) => {}
            Err(e) => eprintln!("[push] delivery skipped: {e}"),
        }
    });
}

/// Whether any device is subscribed — checked before doing any policy work, so a
/// user who never turned notifications on pays one count per message.
fn push_subscriptions_exist(store: &Store) -> bool {
    store.count_push_subscriptions().map(|count| count > 0).unwrap_or(false)
}

/// Take every custom emoji a freshly-arrived message carries into this machine's pack,
/// under the name its sender gave it.
///
/// The art already travels with the message — that is what lets a reader SEE a colleague's
/// emoji without holding it — but seeing one and being able to USE one were two different
/// things: the code had to be picked out of the message's own "…" menu, one emoji at a
/// time, before `:shipit:` would post anything. So the pack fills itself here, which is
/// where every other "this message is new" reaction already lives (beside
/// [`push_live_message`] and [`agent_live_message`], on a fresh insert only).
///
/// Six things bound it, and each one is deliberate:
///
/// - **The user's own switch** ([`SETTING_EMOJI_AUTO_IMPORT`]), which is what a store that
///   cannot be read reads as OFF: a write made on somebody's behalf needs their answer, and
///   a failed read is not one.
/// - **A read-only backend never writes**, before the network rather than at the dispatch
///   gate — a live frame passes through no gate.
/// - **The art must come from a Teams host** (`teams_media::is_allowed_media_url`), which is
///   the same rail `custom_emoji_add` holds and the thing that keeps Teams' OWN emoji out:
///   theirs is served from the personal-expressions CDN, which is not on that list.
/// - **The bytes are measured, never believed** (`custom_emoji::measure_art`) — the type,
///   the weight and the dimensions, exactly as an upload from the dialog is.
/// - **A name the user already holds is never overwritten** (`custom_emoji::take_as`). Their
///   `:shipit:` keeps posting their own art; a colleague's arrives as `shipit-2`, and art
///   the pack already holds under any name is not taken twice — which is what stops `-3`,
///   `-4` … on every later message, since each send re-uploads to a fresh URL.
/// - **One backend does it**, claimed in the store like a push: this machine runs two
///   send-capable backends against one store, and both ingest every frame.
///
/// `ponytail:` one authenticated GET of at most 128 KB per distinct emoji per claimed
/// message, including for art the pack already holds — only the bytes can answer that, and
/// they have to be here to be compared. Remember resolved object URLs if it ever matters.
fn import_emoji_from_message(ctx: &Ctx, store: &Store, message: &Message) {
    if read_only() {
        return;
    }
    // The cheapest test first: nearly every message carries no emoji at all, and this is
    // one pass over the body and one over the reactions against a settings read and a claim.
    let art = inbound_emoji_in(message);
    if art.is_empty() {
        return;
    }
    if !emoji_auto_import_enabled(store).unwrap_or(false) {
        return;
    }
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let mut added = 0;
        for emoji in art {
            match take_emoji_into_pack(&ctx, &emoji).await {
                Ok(Some(name)) => {
                    eprintln!("[emoji] took :{name}: into the pack from a message");
                    added += 1;
                }
                Ok(None) => {}
                Err(e) => eprintln!("[emoji] could not take :{}: from a message: {e:#}", emoji.name),
            }
        }
        // Once, whatever the message carried: the pack is a list, and a page re-reads all
        // of it on the event. This is also what takes "Add to my emoji" off the menu for a
        // code the pack now holds, with no reload.
        if added > 0 {
            ctx.emit("custom_emoji_changed", json!({}));
        }
    });
}

/// Every named custom emoji one message carries, from its BODY and from its REACTIONS,
/// distinct by name and body-first.
///
/// A reaction is not a footnote here: measured on this tenant
/// (`examples/custom_emoji_inbound_recon.rs`), it is how most custom emoji arrive — 14
/// distinct pictures against 12 held in the pack — and reading the body alone left every one
/// of them visible and unusable, which is exactly the complaint this whole feature answers.
///
/// A reaction key names its art and, since `custom_emoji::custom_reaction_key` learned to
/// carry it, the name its reactor knows it by. A key written before that — this tenant holds
/// those, and so does any colleague on an older build — carries no name, and is SKIPPED: the
/// art is drawn from the key as it always was, and naming it is the reader's own act through
/// the message's "…" menu. This app never invents a name for somebody else's picture, because
/// the name is what the reader will type and what their own next send will post.
fn inbound_emoji_in(message: &Message) -> Vec<custom_emoji::InboundEmoji> {
    let mut art = custom_emoji::art_in_body(&message.content);
    for key in teams_lite::store::reaction_keys(&message.reactions) {
        let Some((src, Some(name))) = custom_emoji::custom_reaction_art(&key) else { continue };
        if art.iter().any(|held| held.name == name) {
            continue;
        }
        art.push(custom_emoji::InboundEmoji { name: name.to_string(), src: src.to_string() });
    }
    art
}

/// Fetch one inbound emoji's art and store it, answering the name it was stored under —
/// or `None` when the pack was deliberately left alone. See [`import_emoji_from_message`]
/// for what each step is guarding against.
async fn take_emoji_into_pack(
    ctx: &Ctx,
    emoji: &custom_emoji::InboundEmoji,
) -> Result<Option<String>> {
    anyhow::ensure!(
        teams_media::is_allowed_media_url(&emoji.src),
        "its art is not served from a Teams host"
    );
    // Claim the WORK ITEM — this upload under this name — rather than the message, because
    // a REACTION arrives on a message that is already in the store: a claim on the message
    // would be taken by its own insert and every later reaction on it silently dropped. An
    // AMS object is one upload, so this key is exactly "these bytes, under this name".
    //
    // It stays an optimisation and not a correctness rail: it spares this machine's second
    // backend the same fetch, and a claim that were somehow lost costs one repeat fetch that
    // `take_as` then skips on the bytes.
    let claim = format!("emoji/{}#{}", emoji.name, emoji.src);
    if !ctx.store()?.claim_once(&claim, now_ms())? {
        return Ok(None);
    }
    let session = ctx.session().await?;
    // The bytes as they were UPLOADED, not the rendition the message names: AMS answers
    // `views/imgo` for an animated GIF with a single still frame, and a pack entry outlives
    // the message it came from (the same reason `custom_emoji_add` does this).
    let art_url = custom_emoji::original_art_url(&emoji.src);
    let media = teams_media::fetch_media(&ctx.http, &session, &art_url).await?;
    let (content_type, width, height) = custom_emoji::measure_art(&media.bytes)?;

    // Read the pack AFTER the fetch, so the window between deciding a name is free and
    // taking it is as short as it can be. It is not zero: two backends could each find
    // `shipit` free in the same instant. Both would then write the same bytes from the same
    // message, which is why that race costs nothing worth a second claim.
    let store = ctx.store()?;
    let taken: Vec<String> = store
        .custom_emoji()?
        .into_iter()
        .flat_map(|held| [held.name, held.alias_of])
        .filter(|name| !name.is_empty())
        .collect();
    let already_named = store.custom_emoji_named_by_bytes(&media.bytes)?;
    let Some(name) = custom_emoji::take_as(&emoji.name, &taken, already_named.as_deref()) else {
        return Ok(None);
    };
    store.set_custom_emoji(
        &name,
        Some((content_type, &media.bytes, width, height)),
        None,
        "message",
        now_ms(),
    )?;
    Ok(Some(name))
}

// ---- the local agent (see src/agent.rs and src/agent_policy.rs) ---------------

/// How often the streamed reply is edited in place, at most. Slow enough that a long
/// answer costs tens of requests rather than thousands, fast enough that the thread
/// visibly fills in.
const AGENT_EDIT_INTERVAL: Duration = Duration::from_millis(1_200);

/// How many progress edits one reply may make. Past this the answer only lands once,
/// at the end: a pathological answer must not turn into a thousand PUTs.
const AGENT_MAX_EDITS: usize = 100;

/// How often the app's own frontends hear about a run, at most.
///
/// Two orders of magnitude under [`AGENT_EDIT_INTERVAL`], because these two paths cost
/// different things: an edit is an HTTPS request that every member of the thread sees
/// land, while this is a JSON frame on a loopback socket. The floor exists only so a
/// model emitting a token every few milliseconds does not turn into a frame per token
/// for every connected page; at 50 ms the answer still arrives faster than it can be
/// read, and the client eases the reveal on top of it (see `useSmoothReveal` in
/// web/src/components/agent-reply.tsx).
const AGENT_STREAM_INTERVAL: Duration = Duration::from_millis(50);

/// How often a run repeats its latest frame while nothing changes.
///
/// The clock half of [`agent_stream_local`], and the client's counterpart of the store
/// heartbeat: a run may spend half an hour inside ONE tool call (`agent::RUN_IDLE_TIMEOUT`
/// is what bounds that), and a page hearing nothing for that long has to assume the
/// backend died — which is what `AGENT_RUN_STALE_MS` in web/src/lib/agent-run.ts does.
/// The keepalive is what tells a quiet run from a gone one, so that window can be short.
const AGENT_STREAM_KEEPALIVE: Duration = Duration::from_secs(15);

/// How often a live run says it is still writing, in the store and in its marker file.
///
/// It has to keep ticking through a silent minute of tool calls, because its ABSENCE is
/// the only thing that tells an abandoned run from a slow one.
const AGENT_RUN_HEARTBEAT: Duration = Duration::from_secs(5);

/// How long a run may say nothing before another process may close its message.
///
/// An order of magnitude over the heartbeat: a dozen missed beats is a dead process, a
/// paused container or a machine under load — never a run that is merely thinking. The
/// cost of waiting too long is a placeholder in the thread for another minute; the cost
/// of not waiting long enough is overwriting the answer of a run that was still writing.
const AGENT_RUN_ABANDONED_AFTER: Duration = Duration::from_secs(60);

/// How often abandoned runs are swept for.
///
/// A sweep, not a one-shot at startup: the run killed by THIS restart still has a fresh
/// heartbeat when the next process boots (a restart takes a second), so a single pass
/// would find nothing and the message would stay frozen — the exact bug being fixed.
const AGENT_REPAIR_INTERVAL: Duration = Duration::from_secs(30);

/// Where a live run publishes its marker, for tooling that must not cut it short.
///
/// The runtime directory ONLY (tmpfs, wiped on logout), unlike the write token's two
/// locations: a marker names a process id, and a marker that outlived a reboot could
/// name a pid something else now holds. No `XDG_RUNTIME_DIR`, no markers — a shell
/// without one then reads "no run is live", which is what it would have assumed anyway.
///
/// It exists because the reader is a SHELL: `bin/teams-lite-service.sh` waits for a
/// quiet agent before it restarts the units, and the alternative was a build script
/// opening the app's SQLite store or guessing from a process tree.
fn agent_run_marker_dir() -> Option<std::path::PathBuf> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
    let runtime = std::path::PathBuf::from(runtime);
    runtime.is_absolute().then(|| runtime.join("teams-lite/agent-runs"))
}

/// Publish one live run's marker, named after the message it is writing into.
///
/// Best-effort throughout: a marker is a courtesy to tooling, and no run must fail
/// because a tmpfs would not take a file.
fn publish_agent_run_marker(run: &store::AgentRun) {
    let Some(dir) = agent_run_marker_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let body = format!(
        "pid={}\nbackend={}\nconversation={}\nmessage={}\nstarted_ms={}\n",
        std::process::id(),
        run.backend,
        run.conversation_id,
        run.message_id,
        run.started_ms,
    );
    let _ = std::fs::write(dir.join(marker_name(&run.message_id)), body);
}

/// How many agent replies THIS process is writing right now.
///
/// Read from the markers rather than from the store, and narrowed to our own pid, because
/// the question a restart asks is "what would I cut off": the store's rows belong to every
/// backend on this machine, and a run in the other one survives us untouched. It is the same
/// directory `bin/teams-lite-service.sh` counts before it restarts the units
/// (`wait_for_quiet_agent`) — one place a live run is published, two readers.
///
/// Best-effort like everything else about the markers: no runtime directory, or a directory
/// that will not open, reads as no runs — which is what the caller would have assumed.
fn live_agent_runs_here() -> usize {
    let Some(dir) = agent_run_marker_dir() else { return 0 };
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    let ours = format!("pid={}", std::process::id());
    entries
        .flatten()
        .filter(|entry| {
            std::fs::read_to_string(entry.path())
                .is_ok_and(|body| body.lines().any(|line| line.trim() == ours))
        })
        .count()
}

/// Take a finished run's marker away. Called on every exit path, so the directory
/// holds live runs and leftovers of killed processes — nothing else.
fn remove_agent_run_marker(message_id: &str) {
    if let Some(dir) = agent_run_marker_dir() {
        let _ = std::fs::remove_file(dir.join(marker_name(message_id)));
    }
}

/// A file name that cannot escape the directory, whatever a message id turns out to
/// hold. Teams ids are digits today; a path separator arriving from the network must
/// still land inside the marker directory.
fn marker_name(message_id: &str) -> String {
    message_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Drop the markers of runs that no longer have a process, once, at startup.
///
/// Every one of them is a run this machine killed — most likely by restarting us. Left
/// behind they would tell `bin/teams-lite-service.sh` to wait for an agent that stopped
/// answering days ago. The store row is NOT dropped here: that one is the record a
/// repair still has to act on (see `repair_abandoned_agent_runs`).
fn clear_dead_agent_run_markers() {
    let Some(dir) = agent_run_marker_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let alive = std::fs::read_to_string(&path)
            .ok()
            .and_then(|body| {
                body.lines()
                    .find_map(|line| line.strip_prefix("pid="))
                    .and_then(|pid| pid.trim().parse::<u32>().ok())
            })
            .is_some_and(|pid| std::path::Path::new(&format!("/proc/{pid}")).exists());
        if !alive {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Say at startup which local agents this process can run, and where.
///
/// A CLI that is not on `PATH` turns every `@claude` message into a no-op, and the only
/// other trace is one line per dropped trigger — which nobody reads, because the
/// symptom is a thread that stays silent. A service inherits the systemd user manager's
/// PATH, which holds neither `~/.local/bin` nor `~/.bun/bin`, so the PATH is printed
/// with the refusal: it names the cause instead of the effect.
fn log_agent_backends(unrestricted: bool) {
    if unrestricted {
        eprintln!(
            "[agent] UNRESTRICTED — a trigger runs on the user's own Claude Code \
             configuration: every MCP server and tool their settings allow, and their own \
             permission mode. Turn it off from a thread's agent menu."
        );
    }
    for backend in agent_policy::BACKENDS.iter() {
        match agent::program_path(backend) {
            Some(path) => eprintln!(
                "[agent] {} ready — {} runs {}",
                backend.name,
                backend.prefix,
                path.display()
            ),
            None => eprintln!(
                "[agent] {} unavailable — `{}` is on no PATH entry: {}",
                backend.name,
                backend.program,
                std::env::var("PATH").unwrap_or_else(|_| "<unset>".into())
            ),
        }
    }
}

/// Answer one live message with a local agent, if the policy says it asked for one.
///
/// Fire-and-forget, like [`push_live_message`]: the trouter loop must never wait on a
/// child process or the network, so the whole run happens in its own task.
///
/// Refuses in read-only mode before anything else. That mode exists so tooling can
/// drive the user's real store, and an agent that answers a message in their name is
/// the loudest possible thing for a screenshot script to do — the check is here, not
/// only at the dispatch gate, because this path never passes through the gate.
fn agent_live_message(ctx: &Ctx, store: &Store, message: &Message, from_me: bool, self_mri: &str) {
    if read_only() {
        return;
    }
    // The cheap test first: only OUR message can be a trigger, and the great majority
    // of live messages are not ours (see the module docs for why this is the rule that
    // keeps the feature from being remote code execution).
    if !from_me {
        return;
    }
    let modes = store.get_setting(agent_policy::SETTING_MODES).unwrap_or_default();
    let mode = agent_policy::mode_for(&message.conversation_id, modes.as_deref());
    let providers = agent_policy::Providers::parse(
        store.get_setting(agent_policy::SETTING_PROVIDERS).unwrap_or_default().as_deref(),
    );
    // The user's own custom agents, so `@bebou` is an address rather than a word (see
    // `agent_persona`). Read per trigger rather than cached: the list is a handful of rows
    // on the machine the message just arrived on, and a persona saved a second ago must
    // answer the very next message.
    let personas = store.agent_personas().unwrap_or_else(|e| {
        eprintln!("[agent] could not read the custom agents: {e}");
        Vec::new()
    });
    let Some(command) =
        agent_policy::command_for(message, from_me, mode, &providers, &personas, now_ms())
    else {
        // Say when the user's own request was dropped by one of their own settings.
        // Silence here reads as a broken feature, and neither cause — `off` is the
        // default in every conversation, and a provider can be switched off in Settings
        // — is visible from the thread.
        // The name NAMED is what the user wrote — `bebou (claude)` for a custom agent —
        // because a line about `claude` answers the wrong question for somebody who typed
        // `@bebou`.
        if let Some(named) = agent_policy::ignored_trigger(message, from_me, &personas, now_ms()) {
            if mode == agent_policy::Mode::Off {
                eprintln!(
                    "[agent] {named} is `off` in {} — ignoring the trigger. Turn it on from \
                     that conversation's own header.",
                    message.conversation_id
                );
            } else {
                eprintln!(
                    "[agent] the provider behind {named} is disabled — ignoring the trigger. \
                     Turn it on under Settings › AI providers."
                );
            }
        }
        return;
    };
    if !agent::is_available(command.backend) {
        eprintln!(
            "[agent] `{}` is not installed on this machine — ignoring the trigger",
            command.backend.program
        );
        return;
    }
    // Claim the trigger in the store, so the two send-capable backends that share it
    // (the always-on service on 19420 and the user's dev one on 19421) cannot both
    // answer the same message. The same primitive the push path uses, with its own key
    // space.
    let claim = format!("agent/{}/{}", command.conversation_id, command.message_id);
    match store.claim_once(&claim, now_ms()) {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            eprintln!("[agent] could not claim {claim}: {e}");
            return;
        }
    }
    let request = match agent_request(store, &command, self_mri) {
        Ok(request) => request,
        Err(e) => {
            eprintln!("[agent] could not prepare the run: {e}");
            return;
        }
    };
    let ctx = ctx.clone();
    tokio::spawn(async move {
        if let Err(e) = agent_reply(&ctx, &command, request).await {
            eprintln!("[agent] {} failed in {}: {e}", command.backend.name, command.conversation_id);
        }
    });
}

/// Assemble everything a run needs from the store: the thread as context, the tool
/// allowlist, the workspace, the model this provider runs, and the agent session this
/// thread already has.
fn agent_request(
    store: &Store,
    command: &agent_policy::Command,
    self_mri: &str,
) -> Result<agent::Request> {
    let history = store
        .messages_before(&command.conversation_id, i64::MAX, 60)
        .unwrap_or_default();
    let transcript = agent_policy::transcript(&history, &command.message_id);
    let title = store.conversation_context(&command.conversation_id, self_mri).unwrap_or_default();
    let workspace = store
        .get_setting(agent::SETTING_WORKSPACE)?
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(agent::default_workspace);
    Ok(agent::Request {
        // The PROGRAM is the provider's, whether or not a custom agent was addressed: a
        // persona points at an entry of the static table and adds no path of its own (see
        // `agent_persona`). So `agent.rs` needed no change for this feature at all — what a
        // persona decides is the three fields below.
        backend: command.backend,
        // The preprompt LEADS what the CLI is handed, outside the context blocks, so a
        // `/review` is still the first thing it reads. It appears in no message body.
        prompt: command.lead_prompt(&agent_policy::prompt_with_context(
            &command.prompt,
            &transcript,
            command.answering.as_deref(),
        )),
        system_prompt: agent_policy::system_prompt(command.identity(), &title),
        resume_session: store
            .get_setting(&agent_session_key(
                &command.conversation_id,
                command.backend.name,
                command.persona.as_ref().map_or("", |persona| persona.name.as_str()),
            ))?
            .filter(|session| !session.trim().is_empty()),
        workspace,
        // The tool allowlist stays MACHINE-WIDE. A persona is a name and a preprompt, and
        // naming an agent must not be a way to grant it more than the user granted the
        // machine — `agent_set_tools` is the one consent surface for that.
        permissions: agent::permissions_from_settings(
            store.get_setting(agent::SETTING_TOOLS)?.as_deref(),
            store.get_setting(agent::SETTING_UNRESTRICTED)?.as_deref(),
        ),
        // The persona's own model wins over the provider's, and inherits it when it names
        // none: a persona is often only a character, and one that had to restate the model
        // would go stale the day the user changes it in Settings.
        model: command.persona.as_ref().and_then(|persona| persona.model.clone()).or_else(|| {
            agent_policy::Providers::parse(
                store.get_setting(agent_policy::SETTING_PROVIDERS).ok().flatten().as_deref(),
            )
            .model(command.backend.name)
        }),
    })
}

/// The setting key holding one thread's agent session, per backend AND per custom agent —
/// asking claude a follow-up must not resume an opencode session, and asking `@bebou` must
/// not resume the ordinary assistant's.
///
/// That second half is what a persona would otherwise break: one thread can hold a review
/// bot and a boomer aunt, and a shared session would hand each of them the other's context
/// — with the preprompt of one leading a conversation the other has been having. A persona
/// is a different agent to the reader, so it is a different session.
///
/// A provider run keeps EXACTLY the key it always had (`claude:<conversation>`), so no
/// thread loses the session it is in the middle of; a persona's is a segment longer.
fn agent_session_key(conversation_id: &str, backend: &str, persona: &str) -> String {
    let prefix = agent::SETTING_SESSION_PREFIX;
    if persona.is_empty() {
        format!("{prefix}{backend}:{conversation_id}")
    } else {
        format!("{prefix}{backend}/{persona}:{conversation_id}")
    }
}

/// Post the answer, then keep editing that one message as the answer grows.
///
/// The streamed edit is the whole point: everybody in the thread watches the reply
/// being written, rather than staring at nothing for two minutes. It is also the
/// reason the placeholder goes out FIRST — the message must exist before it can be
/// edited, and its id is what the send hands back (see [`teams_send::Sent`]).
///
/// The same run also goes out on `agent_stream`, for the app's own frontends. That is
/// not a second implementation of the same thing: a Teams edit is the LOWEST common
/// denominator — one HTML body, once a second, for clients we do not write — while a
/// local page can be told the reasoning, the tool that is running and the phase, and
/// render the answer token by token. Neither path is authoritative over the other; the
/// message in the thread is the record, and the stream is how this app shows it being
/// written.
///
/// Everything after the placeholder runs inside [`agent_run_to_completion`], so the one
/// thing that must happen however the run ends — dropping the "this message was left
/// mid-answer" record — happens on every path, including the ones that return an error.
/// The marker a stopped run carries out of [`agent_run_to_completion`]'s `run` future.
///
/// It rides an `anyhow::Error` so the one branch that ends a run early is told apart from
/// a real CLI failure by TYPE (`e.is::<AgentStopped>()`), never by matching on a message —
/// a run the user stopped and a run that failed with the words "stopped" are different
/// things, and only one keeps its partial answer.
#[derive(Debug)]
struct AgentStopped;

impl std::fmt::Display for AgentStopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stopped by the user")
    }
}

impl std::error::Error for AgentStopped {}

/// Resolve once the stop switch turns `true`.
///
/// The switch starts `false` and only ever moves to `true`, so a plain `changed()` loop is
/// enough: a spurious wake re-reads `false` and waits again. `changed()` errors only when
/// every sender is dropped, which cannot happen while [`agent_reply`] holds one for the
/// whole run — so this never returns for any reason but a real stop.
async fn wait_for_stop(stop: &mut tokio::sync::watch::Receiver<bool>) {
    if *stop.borrow() {
        return;
    }
    while stop.changed().await.is_ok() {
        if *stop.borrow() {
            return;
        }
    }
    // Every sender gone: let the run finish on its own rather than reporting a stop.
    std::future::pending::<()>().await
}

async fn agent_reply(
    ctx: &Ctx,
    command: &agent_policy::Command,
    mut request: agent::Request,
) -> Result<()> {
    let backend = command.backend;
    // Who the answer may @mention, resolved once for the whole run: the people of THIS
    // thread and nobody else. The list does two jobs — it tells the model which names it
    // can write (a capability nothing says is a capability nothing uses), and it is what
    // every `@…` in the answer is matched against.
    //
    // Best-effort, like the composer's own list: a thread whose roster Teams refuses
    // leaves an answer that mentions nobody, which is what every answer did before.
    let people = thread_mentionable_people(ctx, &command.conversation_id)
        .await
        .unwrap_or_else(|e| {
            eprintln!("[agent] no mention list for {}: {e}", command.conversation_id);
            Vec::new()
        });
    request.system_prompt.push_str(&agent_markdown::mention_note(&people));

    // Who this answer says wrote it: the CLI, or the custom agent that was addressed. One
    // value for every body of the run, so the placeholder, each streamed edit and the final
    // one cannot disagree — and so the loop guard recognises all three.
    let signer = command.signature();
    let placeholder = agent_policy::thinking_html(&signer);
    let sent = agent_send(ctx, command, &placeholder).await?;
    if sent.id.is_empty() {
        anyhow::bail!("the reply was posted but Teams returned no message id to edit");
    }
    // The reply is our own message, so it comes back on the trouter as a live message
    // from us — and if an answer ever opened with a prefix, it would summon the agent
    // again, forever. Claiming its id here means the trigger check finds it already
    // taken. One line, and the loop cannot happen.
    if let Ok(store) = ctx.store() {
        let claim = format!("agent/{}/{}", command.conversation_id, sent.id);
        if let Err(e) = store.claim_once(&claim, now_ms()) {
            eprintln!("[agent] could not claim our own reply {claim}: {e}");
        }
    }

    // From here the thread holds a message this process alone can finish, so record the
    // run before anything can go wrong with it. A restart from here on is what leaves a
    // "claude is thinking…" body in the thread for good, and this row plus its marker
    // are the two things that make that recoverable (see the `agent_runs` note in
    // src/store.rs and `agent_run_marker_dir`).
    let run = store::AgentRun {
        conversation_id: command.conversation_id.clone(),
        message_id: sent.id.clone(),
        trigger_id: command.message_id.clone(),
        // By NAME, so a repair can sign the interrupted body as `bebou (claude)` even if the
        // user deleted that persona while the run was writing.
        persona: command.persona.as_ref().map_or(String::new(), |p| p.name.clone()),
        backend: backend.name.to_string(),
        started_ms: now_ms(),
        heartbeat_ms: now_ms(),
    };
    if let Ok(store) = ctx.store() {
        if let Err(e) = store.begin_agent_run(&run) {
            eprintln!("[agent] could not record the run on {}: {e}", sent.id);
        }
    }
    publish_agent_run_marker(&run);

    // The switch the user can flip to stop this run, keyed by the same `run_id` every
    // frame carries. Registered before the run starts so a stop that arrives in the first
    // second finds it, and taken back on every exit path below — a token left in the map
    // would let `agent_stop` "stop" a run that already finished.
    let run_id = format!("{}/{}", command.conversation_id, command.message_id);
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    ctx.agent_runs_inflight.lock().unwrap().insert(run_id.clone(), stop_tx);

    let outcome = agent_run_to_completion(ctx, command, request, &sent.id, &people, stop_rx).await;

    ctx.agent_runs_inflight.lock().unwrap().remove(&run_id);

    // The run is over, whatever it produced. Clearing the record BEFORE the result is
    // propagated is deliberate: a failed final edit is a finished run whose answer was
    // lost, and rewriting its body an hour later with "the backend restarted" would be
    // a repair inventing a cause.
    if let Ok(store) = ctx.store() {
        if let Err(e) = store.finish_agent_run(&command.conversation_id, &sent.id) {
            eprintln!("[agent] could not clear the run on {}: {e}", sent.id);
        }
    }
    remove_agent_run_marker(&sent.id);
    outcome
}

/// Run the agent and write its answer into the message [`agent_reply`] posted.
///
/// `stop` is the switch [`agent_stop`] flips: while it is `false` the run streams
/// normally, and when it turns `true` the run future is dropped — which kills the CLI
/// child (`kill_on_drop` in src/agent.rs) — and the answer so far is finalized with a
/// "stopped by you" note rather than lost. Everything else about the terminal path is
/// unchanged, which is the point: a stop is a run that ends early, not a fifth shape.
async fn agent_run_to_completion(
    ctx: &Ctx,
    command: &agent_policy::Command,
    request: agent::Request,
    message_id: &str,
    people: &[agent_markdown::Mentionable],
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let backend = command.backend;

    // The run starts: say so at once, so a page that has the thread open shows the
    // agent taking the question rather than a lone "thinking…" placeholder.
    ctx.emit(
        "agent_stream",
        agent_stream_frame(command, message_id, "thinking", &agent::Progress::default(), None),
    );

    let (progress, mut watch_edits) = tokio::sync::watch::channel(agent::Progress::default());
    let mut watch_local = progress.subscribe();
    let mut watch_alive = progress.subscribe();
    // The sender is dropped the moment the run ends, which is what stops both loops
    // below. Without that explicit drop the futures would wait on each other:
    // `tokio::join!` keeps every branch alive until all of them finish.
    //
    // The user's Stop wins a race against the CLI here: `select!` drops the losing
    // branch, so a stop drops `agent::run` — and with it the child, via `kill_on_drop`.
    // `Stopped` is the marker `outcome` carries out for it; the CLI's own answer never
    // reads as one.
    let run = async move {
        let outcome = tokio::select! {
            outcome = agent::run(&request, &progress) => outcome,
            // `changed()` only errors when every sender is dropped, which cannot happen
            // while `agent_reply` holds one — so a real flip to `true` is the only way out.
            _ = wait_for_stop(&mut stop) => Err(anyhow::Error::new(AgentStopped)),
        };
        drop(progress);
        outcome
    };
    let edits = agent_stream_edits(ctx, command, message_id, &mut watch_edits, people);
    let local = agent_stream_local(ctx, command, message_id, &mut watch_local);
    let alive = agent_run_heartbeat(ctx, &command.conversation_id, message_id, &mut watch_alive);
    // All four at once: the child's output drives the watch channel, and the three
    // consumers drain it at the pace each one can afford.
    let (outcome, edits, (), ()) = tokio::join!(run, edits, local, alive);
    if let Err(e) = edits {
        eprintln!("[agent] a progress edit failed (the answer still lands): {e}");
    }

    // A stop is not a failure: the answer so far is real and kept, with a note that the
    // user ended the run. `watch_local` holds the last streamed progress, so the partial
    // is exactly what the bubble was showing — and an empty one (stopped while thinking)
    // falls back to the note alone inside `stopped_body`.
    let signer = command.signature();
    let stopped = outcome.as_ref().err().is_some_and(|e| e.is::<AgentStopped>());
    let (final_body, session_id, cost) = if stopped {
        let partial = watch_local.borrow().text.clone();
        (agent_policy::stopped_body(&signer, &partial, people), None, None)
    } else {
        match &outcome {
            Ok(outcome) => (
                agent_policy::reply_body(&signer, &outcome.text, true, people),
                outcome.session_id.clone(),
                outcome.cost_usd,
            ),
            Err(e) => (agent_policy::failure_body(&signer, &e.to_string()), None, None),
        }
    };
    // The answer lands in the thread, and only THEN does the stream say it is over.
    //
    // That order matters to a client. A finished run stops being an overlay: the app
    // lets go of it and renders the posted message instead (see `forgetAgentRun` in
    // web/src/lib/store.ts). If "done" arrived first, the message it fell back to would
    // still be the second-to-last edit — so the answer would visibly lose its last
    // sentence for as long as it takes Teams to echo the final one back.
    let edited = agent_edit(ctx, &command.conversation_id, message_id, &final_body).await;
    // The run's own last state, with the authoritative answer over it. The transcript
    // travels on the terminal frame too: it is an overlay on the message, so this is the
    // last frame that can carry it, and a `done` that dropped it would blank the
    // reasoning a beat before the app lets the run go. A stopped run keeps the partial it
    // was showing, so the frame's text matches the body just edited in.
    let final_text = match &outcome {
        Ok(outcome) => outcome.text.clone(),
        Err(_) if stopped => watch_local.borrow().text.clone(),
        Err(_) => String::new(),
    };
    let final_progress = agent::Progress {
        phase: agent::Phase::Writing,
        text: final_text,
        ..watch_local.borrow().clone()
    };
    // Sent whatever the edit did: a client that never hears the run ended would show a
    // bubble writing forever (until its own staleness guard fires, minutes later). A STOP
    // ends the run as `done`, not `error`: the answer it kept is real, the body reads as
    // finished, and the overlay tears down the same way a normal finish does.
    match &outcome {
        Ok(_) => ctx.emit(
            "agent_stream",
            agent_stream_frame(command, message_id, "done", &final_progress, None),
        ),
        Err(_) if stopped => ctx.emit(
            "agent_stream",
            agent_stream_frame(command, message_id, "done", &final_progress, None),
        ),
        Err(e) => ctx.emit(
            "agent_stream",
            agent_stream_frame(command, message_id, "error", &final_progress, Some(&e.to_string())),
        ),
    }
    edited?;

    // Remember the session so a follow-up in this thread continues the conversation.
    if let (Some(session), Ok(store)) = (session_id, ctx.store()) {
        let key = agent_session_key(
            &command.conversation_id,
            backend.name,
            command.persona.as_ref().map_or("", |persona| persona.name.as_str()),
        );
        if let Err(e) = store.set_setting(&key, &session) {
            eprintln!("[agent] could not remember the session for {key}: {e}");
        }
    }
    match &outcome {
        Ok(outcome) => eprintln!(
            "[agent] {} answered in {} ({} chars{})",
            backend.name,
            command.conversation_id,
            outcome.text.chars().count(),
            cost.map(|c| format!(", ${c:.2}")).unwrap_or_default()
        ),
        Err(_) if stopped => {
            eprintln!("[agent] {} was stopped in {}", backend.name, command.conversation_id)
        }
        Err(e) => eprintln!("[agent] {} could not answer: {e}", backend.name),
    }
    // A stop is a clean end, not a failure the spawn wrapper should log as one.
    if stopped { Ok(()) } else { outcome.map(|_| ()) }
}

/// Say every [`AGENT_RUN_HEARTBEAT`] that this run is still writing, until it ends.
///
/// On a CLOCK rather than on progress, which is the whole point: an agent reading files
/// for a minute emits nothing, and a run judged dead because it went quiet would have
/// its answer overwritten by a repair while it was still working (see
/// [`repair_abandoned_agent_runs`]). What a missed beat must mean is a missing process.
///
/// Returns when the runner drops its end of the channel, i.e. when the run is over.
async fn agent_run_heartbeat(
    ctx: &Ctx,
    conversation_id: &str,
    message_id: &str,
    progress: &mut tokio::sync::watch::Receiver<agent::Progress>,
) {
    loop {
        // The inner future returns only when the channel closes, so the timeout IS the
        // beat: `Ok` means the run ended, `Err` means it is still going.
        let ended = tokio::time::timeout(AGENT_RUN_HEARTBEAT, async {
            while progress.changed().await.is_ok() {}
        })
        .await;
        if ended.is_ok() {
            return;
        }
        if let Ok(store) = ctx.store() {
            if let Err(e) = store.touch_agent_run(conversation_id, message_id, now_ms()) {
                eprintln!("[agent] could not refresh the run on {message_id}: {e}");
            }
        }
    }
}

/// Close the messages of runs no process is writing any more, for as long as this one
/// lives.
///
/// The failure it repairs: the always-on service is restarted — a re-stage, a broker bus
/// that moved — while an agent is answering. The child dies with the process, the final
/// edit never goes out, and the message sits in the thread saying "claude is thinking…"
/// forever, for everybody in it. Nothing else notices, because nothing is left that
/// knows a run existed.
///
/// It sweeps rather than checking once at boot: the run this restart just killed still
/// carries a fresh heartbeat when we come up a second later, so a single startup pass
/// would find nothing at all.
fn spawn_agent_run_repair(ctx: Ctx) {
    // A read-only backend must never edit the user's messages — the screenshot backend
    // shares this store, and the message belongs to the run that is still writing it in
    // the send-capable one.
    if read_only() {
        return;
    }
    tokio::spawn(async move {
        loop {
            repair_abandoned_agent_runs(&ctx).await;
            tokio::time::sleep(AGENT_REPAIR_INTERVAL).await;
        }
    });
}

/// One sweep: every run quiet for longer than [`AGENT_RUN_ABANDONED_AFTER`] has its
/// message closed with [`agent_policy::interrupted_html`].
async fn repair_abandoned_agent_runs(ctx: &Ctx) {
    let Ok(store) = ctx.store() else { return };
    let quiet_before = now_ms() - AGENT_RUN_ABANDONED_AFTER.as_millis() as i64;
    let abandoned = match store.abandoned_agent_runs(quiet_before) {
        Ok(runs) => runs,
        Err(e) => {
            eprintln!("[agent] could not look for abandoned runs: {e}");
            return;
        }
    };
    for run in abandoned {
        // Two backends share the store and both sweep it. Taking the row is what makes
        // exactly one of them edit the message.
        match store.take_abandoned_agent_run(&run.conversation_id, &run.message_id, quiet_before) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                eprintln!("[agent] could not take the run on {}: {e}", run.message_id);
                continue;
            }
        }
        let backend =
            agent_policy::backend_named(&run.backend).unwrap_or(&agent_policy::BACKENDS[0]);
        // The interrupted body signs itself with what the thread has been WATCHING — the
        // custom agent's own name when one was addressed — built from the two names the row
        // wrote down rather than from the persona, which the user may have deleted while
        // this run was quietly dying.
        let signer = agent_policy::Signature::stored(&run.persona, backend.name);
        let body = agent_policy::interrupted_body(&signer);
        if let Err(e) = agent_edit(ctx, &run.conversation_id, &run.message_id, &body).await {
            // Put it back rather than lose it: a transient 429 or a re-locked broker
            // must not be the reason a message stays "thinking…" for good.
            eprintln!("[agent] could not close the run on {}: {e:#}", run.message_id);
            if let Err(e) = store.begin_agent_run(&run) {
                eprintln!("[agent] could not keep the run on {} for a retry: {e}", run.message_id);
            }
            continue;
        }
        // The app's own pages may still be drawing this run as an overlay. Tell them it
        // is over, so they fall back to the message they can now read (rather than
        // waiting for their own staleness guard).
        ctx.emit(
            "agent_stream",
            agent_run_frame(
                &run.conversation_id,
                &run.trigger_id,
                &run.message_id,
                backend.name,
                &run.persona,
                "error",
                &agent::Progress::default(),
                Some(agent_policy::INTERRUPTED_REASON),
            ),
        );
        remove_agent_run_marker(&run.message_id);
        eprintln!(
            "[agent] {} left a reply unfinished in {} — closed it ({})",
            signer.as_str(),
            run.conversation_id,
            agent_policy::INTERRUPTED_REASON
        );
    }
}

/// Edit the reply in place whenever the answer changed, at most every
/// [`AGENT_EDIT_INTERVAL`] and at most [`AGENT_MAX_EDITS`] times.
///
/// Returns when the runner drops its end of the channel, i.e. when the run is over.
/// The final text is NOT posted here — [`agent_run_to_completion`] does that once, from
/// the authoritative outcome — so a missed last tick costs nothing.
async fn agent_stream_edits(
    ctx: &Ctx,
    command: &agent_policy::Command,
    message_id: &str,
    progress: &mut tokio::sync::watch::Receiver<agent::Progress>,
    people: &[agent_markdown::Mentionable],
) -> Result<()> {
    let mut edits = 0;
    let mut posted = String::new();
    while progress.changed().await.is_ok() {
        if edits >= AGENT_MAX_EDITS {
            return Ok(());
        }
        // Only the answer travels to Teams. A reasoning delta or a tool starting
        // changes the progress without changing the message, and spending one of the
        // hundred edits on a body nobody can tell apart from the last one is waste.
        let text = progress.borrow_and_update().text.clone();
        if text.trim().is_empty() || text == posted {
            continue;
        }
        let body = agent_policy::reply_body(&command.signature(), &text, false, people);
        agent_edit(ctx, &command.conversation_id, message_id, &body).await?;
        posted = text;
        edits += 1;
        // Rate limit AFTER the edit, so the first piece of the answer appears as soon
        // as it exists and the interval spaces out what follows.
        tokio::time::sleep(AGENT_EDIT_INTERVAL).await;
    }
    Ok(())
}

/// Report the whole run to the app's own frontends, as `agent_stream` events.
///
/// The local twin of [`agent_stream_edits`], and deliberately less frugal: a frame
/// costs a JSON serialization and a loopback write, so every change is worth sending —
/// the reasoning, the tool that started, the phase — floored only at
/// [`AGENT_STREAM_INTERVAL`] so a fast model does not become a frame per token.
///
/// Returns when the runner drops its end of the channel. The terminal frame is NOT
/// sent here: [`agent_run_to_completion`] sends it from the authoritative outcome, which
/// is the only place that knows whether the run succeeded.
///
/// A frame also goes out every [`AGENT_STREAM_KEEPALIVE`] while nothing changes, because
/// a client cannot tell a run reading files in silence from a backend that died mid-answer
/// — and it must not drop a live run from under the user (see that constant).
async fn agent_stream_local(
    ctx: &Ctx,
    command: &agent_policy::Command,
    message_id: &str,
    progress: &mut tokio::sync::watch::Receiver<agent::Progress>,
) {
    loop {
        let waited = tokio::time::timeout(AGENT_STREAM_KEEPALIVE, progress.changed()).await;
        // A closed channel is the run ending; a timeout is a run that is merely quiet,
        // and the frame below then repeats what it said last.
        if matches!(waited, Ok(Err(_))) {
            return;
        }
        let current = progress.borrow_and_update().clone();
        ctx.emit(
            "agent_stream",
            agent_stream_frame(command, message_id, current.phase.as_str(), &current, None),
        );
        // Floor the rate AFTER the frame, so the first token appears at once and only
        // what follows is spaced out. The channel keeps just the latest value, so a
        // burst during the sleep collapses into one frame rather than a backlog.
        tokio::time::sleep(AGENT_STREAM_INTERVAL).await;
    }
}

/// One `agent_stream` frame: where a run stands, for a client that renders it.
///
/// `phase` is passed rather than read off the progress because the two terminal states
/// — `done` and `error` — are not progress at all (see [`agent::Phase`]), and a client
/// needs them to stop streaming.
///
/// The `run_id` names the REQUEST, not the reply: it is the trigger message's id, so a
/// client can tell one run from the next in a thread where the user asked twice, and
/// `message_id` says which posted message the run is writing into.
fn agent_stream_frame(
    command: &agent_policy::Command,
    message_id: &str,
    phase: &str,
    progress: &agent::Progress,
    error: Option<&str>,
) -> Value {
    agent_run_frame(
        &command.conversation_id,
        &command.message_id,
        message_id,
        command.backend.name,
        command.persona.as_ref().map_or("", |persona| persona.name.as_str()),
        phase,
        progress,
        error,
    )
}

/// The same frame, from the parts a stored run holds rather than from a live
/// [`agent_policy::Command`] — which a process that only found the run in the store no
/// longer has (see [`repair_abandoned_agent_runs`]).
#[allow(clippy::too_many_arguments)]
fn agent_run_frame(
    conversation_id: &str,
    trigger_id: &str,
    message_id: &str,
    backend: &str,
    persona: &str,
    phase: &str,
    progress: &agent::Progress,
    error: Option<&str>,
) -> Value {
    json!({
        "run_id": format!("{conversation_id}/{trigger_id}"),
        "conversation": conversation_id,
        "message_id": message_id,
        "backend": backend,
        // The CUSTOM AGENT answering, or "" — so the LIVE bubble draws its face from the
        // first frame. Without it the run would wear the vendor's mark all the way through
        // and swap to the persona's the instant it ended, when the posted message's own
        // signature takes over: a change the reader watches for no reason.
        "persona": persona,
        "phase": phase,
        "text": progress.text,
        "steps": progress.steps.iter().map(agent_step_json).collect::<Vec<_>>(),
        "activity": progress.activity.as_ref().map(|activity| json!({
            "tool": activity.tool,
            "target": activity.target,
            "done": activity.done,
        })),
        "tools_used": progress.tools_used,
        "error": error,
        "at": now_ms(),
    })
}

/// One entry of the run's transcript, on the wire.
///
/// Tagged by `kind` rather than by which field is present: a reader that does not know a
/// kind we add later skips it, where a shape guessed from the keys would draw it wrong.
fn agent_step_json(step: &agent::Step) -> Value {
    match step {
        agent::Step::Thought(text) => json!({ "kind": "thought", "text": text }),
        agent::Step::Tool(activity) => json!({
            "kind": "tool",
            "tool": activity.tool,
            "target": activity.target,
            "done": activity.done,
        }),
    }
}

/// Post the agent's message as a native Teams reply to the message that summoned it.
///
/// In a CHANNEL that quote is all the link there is: the send path does not carry a
/// `rootMessageId` yet, so the answer opens its own thread rather than landing inside
/// the user's. Nothing here needs to change when it does — the reply markup is already
/// what a chat uses, and a channel would simply gain the parent id alongside it.
async fn agent_send(
    ctx: &Ctx,
    command: &agent_policy::Command,
    html: &str,
) -> Result<teams_send::Sent> {
    let reply_to = teams_send::ReplyTo {
        sender: command.sender.clone(),
        sender_mri: command.sender_mri.clone(),
        compose_time: command.compose_time,
        preview: agent_policy::preview_of(&command.prompt),
        before: String::new(),
        after: String::new(),
    };
    let http = ctx.http.clone();
    let tokens = ctx.tokens.clone();
    let conversation = command.conversation_id.clone();
    let html = html.to_string();
    // The agent's answer is sealed like every other message in a sealed chat — the user asked
    // for exactly that split: the agent READS the thread in the clear (its prompt carries the
    // conversation to the model provider), and what it POSTS is sealed. Read once, outside the
    // retry, so an auth retry re-seals under the same key.
    let seal_key = ctx
        .store()
        .context("this chat may be sealed and the store cannot be read")?
        .current_seal_key(&conversation)?;
    ctx.retry_on_auth(move |session, _csa| {
        let http = http.clone();
        let tokens = tokens.clone();
        let conversation = conversation.clone();
        let html = html.clone();
        let reply_to = reply_to.clone();
        let seal_key = seal_key.clone();
        async move {
            let ic3 = tokens.get(IC3_SCOPE).await?;
            teams_send::send_message(
                &http,
                &session,
                &ic3,
                &conversation,
                "",
                Some(&reply_to),
                Some(&html),
                &[],
                // An agent's answer carries no custom emoji: its words are not the
                // user's pack, and an agent that turned text into art would upload
                // bytes the user never chose to post — and re-upload them on every
                // one-second edit as the answer streams.
                &[],
                // An agent's answer mentions nobody: it is a reply, and a machine must
                // not be able to notify a colleague.
                &[],
                // Never scheduled: the answer is posted now and EDITED as it is written,
                // and a message Teams is holding has no body to edit.
                None,
                // And no title: an answer is a REPLY, which has none — the thread it
                // answers in is already named by its first post.
                None,
                seal_key.as_ref(),
            )
            .await
        }
    })
    .await
}

/// Replace the reply's content with the answer as it stands.
///
/// Takes the conversation rather than the whole [`agent_policy::Command`]: the repair
/// sweep edits a message whose trigger is long gone, and an edit needs nothing else.
async fn agent_edit(
    ctx: &Ctx,
    conversation_id: &str,
    message_id: &str,
    body: &agent_policy::ReplyBody,
) -> Result<()> {
    let http = ctx.http.clone();
    let conversation = conversation_id.to_string();
    let message_id = message_id.to_string();
    let body = body.clone();
    // Every streaming frame of the answer is a re-seal, with a fresh nonce each time. Read the
    // key once here rather than per frame: the derivation is already paid (the store holds the
    // derived key), and a passphrase changed mid-answer must not split one message across two.
    let seal_key = ctx
        .store()
        .context("this chat may be sealed and the store cannot be read")?
        .current_seal_key(conversation_id)?;
    ctx.retry_on_auth(move |session, _csa| {
        let http = http.clone();
        let conversation = conversation.clone();
        let message_id = message_id.clone();
        let body = body.clone();
        let seal_key = seal_key.clone();
        async move {
            teams_send::edit_message(
                &http,
                &session,
                &conversation,
                &message_id,
                "",
                Some(&body.html),
                &body.mentions,
                // An agent's reply has no title: it is posted as a REPLY, and a reply is
                // never titled (see `teams_send::parse_subject`). So there is nothing for
                // this edit — one of many, once a second as the answer streams — to carry.
                None,
                seal_key.as_ref(),
            )
            .await
            // The edit answers with the body it posted; an agent's own edit has no local row to
            // reconcile, so it is dropped here rather than threaded through the caller.
            .map(|_posted| ())
        }
    })
    .await
}

/// What `agent_status` reports: which backends this machine can run, which of them the
/// user left enabled and on which model, which conversations are opted in, and what an
/// agent is allowed to do.
/// The user's custom agents as a client reads them, in one place — the status carries them
/// and both writes answer with the status.
///
/// `prefix` is stated rather than left to a client to spell: an address is `@` plus the name
/// today, and a page that assembled its own would be a second spelling of the one thing a
/// message has to carry for the backend to read it back (the rule `AgentBackend.prefix`
/// already follows).
fn agent_personas_json(store: &Store) -> Result<Vec<Value>> {
    Ok(store
        .agent_personas()?
        .into_iter()
        .map(|persona| {
            json!({
                "name": persona.name,
                "label": persona.label(),
                "prefix": persona.prefix(),
                "backend": persona.backend.name,
                "model": persona.model,
                "preprompt": persona.preprompt,
                // Whether to ASK for the face, so a persona with none costs no request and
                // draws the provider's own mark instead.
                "has_avatar": persona.avatar.is_some(),
                "added_ms": persona.added_ms,
                "updated_ms": persona.updated_ms,
            })
        })
        .collect())
}

fn agent_status_json(store: &Store) -> Result<Value> {
    let personas = agent_personas_json(store)?;
    let modes = store.get_setting(agent_policy::SETTING_MODES)?;
    let stored_providers = store.get_setting(agent_policy::SETTING_PROVIDERS)?;
    let providers = agent_policy::Providers::parse(stored_providers.as_deref());
    let backends: Vec<Value> = agent_policy::BACKENDS
        .iter()
        .map(|backend| {
            json!({
                "name": backend.name,
                "prefix": backend.prefix,
                // Two different facts, and a UI needs both: whether the CLI exists on
                // this machine, and whether the user left it on.
                "available": agent::is_available(backend),
                "enabled": providers.is_enabled(backend.name),
                "model": providers.model(backend.name),
                // What a picker offers, never a limit on what may be saved — see
                // `agent_models::choices`, which reads this machine's own catalogue.
                "models": agent_models::choices(backend),
            })
        })
        .collect();
    let conversations: Vec<Value> = agent_policy::configured_modes(modes.as_deref())
        .into_iter()
        .map(|(id, mode)| json!({ "conversation": id, "mode": mode.as_str() }))
        .collect();
    let workspace = store
        .get_setting(agent::SETTING_WORKSPACE)?
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| agent::default_workspace().display().to_string());
    // What the user may switch on, so a client offers the same read-only groups this
    // crate reviewed rather than a tool-name text field (`agent::TOOL_GRANTS`).
    let tool_grants: Vec<Value> = agent::TOOL_GRANTS
        .iter()
        .map(|grant| {
            json!({
                "key": grant.key,
                "label": grant.label,
                "detail": grant.detail,
                "tools": grant.tools,
            })
        })
        .collect();
    // The one provider a surface offers when it offers a single row — a message's "…"
    // menu. Every enabled provider still answers its own prefix; this only says which one
    // is named where there is room for one (`agent_policy::default_backend`).
    let default_provider = agent_policy::default_backend(
        store.get_setting(agent_policy::SETTING_DEFAULT_PROVIDER)?.as_deref(),
    );
    Ok(json!({
        "backends": backends,
        "default_provider": default_provider.name,
        // The user's own custom agents (see `teams_lite::agent_persona`). They ride in the
        // STATUS rather than in a read of their own because every surface that offers an
        // agent already holds this payload — the composer's "@", a bubble's chip, the
        // Settings pane — and a second list would be a second thing to keep in step.
        //
        // The PREPROMPT travels, unlike a token in `get_settings`: it is not a credential
        // but the user's own instruction, and the pane that edits one has to show what is
        // there. The avatar BYTES do not — a status is answered on every connect, and ten
        // faces is megabytes (see `agent_persona_avatar`).
        "personas": personas,
        "conversations": conversations,
        "tools": agent::tools_from_setting(store.get_setting(agent::SETTING_TOOLS)?.as_deref()),
        "tool_grants": tool_grants,
        // Whether the allowlist above applies at all: on the user's own configuration it
        // does not, and a client must say so rather than draw switches that decide
        // nothing.
        "unrestricted": agent::unrestricted_from_setting(
            store.get_setting(agent::SETTING_UNRESTRICTED)?.as_deref(),
        ),
        "workspace": workspace,
        // A read-only backend never answers, so a UI can say so rather than offering a
        // switch that would do nothing.
        "enabled": !read_only(),
        "sandbox_conversation": agent_policy::SANDBOX_THREAD,
    }))
}

// ---------------------------------------------------------------------------
// Audio calling (see `teams_lite::calling` and NATIVE-CALLING.md)
//
// The backend signals and the browser carries the audio. That split is not an
// implementation detail: the tokens must never reach a page, and the microphone can
// only be reached from one. So every SDP crosses the local WebSocket — an offer out,
// an answer in — and this side never handles RTP.
// ---------------------------------------------------------------------------

/// Does this backend take and place calls? EVERY install does, save a read-only one.
///
/// The app IS a Teams client, so it registers as a device their calls ring on the way
/// every other client they are signed in on does — there is no switch, because a
/// messaging client that cannot be called is half a client, and every window the user
/// opens is one they may want to call from. Registering is reversible in both directions
/// and by itself reaches nobody: what rings a person is `call_place`, which is gated as
/// the outward action it is.
///
/// A READ-ONLY backend is the single exception, and it is the one install the user never
/// opened: a screenshot backend must not become a device their calls ring on.
///
/// SEVERAL installs on one machine therefore all register, and that is deliberate. Each
/// holds a calling endpoint id of its own (`endpoint_id_path`, keyed by the port), so the
/// service sees as many DEVICES — a call rings all of them, exactly as it rings the
/// user's phone beside their laptop, and answering on one ends the ring on the rest.
/// That second ring is the whole cost, and it used to be paid the other way round: the
/// released build running beside the staged pair carried an environment value that
/// silenced its registration, so every call and Join control in that window was drawn
/// disabled — and the window a phone had open was the silenced one, which reads as an app
/// that cannot call at all. No environment value silences a device now
/// (`no_environment_value_silences_calling` scans this module), because a call the user
/// cannot place is far the worse failure.
fn calling_available() -> bool {
    !read_only()
}

impl Ctx {
    /// The `call_state` event and the `call_status` answer, in one shape so a client
    /// that reconnects mid-call learns exactly what a live one already knows.
    fn call_state_payload(&self) -> Value {
        let plane = self.calling.lock().unwrap();
        json!({
            "enabled": calling_available(),
            // Ready means a call could start right now: the connection is up and
            // registered. A backend that calls while this is false is honest about a
            // connection that has not come back yet.
            "ready": plane.channel.is_some() && plane.connected,
            "call": plane.call.as_ref().map(CallSession::json),
        })
    }

    fn emit_call_state(&self) {
        self.emit("call_state", self.call_state_payload());
    }

    /// Our own identity for one call: our mri and name, the calling endpoint's
    /// registration id, and a fresh participant leg.
    fn local_participant(&self, session: &Session, endpoint_id: &str) -> calling::LocalParticipant {
        calling::LocalParticipant {
            id: session.self_mri.clone(),
            display_name: session.self_name.clone(),
            endpoint_id: endpoint_id.to_string(),
            participant_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// Start the calling connection, unless it is already up.
    ///
    /// One connection of its own, on the calling trouter, registered as the web
    /// client registers it. It reconnects forever on its own (`trouter::run`), so
    /// this is called once per process, at boot (see `spawn_calling`).
    async fn start_calling(&self) -> Result<()> {
        if self.calling.lock().unwrap().connection.is_some() {
            return Ok(());
        }
        let session = self.session().await?;
        let endpoints = calling::endpoints(&session)?;
        // A registration id of its own, persisted beside the messaging one: two
        // workers are two endpoints, and one id would make the second registration
        // replace the first. Per BACKEND as well as per worker, for the same reason
        // (see `endpoint_id_path`) — two calling registrations on one machine would
        // ring both, and the second would silence the first.
        let epid_path = endpoint_id_path(self.db_path.as_str(), own_port(), "calling");
        let epid = trouter::load_or_create_epid(&epid_path);
        let endpoint = trouter::Endpoint::calling(&endpoints.trouter, &endpoints.registrar);
        eprintln!(
            "[calling] registering as {} on {} (epid {epid})",
            endpoint.template_key, endpoint.allocate
        );

        let (frames_tx, mut frames_rx) = tokio::sync::mpsc::unbounded_channel();
        let (chan_tx, mut chan_rx) =
            tokio::sync::mpsc::unbounded_channel::<trouter::CallingChannel>();
        let (st_tx, mut st_rx) = tokio::sync::mpsc::unbounded_channel::<trouter::Status>();

        // The connection's own address. Every reconnect publishes it again, and a
        // surl that CHANGED invalidates the links of a call still up — so the call is
        // ended rather than left with links nobody answers.
        let ctx_chan = self.clone();
        tokio::spawn(async move {
            while let Some(channel) = chan_rx.recv().await {
                eprintln!(
                    "[calling] callbacks on {} (epid {})",
                    calling::surl_shape(&channel.surl),
                    channel.endpoint_id
                );
                let changed = {
                    let mut plane = ctx_chan.calling.lock().unwrap();
                    let changed = plane
                        .channel
                        .as_ref()
                        .is_some_and(|existing| existing.surl != channel.surl);
                    plane.channel = Some(channel);
                    plane.connected = true;
                    changed
                };
                if changed {
                    ctx_chan.end_call_locally("CallEndReasonReconnected").await;
                }
                ctx_chan.emit_call_state();
            }
        });

        let ctx_frames = self.clone();
        tokio::spawn(async move {
            while let Some(frame) = frames_rx.recv().await {
                ctx_frames.handle_call_frame(frame).await;
            }
        });

        // The calling socket's lifecycle is worth one journal line each way — a call
        // that never rings is diagnosed from here — and it decides whether this machine
        // says it is ready. It does NOT end a live call: a socket that comes back with
        // the same surl comes back to the same links, and only a CHANGED surl breaks
        // them (see the channel task above).
        let ctx_status = self.clone();
        tokio::spawn(async move {
            while let Some(status) = st_rx.recv().await {
                match status {
                    trouter::Status::Connected => eprintln!("[calling] connected"),
                    trouter::Status::Disconnected { retry_in_secs } => {
                        eprintln!("[calling] disconnected, retrying in {retry_in_secs}s");
                        ctx_status.calling.lock().unwrap().connected = false;
                        ctx_status.emit_call_state();
                    }
                    trouter::Status::Connecting => {}
                }
            }
        });

        // One ticker for the whole connection rather than one per call: there is only
        // ever one call, and a task that outlives it has nothing to leak.
        let ctx_keepalive = self.clone();
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(CALL_KEEPALIVE);
            ticks.tick().await; // consume the immediate first tick
            loop {
                ticks.tick().await;
                if ctx_keepalive.calling.lock().unwrap().connection.is_none() {
                    return; // calling was turned off; this connection is gone
                }
                ctx_keepalive.keep_call_alive().await;
            }
        });

        let creds = self.clone();
        let handle = tokio::spawn(async move {
            trouter::run(
                creds,
                epid,
                endpoint,
                trouter::Role::Calling { frames: frames_tx, channel: chan_tx },
                st_tx,
            )
            .await;
        });
        self.calling.lock().unwrap().connection = Some(handle);
        Ok(())
    }

    /// Stop the calling connection and unregister the endpoint.
    ///
    /// Unregistering is the load-bearing half. A registration Teams still believes in
    /// keeps routing the user's calls to a client that is gone, and a call offered to
    /// a device that never rings is a call they miss — so the DELETE goes out even if
    /// dropping the socket already did.
    async fn stop_calling(&self) {
        let (handle, endpoint_id) = {
            let mut plane = self.calling.lock().unwrap();
            plane.connected = false;
            plane.relay = None;
            plane.relay_credentials = None;
            (plane.connection.take(), plane.channel.take().map(|c| c.endpoint_id))
        };
        self.end_call_locally("CallEndReasonCallingTurnedOff").await;
        if let Some(handle) = handle {
            handle.abort();
        }
        if let Some(endpoint_id) = endpoint_id {
            if let Err(e) = self.unregister_calling(&endpoint_id).await {
                eprintln!("[calling] could not unregister {endpoint_id}: {e:#}");
            } else {
                eprintln!("[calling] unregistered {endpoint_id} — calls stop ringing here");
            }
        }
        self.emit_call_state();
    }

    async fn unregister_calling(&self, endpoint_id: &str) -> Result<()> {
        let session = self.session().await?;
        let ic3 = self.tokens.get(IC3_SCOPE).await?;
        let endpoints = calling::endpoints(&session)?;
        trouter::unregister(&self.http, &session.skypetoken, &ic3, &endpoints.registrar, endpoint_id)
            .await
    }

    /// One decoded frame from the calling socket. This is the whole receive path.
    async fn handle_call_frame(&self, frame: trouter_events::CallFrame) {
        record_call_frame(&frame);
        // The raw frame still goes to the UI console: the schema is young, and a
        // capture of what really arrived is what corrects it.
        self.emit(
            "call_signal",
            json!({ "url": frame.url, "call_id": frame.call_id, "body": frame.body }),
        );

        // The relay description can ride on any frame; cache it the moment it does,
        // so the credentials are ready before the next call needs them.
        if let Some(relay) = calling::relay_config_in_frame(&frame.body) {
            let already = self.calling.lock().unwrap().relay.as_ref() == Some(&relay);
            if !already {
                self.calling.lock().unwrap().relay = Some(relay);
                self.refresh_relay_credentials().await;
            }
        }

        if let Some(invite) = calling::incoming_call_from_frame(&frame.body) {
            self.handle_incoming_call(invite).await;
            return;
        }

        // The content-sharing session being GRANTED. It arrives here and not in the answer to
        // the POST, which is `{}` — measured 2026-08-06 — so this is the moment this endpoint
        // becomes the meeting's presenter, and `call_start_sharing` waits for it before the
        // page offers a section. The links are kept on the session's own struct: merged into
        // the call's, this frame's `leave` would overwrite the one a hangup posts to.
        if frame.url.contains(calling::paths::CONVERSATION_ADD_MODALITY_SUCCESS) {
            let mut plane = self.calling.lock().unwrap();
            if let Some(call) = plane.call.as_mut().filter(|c| !c.ended()) {
                let correlation = call
                    .sharing
                    .as_ref()
                    .map(|s| s.correlation_id.clone())
                    .unwrap_or_default();
                if let Some(session) = calling::ContentSharing::from_frame(&correlation, &frame.body)
                {
                    eprintln!(
                        "[calling] the meeting granted the sharing session: can_stop={}",
                        session.leave.is_some()
                    );
                    call.sharing = Some(session);
                }
            }
            return;
        }

        // Everything below is about the call we are already in. A frame for any other
        // call is not ours to act on — a second call rings the user's other devices.
        let links = calling::Links::collect(&frame.body);
        let mine = {
            let mut plane = self.calling.lock().unwrap();
            match plane.call.as_mut() {
                Some(call) if call.phase != CallPhase::Ended => {
                    call.links.merge(&links);
                    true
                }
                _ => false,
            }
        };
        if !mine {
            return;
        }

        // The invitation reached NOBODY. It is the only frame that says so, it arrives a beat
        // before the ending, and the ending's own phrase names the symptom instead — so the
        // cause is remembered here and preferred below. Without it the user is told "The call
        // ended." two seconds after they pressed call, which reads as this app dropping it.
        if let Some(failed) = calling::invite_failed(&frame.url, &frame.body) {
            eprintln!(
                "[calling] the invitation reached nobody: {} (no endpoints: {})",
                failed.phrase, failed.no_endpoints
            );
            if failed.no_endpoints {
                let mut plane = self.calling.lock().unwrap();
                if let Some(call) = plane.call.as_mut() {
                    call.unreachable = true;
                }
            }
            return;
        }

        if let Some(ended) = calling::call_ended_from_frame(&frame.body) {
            let reason = if ended.phrase.is_empty() {
                format!("code {}", ended.code)
            } else {
                ended.phrase
            };
            self.end_call_locally(&reason).await;
            return;
        }

        // A meeting's roster: who is in it, and who is still in its lobby. The service
        // sends a DELTA — this app asks for one — so each frame is FOLDED into the list
        // rather than replacing it (`calling::apply_roster_update`). Measured: consecutive
        // frames of one meeting carried one participant, then two, then one, and a reader
        // that replaced the list showed the meeting emptying and refilling.
        if let Some(roster) = calling::roster_in_frame(&frame.body) {
            let changed = {
                let mut plane = self.calling.lock().unwrap();
                match plane.call.as_mut() {
                    Some(call) => calling::apply_roster_update(&mut call.roster, roster),
                    None => false,
                }
            };
            if changed {
                self.emit_call_state();
            }
        }

        // The lobby: joined, and waiting for somebody inside to admit us. It is read
        // from OUR OWN state in the frame, and only for a meeting — a one-to-one call
        // has no lobby, and reading one into it would show a state that cannot end.
        if let Some(state) = calling::lobby_state_in_frame(&frame.body) {
            let changed = {
                let mut plane = self.calling.lock().unwrap();
                match plane.call.as_mut() {
                    Some(call) if call.kind == CallKind::Meeting => {
                        let waiting = state == calling::LobbyState::Waiting;
                        let changed = call.in_lobby != waiting;
                        call.in_lobby = waiting;
                        // Being admitted is what turns a join into audio.
                        if !waiting && call.phase == CallPhase::Connecting {
                            call.phase = CallPhase::Connected;
                            call.connected_at_ms.get_or_insert(now_ms());
                        }
                        changed
                    }
                    _ => false,
                }
            };
            if changed {
                self.emit_call_state();
            }
        }

        // An acceptance must be ACKNOWLEDGED, and that is not a nicety: the service waits
        // for this one POST and ends the call without it — `Call Controller timed out
        // while waiting for acknowledgement`, thirty seconds after a meeting that had
        // joined cleanly. It goes first, before the phase and before the answer, because
        // the clock is the service's.
        if let Some(url) =
            calling::acceptance_acknowledgement_link(&frame.body).map(str::to_string)
        {
            let callbacks = self.calling.lock().unwrap().call.as_ref().map(|c| c.callbacks.clone());
            if let Some(callbacks) = callbacks {
                let payload = calling::acceptance_acknowledgement_payload(&callbacks);
                if let Err(e) = self.post_call_signal(&url, &payload).await {
                    eprintln!("[calling] could not acknowledge the acceptance: {e:#}");
                }
            }
        }

        // The far side picked up. Audio still waits for their SDP, so this only stops
        // the ringing tone.
        if calling::call_accepted_in_frame(&frame.body) {
            let mut changed = false;
            {
                let mut plane = self.calling.lock().unwrap();
                if let Some(call) = plane
                    .call
                    .as_mut()
                    .filter(|c| c.phase == CallPhase::Dialing || c.phase == CallPhase::Ringing)
                {
                    call.phase = CallPhase::Connecting;
                    changed = true;
                }
            }
            if changed {
                self.emit_call_state();
            }
        }

        // A media offer the service made ON ITS OWN, which is how a shared screen and a
        // colleague's camera arrive (NATIVE-CALLING.md § 10.3a). It has to be read BEFORE
        // the answer path below, because an offer and an answer look alike from a distance
        // and this app used to hand the page an offer where it expected an answer — the
        // page checked its signaling state, dropped it, and nothing said so.
        if let Some(renegotiation) = calling::media_renegotiation_from_frame(&frame.body) {
            let id = {
                let mut plane = self.calling.lock().unwrap();
                match plane.call.as_mut().filter(|c| c.phase != CallPhase::Ended) {
                    Some(call) => {
                        call.renegotiation_answer_link = Some(renegotiation.answer_link.clone());
                        Some(call.id.clone())
                    }
                    None => None,
                }
            };
            // No live call means there is nothing to renegotiate, and answering would put
            // this machine back into a call it has left.
            if let Some(id) = id {
                eprintln!(
                    "[calling] media renegotiation offered: modalities={:?}",
                    renegotiation.modalities
                );
                self.emit(
                    "call_media",
                    json!({
                        "call_id": id,
                        "sdp": renegotiation.offer.blob,
                        "kind": "offer",
                    }),
                );
            }
            // And nothing below applies: the same body would be read as an answer.
            return;
        }

        // Their SDP answer: the page needs it to finish the handshake, and it is the
        // one frame whose body a client is given.
        if let Some(answer) = calling::media_answer_from_frame(&frame.body) {
            let (id, acknowledgement) = {
                let mut plane = self.calling.lock().unwrap();
                match plane.call.as_mut() {
                    Some(call) => {
                        // THE answer is what makes a call a call: from here audio can
                        // flow, so this is the transition to `connected` — for a meeting
                        // and for a one-to-one alike. Nothing else set it: a 1:1 waited
                        // on a lobby state it can never have, and a meeting on one it
                        // only gets when somebody admits it, so both sat at
                        // "Joining…" / "Connecting…" through a working call.
                        //
                        // A call still held in a lobby is the exception: it is not
                        // connected until it is let in, whatever its media says.
                        if !call.in_lobby && call.phase != CallPhase::Ended {
                            call.phase = CallPhase::Connected;
                            call.connected_at_ms.get_or_insert(now_ms());
                        }
                        (
                            call.id.clone(),
                            call.links.media_acknowledgement().map(str::to_string),
                        )
                    }
                    None => return,
                }
            };
            // What CAME BACK, section by section. The offer's modalities were already
            // logged and they say what this machine asked for; only the answer says what
            // the service granted — and a screen share that was rejected mid-call left
            // nothing on this machine to read (`calling::media_sections`).
            eprintln!(
                "[calling] a media answer arrived: {}",
                calling::media_sections(&answer.blob).join(" | ")
            );
            self.emit(
                "call_media",
                json!({ "call_id": id, "sdp": answer.blob, "kind": "answer" }),
            );
            self.emit_call_state();
            // Acknowledge it, or the service re-sends the answer until it gives up.
            if let Some(url) = acknowledgement
                && let Err(e) = self.post_call_signal(&url, &json!({})).await
            {
                eprintln!("[calling] could not acknowledge the answer: {e:#}");
            }
        }
    }

    /// Somebody is calling. Ring, unless this machine is busy.
    async fn handle_incoming_call(&self, invite: calling::IncomingCall) {
        if !invite.has_audio() {
            eprintln!("[calling] ignoring an invite with no audio: {:?}", invite.modalities);
            return;
        }
        let (session, endpoint_id) = {
            let endpoint_id = self.calling.lock().unwrap().channel.as_ref().map(|c| c.endpoint_id.clone());
            match (self.session().await, endpoint_id) {
                (Ok(session), Some(endpoint_id)) => (session, endpoint_id),
                _ => {
                    eprintln!("[calling] an invite arrived before the connection was ready");
                    return;
                }
            }
        };
        // A name we can state. The invite's own `displayName` is often empty, and the
        // store already holds what this app calls that person — the user's own
        // nickname for them included (see `person_overrides`).
        let peer_name = self
            .store()
            .ok()
            .and_then(|s| s.display_name_for_mri(&invite.caller_mri).ok().flatten())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| invite.caller_name.clone());

        let surl = match self.calling.lock().unwrap().channel.as_ref() {
            Some(channel) => channel.surl.clone(),
            None => return,
        };
        let call = CallSession {
            // An incoming call is correlated by the service's own id where it named
            // one, so our requests about it land on the same call.
            id: if invite.call_id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                invite.call_id.clone()
            },
            direction: CallDirection::Incoming,
            // An invite on the calling socket is a call. A meeting is joined, never
            // offered: this app is not invited to a meeting, it walks in.
            kind: CallKind::Call,
            phase: CallPhase::Ringing,
            conversation_id: invite.thread_id.clone(),
            peer_mri: invite.caller_mri.clone(),
            peer_name,
            // We are the one being rung, so this side rings nobody. An invite that reaches
            // us from a GROUP call is still named after its CALLER: they are who the user
            // decides about, and everybody else arrives on the roster.
            ring: Vec::new(),
            links: invite.links.clone(),
            local: calling::LocalParticipant {
                // The leg the service assigned us, when it did: answering under a
                // different one is answering a call it does not think we are in.
                participant_id: invite
                    .participant_id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                ..self.local_participant(&session, &endpoint_id)
            },
            callbacks: calling::CallbackBase {
                surl,
                session_id: uuid::Uuid::new_v4().to_string(),
                cause_id: short_cause_id(),
            },
            offer: invite.offer.clone(),
            roster: Vec::new(),
            in_lobby: false,
            muted: false,
            connected_at_ms: None,
            end_reason: None,
            unreachable: false,
            renegotiation_answer_link: None,
            source_request_sequence: 0,
            sending: Vec::new(),
            sharing: None,
        };

        {
            let mut plane = self.calling.lock().unwrap();
            if plane.call.as_ref().is_some_and(|c| c.phase != CallPhase::Ended) {
                eprintln!(
                    "[calling] busy — leaving this call for the user's other devices to ring"
                );
                return;
            }
            plane.call = Some(call);
        }
        eprintln!("[calling] ringing: a call from {}", invite.caller_mri);
        self.emit_call_state();
    }

    /// Wait for the meeting to GRANT the sharing session, bounded.
    ///
    /// The grant arrives on the `addModalitySuccess` callback rather than in the answer to the
    /// POST (measured 2026-08-06: the answer is `{}`), and the client's own `start` returns a
    /// deferred that frame resolves — so a section offered before it lands is a section the
    /// service has no presenter for. Polled rather than notified because the wait is one
    /// request long and a channel per call would be a second thing to keep in step with the
    /// call's own lifetime.
    ///
    /// It gives up rather than failing: the caller reports `can_stop: false`, the page still
    /// offers its section, and the journal says the grant never came — which is a measurement
    /// rather than an error, and it is how the next unknown gets named.
    async fn await_sharing_session(&self, call_id: &str) -> bool {
        for _ in 0..(SHARING_GRANT_WAIT.as_millis() / SHARING_GRANT_POLL.as_millis()) {
            {
                let plane = self.calling.lock().unwrap();
                match plane.call.as_ref().filter(|c| c.id == call_id) {
                    // Granted: the frame filled the way out in.
                    Some(call) if call.sharing.as_ref().is_some_and(|s| s.leave.is_some()) => {
                        return true;
                    }
                    // The call ended, or the share was given up while this was waiting.
                    None => return false,
                    Some(call) if call.sharing.is_none() => return false,
                    Some(_) => {}
                }
            }
            tokio::time::sleep(SHARING_GRANT_POLL).await;
        }
        false
    }

    /// Mark the call over locally and tell every client. Sends nothing: this is what
    /// runs when the SERVICE ended it, when the connection moved, or after our own
    /// hangup has already gone out.
    async fn end_call_locally(&self, reason: &str) {
        let ending = {
            let mut plane = self.calling.lock().unwrap();
            match plane.call.as_mut() {
                Some(call) if call.phase != CallPhase::Ended => {
                    call.phase = CallPhase::Ended;
                    // A call that rang NOBODY ends with a phrase about the symptom ("no one
                    // else has joined"), and the cause arrived on its own frame a beat
                    // earlier. The cause wins wherever we have it.
                    let stated = if call.unreachable {
                        calling::END_REASON_UNREACHABLE.to_string()
                    } else {
                        reason.to_string()
                    };
                    call.end_reason = Some(stated.clone());
                    Some(stated)
                }
                _ => None,
            }
        };
        let Some(stated) = ending else {
            return;
        };
        // EVERY ending passes through here, so this is the one place that can state why.
        // The page says "The call ended." and the reason was nowhere on this machine, so a
        // call that stopped a second after it started could not be told from one the
        // service refused — the same blind spot a refused write had before it said so. The
        // service's own words are kept beside ours: they are what a journal is read for.
        eprintln!("[calling] the call is over: {stated} (the service said: {reason})");
        // One emit with the ending in it, then the slot is free. The UI needs that
        // frame to stop holding the microphone, so the drop cannot be folded into it.
        self.emit_call_state();
        self.calling.lock().unwrap().call = None;
    }

    /// End a call the service accepted for a reservation this machine no longer holds.
    ///
    /// It is the one thing a cancelled start cannot leave alone. The user hangs up while
    /// the POST that places, joins or accepts is still on the wire: the hangup finds no
    /// link to post on — the answer carrying it has not come back yet — so it drops the
    /// call here, and a moment later the service reports a call somebody is ringing for,
    /// or is already talking into. That answer's own links are the only address that call
    /// ever has, and this is the only moment they exist.
    ///
    /// Nothing is retried and nothing is reported to the page: the user ended this call
    /// before it existed, and there is no surface left to say anything on.
    async fn hang_up_orphan(
        &self,
        method: &str,
        local: &calling::LocalParticipant,
        links: &calling::Links,
    ) {
        let Some(url) = links.hangup() else {
            eprintln!("[calling] {method}: the call was cancelled and answered no hangup link");
            return;
        };
        let url = url.to_string();
        match self.post_call_signal(&url, &calling::hangup_payload(local)).await {
            Ok(_) => eprintln!("[calling] {method}: the call was cancelled — hung it up"),
            Err(e) => eprintln!("[calling] {method}: the cancelled call did not hang up: {e:#}"),
        }
    }

    /// POST one signaling frame for the live call, with its correlation id.
    async fn post_call_signal(&self, url: &str, payload: &Value) -> Result<Value> {
        let correlation = self
            .calling
            .lock()
            .unwrap()
            .call
            .as_ref()
            .map(|c| c.id.clone())
            .unwrap_or_default();
        let session = self.session().await?;
        let ic3 = self.tokens.get(IC3_SCOPE).await?;
        calling::post_signal(&self.http, url, &session, &ic3, &correlation, payload).await
    }

    /// Tell the service the live call is still here, if it gave us a link to say it on.
    ///
    /// Silent when there is no call, and silent when the invite named no `keepAlive`
    /// link — the service only expects one where it asked for one. A failure is one
    /// journal line: the call is still up as far as this side knows, and the ending will
    /// arrive as a frame like any other.
    async fn keep_call_alive(&self) {
        let url = {
            let plane = self.calling.lock().unwrap();
            plane
                .call
                .as_ref()
                .filter(|call| call.phase == CallPhase::Connected)
                .and_then(|call| call.links.keep_alive().map(str::to_string))
        };
        let Some(url) = url else { return };
        if let Err(e) = self.post_call_signal(&url, &json!({})).await {
            eprintln!("[calling] the keep-alive did not reach the service: {e:#}");
        }
    }

    /// Fetch the relay credentials for the cached relay description, if it names a
    /// token URL. Best-effort: without them a call still has STUN, which is enough
    /// whenever the far side publishes a reachable candidate of its own.
    async fn refresh_relay_credentials(&self) {
        let token_url = {
            let plane = self.calling.lock().unwrap();
            plane
                .relay
                .as_ref()
                .and_then(|r| r.pointer("/Service/tokenUrl").and_then(Value::as_str))
                .map(str::to_string)
        };
        let Some(token_url) = token_url else { return };
        let Ok(session) = self.session().await else { return };
        match calling::fetch_relay_credentials(&self.http, &token_url, &session).await {
            Ok(response) => {
                let credential = calling::first_relay_credential(&response);
                if credential.is_none() {
                    eprintln!("[calling] the relay token response named no credentials");
                }
                self.calling.lock().unwrap().relay_credentials = credential;
            }
            // Never log the URL: a relay token URL has carried a token in its query.
            Err(e) => eprintln!("[calling] could not fetch the relay credentials: {e:#}"),
        }
    }

    /// The ICE servers the page should build its `RTCPeerConnection` with: the
    /// directory's STUN server, plus the service's TURN relay when we hold its
    /// credentials.
    async fn call_ice_servers(&self) -> Vec<Value> {
        let Ok(session) = self.session().await else { return Vec::new() };
        let Ok(endpoints) = calling::endpoints(&session) else { return Vec::new() };
        let (relay, credentials) = {
            let plane = self.calling.lock().unwrap();
            (plane.relay.clone(), plane.relay_credentials.clone())
        };
        let relay_turn = relay
            .as_ref()
            .and_then(|r| r.pointer("/Relay/Turn").cloned())
            .or_else(|| relay.clone());
        calling::ice_servers(&endpoints, relay_turn.as_ref(), credentials.as_ref())
            .iter()
            .map(calling::IceServer::json)
            .collect()
    }
}

/// Log one calling frame, and append it to the capture file when the user asked for one.
///
/// Two switches, both for the phase this feature is in (see NATIVE-CALLING.md § 8):
/// `TEAMS_LITE_CALL_DEBUG=1` prints every frame, and `TEAMS_LITE_CALL_CAPTURE` names a
/// file to append them to as JSON lines — opened once, in append mode, so the frames of
/// several calls accumulate and a single real test call is never lost to a scrollback
/// wipe. The records carry live identities and SDP, so that path must point inside the
/// gitignored `captures/` directory and must never be committed. Turn both off once
/// calling is known to work.
fn record_call_frame(frame: &trouter_events::CallFrame) {
    if std::env::var("TEAMS_LITE_CALL_DEBUG").as_deref() == Ok("1") {
        eprintln!(
            "[calling] frame {} id={}\n{}",
            frame.url,
            frame.call_id,
            serde_json::to_string_pretty(&frame.body).unwrap_or_default()
        );
    }
    static CAPTURE: std::sync::OnceLock<Option<Mutex<std::fs::File>>> =
        std::sync::OnceLock::new();
    let capture = CAPTURE.get_or_init(|| {
        let path = std::env::var("TEAMS_LITE_CALL_CAPTURE").ok().filter(|p| !p.is_empty())?;
        match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => {
                eprintln!("[calling] capturing decoded frames to {path}");
                Some(Mutex::new(file))
            }
            Err(e) => {
                eprintln!("[calling] cannot open capture file {path}: {e}");
                None
            }
        }
    });
    if let Some(file) = capture {
        use std::io::Write;
        let line = call_capture_line(now_ms() as u64, &frame.url, &frame.call_id, &frame.body);
        if let Ok(mut file) = file.lock()
            && let Err(e) = file.write_all(line.as_bytes())
        {
            eprintln!("[calling] capture write failed: {e}");
        }
    }
}

/// An 8-hex cause id, the shape the web client's own `ti()` produces. It labels one
/// leg of one call in the service's logs and in ours.
fn short_cause_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// Start the trouter; persist each live message and broadcast it as an event.
///
/// The trouter re-acquires fresh credentials before every (re)connection via the
/// `Ctx` credential provider, so the real-time feed survives token expiry.
fn spawn_realtime(ctx: Ctx, db_path: String) {
    // One id per backend, never one per store: two backends registering the same id
    // take the live feed from each other (see `endpoint_id_path`).
    let epid_path = endpoint_id_path(&db_path, own_port(), "");
    let epid = trouter::load_or_create_epid(&epid_path);

    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<Message>>();
    let (ty_tx, mut ty_rx) =
        tokio::sync::mpsc::unbounded_channel::<trouter_events::TypingEvent>();
    let (rr_tx, mut rr_rx) =
        tokio::sync::mpsc::unbounded_channel::<trouter_events::ReadReceiptEvent>();
    let (call_tx, mut call_rx) =
        tokio::sync::mpsc::unbounded_channel::<trouter_events::CallFrame>();
    let (st_tx, mut st_rx) = tokio::sync::mpsc::unbounded_channel::<trouter::Status>();

    // consume trouter messages: persist + broadcast.
    //
    // The identity is resolved per batch, not captured once: this process may have
    // started before it could sign in (see the boot order in `main`), so there was
    // nothing to capture. It costs a lock and a clone — never a network call — and a
    // frame only ever arrives on a connection that already holds a session.
    let ctx_msgs = ctx.clone();
    let mut msgs_store = ctx.task_store();
    tokio::spawn(async move {
        while let Some(msgs) = ev_rx.recv().await {
            let Ok(me) = ctx_msgs.identity().await else { continue };
            let (self_name, self_mri) = (me.name, me.mri);
            if let Some(store) = msgs_store.get() {
                let mut activity_changed = false;
                let mut channels_changed = false;
                for m in &msgs {
                    // Incoming-call awareness: a live `Event/Call` frame in a real
                    // conversation rings (or dismisses) an incoming-call banner.
                    // Ephemeral, like `typing` — the frame is still persisted +
                    // broadcast as a `message` below. Never fires for an activity
                    // stream (not a chat).
                    if !teams_activity::is_system_feed_thread(&m.conversation_id) {
                        if let Some(call) = call_event_json(m, &self_name, &self_mri) {
                            ctx_msgs.emit("call", call);
                        }
                    }
                    // An activity stream (Activity / Mentions / Following) is not
                    // a chat: never persist it as a conversation. Signal the UI to
                    // refresh the notifications panel instead — the full payload is
                    // re-fetched via the `notifications` method (the live frame's
                    // chat `content` is always empty; the payload lives in
                    // properties.activity).
                    if teams_activity::is_system_feed_thread(&m.conversation_id) {
                        activity_changed = true;
                        continue;
                    }
                    // A channel post must NOT create a chat-list row. Bump the
                    // channel's last-message metadata instead (kept in the
                    // channels table, surfaced under the Channels tab). The
                    // message body still lands in the shared `messages` table
                    // below, so an open channel view updates live. We match on the
                    // thread-id shape (reliable, covers channels not yet synced)
                    // and, defensively, on any channel we already know.
                    let is_channel = teams_read::is_channel_thread_id(&m.conversation_id)
                        || store.is_channel(&m.conversation_id).unwrap_or(false);
                    let from_me = is_self(m, &self_name, &self_mri);
                    if is_channel {
                        if store
                            .touch_channel(&m.conversation_id, m.compose_time, from_me)
                            .unwrap_or(false)
                        {
                            channels_changed = true;
                        }
                    } else {
                        store.upsert_conversation(&m.conversation_id, "", m.compose_time).ok();
                    }
                    let inserted = store.insert_message(m).unwrap_or(false);
                    // Reconcile reactions when this live frame carried an
                    // emotions snapshot. An empty sentinel means the frame said
                    // nothing about reactions (e.g. a plain edit), so we never
                    // clobber an existing set. On a real change we get back the
                    // refreshed row to broadcast.
                    let reacted = if m.reactions.is_empty() {
                        None
                    } else {
                        store
                            .update_message_reactions(&m.conversation_id, &m.id, &m.reactions)
                            .unwrap_or(None)
                    };
                    // BROADCAST EVERY LIVE FRAME, whether or not this process was the
                    // one that wrote the row.
                    //
                    // It used to be gated on `inserted`, which reads as "nothing
                    // changed, so nobody needs telling" — and that is wrong the moment
                    // two backends share one store (§ Running the released build beside
                    // the staged one). Both hold a feed, both ingest the same frame, and
                    // the one that loses the insert by a millisecond would tell its own
                    // pages nothing: the message would sit in the store, invisible until
                    // a reload. The store's row is shared; what a page has SEEN is not.
                    //
                    // A re-delivered frame costs nothing, because a client merges a live
                    // message into its history by id (`appendLiveMessage`).
                    //
                    // Emit the authoritative stored row: on a reaction change it is
                    // `reacted`; otherwise re-read, so the broadcast carries reactions
                    // preserved across the change (the parsed `m` may hold the sentinel,
                    // not the stored set).
                    // Whether the reaction set really changed, read before `reacted` is
                    // consumed below: it is what says a frame carrying no new message may
                    // still carry new emoji (see the import further down).
                    let reactions_changed = reacted.is_some();
                    let row = reacted
                        .or_else(|| store.get_message(&m.conversation_id, &m.id).ok().flatten())
                        .unwrap_or_else(|| m.clone());
                    ctx_msgs.emit("message", message_json(&row, &self_name, &self_mri, Some(&store)));
                    // Reach the devices no socket reaches: a phone whose Home Screen app
                    // is closed learns about this message only through Web Push. Only on
                    // a FRESH insert — a reaction arriving on an old message is not news
                    // worth a lock screen, and the backend that already stored this one
                    // has already pushed it (the delivery is claimed either way, in
                    // `push_deliveries`).
                    if inserted {
                        push_live_message(&ctx_msgs, store, &row, is_channel, from_me, &self_mri);
                        // …and answer it, when the user summoned a local agent with it.
                        // Same place for the same reason: a fresh insert is the one event
                        // that means "this message is new", and the trigger is claimed in
                        // the store so two backends answer it once.
                        agent_live_message(&ctx_msgs, store, &row, from_me, &self_mri);
                    }
                    // …and take the custom emoji this frame carries into the pack, so a
                    // colleague's `:shipit:` is one the user can type rather than one they
                    // have to pick out of a menu first.
                    //
                    // NOT under `inserted`, unlike the two above, and that is the whole
                    // difference: a REACTION arrives as a frame on a message this store
                    // already holds, so `inserted` is false and the art a colleague reacted
                    // with — which is how MOST custom emoji arrive here, measured — would
                    // never be seen. A changed reaction set is as much "new emoji" as a new
                    // message is. Each upload is claimed individually, so a frame that
                    // carries nothing new costs one settings read.
                    //
                    // Not gated on `from_me` either: a message the user sent from ANOTHER
                    // install carries art this pack may not hold, and one sent from this
                    // pack is skipped on its bytes.
                    if inserted || reactions_changed {
                        import_emoji_from_message(&ctx_msgs, store, &row);
                    }
                }
                if activity_changed {
                    ctx_msgs.emit("notifications_changed", json!({}));
                }
                if channels_changed {
                    ctx_msgs.emit("channels_changed", json!({}));
                }
            }
        }
    });
    // trouter status -> event
    let ctx_st = ctx.clone();
    tokio::spawn(async move {
        while let Some(st) = st_rx.recv().await {
            let label = match st {
                trouter::Status::Connecting => "connecting",
                trouter::Status::Connected => "connected",
                trouter::Status::Disconnected { .. } => "disconnected",
            };
            ctx_st.emit("realtime_status", json!(label));
        }
    });

    // trouter typing signals -> `typing` event. Ephemeral presence: resolve the
    // sender MRI to a display name from what the store already holds (no network),
    // drop our own echo, and never touch the activity-feed thread.
    let ctx_ty = ctx.clone();
    let mut typing_store = ctx.task_store();
    tokio::spawn(async move {
        while let Some(t) = ty_rx.recv().await {
            let Ok(me) = ctx_ty.identity().await else { continue };
            if t.sender_mri == me.mri {
                continue; // don't show ourselves typing
            }
            if teams_activity::is_system_feed_thread(&t.conversation_id) {
                continue; // an activity stream is not a chat
            }
            let sender = typing_store
                .get()
                .and_then(|s| s.display_name_for_mri(&t.sender_mri).ok().flatten())
                .unwrap_or_default();
            ctx_ty.emit(
                "typing",
                json!({
                    "conversation_id": t.conversation_id,
                    "sender_mri": t.sender_mri,
                    "sender": sender,
                    "is_typing": t.is_typing,
                }),
            );
        }
    });

    // trouter read-receipt updates -> `read_receipt` event. Ephemeral, like
    // typing: resolve the reader MRI to a display name from what the store
    // already holds (no network), drop our own echo (we never show our own read
    // state), and never touch the activity-feed thread. The UI merges each update
    // into the open conversation's "seen by" avatars.
    let ctx_rr = ctx.clone();
    let mut receipts_store = ctx.task_store();
    tokio::spawn(async move {
        while let Some(r) = rr_rx.recv().await {
            let Ok(me) = ctx_rr.identity().await else { continue };
            if teams_lite::store::same_user(&r.member_mri, &me.mri) {
                continue; // never surface our own read position
            }
            if teams_activity::is_system_feed_thread(&r.conversation_id) {
                continue; // an activity stream is not a chat
            }
            let member = receipts_store
                .get()
                .and_then(|s| s.display_name_for_mri(&r.member_mri).ok().flatten())
                .unwrap_or_default();
            ctx_rr.emit(
                "read_receipt",
                json!({
                    "conversation_id": r.conversation_id,
                    "member_mri": r.member_mri,
                    "member": member,
                    "last_read_message_id": r.last_read_message_id,
                    "read_time_ms": r.read_time_ms,
                }),
            );
        }
    });

    // A calling frame that arrived on the MESSAGING socket. The calling connection has
    // one of its own (see `Ctx::start_calling`), so this is the stray case — the service
    // has routed one here before — and it goes through exactly the same handler, because
    // a frame is a frame and a second decoding path is a second place to get it wrong.
    let ctx_call = ctx.clone();
    tokio::spawn(async move {
        while let Some(frame) = call_rx.recv().await {
            ctx_call.handle_call_frame(frame).await;
        }
    });

    tokio::spawn(async move {
        trouter::run(
            ctx,
            epid,
            trouter::Endpoint::messaging(),
            trouter::Role::Messaging {
                events: ev_tx,
                typing: ty_tx,
                receipts: rr_tx,
                calls: call_tx,
            },
            st_tx,
        )
        .await;
    });
}

/// Bring the calling connection up at boot, on every backend that calls at all.
///
/// This is the whole of "calling is on": the app registers as a device the user's calls
/// ring on, once, at startup (see {@link calling_available} for the one backend that does
/// not). A failure is one journal line and nothing else: the rest of the app does not
/// depend on it, and `trouter::run` reconnects on its own.
fn spawn_calling(ctx: Ctx) {
    tokio::spawn(async move {
        if !calling_available() {
            return;
        }
        if let Err(e) = ctx.start_calling().await {
            eprintln!("[calling] could not start: {e:#}");
        }
    });
}

/// Format one decoded call frame as a single JSON-lines (JSONL) capture record:
/// `{ts_ms, url, call_id, body}` followed by a newline. Pure (no I/O) so it can be
/// unit-tested; the actual append lives in the call_signal task above, guarded by
/// TEAMS_LITE_CALL_CAPTURE. One self-describing object per line keeps a multi-call
/// capture easy to replay while we reverse-engineer the native call schema.
fn call_capture_line(ts_ms: u64, url: &str, call_id: &str, body: &Value) -> String {
    let mut line = serde_json::to_string(
        &json!({ "ts_ms": ts_ms, "url": url, "call_id": call_id, "body": body }),
    )
    .unwrap_or_default();
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the write lock ----------------------------------------------------
    // Reads stay open (the point: tooling may inspect real data); writes need the
    // capability token, so a client that merely found the socket cannot post.

    #[test]
    fn reads_never_need_the_write_token() {
        for method in [
            "conversations",
            "open",
            "backfill",
            "read_receipts",
            "set_draft",
            // The read-only Graph surfaces: the write lock gates Teams, and neither
            // of these can act on the mailbox or the calendar at all.
            "mail_folders",
            "mail_list",
            "calendars",
            "calendar_view",
        ] {
            assert!(check_write_allowed(method, &json!({}), Some("tok")).is_ok(), "{method}");
            assert!(check_write_allowed(method, &json!({}), None).is_ok(), "{method}");
        }
    }

    #[test]
    fn outward_methods_are_refused_without_the_token() {
        for method in OUTWARD_METHODS {
            let err = check_write_allowed(method, &json!({ "conversation": "c1" }), Some("tok"))
                .expect_err("must refuse a tokenless write");
            assert!(err.contains("write token"), "{err}");
        }
    }

    #[test]
    fn outward_methods_are_refused_with_a_wrong_token() {
        let params = json!({ "conversation": "c1", "write_token": "not-the-token" });
        assert!(check_write_allowed("send", &params, Some("tok")).is_err());
    }

    /// A page cannot see that the backend it talks to is a NEW process, because reads
    /// keep answering — so the refusal is what tells it, and it re-reads the token and
    /// retries once on these words (`isWriteTokenRefusal` in web/src/lib/ws-client.ts).
    /// Both classes must carry them, and the read-only refusal must NOT: no token exists
    /// there, so re-reading one would loop.
    #[test]
    fn the_token_refusal_says_what_a_frontend_looks_for() {
        let stale = json!({ "conversation": "c1", "write_token": "a-dead-backend's-token" });
        for method in ["send", "set_person_name"] {
            let err = check_write_allowed(method, &stale, Some("tok"))
                .expect_err("must refuse another process's token");
            assert!(err.contains(WRITE_TOKEN_REFUSAL), "{method}: {err}");
        }
        for method in ["send", "set_person_name"] {
            let err = check_write_allowed(method, &stale, None)
                .expect_err("must refuse a write on a read-only backend");
            assert!(!err.contains(WRITE_TOKEN_REFUSAL), "{method}: {err}");
        }
    }

    /// The three states a client can be in, and the one the refusal above cannot state
    /// in time (see `write_lock_state`). A missing token is `foreign` like a wrong one:
    /// both mean the same thing to the user, which is that nothing they press will act.
    #[test]
    fn the_write_lock_states_are_the_three_a_client_can_be_in() {
        assert_eq!(write_lock_state(Some("tok"), Some("tok")), WriteLockState::Held);
        assert_eq!(write_lock_state(Some("stale"), Some("tok")), WriteLockState::Foreign);
        assert_eq!(write_lock_state(None, Some("tok")), WriteLockState::Foreign);
        // Read-only comes first, and outranks whatever was presented: there is no token
        // to hold, so no frontend is at fault and none can mend it.
        assert_eq!(write_lock_state(None, None), WriteLockState::ReadOnly);
        assert_eq!(write_lock_state(Some("tok"), None), WriteLockState::ReadOnly);
    }

    /// Asking must never need the answer. `write_lock_status` is in neither list — a
    /// client with no token is exactly the one that has to be told.
    #[test]
    fn asking_about_the_write_lock_is_not_itself_gated() {
        assert!(write_class("write_lock_status").is_none());
        for token in [Some("tok"), None] {
            assert!(check_write_allowed("write_lock_status", &json!({}), token).is_ok());
        }
    }

    /// The answer says WHERE the client stands and nothing about the secret it stands
    /// against. An endpoint that echoed the token back would hand every local process
    /// the one thing the write lock keeps from them.
    #[test]
    fn the_write_lock_payload_never_carries_the_token() {
        for presented in [Some("tok"), Some("stale"), None] {
            for pinned in [true, false] {
                let payload = write_lock_payload(presented, Some("tok"), pinned);
                let mut keys: Vec<&str> =
                    payload.as_object().expect("an object").keys().map(String::as_str).collect();
                keys.sort_unstable();
                assert_eq!(keys, ["pinned", "state"], "only the two fields: {payload}");
                assert!(!payload.to_string().contains("tok\""), "{payload}");
                assert_eq!(payload["pinned"], json!(pinned));
            }
        }
        assert_eq!(write_lock_payload(Some("tok"), Some("tok"), true)["state"], json!("held"));
        assert_eq!(write_lock_payload(None, Some("tok"), true)["state"], json!("foreign"));
        assert_eq!(write_lock_payload(None, None, false)["state"], json!("read_only"));
    }

    #[test]
    fn outward_methods_pass_with_the_published_token() {
        let params = json!({ "conversation": "c1", "write_token": "tok" });
        for method in OUTWARD_METHODS {
            assert!(check_write_allowed(method, &params, Some("tok")).is_ok(), "{method}");
        }
    }

    // ---- the machine methods -----------------------------------------------
    // `repair_broker` restarts the user's Intune container. It posts nothing to
    // Teams, so it is not outward — but a client that merely found this socket must
    // not be able to take the identity broker down either.

    // Marking a thread read publishes our consumption horizon: the unread marker
    // clears on every device the user owns, and the sender sees a read receipt. That
    // is other people seeing a change in the user's account, so it is outward and
    // needs the token — Ghost mode does not soften the gate, because the method can
    // still write.
    #[test]
    fn mark_read_is_outward_facing_and_token_gated() {
        assert!(OUTWARD_METHODS.contains(&"mark_read"));
        assert_eq!(write_class("mark_read"), Some(WriteClass::Outward));
        let params = json!({ "conversation": "c1" });
        let err = check_write_allowed("mark_read", &params, Some("tok"))
            .expect_err("must refuse a tokenless read-state write");
        assert!(err.contains("write token"), "{err}");
        assert!(
            check_write_allowed(
                "mark_read",
                &json!({ "conversation": "c1", "write_token": "tok" }),
                Some("tok")
            )
            .is_ok()
        );
    }

    // Muting a chat publishes the user's own `alerts` property: it reaches no
    // colleague, but it lands on every device they are signed in on and silences a
    // thread they may be waiting on. So it is outward and token-gated — and the chat's
    // PIN and HIDE must stay OUT of that list, because neither write round-trips
    // through the tenant and a gate on a write nobody makes is a false promise.
    #[test]
    fn muting_a_chat_is_outward_facing_and_token_gated() {
        assert!(OUTWARD_METHODS.contains(&"set_chat_muted"));
        assert_eq!(write_class("set_chat_muted"), Some(WriteClass::Outward));
        let params = json!({ "conversation": "c1", "muted": true });
        let err = check_write_allowed("set_chat_muted", &params, Some("tok"))
            .expect_err("must refuse a tokenless mute");
        assert!(err.contains("write token"), "{err}");
        assert!(
            check_write_allowed(
                "set_chat_muted",
                &json!({ "conversation": "c1", "muted": true, "write_token": "tok" }),
                Some("tok")
            )
            .is_ok()
        );
        // The two settings this app holds locally have no RPC at all: nothing in the
        // dispatcher may publish them while nothing reads the write back.
        for absent in ["set_chat_pinned", "set_chat_hidden"] {
            assert_eq!(write_class(absent), None, "{absent}");
        }
    }

    // Approving a merge request is the ONE write this app makes to a tracker. It acts
    // under the user's own GitLab account, everybody watching the merge request is told,
    // and a project rule may act on it — so it is outward and token-gated exactly like a
    // send, while the READ beside it stays open like every other read.
    #[test]
    fn approving_a_merge_request_is_outward_facing_and_token_gated() {
        assert!(OUTWARD_METHODS.contains(&"gitlab_set_approval"));
        assert_eq!(write_class("gitlab_set_approval"), Some(WriteClass::Outward));
        let params = json!({ "url": "https://gitlab.com/a/b/-/merge_requests/1", "approved": true });
        let err = check_write_allowed("gitlab_set_approval", &params, Some("tok"))
            .expect_err("must refuse a tokenless approval");
        assert!(err.contains("write token"), "{err}");
        assert!(
            check_write_allowed(
                "gitlab_set_approval",
                &json!({
                    "url": "https://gitlab.com/a/b/-/merge_requests/1",
                    "approved": true,
                    "write_token": "tok",
                }),
                Some("tok")
            )
            .is_ok()
        );
        // Taking the approval BACK is the same call, so it cannot end up ungated: an
        // approval this app could give and not revoke is one it must not give.
        assert_eq!(write_class("gitlab_unapprove"), None);
        // And reading the state is a read: the menu asks it on every open, and a gate
        // there would make the feature invisible on a read-only backend that can still
        // show the user who approved.
        for read in ["gitlab_approvals", "enrich_link"] {
            assert!(check_write_allowed(read, &json!({}), None).is_ok(), "{read}");
        }
    }

    /// The write reaches GitLab through the one module that may, and the read is the
    /// only thing the ungated arm can do. A later edit that called `gitlab_approval::set`
    /// from the read arm would hand a tracker write the read path's own openness.
    #[test]
    fn the_approval_read_arm_never_names_the_write() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let read = code
            .split("\"gitlab_approvals\" =>")
            .nth(1)
            .expect("the gitlab_approvals handler")
            .split("\"gitlab_set_approval\" =>")
            .next()
            .expect("the handler ends at the next arm");
        assert!(read.contains("gitlab_approval::fetch"), "scanned the wrong text");
        assert!(
            !read.contains("gitlab_approval::set"),
            "the gitlab_approvals arm names the approval WRITE. That arm is ungated, so a \
             write called from it would reach the user's tracker with no consent gate at all."
        );
    }

    // The merge-request page's four writes are gated exactly like a send, and its four
    // reads stay open exactly like every other read. That split is the whole safety story
    // of the page: reading a tracker is what it is for, and writing to one is the user's
    // own click (see AGENTS.md § The GitLab page).
    #[test]
    fn the_merge_request_page_gates_its_writes_and_leaves_its_reads_open() {
        for write in [
            "gitlab_mr_merge",
            "gitlab_mr_comment",
            "gitlab_mr_delete_comment",
            "gitlab_mr_set_state",
        ] {
            assert!(OUTWARD_METHODS.contains(&write), "{write} must be outward-facing");
            assert_eq!(write_class(write), Some(WriteClass::Outward), "{write}");
            let params = json!({ "project_path": "a/b", "iid": 1, "sha": "abc", "body": "hi" });
            let err = match check_write_allowed(write, &params, Some("tok")) {
                Ok(()) => panic!("{write} must be refused when no write token is presented"),
                Err(err) => err,
            };
            assert!(err.contains("write token"), "{write}: {err}");
            let mut with_token = params.clone();
            with_token["write_token"] = json!("tok");
            assert!(check_write_allowed(write, &with_token, Some("tok")).is_ok(), "{write}");
        }

        // The reads are ungated. A page that could not LIST merge requests on a read-only
        // backend would be a page nothing could screenshot, and reading a tracker is the
        // half of this feature that was never in question.
        for read in [
            "gitlab_mr_list",
            "gitlab_mr_detail",
            "gitlab_mr_notes",
            "gitlab_mr_pipeline",
            "gitlab_mr_diff",
            "gitlab_mr_job_log",
        ] {
            assert_eq!(write_class(read), None, "{read} is a read");
            assert!(check_write_allowed(read, &json!({}), None).is_ok(), "{read}");
        }

        // And nothing else about a merge request is a method at all: a rebase, an
        // assignment or a label edit is a further tracker write, which is a deliberate
        // feature with its own gate rather than a new arm in the dispatcher.
        for absent in [
            "gitlab_mr_rebase",
            "gitlab_mr_assign",
            "gitlab_mr_set_labels",
            "gitlab_mr_edit",
        ] {
            assert_eq!(write_class(absent), None, "{absent}");
        }
    }

    /// The MERGE is the one write on this page that no later call takes back, and the `sha`
    /// is what stands between it and landing a commit the reader never saw. GitLab enforces
    /// it — a mismatched sha is a 409 — so the handler must always send one.
    #[test]
    fn the_merge_handler_always_sends_the_commit_the_page_read() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let handler = code
            .split("\"gitlab_mr_merge\" => {")
            .nth(1)
            .expect("the gitlab_mr_merge handler")
            .split("\"gitlab_mr_comment\" =>")
            .next()
            .expect("the handler ends at the next arm");
        assert!(handler.contains("gitlab_mr_write::merge"), "scanned the wrong text");
        assert!(
            handler.contains("param_str(params, \"sha\")"),
            "the merge handler must REQUIRE the sha the page drew. Without it GitLab merges \
             whatever the branch holds now, which is exactly the commit nobody reviewed."
        );
        // And it drops the cache of what it changed, or the page paints the pre-merge state
        // straight back over the outcome.
        assert!(handler.contains("forget_gitlab_merge_request"), "the merge must invalidate");
    }

    /// A comment is deleted — and EDITED — only when it is the USER'S OWN, and that is
    /// decided from GitLab's answer rather than from what the client claimed. GitLab itself
    /// would let a maintainer rewrite or remove a colleague's note; this app never offers
    /// that, exactly as it refuses to delete a Teams message that is not the user's own.
    ///
    /// Both writes go through ONE check, so this pins the two halves that matter: that the
    /// check really asks GitLab, and that each handler asks it BEFORE it writes.
    #[test]
    fn a_comment_is_deleted_or_edited_only_when_it_is_the_user_s_own() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);

        let check = code
            .split("async fn require_own_gitlab_note(")
            .nth(1)
            .expect("the shared ownership check")
            .split("\nasync fn ")
            .next()
            .expect("the function ends at the next one");
        assert!(check.contains("fetch_discussions"), "whose note it is must be READ from GitLab");
        assert!(check.contains("note.mine"), "ownership is GitLab's own answer");

        for (method, write) in [
            ("\"gitlab_mr_delete_comment\" => {", "delete_comment"),
            ("\"gitlab_mr_edit_comment\" => {", "edit_comment"),
        ] {
            let handler = code
                .split(method)
                .nth(1)
                .unwrap_or_else(|| panic!("the {method} handler"))
                .split("        // ")
                .next()
                .expect("the handler ends at the next arm's comment");
            let checked = handler
                .find("require_own_gitlab_note")
                .unwrap_or_else(|| panic!("{method} must check whose comment it is"));
            let written = handler
                .find(&format!("gitlab_mr_write::{write}"))
                .unwrap_or_else(|| panic!("{method} must call {write}"));
            assert!(checked < written, "{method} must check BEFORE it writes, not after");
        }
    }

    /// Every read of the page has a staleness window, and they are ordered by what a stale
    /// answer costs: a running pipeline is the shortest, the sidebar list the longest.
    #[test]
    fn the_live_read_has_the_shortest_window_and_the_list_the_longest() {
        assert!(GITLAB_PIPELINE_TTL < GITLAB_DETAIL_TTL);
        assert!(GITLAB_PIPELINE_TTL < GITLAB_NOTES_TTL);
        assert!(GITLAB_DETAIL_TTL <= GITLAB_LIST_TTL);
        // The live one is short enough to feel live, and long enough that two open pages
        // cost one request between them rather than two.
        assert!(GITLAB_PIPELINE_TTL >= Duration::from_secs(2));
        assert!(GITLAB_PIPELINE_TTL <= Duration::from_secs(10));
    }

    /// A job's LOG is the one read whose window the ANSWER decides: it is polled like the
    /// pipeline while the job runs, and never changes again the moment the job stops.
    ///
    /// The unfinished window is what an unanswered `complete` reads as, because an answer from
    /// an older build must not be cached for a day on the strength of a field it never carried.
    #[test]
    fn a_job_logs_window_is_the_pipelines_until_the_job_stops() {
        let live = GitLabTtl::JobLog;
        assert_eq!(live.window(&json!({ "complete": true })), GITLAB_JOB_LOG_SETTLED_TTL);
        assert_eq!(live.window(&json!({ "complete": false })), GITLAB_JOB_LOG_LIVE_TTL);
        assert_eq!(live.window(&json!({})), GITLAB_JOB_LOG_LIVE_TTL);
        assert_eq!(live.window(&json!({ "complete": "yes" })), GITLAB_JOB_LOG_LIVE_TTL);

        // A running job's log is as live as the pipeline that holds it — one window, so a
        // reader watching a job work is never served a staler line than the card that sent
        // them there — and a finished one is the longest-lived answer on the page.
        assert_eq!(GITLAB_JOB_LOG_LIVE_TTL, GITLAB_PIPELINE_TTL);
        assert!(GITLAB_JOB_LOG_SETTLED_TTL > GITLAB_DIFF_TTL);

        // Every other read still says its window by BEING one, so this type cannot quietly
        // change what the four constants mean.
        assert_eq!(GitLabTtl::from(GITLAB_LIST_TTL).window(&json!({})), GITLAB_LIST_TTL);
    }

    /// A job is addressed by its own id, read as a number.
    ///
    /// The id becomes a path segment, so a string would be a way to steer this read at another
    /// endpoint of the project — the rule the merge request's own iid already follows.
    #[test]
    fn a_job_log_is_addressed_by_the_jobs_own_number() {
        assert_eq!(gitlab_job_id(&json!({ "job_id": 1_284_501 })).unwrap(), 1_284_501);
        for bad in [
            json!({}),
            json!({ "job_id": 0 }),
            json!({ "job_id": -3 }),
            json!({ "job_id": "1284501" }),
            json!({ "job_id": "1284501/artifacts" }),
            json!({ "job_id": null }),
        ] {
            assert!(gitlab_job_id(&bad).is_err(), "{bad} must be refused");
        }
    }

    /// A list read is a closed set on both axes, and its default is the sidebar's own.
    #[test]
    fn a_list_query_can_never_ask_for_merged_merge_requests() {
        let query = gitlab_list_query(&json!({})).expect("a default");
        assert_eq!(query.scope.as_str(), "all");
        assert_eq!(query.state.as_str(), "opened");

        let query = gitlab_list_query(&json!({ "scope": "reviewing", "state": "closed" }))
            .expect("both named");
        assert_eq!((query.scope.as_str(), query.state.as_str()), ("reviewing", "closed"));

        // The page is about what is NOT merged, so `merged` is not a state it can ask for
        // — and a scope GitLab would understand but the page never offers is refused too.
        assert!(gitlab_list_query(&json!({ "state": "merged" })).is_err());
        assert!(gitlab_list_query(&json!({ "state": "all" })).is_err());
        assert!(gitlab_list_query(&json!({ "scope": "created_by_me" })).is_err());
    }

    /// The params name a project and a number, and nothing that could aim a request
    /// somewhere else. The host is never among them — it comes from the user's settings —
    /// so this checks the shape a 404 would otherwise be the only report of.
    #[test]
    fn a_merge_request_is_addressed_by_a_project_path_and_a_number() {
        assert_eq!(
            gitlab_merge_request_params(&json!({ "project_path": " group/sub/app ", "iid": 42 }))
                .unwrap(),
            ("group/sub/app".to_string(), 42)
        );
        for bad in [
            json!({ "iid": 1 }),
            json!({ "project_path": "", "iid": 1 }),
            json!({ "project_path": "/group/app", "iid": 1 }),
            json!({ "project_path": "group//app", "iid": 1 }),
            json!({ "project_path": "group/../app", "iid": 1 }),
            json!({ "project_path": "https://evil.example/a/b", "iid": 1 }),
            json!({ "project_path": "group/a b", "iid": 1 }),
            json!({ "project_path": "group/app" }),
            json!({ "project_path": "group/app", "iid": 0 }),
            json!({ "project_path": "group/app", "iid": "42" }),
        ] {
            assert!(gitlab_merge_request_params(&bad).is_err(), "{bad} must be refused");
        }
    }

    /// The handler names the ONE property whose write round-trips, and no other. A
    /// later change that publishes the pin or the hide has to move the measurement
    /// forward first (see src/teams_chat_settings.rs).
    #[test]
    fn the_chat_settings_handler_publishes_only_the_mute() {
        let source = include_str!("server.rs");
        let handler = source
            .split("\"set_chat_muted\" => {")
            .nth(1)
            .expect("the set_chat_muted handler");
        let handler = &handler[..handler.find("\n        }").unwrap_or(handler.len())];
        for forbidden in ["ispinned", "historyHiddenTime", "favorite"] {
            assert!(!handler.contains(forbidden), "{forbidden} must not be published");
        }
    }

    // Deleting a message removes it from the thread for everybody, on every device,
    // and nothing brings it back. So it is outward, token-gated, and refused
    // read-only — exactly like the send it undoes.
    #[test]
    fn delete_is_outward_facing_and_token_gated() {
        assert!(OUTWARD_METHODS.contains(&"delete"));
        assert_eq!(write_class("delete"), Some(WriteClass::Outward));
        let params = json!({ "conversation": "c1", "message_id": "m1" });
        let err = check_write_allowed("delete", &params, Some("tok"))
            .expect_err("must refuse a tokenless deletion");
        assert!(err.contains("write token"), "{err}");
        assert!(
            check_write_allowed(
                "delete",
                &json!({ "conversation": "c1", "message_id": "m1", "write_token": "tok" }),
                Some("tok")
            )
            .is_ok()
        );
    }

    // Teams would let a team owner delete a colleague's channel post. This app never
    // offers that, so the RPC refuses a stored message that is not ours — while a
    // message we never synced is left to Teams to judge.
    #[test]
    fn only_our_own_message_may_be_deleted() {
        let mut mine = message(1);
        mine.sender_mri = "8:orgid:me".into();
        mine.sender = "Me".into();
        let mut theirs = message(2);
        theirs.sender_mri = "8:orgid:them".into();
        theirs.sender = "Ada Lovelace".into();

        assert!(may_delete(Some(&mine), "Me", "8:orgid:me"));
        assert!(!may_delete(Some(&theirs), "Me", "8:orgid:me"));
        assert!(may_delete(None, "Me", "8:orgid:me"), "an unsynced message is Teams' call");

        // No mri anywhere (a legacy row): the display name decides, as `is_self` does.
        let mut nameless = message(3);
        nameless.sender_mri = String::new();
        nameless.sender = "Me".into();
        assert!(may_delete(Some(&nameless), "Me", ""));
        nameless.sender = "Ada Lovelace".into();
        assert!(!may_delete(Some(&nameless), "Me", ""));
    }

    // Ghost mode is a stored string, and only "1" means on: an unset, empty or
    // malformed value must read as off, because off is the behaviour that matches
    // every other chat client.
    #[test]
    fn ghost_mode_is_off_unless_explicitly_enabled() {
        let store = Store::open_in_memory().unwrap();
        assert!(!ghost_mode(&store).unwrap(), "unset reads as off");
        assert_eq!(settings_json(&store).unwrap()["ghost_mode"], false);

        store.set_setting(SETTING_GHOST_MODE, "1").unwrap();
        assert!(ghost_mode(&store).unwrap());
        assert_eq!(settings_json(&store).unwrap()["ghost_mode"], true);

        for off in ["0", "", "true", "yes"] {
            store.set_setting(SETTING_GHOST_MODE, off).unwrap();
            assert!(!ghost_mode(&store).unwrap(), "{off:?} must read as off");
        }
    }

    // Publishing our own presence is outward: the green dot is what every colleague
    // reads to decide whether to write, and it is the user's account making the claim.
    // Both directions ride the same method, so the gate covers taking it back too.
    #[test]
    fn always_available_is_outward_facing_and_token_gated() {
        assert!(OUTWARD_METHODS.contains(&"set_always_available"));
        assert_eq!(write_class("set_always_available"), Some(WriteClass::Outward));
        for enabled in [true, false] {
            let err =
                check_write_allowed("set_always_available", &json!({ "enabled": enabled }), Some("tok"))
                    .expect_err("must refuse a tokenless presence publish");
            assert!(err.contains("write token"), "{err}");
            assert!(
                check_write_allowed(
                    "set_always_available",
                    &json!({ "enabled": enabled, "write_token": "tok" }),
                    Some("tok")
                )
                .is_ok()
            );
        }
        // Reading the settings back stays open: it says whether the switch is on,
        // which is not a write.
        assert_eq!(write_class("get_settings"), None);
    }

    // Off unless the stored value is exactly "1". The default has to be off: a status
    // the user never asked for is a claim about where they are that they never made.
    #[test]
    fn always_available_is_off_unless_explicitly_enabled() {
        let store = Store::open_in_memory().unwrap();
        assert!(!always_available(&store).unwrap(), "unset reads as off");
        assert_eq!(settings_json(&store).unwrap()["always_available"], false);

        store.set_setting(SETTING_ALWAYS_AVAILABLE, "1").unwrap();
        assert!(always_available(&store).unwrap());
        assert_eq!(settings_json(&store).unwrap()["always_available"], true);

        for off in ["0", "", "true", "yes"] {
            store.set_setting(SETTING_ALWAYS_AVAILABLE, off).unwrap();
            assert!(!always_available(&store).unwrap(), "{off:?} must read as off");
        }
    }

    // The hours narrow the switch, and the wire says both of them plus what they mean for
    // THIS minute — a page cannot work that out, because the clock and the zone that
    // decide it are the backend's.
    #[test]
    fn the_hours_narrow_the_switch_and_travel_with_it() {
        let store = Store::open_in_memory().unwrap();
        let settings = settings_json(&store).unwrap();
        assert_eq!(settings["available_from"], Value::Null, "no hours set is all day");
        assert_eq!(settings["available_to"], Value::Null);
        assert_eq!(settings["available_now"], false, "the switch is off");

        // The switch alone, with no hours: all day, exactly as before this setting grew a
        // window. `available_now` is then the switch itself.
        store.set_setting(SETTING_ALWAYS_AVAILABLE, "1").unwrap();
        assert_eq!(settings_json(&store).unwrap()["available_now"], true);
        let night = "2026-08-14T01:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap();
        let midday = "2026-08-14T10:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap();
        assert_eq!(presence_intent(&store, night).unwrap(), Some(true));

        // The hours, kept in a zone the user named — which is what the two of them mean
        // together: 01:00Z is 03:00 in Paris, and nobody is at their desk.
        store.set_setting(SETTING_AVAILABLE_HOURS, "08:00-19:00").unwrap();
        store.set_setting(SETTING_AVAILABLE_ZONE, "Europe/Paris").unwrap();
        let settings = settings_json(&store).unwrap();
        assert_eq!(settings["available_from"], "08:00");
        assert_eq!(settings["available_to"], "19:00");
        assert_eq!(settings["available_zone"], "Europe/Paris");
        assert_eq!(presence_intent(&store, midday).unwrap(), Some(true), "12:00 in Paris");
        assert_eq!(
            presence_intent(&store, night).unwrap(),
            Some(false),
            "outside them the heartbeat withdraws, rather than doing nothing"
        );

        // The same instant and the same window, read in Tokyo: 10:00, and green. This is
        // the whole point of storing the zone — the person moved, the machine did not.
        store.set_setting(SETTING_AVAILABLE_ZONE, "Asia/Tokyo").unwrap();
        assert_eq!(presence_intent(&store, night).unwrap(), Some(true));
        assert_eq!(settings_json(&store).unwrap()["available_zone"], "Asia/Tokyo");

        // A zone no database holds reads as this machine's own, like a malformed window: one
        // answer for the pane and for the heartbeat.
        store.set_setting(SETTING_AVAILABLE_ZONE, "Europe/Pariss").unwrap();
        assert!(available_zone(&store).unwrap().is_none());
        assert_eq!(settings_json(&store).unwrap()["available_zone"], Value::Null);
        store.set_setting(SETTING_AVAILABLE_ZONE, "Europe/Paris").unwrap();

        // The switch off is `None` and not `Some(false)`: an install that never turned this
        // on must make no presence request at all, and the RPC that turns it off has
        // already withdrawn the registration.
        store.set_setting(SETTING_ALWAYS_AVAILABLE, "0").unwrap();
        assert_eq!(presence_intent(&store, midday).unwrap(), None);
        assert_eq!(
            available_hours(&store).unwrap(),
            teams_presence::AvailableHours::parse_setting("08:00-19:00"),
            "the window survives the switch, so a morning does not have to set it again"
        );

        // A stored value no RPC would have written reads as all day — one answer for the
        // settings the page draws and for the heartbeat that acts on them.
        store.set_setting(SETTING_AVAILABLE_HOURS, "nonsense").unwrap();
        assert!(available_hours(&store).unwrap().is_none());
        assert_eq!(settings_json(&store).unwrap()["available_from"], Value::Null);
    }

    // Both hours or neither. A half window has two readings and the caller has to say
    // which; an hour that will not parse must never reach the store, because every later
    // read of that row treats what it cannot parse as all day.
    #[test]
    fn a_presence_window_is_a_pair_or_nothing() {
        assert_eq!(available_hours_param(&json!({ "enabled": true })).unwrap(), None);
        assert_eq!(
            available_hours_param(&json!({ "enabled": true, "from": null, "to": null })).unwrap(),
            None
        );
        assert_eq!(
            available_hours_param(&json!({ "from": "08:00", "to": "19:00" })).unwrap(),
            Some(teams_presence::AvailableHours { from: 8 * 60, to: 19 * 60 })
        );
        for half in [json!({ "from": "08:00" }), json!({ "to": "19:00" }), json!({ "from": "08:00", "to": "" })] {
            let err = available_hours_param(&half).unwrap_err().to_string();
            assert!(err.contains("pair"), "{err}");
        }
        assert!(available_hours_param(&json!({ "from": "8am", "to": "19:00" })).is_err());
        assert!(available_hours_param(&json!({ "from": "09:00", "to": "09:00" })).is_err());
    }

    // The zone travels with the hours, and a name the database does not hold is REFUSED: a
    // typo answered with this machine's zone would publish the user's status at hours nobody
    // chose, which is the failure the setting exists to prevent.
    #[test]
    fn a_presence_zone_is_an_iana_name_or_nothing() {
        assert!(available_zone_param(&json!({ "enabled": true })).unwrap().is_none());
        assert!(available_zone_param(&json!({ "zone": null })).unwrap().is_none());
        assert!(available_zone_param(&json!({ "zone": "" })).unwrap().is_none());
        assert_eq!(
            available_zone_param(&json!({ "zone": "Europe/Paris" })).unwrap().map(|z| z.name()),
            Some("Europe/Paris")
        );
        for bad in ["Europe/Pariss", "+02:00", "CEST", "paris"] {
            let err = available_zone_param(&json!({ "zone": bad })).unwrap_err().to_string();
            assert!(err.contains("IANA"), "{err}");
        }
    }

    // One id, minted once and then kept. A fresh id per call would register a second
    // endpoint on every heartbeat, and Teams would count every one of them as us.
    #[test]
    fn the_presence_endpoint_id_is_minted_once_and_reused() {
        let store = Store::open_in_memory().unwrap();
        let first = presence_endpoint_id(&store).unwrap();
        assert!(!first.is_empty());
        assert_eq!(first, presence_endpoint_id(&store).unwrap());
        assert_eq!(store.get_setting(SETTING_PRESENCE_ENDPOINT_ID).unwrap(), Some(first.clone()));

        // An empty stored value is not an id: it must be replaced rather than sent.
        store.set_setting(SETTING_PRESENCE_ENDPOINT_ID, "").unwrap();
        let second = presence_endpoint_id(&store).unwrap();
        assert!(!second.is_empty());
    }

    // The heartbeat refreshes a registration whose lifetime we measured against the
    // tenant (300 s). A heartbeat at or past that is a status that blinks off.
    #[test]
    fn the_presence_heartbeat_stays_inside_the_registration_lifetime() {
        assert!(
            PRESENCE_HEARTBEAT < Duration::from_secs(300),
            "an endpoint registration expires after 300 s"
        );
    }

    #[test]
    fn repair_broker_is_gated_but_is_not_outward_facing() {
        // The distinction is load-bearing: OUTWARD_METHODS means "posts as the user",
        // and AGENTS.md tells every later reader that a new entry there is a Teams,
        // mail or calendar write gaining a consent gate.
        assert!(!OUTWARD_METHODS.contains(&"repair_broker"));
        assert_eq!(write_class("repair_broker"), Some(WriteClass::Machine));
        assert_eq!(write_class("send"), Some(WriteClass::Outward));
        assert_eq!(write_class("conversations"), None);
    }

    #[test]
    fn repair_broker_is_refused_without_the_token() {
        let err = check_write_allowed("repair_broker", &json!({}), Some("tok"))
            .expect_err("must refuse a tokenless repair");
        assert!(err.contains("write token"), "{err}");
        // The refusal has to say what it is about; the outward text would be wrong.
        assert!(err.contains("Intune container"), "{err}");
    }

    #[test]
    fn repair_broker_is_refused_with_a_wrong_token() {
        let params = json!({ "write_token": "not-the-token" });
        assert!(check_write_allowed("repair_broker", &params, Some("tok")).is_err());
    }

    /// Restarting the backend is gated; ASKING GitHub about a release is not.
    ///
    /// The split is the whole shape of Settings › This app. One takes down the process every
    /// open page is talking to, cuts off a local agent mid-reply and stops the user's calls
    /// ringing here for a moment; the other makes one HTTP request the poll already makes
    /// every two minutes and changes nothing on this machine. A gate on the second would
    /// only stop a page from answering "am I up to date?".
    #[test]
    fn restarting_the_backend_is_gated_and_checking_for_an_update_is_not() {
        assert!(!OUTWARD_METHODS.contains(&"restart_backend"));
        assert_eq!(write_class("restart_backend"), Some(WriteClass::Machine));
        assert_eq!(write_class("update_check"), None);
    }

    #[test]
    fn restarting_the_backend_is_refused_without_the_token() {
        let err = check_write_allowed("restart_backend", &json!({}), Some("tok"))
            .expect_err("must refuse a tokenless restart");
        assert!(err.contains("write token"), "{err}");
        // Its own words, not the class's: what this one costs is every page's connection
        // and a reply an agent was writing.
        assert!(err.contains("backend"), "{err}");
        assert!(err.contains("agent"), "{err}");
    }

    /// A restart answers the click that asked for it, and only then goes.
    ///
    /// Scanned rather than run, because the method ends in a killed process: what has to
    /// hold is the ORDER of three things. The agent count is read BEFORE anything is taken
    /// down (a reply frozen mid-answer is the one cost the user has to be asked about); the
    /// reply's grace comes before the exit (the answer travels on the socket this drops, so
    /// acting at once swallows it); and the calling registration is handed back before the
    /// process that would answer a call is gone.
    #[test]
    fn a_requested_restart_asks_about_the_agent_and_answers_before_it_goes() {
        let source = include_str!("server.rs");
        let body = source
            .split("    async fn restart_backend(")
            .nth(1)
            .expect("the restart handler")
            .split("\n    /// A valid CSA-audience token")
            .next()
            .expect("the handler ends before the next method");

        let agent = body.find("live_agent_runs_here()").expect("the agent count");
        let grace = body.find("RESTART_ANSWER_GRACE").expect("the answer's own grace");
        let calling = body.find("stop_calling()").expect("the calling registration");
        let exit = body.find("std::process::exit(0)").expect("the exit");
        assert!(agent < grace, "the runs a restart would cut off are read before it starts");
        assert!(grace < calling, "the click's own answer goes out before anything is stopped");
        assert!(calling < exit, "a device Teams still routes calls to must be taken back");
    }

    #[test]
    fn the_push_methods_are_gated_but_are_not_outward_facing() {
        // Subscribing decides which devices this machine notifies. It posts nothing
        // to Teams, so it is not outward — but a client that merely found this
        // socket must not be able to aim the user's message previews anywhere.
        for method in ["push_subscribe", "push_unsubscribe", "push_test"] {
            assert!(!OUTWARD_METHODS.contains(&method), "{method}");
            assert_eq!(write_class(method), Some(WriteClass::Machine), "{method}");
            let err = check_write_allowed(method, &json!({}), Some("tok"))
                .expect_err("must refuse a tokenless push change");
            assert!(err.contains("write token"), "{err}");
            // The refusal has to say what it is about; the container text would be
            // wrong, and a refusal nobody believes is a refusal nobody reads.
            assert!(err.contains("push notifications"), "{err}");
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok());
        }
        // Reading the status is open, like every other read.
        assert_eq!(write_class("push_status"), None);
    }

    #[test]
    fn storing_the_integration_credentials_is_gated_but_is_not_outward_facing() {
        // Writing the settings can move the GitLab host the stored token is pinned
        // to, which would send that token somewhere the user never configured. It
        // posts nothing to Teams, so it is gated as a machine change, not as an
        // outward action.
        assert!(!OUTWARD_METHODS.contains(&"set_settings"));
        assert_eq!(write_class("set_settings"), Some(WriteClass::Machine));
        let err = check_write_allowed("set_settings", &json!({}), Some("tok"))
            .expect_err("must refuse a tokenless settings write");
        assert!(err.contains("write token"), "{err}");
        assert!(err.contains("integration credentials"), "{err}");
        assert!(
            check_write_allowed("set_settings", &json!({ "write_token": "tok" }), Some("tok"))
                .is_ok()
        );
        // Reading them back stays open: the view carries no token, only whether one
        // is set, and the UI needs it before the user has done anything.
        assert_eq!(write_class("get_settings"), None);
        // Enriching a link is a read as well — it is how every preview card loads.
        assert_eq!(write_class("enrich_link"), None);
    }

    #[test]
    fn the_settings_view_reports_each_token_without_revealing_it() {
        let store = Store::open_in_memory().unwrap();

        // Untouched: the GitLab default host, and neither integration configured.
        let fresh = settings_json(&store).unwrap();
        assert_eq!(fresh["gitlab_host"], gitlab::DEFAULT_HOST);
        assert_eq!(fresh["gitlab_token_set"], false);
        assert_eq!(fresh["linear_token_set"], false);

        store.set_setting(SETTING_LINEAR_TOKEN, "lin_api_secret").unwrap();
        store.set_setting(SETTING_GITLAB_HOST, "gitlab.example.com").unwrap();
        let configured = settings_json(&store).unwrap();
        assert_eq!(configured["gitlab_host"], "gitlab.example.com");
        assert_eq!(configured["linear_token_set"], true);
        // One integration's token says nothing about the other's.
        assert_eq!(configured["gitlab_token_set"], false);
        // THE point of the non-secret view: no raw token is anywhere in it.
        assert!(
            !configured.to_string().contains("lin_api_secret"),
            "the settings view must never carry a raw token: {configured}"
        );
    }

    /// The Linear workspace a bare `ENG-123` is addressed in: an open READ, cached, and
    /// forgotten the moment the key that named it changes.
    #[test]
    fn the_linear_workspace_is_an_open_read_that_carries_no_key() {
        // Open, like every other tracker read: it is asked on connect, it publishes
        // nothing about the user, and a gate would only stop a page from drawing a chip.
        assert_eq!(write_class("linear_workspace"), None);
        assert!(check_write_allowed("linear_workspace", &json!({}), None).is_ok());
        // The wire shape carries the workspace and when it was read — never the key.
        let workspace = linear::Workspace {
            url_key: "heka-internal".into(),
            team_keys: vec!["STMN".into(), "CONFIG".into()],
        };
        let answer = linear_workspace_json(Some(&workspace), 1_700_000_000_000);
        assert_eq!(answer["workspace"]["url_key"], "heka-internal");
        assert_eq!(answer["workspace"]["team_keys"][1], "CONFIG");
        assert_eq!(answer["read_at_ms"], 1_700_000_000_000_i64);
        // A machine with no key answers the same shape with nothing in it, which is what
        // makes "no chip" a cached answer rather than a request on every connect.
        assert_eq!(linear_workspace_json(None, 1)["workspace"], Value::Null);
    }

    #[test]
    fn a_cached_workspace_stands_for_its_window_and_no_longer() {
        let store = Store::open_in_memory().unwrap();
        let now = 10_000_000_000_i64;
        // Nothing stored: read Linear.
        assert_eq!(fresh_linear_workspace(&store, now).unwrap(), None);

        let workspace =
            linear::Workspace { url_key: "acme".into(), team_keys: vec!["ENG".into()] };
        let answer = linear_workspace_json(Some(&workspace), now);
        store.set_setting(SETTING_LINEAR_WORKSPACE, &answer.to_string()).unwrap();
        // Inside the window the stored answer IS the answer, so a page that asks on every
        // connect costs no request.
        let fresh = fresh_linear_workspace(&store, now + 60_000).unwrap();
        assert_eq!(fresh.unwrap()["workspace"]["url_key"], "acme");
        // Past it, Linear is read again.
        let stale = now + LINEAR_WORKSPACE_TTL.as_millis() as i64 + 1;
        assert_eq!(fresh_linear_workspace(&store, stale).unwrap(), None);
        // A stale answer is still there for the one caller that wants one: a read that
        // failed, because a url key from this morning addresses every issue.
        assert!(stored_linear_workspace(&store).is_some());

        // A value that no longer parses reads as absent — the only thing to do with one
        // is to read again.
        store.set_setting(SETTING_LINEAR_WORKSPACE, "not json").unwrap();
        assert_eq!(fresh_linear_workspace(&store, now).unwrap(), None);
        assert_eq!(stored_linear_workspace(&store), None);
    }

    #[test]
    fn a_new_linear_key_forgets_the_workspace_the_old_one_named() {
        // A key may name another workspace, so the cached one cannot be left to age out:
        // a reference would be addressed at a workspace that key no longer reaches.
        let store = Store::open_in_memory().unwrap();
        let workspace = linear::Workspace { url_key: "acme".into(), team_keys: vec![] };
        store
            .set_setting(SETTING_LINEAR_WORKSPACE, &linear_workspace_json(Some(&workspace), 1).to_string())
            .unwrap();
        // What the `set_settings` arm does when `linear_token` is among its params.
        store.set_setting(SETTING_LINEAR_WORKSPACE, "").unwrap();
        assert_eq!(fresh_linear_workspace(&store, 2).unwrap(), None);
        assert_eq!(stored_linear_workspace(&store), None);
    }

    #[test]
    fn an_emptied_token_reads_back_as_unset() {
        // How the UI clears a token: it sends "", which must not count as a stored
        // one — otherwise the pane would keep offering "Remove token" forever.
        let store = Store::open_in_memory().unwrap();
        store.set_setting(SETTING_LINEAR_TOKEN, "lin_api_secret").unwrap();
        store.set_setting(SETTING_LINEAR_TOKEN, "").unwrap();
        assert_eq!(settings_json(&store).unwrap()["linear_token_set"], false);
        assert_eq!(link_preview_settings(&store).unwrap().linear_token, None);
    }

    /// A call rings a person, so every calling method that reaches one is gated
    /// exactly like a send — and the two that reach nobody are gated for their own
    /// reason, with their own words.
    #[test]
    fn every_calling_method_that_reaches_a_person_is_outward_facing() {
        for method in ["call_place", "call_accept", "call_hangup", "call_mute"] {
            assert!(OUTWARD_METHODS.contains(&method), "{method} rings or is heard by a person");
            assert_eq!(write_class(method), Some(WriteClass::Outward), "{method}");
            let refused = check_write_allowed(method, &json!({}), None)
                .expect_err("a read-only backend must refuse it");
            assert!(refused.contains("read-only"), "{method}: {refused}");
            let untokened = check_write_allowed(method, &json!({}), Some("tok"))
                .expect_err("a client without the token must be refused");
            assert!(untokened.contains("write token"), "{method}: {untokened}");
            assert!(
                check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok()
            );
        }

        // The one that posts nothing: gated, but never described as posting.
        for (method, phrase) in [("call_prepare", "media credentials")] {
            assert!(!OUTWARD_METHODS.contains(&method), "{method} posts nothing");
            assert_eq!(write_class(method), Some(WriteClass::Machine), "{method}");
            let err = check_write_allowed(method, &json!({}), Some("tok"))
                .expect_err("must refuse without the token");
            assert!(err.contains(phrase), "{method}: {err}");
        }

        // Reading the state is open, like every other read.
        assert_eq!(write_class("call_status"), None);
    }

    /// NO environment value silences a device, and this scans for the one that used to.
    ///
    /// The released build beside the staged pair carried `TEAMS_LITE_CALLING=0`, so the
    /// front a phone had open drew every call and Join control disabled — a whole feature
    /// missing, with the cause in a unit file. What that switch bought was one less ring
    /// on a second registration; what it cost was the user's ability to call at all from
    /// that window. It reads as a sensible optimisation, which is exactly why a test has
    /// to keep it out: the spelling is split so this needle is not its own match.
    #[test]
    fn no_environment_value_silences_calling() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let switch = concat!("TEAMS_LITE", "_CALLING");
        for (number, line) in code.lines().enumerate() {
            assert!(
                line.trim_start().starts_with("//") || !line.contains(switch),
                "line {}: calling has no environment switch — every install but a \
                 read-only one registers, and each holds an endpoint id of its own",
                number + 1
            );
        }
    }

    /// A read-only backend never registers: a screenshot backend must not become a device
    /// the user's calls ring on. It is the ONLY backend that says no, so this equality is
    /// the whole rule rather than one clause of it.
    #[test]
    fn a_read_only_backend_is_never_a_device_calls_ring_on() {
        assert_eq!(calling_available(), !read_only());
    }

    /// A meeting is named in one of two ways, because the user reaches one from two
    /// places: the LINK a calendar event carries, and the THREAD it has in the chat list.
    /// One parse for both, so nothing downstream knows two address types.
    #[test]
    fn a_meeting_is_addressed_by_its_link_or_by_its_own_thread() {
        let by_link = meeting_address(&json!({
            "join_url": "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0"
        }))
        .unwrap()
        .expect("a meeting");
        assert_eq!(by_link.thread_id.as_deref(), Some("19:meeting_x@thread.v2"));

        let by_thread = meeting_address(&json!({ "meeting_thread": "19:meeting_x@thread.v2" }))
            .unwrap()
            .expect("a meeting");
        assert_eq!(by_thread.thread_id.as_deref(), Some("19:meeting_x@thread.v2"));
        assert_eq!(by_thread.message_id, "0");

        // Neither named: the placing branch of `call_prepare`, which rings people instead.
        assert!(meeting_address(&json!({ "conversation": "19:chat@thread.v2" })).unwrap().is_none());

        // Named and unusable is an ERROR, never a fallthrough — a join that quietly became
        // a call would ring people instead of walking into a meeting. A plain group chat is
        // the case that really happens: it is called, and it has no meeting to join.
        let refused = meeting_address(&json!({
            "meeting_thread": "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2"
        }))
        .expect_err("a group chat is not a meeting");
        assert!(refused.to_string().contains("not a meeting"), "{refused}");
        assert!(meeting_address(&json!({ "join_url": "https://zoom.us/j/1" })).is_err());
    }

    /// A group call rings every phone in the thread at once, and that cannot be taken
    /// back — so there is a ceiling, and it is stated where both the refusal and the mock
    /// can read it.
    #[test]
    fn a_group_call_rings_a_group_and_not_a_broadcast() {
        assert_eq!(MAX_GROUP_CALL_PEOPLE, 20);
        // The three kinds a client is shown, each spelled once. A group is its own name
        // because the UI draws a conversation rather than a face for it, and a meeting's
        // lobby is a state a group call does not have.
        assert_eq!(CallKind::Call.as_str(), "call");
        assert_eq!(CallKind::Group.as_str(), "group");
        assert_eq!(CallKind::Meeting.as_str(), "meeting");
    }

    /// The state every client is given must carry no SDP and no credentials: those
    /// leave only through a token-gated method.
    #[test]
    fn the_call_a_client_is_shown_carries_no_media_and_no_secret() {
        let call = CallSession {
            id: "call-1".into(),
            direction: CallDirection::Incoming,
            // An invite on the calling socket is a call. A meeting is joined, never
            // offered: this app is not invited to a meeting, it walks in.
            kind: CallKind::Call,
            phase: CallPhase::Ringing,
            conversation_id: Some("19:thread@thread.v2".into()),
            peer_mri: "8:orgid:her".into(),
            peer_name: "Her".into(),
            ring: Vec::new(),
            links: calling::Links::collect(&json!({
                "links": { "accept": "https://x/accept", "hangup": "https://x/hangup" }
            })),
            local: calling::LocalParticipant {
                id: "8:orgid:me".into(),
                display_name: "Me".into(),
                endpoint_id: "endpoint".into(),
                participant_id: "leg".into(),
            },
            callbacks: calling::CallbackBase {
                surl: "https://tr/v4/f/a/".into(),
                session_id: "s".into(),
                cause_id: "c".into(),
            },
            offer: Some(calling::MediaContent::sdp("v=0 secret-sdp")),
            roster: Vec::new(),
            in_lobby: false,
            muted: false,
            connected_at_ms: None,
            end_reason: None,
            unreachable: false,
            renegotiation_answer_link: None,
            source_request_sequence: 0,
            sending: Vec::new(),
            sharing: None,
        };
        let json = call.json();
        assert_eq!(json["phase"], "ringing");
        assert_eq!(json["direction"], "incoming");
        assert_eq!(json["peer"], "Her");
        // What the UI may offer, decided here because only this side holds the links.
        assert_eq!(json["can_accept"], true);
        assert_eq!(json["can_hangup"], true);
        let rendered = json.to_string();
        for secret in ["v=0", "https://x/accept", "https://tr/v4/f/a/", "endpoint"] {
            assert!(!rendered.contains(secret), "the client view leaked {secret}: {rendered}");
        }
    }

    /// A ringing call with no offer cannot be answered, and saying so HERE is what
    /// stops the page from asking the microphone for nothing.
    #[test]
    fn a_call_with_no_offer_is_not_answerable() {
        let mut call = CallSession {
            id: "call-1".into(),
            direction: CallDirection::Incoming,
            // An invite on the calling socket is a call. A meeting is joined, never
            // offered: this app is not invited to a meeting, it walks in.
            kind: CallKind::Call,
            phase: CallPhase::Ringing,
            conversation_id: None,
            peer_mri: "8:orgid:her".into(),
            peer_name: "Her".into(),
            ring: Vec::new(),
            links: calling::Links::default(),
            local: calling::LocalParticipant {
                id: "8:orgid:me".into(),
                display_name: "Me".into(),
                endpoint_id: "e".into(),
                participant_id: "l".into(),
            },
            callbacks: calling::CallbackBase {
                surl: "https://tr/".into(),
                session_id: "s".into(),
                cause_id: "c".into(),
            },
            offer: None,
            roster: Vec::new(),
            in_lobby: false,
            muted: false,
            connected_at_ms: None,
            end_reason: None,
            unreachable: false,
            renegotiation_answer_link: None,
            source_request_sequence: 0,
            sending: Vec::new(),
            sharing: None,
        };
        assert_eq!(call.json()["can_accept"], false);
        // And a call that is over offers nothing at all.
        call.phase = CallPhase::Ended;
        call.offer = Some(calling::MediaContent::sdp("v=0"));
        assert_eq!(call.json()["can_accept"], false);
        assert_eq!(call.json()["can_hangup"], false);
    }

    /// Every POST that puts this machine INTO a call re-reads the reservation when its
    /// answer comes back, and hangs the call up when the reservation has gone.
    ///
    /// That window is one click wide and the user hits it often: they stop a call a second
    /// after starting it. The hangup then finds no link to post on — the answer carrying it
    /// is still on the wire — so it drops the call here, and a moment later the service has
    /// somebody's phone ringing, or a caller talking into a machine that holds nothing. The
    /// answer's own links are that call's only address, and this is the only moment they
    /// exist, so a handler that merely skipped its merge would leave the call standing.
    #[test]
    fn a_call_answered_for_a_cancelled_start_is_hung_up() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        for (method, next) in [
            ("\"call_place\" => {", "\"call_join\" => {"),
            ("\"call_join\" => {", "\"call_accept\" => {"),
            ("\"call_accept\" => {", "\"call_answer_media\" => {"),
        ] {
            let handler = code.split(method).nth(1).expect(method);
            let handler = handler.split(next).next().expect("the handler ends at the next arm");
            assert!(
                handler.contains("hang_up_orphan"),
                "{method} keeps a call the user cancelled while its POST was in flight. \
                 Re-read the reservation after the answer and hang the call up on the links \
                 that answer carried."
            );
            assert!(
                handler.contains("!c.ended()"),
                "{method} reads the reservation without checking whether it ENDED. \
                 `end_call_locally` marks the session before it drops it, so a request \
                 landing on that side of the emit would look like a live call."
            );
        }
    }

    /// A one-to-one call negotiates the CAMERA and the SCREEN with the call itself, and a
    /// conference does not — so `call_prepare` has to say which kind it reserved.
    ///
    /// It is the real client's own split (`addModalities`: `numVideoChannels` is 1 and both
    /// modalities are forced inactive at the first negotiation of a one-to-one, while a
    /// conference offers audio alone). This app added the section mid-call in every case, and
    /// the service answered a real screen share by zeroing its port — see
    /// NATIVE-CALLING.md § 10.8. The page cannot work the kind out for itself: the RING LIST
    /// is what says how many people a call reaches, and only the backend fetches it.
    #[test]
    fn call_prepare_says_whether_the_call_is_one_to_one() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        // The LAST occurrence is the handler: the name is spelled earlier in this file too,
        // in the gate list that decides which methods need the write token.
        let handler = code.rsplit("\"call_prepare\" => {").next().expect("call_prepare");
        let handler = handler.split("\"call_place\" => {").next().expect("the next arm");
        assert!(
            handler.contains("\"one_to_one\": kind == CallKind::Call"),
            "call_prepare no longer states whether the call is a one-to-one. The page \
             reserves the camera and screen sections in the first offer for that case only, \
             and it has no other way to know: a conversation id does not say how many \
             people a call rings."
        );
        // And it is stated for a CHAT call only. A meeting join reserves nothing, exactly as
        // the client's own conference path offers audio alone.
        assert_eq!(
            handler.matches("\"one_to_one\"").count(),
            1,
            "`one_to_one` is answered more than once in call_prepare. A meeting and an \
             answered call must not claim it: the reservation belongs to the one shape the \
             client reserves for."
        );
    }

    /// A share ASKS before it offers, and it can always be given back.
    ///
    /// A meeting shows one screen at a time, so a section from an endpoint that never asked to
    /// present is rejected outright — measured 2026-08-06, with the section labelled correctly
    /// and offering the codecs a client offers. Both halves are outward: everybody in the
    /// meeting is told who is presenting.
    #[test]
    fn sharing_a_screen_is_a_session_that_is_gated_and_can_be_given_back() {
        assert!(OUTWARD_METHODS.contains(&"call_start_sharing"));
        assert!(OUTWARD_METHODS.contains(&"call_stop_sharing"));

        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let start = code
            .rsplit("\"call_start_sharing\" => {")
            .next()
            .and_then(|rest| rest.split("\"call_stop_sharing\" => {").next())
            .expect("the start handler");
        // The link is the conversation's own, and the session is asked of a LIVE call: the
        // service adds a modality to an ongoing conversation and refuses one before that.
        assert!(start.contains("add_modality()"), "the session is asked for on `addModality`");
        assert!(start.contains("CallPhase::Connected"), "a modality needs a live conversation");
        // The GRANT is waited for. It arrives on the `addModalitySuccess` callback and not in
        // the answer to the POST, and a section offered before the service has registered a
        // presenter is a section it rejects (measured 2026-08-06).
        assert!(
            start.contains("await_sharing_session"),
            "the section must not be offered before the meeting has granted the session"
        );
        // And the session's links never join the call's: merged in, this frame's `leave`
        // would overwrite the one a hangup posts to, so giving a share up would end the call.
        assert!(!start.contains("links.merge"), "the session's links stay on their own struct");
        let frames = code
            .split("CONVERSATION_ADD_MODALITY_SUCCESS")
            .nth(1)
            .expect("the grant frame is read");
        assert!(
            frames.contains("ContentSharing::from_frame"),
            "the grant is read off its own frame"
        );

        let stop = code.rsplit("\"call_stop_sharing\" => {").next().expect("the stop handler");
        assert!(
            stop.contains("content_sharing_leave_payload"),
            "a share that cannot be given back is not one this app would start"
        );
        // And a colleague who is presenting is never a REFUSAL. The session changes hands —
        // measured against a real share: the service granted us the role and then offered
        // their screen at port 0 — which is what every Teams client does when somebody
        // presses Share while another person presents. A roster this handler read to say no
        // took the one action the user came for away in the state they wanted it in.
        assert!(
            !start.contains("is sharing their screen"),
            "a colleague's share is displaced by the service, never refused here"
        );
        assert!(
            start.contains("displacing"),
            "the journal says when a press here takes a colleague's share down"
        );
    }

    /// "Ready" must mean a call could start RIGHT NOW: registered, and the socket up.
    /// A registration that is still remembered across a reconnect is not readiness, or
    /// the UI would offer a call the backend has nothing to send it on.
    #[test]
    fn readiness_needs_both_the_registration_and_a_live_socket() {
        let mut plane = CallingPlane::default();
        assert!(plane.channel.is_none() && !plane.connected, "a fresh plane is not ready");

        plane.channel = Some(trouter::CallingChannel {
            surl: "https://tr/v4/f/abc/".into(),
            endpoint_id: "epid".into(),
        });
        // Registered but the socket is down: not ready, and the address is kept so a
        // reconnect can still tell a surl that MOVED from one that came back.
        assert!(plane.channel.is_some() && !plane.connected);
        plane.connected = true;
        assert!(plane.channel.is_some() && plane.connected);
    }

    /// The keep-alive is shorter than any plausible server timeout, and it exists at all
    /// because a call the service stops hearing from is a call it tears down.
    #[test]
    fn the_call_keepalive_is_frequent_enough_to_hold_a_call() {
        assert!(CALL_KEEPALIVE <= Duration::from_secs(30), "too slow to hold a call");
        assert!(CALL_KEEPALIVE >= Duration::from_secs(5), "one request per few seconds is noise");
    }

    /// The cause id the web client generates is 8 hex characters, and the service
    /// logs a leg by it.
    #[test]
    fn a_cause_id_is_eight_hex_characters() {
        let id = short_cause_id();
        assert_eq!(id.len(), 8);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        assert_ne!(id, short_cause_id(), "two legs must not share one id");
    }

    #[test]
    fn the_agent_methods_are_gated_but_are_not_outward_facing() {
        // None of them posts, so none is outward — but `agent_set_mode` decides which
        // conversations this machine will later answer in the user's name,
        // `agent_set_tools` decides what a chat message may make a local agent do, and
        // `agent_set_provider` decides which program it starts.
        for (method, phrase) in [
            ("agent_set_mode", "in the user's name"),
            ("agent_set_tools", "local agent"),
            ("agent_set_provider", "which coding agent"),
            // Stopping a run is the same class: it acts on a program this machine runs,
            // it posts nothing itself (the run's own finalization writes the body), and a
            // client that merely found the socket must not kill the user's agent.
            ("agent_stop", "stops a local agent"),
        ] {
            assert!(!OUTWARD_METHODS.contains(&method), "{method}");
            assert_eq!(write_class(method), Some(WriteClass::Machine), "{method}");
            let err = check_write_allowed(method, &json!({}), Some("tok"))
                .expect_err("must refuse a tokenless agent change");
            assert!(err.contains("write token"), "{err}");
            assert!(err.contains(phrase), "{method}: {err}");
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok());
        }
        // Reading the status is open, like every other read.
        assert_eq!(write_class("agent_status"), None);
    }

    #[test]
    fn a_read_only_backend_refuses_to_arm_the_agent() {
        // The reply path checks `read_only()` on its own (an agent answering in the
        // user's name is the loudest thing a screenshot script could do), and the
        // gate refuses the switch that would arm it in the first place.
        for method in ["agent_set_mode", "agent_set_tools", "agent_set_provider", "agent_stop"] {
            let err = check_write_allowed(method, &json!({ "write_token": "tok" }), None)
                .expect_err("read-only must refuse");
            assert!(err.contains("read-only"), "{err}");
        }
    }

    #[test]
    fn the_child_never_inherits_the_write_token() {
        // `src/agent.rs` removes this variable from the agent's environment: an agent
        // holding it could post to any chat directly, around every consent gate here.
        // It cannot import the constant (this is a binary, not a library), so the two
        // spellings are pinned to each other.
        assert_eq!(WRITE_TOKEN_ENV, "TEAMS_LITE_WRITE_TOKEN");
        let source = include_str!("../agent.rs");
        assert!(
            source.contains(&format!("const WRITE_TOKEN_ENV: &str = \"{WRITE_TOKEN_ENV}\"")),
            "src/agent.rs must remove {WRITE_TOKEN_ENV} from the child's environment"
        );
        assert!(source.contains("env_remove(WRITE_TOKEN_ENV)"));
    }

    /// A PINNED token is never published, which is what lets two send-capable backends
    /// share a machine.
    ///
    /// There is ONE token file per machine, so a second backend that published would
    /// overwrite the first one's token — and the first one's own frontend would then be
    /// handed a token its backend refuses. Nothing would look broken: reads keep working,
    /// and only sends come back refused, which on the always-on service means the user's
    /// phone silently losing the ability to answer anybody.
    ///
    /// The test reads this function's own source, because the failure is the ABSENCE of a
    /// call on one branch and no unit test can observe a file the process did not write
    /// without racing the real one at `$XDG_RUNTIME_DIR/teams-lite/write-token`.
    #[test]
    fn a_pinned_write_token_is_never_published() {
        let source = include_str!("server.rs");
        let body = source
            .split("fn write_token() -> Option<&'static str> {")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .expect("write_token is defined once");
        let published = body.matches("publish_write_token(").count();
        assert_eq!(
            published, 1,
            "write_token must publish on exactly one branch — the one that MINTED the \
             token. A pinned one belongs to the parent that handed it over, and \
             publishing it would overwrite the other backend's token: {body}"
        );
        let pinned_arm = body
            .split("let token = match pinned {")
            .nth(1)
            .expect("the pinned/minted split must stay explicit");
        let pinned_first = pinned_arm
            .split("None =>")
            .next()
            .expect("the Some arm comes first");
        assert!(
            !pinned_first.contains("publish_write_token"),
            "the PINNED arm must publish nothing: {pinned_first}"
        );
    }

    /// The page's staleness window must be several keepalives wide.
    ///
    /// The two numbers sit on opposite sides of the socket and only mean something
    /// together: this backend repeats a quiet run's frame every
    /// [`AGENT_STREAM_KEEPALIVE`], and the page drops a run it has not heard from in
    /// `AGENT_RUN_STALE_MS`. Raise the keepalive past that window and the bubble stops
    /// believing in runs that are still writing — which is the failure this pair
    /// replaced, when the window was pinned to a ten-minute cap on the run itself.
    #[test]
    fn the_pages_staleness_window_is_several_keepalives_wide() {
        let source = include_str!("../../web/src/lib/agent-run.ts");
        let product = source
            .split_once("export const AGENT_RUN_STALE_MS =")
            .expect("the client's staleness window")
            .1
            .split_once(';')
            .expect("one statement")
            .0;
        // Spelled as a product in the file (`2 * 60 * 1000`), so read it as one.
        let stale_ms: u128 = product
            .split('*')
            .map(|factor| factor.trim().parse::<u128>().expect("a product of integers"))
            .product();
        assert!(
            stale_ms >= 4 * AGENT_STREAM_KEEPALIVE.as_millis(),
            "{stale_ms} ms is under four keepalives"
        );
    }

    /// The release poll must fit inside GitHub's own hourly budget, with room to spare.
    ///
    /// The two numbers only mean something together: `GITHUB_HOURLY_REQUESTS` is what a
    /// measurement said an unauthenticated caller gets per IP, and this interval is how
    /// often this machine spends one. Half is the ceiling because the poll is not the only
    /// thing that asks — the compare API behind the changelog, and the re-read before every
    /// download attempt, come out of the same 60 — and a `403` costs the update button with
    /// no visible symptom at all.
    #[test]
    fn the_release_poll_spends_at_most_half_of_githubs_hourly_budget() {
        let per_hour = 3600 / RELEASE_CHECK_INTERVAL.as_secs();
        assert!(
            per_hour <= u64::from(teams_lite::update::GITHUB_HOURLY_REQUESTS) / 2,
            "{per_hour} requests an hour leaves too little of GitHub's {} for the compare \
             API and for downloads",
            teams_lite::update::GITHUB_HOURLY_REQUESTS
        );
        // And it must stay a POLL: an interval measured in hours would be back to the
        // startup-only check this replaced, where an app left open never saw a release.
        assert!(
            RELEASE_CHECK_INTERVAL <= Duration::from_secs(10 * 60),
            "an app left open has to notice a release within minutes"
        );
    }

    /// The poll asks once per MACHINE, and speaks only when something moved.
    ///
    /// Scanned rather than run, because the pass is a loop over the network and the store:
    /// what has to hold is the ORDER of its guards, and each one costs something real if it
    /// goes. The claim keeps two installs from spending the budget twice; the read-only
    /// exclusion keeps a screenshot backend from holding the slot the app needs; the
    /// phase check keeps a pass from moving the asset under a progress bar; and the
    /// comparison against what is already published is what stops a page open for a week
    /// from being sent an event every two minutes.
    #[test]
    fn the_release_poll_shares_one_request_and_speaks_only_on_a_change() {
        let source = include_str!("server.rs");
        let pass = source
            .split("    async fn release_pass(")
            .nth(1)
            .expect("the release watch's own pass")
            .split("\n    /// The `update_check` RPC")
            .next()
            .expect("the pass ends before the next method");

        for (needle, why) in [
            (
                "slot.phase",
                "a pass must stand aside for a download: it owns the asset the bar is \
                 drawn against",
            ),
            (
                "!read_only() && self.claim_release_read(ask)",
                "the claim must be taken before the fetch, and never by a read-only \
                 backend — it cannot install anything and would hold the machine's slot",
            ),
            (
                "self.stored_release()",
                "a backend that lost the claim must read the machine's answer, or it would \
                 learn nothing until it won one",
            ),
            (
                "known == info.latest",
                "an unchanged release must be silent, or every client is sent an event \
                 every interval for ever",
            ),
        ] {
            assert!(pass.contains(needle), "{why} (looked for `{needle}`)");
        }

        // The fetch happens inside the claim, never beside it. Read positionally, because
        // that ordering IS the budget: a fetch above the claim would spend a request per
        // backend and the claim would only decide who writes the answer down.
        let claim = pass.find("claim_release_read(ask)").expect("the claim");
        let fetch = pass.find("update::fetch_release(").expect("the fetch");
        assert!(claim < fetch, "the request must happen under the claim, not beside it");

        // And its cleanup NAMES what it spares. The pass's own phase check above guards
        // this process's download and nothing else: the cache is per machine, so a pass
        // that cleared it wholesale took the download another install was about to install
        // (see `update::prune_downloads`).
        assert!(
            pass.contains("prune_downloads(&release.rev)"),
            "the pass must spare the download for the release it just read — a clear-all \
             here is the 2026-08-06 failure, where the staged service deleted the 130 MB \
             the released build was one click from installing"
        );
    }

    /// **A failed swap is REPORTED — on this machine, and to every open page.**
    ///
    /// This is what the 2026-08-06 failure cost its reader. The install threw, the page
    /// that had clicked drew a failure out of the rejected RPC, and nothing else knew: no
    /// journal line on the machine the app runs on, no phase for the phone beside it, and —
    /// because the reply carried `to_string()` — a sentence naming the install path with the
    /// reason stripped off it. The user was shown "install the new build over
    /// /home/…/teams-bin" and had nothing to act on.
    ///
    /// Scanned, because the failure is a filesystem one and reaching it for real means
    /// making a directory unwritable under a live `Ctx`; what has to hold is that all three
    /// halves are spelled at all.
    #[test]
    fn a_failed_swap_says_why_to_the_journal_and_to_every_page() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let apply = code
            .split("    async fn apply_update(")
            .nth(1)
            .expect("the apply")
            .split("\n    /// Restart this backend")
            .next()
            .expect("the apply ends before the restart");

        for (needle, why) in [
            (
                "UpdatePhase::Failed",
                "a swap that failed must leave the slot FAILED, or the row on a second page \
                 keeps drawing `Restarting…` for a restart that never happens",
            ),
            (
                "slot.error = format!(\"{e:#}\")",
                "the slot must carry the WHOLE chain: the outermost context names the \
                 target, and the cause is the half the reader can act on",
            ),
            (
                "eprintln!(\"[update] the swap failed",
                "this machine must keep a record — a failure nobody wrote down cannot be \
                 diagnosed after the page that saw it was closed",
            ),
        ] {
            assert!(apply.contains(needle), "{why} (looked for `{needle}`)");
        }

        // And the reply a client reads carries the cause too. `to_string()` on an
        // `anyhow::Error` is the outermost context ALONE, which is the part the caller
        // already knew; every surface that states a refusal — the composer, the approval
        // menu, the update row — is reading this one string.
        let reply = code
            .split("match dispatch(&request_ctx, &method, &params).await {")
            .nth(1)
            .expect("the dispatch reply")
            .split("};")
            .next()
            .expect("the match ends");
        assert!(
            reply.contains("format!(\"{e:#}\")") && !reply.contains("e.to_string()"),
            "an RPC refusal must reach the client with its cause, not with the context \
             sentence alone"
        );
    }

    #[test]
    fn the_agent_status_lists_the_backends_and_only_the_sandbox_is_armed() {
        let store = Store::open_in_memory().unwrap();
        let status = agent_status_json(&store).unwrap();
        let names: Vec<&str> =
            status["backends"].as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["claude", "opencode"]);
        // Out of the box: one conversation, the pre-authorized one.
        let conversations = status["conversations"].as_array().unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0]["conversation"], agent_policy::SANDBOX_THREAD);
        assert_eq!(conversations[0]["mode"], "reply");
        // And a read-only default for what an agent may do.
        assert_eq!(status["tools"], json!(["Read", "Glob", "Grep"]));
    }

    /// A UI can only offer what the backend describes, so the grants travel with the
    /// status. Without them the tool allowlist is reachable by hand-crafted RPC only,
    /// which is the same as unreachable: the user cannot consent to a tool they have no
    /// switch for.
    #[test]
    fn the_agent_status_offers_the_read_only_tool_grants() {
        let store = Store::open_in_memory().unwrap();
        let status = agent_status_json(&store).unwrap();
        let grants = status["tool_grants"].as_array().unwrap();
        assert_eq!(grants.len(), agent::TOOL_GRANTS.len());
        let keys: Vec<&str> = grants.iter().map(|g| g["key"].as_str().unwrap()).collect();
        assert!(keys.contains(&"grafana"), "{keys:?}");
        let grafana = grants.iter().find(|g| g["key"] == "grafana").unwrap();
        assert!(!grafana["label"].as_str().unwrap().is_empty());
        assert!(grafana["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t == "mcp__grafana__query_prometheus"));
    }

    #[test]
    fn the_agent_status_reports_every_provider_as_enabled_on_no_model() {
        // What the AI providers pane draws on a machine nobody configured: every
        // provider on, each running whatever its own CLI is configured for.
        let store = Store::open_in_memory().unwrap();
        let status = agent_status_json(&store).unwrap();
        for backend in status["backends"].as_array().unwrap() {
            assert_eq!(backend["enabled"], true, "{backend}");
            assert_eq!(backend["model"], Value::Null, "{backend}");
            assert!(backend["models"].is_array(), "{backend}");
            // `available` is this machine's own PATH, so it is a fact, not a default.
            assert!(backend["available"].is_boolean(), "{backend}");
        }
        // Every entry carries what a select needs to draw itself, not just an id: the
        // name a person reads, whose mark sits beside it, and how much it holds.
        assert_eq!(
            status["backends"][0]["models"][1],
            json!({
                "id": "opus",
                "label": "Opus 5",
                "vendor": "anthropic",
                "vendor_label": "Anthropic",
                "context": 1_000_000,
                "output": 128_000,
            }),
        );
        let ids: Vec<&str> = status["backends"][0]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["fable", "opus", "sonnet", "haiku"]);
    }

    #[test]
    fn the_agent_status_names_claude_code_as_the_default_provider() {
        // What a message's "…" menu offers on a machine nobody configured: one row, and
        // it is Claude Code.
        let store = Store::open_in_memory().unwrap();
        assert_eq!(agent_status_json(&store).unwrap()["default_provider"], "claude");

        store.set_setting(agent_policy::SETTING_DEFAULT_PROVIDER, "opencode").unwrap();
        assert_eq!(agent_status_json(&store).unwrap()["default_provider"], "opencode");
        // And a stored name this build does not know never leaves the menu without a row.
        store.set_setting(agent_policy::SETTING_DEFAULT_PROVIDER, "gemini").unwrap();
        assert_eq!(agent_status_json(&store).unwrap()["default_provider"], "claude");
    }

    #[test]
    fn a_stored_provider_choice_shows_up_in_the_status() {
        let store = Store::open_in_memory().unwrap();
        let mut providers = agent_policy::Providers::default();
        providers.set_enabled("opencode", false);
        providers.set_model("claude", Some("opus"));
        store.set_setting(agent_policy::SETTING_PROVIDERS, &providers.to_json()).unwrap();

        let status = agent_status_json(&store).unwrap();
        let backends = status["backends"].as_array().unwrap();
        let claude = backends.iter().find(|b| b["name"] == "claude").unwrap();
        let opencode = backends.iter().find(|b| b["name"] == "opencode").unwrap();
        assert_eq!(claude["enabled"], true);
        assert_eq!(claude["model"], "opus");
        assert_eq!(opencode["enabled"], false);
        assert_eq!(opencode["model"], Value::Null);
    }

    #[test]
    fn arming_a_conversation_keeps_the_others() {
        let store = Store::open_in_memory().unwrap();
        for (conversation, mode) in
            [("19:team@thread.v2", agent_policy::Mode::Reply), (agent_policy::SANDBOX_THREAD, agent_policy::Mode::Off)]
        {
            let modes = store.get_setting(agent_policy::SETTING_MODES).unwrap();
            store
                .set_setting(
                    agent_policy::SETTING_MODES,
                    &agent_policy::with_mode(modes.as_deref(), conversation, mode),
                )
                .unwrap();
        }
        let modes = store.get_setting(agent_policy::SETTING_MODES).unwrap();
        assert_eq!(agent_policy::mode_for("19:team@thread.v2", modes.as_deref()), agent_policy::Mode::Reply);
        // Turning the sandbox off is the user's call too, and it sticks.
        assert_eq!(agent_policy::mode_for(agent_policy::SANDBOX_THREAD, modes.as_deref()), agent_policy::Mode::Off);
    }

    #[test]
    fn one_agent_session_is_kept_per_thread_and_per_backend() {
        // Asking claude a follow-up must not resume an opencode session.
        let claude = agent_session_key("19:team@thread.v2", "claude", "");
        let opencode = agent_session_key("19:team@thread.v2", "opencode", "");
        assert_ne!(claude, opencode);
        assert!(claude.starts_with(agent::SETTING_SESSION_PREFIX));
    }

    /// A custom agent is a different agent to the reader, so it gets a session of its own:
    /// a review bot and a boomer aunt in one thread must not be handed each other's
    /// context, with the preprompt of one leading the other's conversation.
    #[test]
    fn a_custom_agent_keeps_a_session_of_its_own() {
        let plain = agent_session_key("19:team@thread.v2", "claude", "");
        let bebou = agent_session_key("19:team@thread.v2", "claude", "bebou");
        let natacha = agent_session_key("19:team@thread.v2", "claude", "natacha");
        assert_ne!(plain, bebou);
        assert_ne!(bebou, natacha);
        // …and a provider run keeps EXACTLY the key it always had, so no thread loses the
        // session it is in the middle of when this build lands.
        assert_eq!(plain, format!("{}claude:19:team@thread.v2", agent::SETTING_SESSION_PREFIX));
    }

    #[test]
    fn push_status_generates_one_stable_key_and_lists_the_devices() {
        let store = Store::open_in_memory().unwrap();

        let first = push_status_json(&store).unwrap();
        assert_eq!(first["supported"], true);
        let key = first["public_key"].as_str().unwrap().to_string();
        // The browser only accepts the 65-byte uncompressed P-256 point.
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&key).unwrap().len(),
            65
        );
        assert_eq!(first["devices"].as_array().unwrap().len(), 0);

        // Stable across calls, and across a reopen of the same store: a device's
        // subscription embeds this key, so a second answer with a different one
        // would silently retire every phone that opted in.
        assert_eq!(push_status_json(&store).unwrap()["public_key"], key);
        assert_eq!(
            store.get_setting(SETTING_PUSH_VAPID_PRIVATE).unwrap().is_some(),
            true,
            "the private half must be persisted, not regenerated per process"
        );

        store
            .put_push_subscription("https://web.push.apple.com/abc", "k", "a", "iPhone", 42)
            .unwrap();
        let listed = push_status_json(&store).unwrap();
        assert_eq!(listed["public_key"], key);
        let devices = listed["devices"].as_array().unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0]["label"], "iPhone");
        // The keys a push is encrypted to are the DEVICE's secrets; the status is
        // read by any local client, so they must not be in it.
        assert!(devices[0].get("p256dh").is_none(), "{:?}", devices[0]);
        assert!(devices[0].get("auth").is_none(), "{:?}", devices[0]);
    }

    #[test]
    fn every_machine_method_says_what_it_does_to_the_machine() {
        // The refusal text is per method (see `machine_effect`), so a new entry in
        // MACHINE_METHODS that forgets its own phrase is caught here rather than by
        // a user reading a refusal about the wrong subject.
        for method in MACHINE_METHODS {
            assert_ne!(machine_effect(method), "changes this machine", "{method} has no phrase");
        }
    }

    /// SEALING a chat is the user's own act; asking which chats are sealed is not.
    ///
    /// Every one of the four writes decides something a client that merely found this socket must
    /// not decide: whether the next message goes out in the clear, under which passphrase, and
    /// whether a key that opens a thread's history is dropped for good. `seal_reveal` is here
    /// because its ANSWER is the passphrase. `seal_status` stays open: a page has to know whether
    /// a chat is sealed in order to draw a padlock, and it never needs the secret to do it.
    #[test]
    fn sealing_a_chat_needs_the_write_token_and_asking_about_it_does_not() {
        for method in ["seal_set", "seal_off", "seal_forget", "seal_reveal"] {
            assert!(MACHINE_METHODS.contains(&method), "{method} is not gated");
            let err = check_write_allowed(method, &json!({}), Some("tok")).unwrap_err().to_string();
            assert!(err.contains("write token"), "{method}: {err}");
            assert!(
                check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok()
            );
            // A read-only backend refuses them whatever token it is shown: it must not be able to
            // stop a chat being sealed, nor to hand out a passphrase.
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), None).is_err());
            // And each one says what it really does, in its own words.
            assert_ne!(machine_effect(method), "changes this machine", "{method} has no phrase");
        }
        // The read is open, on a read-only backend too.
        assert!(check_write_allowed("seal_status", &json!({}), Some("tok")).is_ok());
        assert!(check_write_allowed("seal_status", &json!({}), None).is_ok());
        assert!(!MACHINE_METHODS.contains(&"seal_status"));
        assert!(!OUTWARD_METHODS.contains(&"seal_status"));
        // None of them posts to Teams, so none belongs in the outward list — the distinction
        // three other tests iterate.
        for method in ["seal_set", "seal_off", "seal_forget", "seal_reveal"] {
            assert!(!OUTWARD_METHODS.contains(&method), "{method} posts nothing");
        }
    }

    /// A page is never handed a key or a passphrase by the status.
    ///
    /// The rule `get_settings` holds for a token: it answers WHETHER a chat is sealed and under
    /// which key id, and a client that merely found this socket learns nothing it could decrypt
    /// with. The passphrase leaves this machine only through `seal_reveal`, which is a press.
    #[test]
    fn the_seal_status_carries_no_key_and_no_passphrase() {
        let store = Store::open_in_memory().unwrap();
        let conversation = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";
        let key = teams_lite::seal::derive("hunter two", conversation).unwrap();
        store.add_seal_key(conversation, &key, "hunter two", 1_700_000_000_000).unwrap();

        let listed = store.sealed_conversations().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].sealing);
        assert_eq!(listed[0].current_key_id, key.id_hex());

        // Serialized the way `seal_status_value` does it, and then searched for the secrets.
        let shown = json!({
            "conversation": listed[0].conversation_id,
            "sealing": listed[0].sealing,
            "current_key_id": listed[0].current_key_id,
            "keys": listed[0].keys.iter().map(|k| json!({
                "key_id": k.key_id, "is_current": k.is_current, "added_ms": k.added_ms,
            })).collect::<Vec<_>>(),
        })
        .to_string();
        assert!(!shown.contains("hunter"), "the passphrase must not be in the status: {shown}");
        assert!(
            !shown.contains(&teams_lite::seal::hex_of(&key.secret_for_store())),
            "the key must not be in the status: {shown}"
        );
        // And the passphrase is still there for the press that reveals it.
        assert_eq!(
            store.seal_passphrase(conversation, &key.id_hex()).unwrap().as_deref(),
            Some("hunter two")
        );
    }

    /// Writing a CUSTOM AGENT is the user's own act; reading the list back is not.
    ///
    /// A row decides what a later `@bebou` does in a thread they opted in — which CLI
    /// starts, which model reads the thread, what instruction leads the prompt — so a
    /// client that merely found this socket must not be able to write one. Reading stays
    /// open: it returns what the user themselves made, and a page that could not read it
    /// could not draw their own agent at all.
    #[test]
    fn writing_a_custom_agent_needs_the_write_token_and_reading_one_does_not() {
        for method in ["agent_persona_save", "agent_persona_remove"] {
            let err = check_write_allowed(method, &json!({}), Some("tok")).unwrap_err().to_string();
            assert!(err.contains("write token"), "{method}: {err}");
            assert!(
                check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok()
            );
            // A read-only backend refuses them whatever token it is shown.
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), None).is_err());
            // They post nothing to Teams, so they are MACHINE methods and not outward ones.
            assert!(MACHINE_METHODS.contains(&method), "{method}");
            assert!(!OUTWARD_METHODS.contains(&method), "{method}");
        }
        for method in ["agent_status", "agent_persona_avatar"] {
            assert!(check_write_allowed(method, &json!({}), Some("tok")).is_ok(), "{method}");
            assert!(check_write_allowed(method, &json!({}), None).is_ok(), "{method}");
            assert!(!MACHINE_METHODS.contains(&method), "{method}");
        }
    }

    /// A custom agent survives a round trip through the store and comes back as something
    /// a page can draw and a trigger can match.
    #[test]
    fn a_custom_agent_is_published_with_its_address_and_its_preprompt() {
        let store = Store::open_in_memory().unwrap();
        // Nothing to begin with: a fresh machine has no custom agents, exactly as it has
        // no nicknames and no emoji.
        assert!(agent_personas_json(&store).unwrap().is_empty());

        store
            .set_agent_persona(
                &agent_persona::Persona {
                    name: "bebou".into(),
                    label: "Bebou".into(),
                    backend: &agent_policy::BACKENDS[0],
                    model: Some("haiku".into()),
                    preprompt: "/bebou".into(),
                    avatar: None,
                    added_ms: 0,
                    updated_ms: 0,
                },
                None,
                1_000,
            )
            .unwrap();

        let published = agent_personas_json(&store).unwrap();
        assert_eq!(published.len(), 1);
        let bebou = &published[0];
        assert_eq!(bebou["name"], "bebou");
        assert_eq!(bebou["label"], "Bebou");
        // The ADDRESS is stated by the backend, so no client spells `@` itself.
        assert_eq!(bebou["prefix"], "@bebou");
        assert_eq!(bebou["backend"], "claude");
        assert_eq!(bebou["model"], "haiku");
        assert_eq!(bebou["preprompt"], "/bebou");
        // No face: a client asks for bytes only when there are some.
        assert_eq!(bebou["has_avatar"], false);

        // …and the whole status carries them, which is what lets every surface that
        // already holds it offer `@bebou` with no second read.
        let status = agent_status_json(&store).unwrap();
        assert_eq!(status["personas"].as_array().map(Vec::len), Some(1));
    }

    /// Downloading and installing a new build are the user's, and only the user's.
    ///
    /// `update_apply` replaces the binary every one of their chats, mails and sends goes
    /// through, and then restarts it. A client that merely found this socket — an
    /// ad-hoc script, an automated driver — may read everything here and must not be
    /// able to do that; a read-only backend must not either, whatever token it is shown.
    #[test]
    fn updating_this_app_needs_the_write_token_and_is_refused_read_only() {
        for method in ["update_download", "update_apply"] {
            let err = check_write_allowed(method, &json!({}), Some("tok")).unwrap_err().to_string();
            assert!(err.contains("write token"), "{method}: {err}");
            assert!(
                check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok()
            );
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), None).is_err());
        }
    }

    /// The phase tags are a contract with the page: `updatePhase` in
    /// web/src/lib/protocol.ts reads exactly these six, and an unknown one leaves the
    /// button drawing nothing. So they are pinned here, spelled out, rather than derived.
    #[test]
    fn the_update_phases_are_the_six_the_page_knows() {
        let tags: Vec<&str> = [
            UpdatePhase::Idle,
            UpdatePhase::Downloading,
            UpdatePhase::Ready,
            UpdatePhase::Restarting,
            UpdatePhase::Installed,
            UpdatePhase::Failed,
        ]
        .iter()
        .map(|p| p.tag())
        .collect();
        assert_eq!(
            tags,
            ["idle", "downloading", "ready", "restarting", "installed", "failed"]
        );
    }

    /// A progress frame carries a total even before the first byte, so the bar is a bar
    /// from the start rather than a spinner that becomes one.
    #[test]
    fn a_progress_frame_states_the_whole_download() {
        let slot = UpdateSlot {
            asset: Some(teams_lite::update::Asset {
                url: "https://example/teams".into(),
                size: 1000,
            }),
            phase: UpdatePhase::Downloading,
            received: 250,
            ..UpdateSlot::default()
        };
        let payload = slot.progress_json();
        assert_eq!(payload["phase"], "downloading");
        assert_eq!(payload["received"], 250);
        assert_eq!(payload["total"], 1000);
        assert_eq!(payload["error"], "");
    }

    /// A DOWNLOAD RE-READS THE RELEASE, and never trusts the size the greeting carried.
    ///
    /// The bug this pins cost the user their only way forward: `latest` is a rolling tag,
    /// CI replaced its asset while the app was up, and the transfer was then verified
    /// against the size measured at startup. It could never match again, so the button
    /// failed every time — and the only thing it offered was to try the same stale number
    /// once more. The fetch therefore reads the release before every attempt, and it makes
    /// more than one.
    #[test]
    fn a_download_re_reads_the_release_before_every_attempt() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let fetch = code
            .split("async fn fetch_release_asset(")
            .nth(1)
            .expect("the fetch that a download runs")
            .split("\n    /// Install the downloaded build")
            .next()
            .expect("the method ends before the next one");
        assert!(
            fetch.contains("refresh_release().await"),
            "the fetch does not re-read the release. A size remembered from the startup \
             check describes an asset the rolling `latest` tag has already replaced, and a \
             transfer verified against it fails forever."
        );
        assert!(
            fetch.contains("for attempt in 1..=DOWNLOAD_ATTEMPTS"),
            "the fetch makes one attempt. The asset can be replaced mid-transfer, and the \
             second attempt — which re-reads the release — is what heals that."
        );
        assert!(DOWNLOAD_ATTEMPTS >= 2, "one attempt cannot recover a replaced asset");
        // And bounded: a download that retried forever would hide a broken release behind
        // a button that never stops trying.
        assert!(DOWNLOAD_ATTEMPTS <= 3, "a download must not retry indefinitely");
    }

    /// **A FAILED DOWNLOAD NEITHER WEDGES THE WATCH NOR RETRIES INTO THE SAME HOLE.**
    ///
    /// 2026-08-07, and this one reached the user. CI deletes the rolling `latest` release and
    /// creates it again with the asset, so the release read and the asset URL both answer 404
    /// for the length of that step. A press inside that window failed twice with NO WAIT
    /// between the attempts — the second re-read the release a millisecond later, inside the
    /// same hole — and the phase then stayed `Failed`, which every pass stood aside for: five
    /// polls and eleven minutes after `latest` was whole again this backend had still never
    /// mentioned it, and the row's only offer was retrying a build the tag had moved past.
    ///
    /// Two halves, and neither replaces the other: the wait is what rides the hole out, and
    /// the pass running while `Failed` is what heals the app when it does not.
    #[test]
    fn a_failed_download_neither_wedges_the_watch_nor_retries_into_the_same_hole() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);

        let pass = code
            .split("    async fn release_pass(")
            .nth(1)
            .expect("the release watch's own pass")
            .split("\n    /// The `update_check` RPC")
            .next()
            .expect("the pass ends before the next method");
        assert!(
            pass.contains("Ok(UpdatePhase::Idle | UpdatePhase::Failed)"),
            "the pass must run while a download has FAILED. Standing aside for it leaves \
             this backend unable to notice the release that healed seconds later — for as \
             long as the process lives."
        );
        assert!(
            pass.contains("clear_failed_update()"),
            "a pass that publishes a NEW release must take the old failure back, or the row \
             keeps offering to retry a download of a build the tag has moved past"
        );

        let fetch = code
            .split("async fn fetch_release_asset(")
            .nth(1)
            .expect("the fetch that a download runs")
            .split("\n    /// Install the downloaded build")
            .next()
            .expect("the method ends before the next one");
        assert!(
            fetch.contains("sleep(DOWNLOAD_RETRY_WAIT)"),
            "the second attempt must WAIT. With no wait it re-reads the release inside the \
             same republish window and fails identically, which is what the user saw."
        );
        // Wider than the widest republish measured (10 s), and short enough that a genuinely
        // broken release still reports while the user is looking at the button.
        assert!(
            DOWNLOAD_RETRY_WAIT >= Duration::from_secs(15),
            "a wait narrower than CI's own republish rides out nothing"
        );
        assert!(
            DOWNLOAD_RETRY_WAIT <= Duration::from_secs(60),
            "a download must report a broken release while somebody is still watching it"
        );
    }

    #[test]
    fn renaming_a_person_needs_the_write_token_and_is_refused_read_only() {
        // A client that merely found this socket must not be able to relabel who wrote
        // a message — in the sidebar, in a bubble, or in the push on the user's phone.
        for method in ["set_person_name", "set_person_avatar"] {
            let err = check_write_allowed(method, &json!({}), Some("tok")).unwrap_err().to_string();
            assert!(err.contains("write token"), "{method}: {err}");
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok());
            // Read-only refuses it even with the right token: a screenshot backend
            // must not rewrite what the user's own app says about their colleagues.
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), None).is_err());
        }
        // Reading them back is open — it returns the user's own decision.
        for method in ["person_override", "person_overrides"] {
            assert!(check_write_allowed(method, &json!({}), Some("tok")).is_ok());
        }
    }

    #[test]
    fn only_raster_images_are_accepted_as_a_custom_avatar() {
        // These bytes come back out of this app into an `<img>`, so the list is short
        // on purpose. SVG is a document, not a bitmap, and is deliberately absent.
        for good in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            assert!(PERSON_AVATAR_TYPES.contains(&good), "{good}");
        }
        for bad in ["image/svg+xml", "text/html", "application/pdf", "image/PNG", ""] {
            assert!(!PERSON_AVATAR_TYPES.contains(&bad), "{bad}");
        }
    }

    #[test]
    fn writing_the_emoji_pack_is_gated_and_reading_it_is_not() {
        for method in ["custom_emoji_add", "custom_emoji_remove", "custom_emoji_import"] {
            assert_eq!(write_class(method), Some(WriteClass::Machine), "{method} must need the write token");
            assert_ne!(machine_effect(method), "changes this machine", "{method} needs its own refusal text");
        }
        for method in ["custom_emoji", "custom_emoji_image", "custom_emoji_export"] {
            assert_eq!(write_class(method), None, "{method} returns what the user themselves put in");
        }
    }

    // A pack exported from one machine has to import into the next one WHOLE. It did not,
    // twice, and each half of this test is one of them:
    //
    //   - the export sorts by name, an alias may only name art the pack already holds, and
    //     `ship` sorts before `shipit` — so the seeded pack lost its own alias every time it
    //     made the round trip, and the refusal blamed "an alias may not point at an alias"
    //     for a target that simply was not there yet;
    //   - and every ART row was refused, because the export writes `alias_of: ""` on one and
    //     the handler read that as an alias. Nothing at all imported. This test was green
    //     through it: it decided what each row meant for itself. So it goes through
    //     `import_entry`, the decision the handler makes, and — since the missing field was
    //     the whole bug — through `export_row`, the shape the handler WRITES. It hand-rolled
    //     that mapping until this pass, which left it unable to catch a field dropped from
    //     the export at all: the half whose absence hid the original failure.
    #[test]
    fn a_pack_survives_being_exported_and_read_back() {
        // A 20x20 PNG as far as everything that reads one goes: the signature `measure_art`
        // sniffs, and the IHDR dimensions it checks against the 512 px cap.
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&20u32.to_be_bytes());
        png.extend_from_slice(&20u32.to_be_bytes());

        let from = Store::open_in_memory().unwrap();
        from.set_custom_emoji("shipit", Some(("image/png", &png, 20, 20)), None, "upload", 100)
            .unwrap();
        from.set_custom_emoji("ship", None, Some("shipit"), "upload", 101).unwrap();

        // What `custom_emoji_export` writes out, through the handler's own row builder and in
        // the order it writes them (by name, so the alias leads).
        let stored = from.custom_emoji().unwrap();
        let exported: Vec<Value> = stored
            .iter()
            .map(|e| {
                export_row(e, |_| base64::engine::general_purpose::STANDARD.encode(&png))
            })
            .collect();
        assert_eq!(exported[0]["name"], "ship", "the export leads with the alias");

        // And what the import does with it: the real ordering, and the real per-row decision.
        let into = Store::open_in_memory().unwrap();
        for entry in import_order(&exported) {
            let name = entry["name"].as_str().unwrap();
            let written = match import_entry(entry) {
                Some(ImportEntry::Alias(alias)) => {
                    into.set_custom_emoji(name, None, Some(alias), "import", 200)
                }
                Some(ImportEntry::Art(data)) => {
                    let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap();
                    let (content_type, width, height) =
                        custom_emoji::measure_art(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
                    into.set_custom_emoji(
                        name,
                        Some((content_type, &bytes, width, height)),
                        None,
                        "import",
                        200,
                    )
                }
                None => panic!("{name} asked for nothing to be written"),
            };
            written.unwrap_or_else(|e| panic!("{name} was refused: {e}"));
        }

        assert_eq!(into.custom_emoji().unwrap().len(), 2, "both rows made the trip");
        assert_eq!(
            into.custom_emoji_art("ship").unwrap().unwrap().1,
            png,
            "the alias still resolves to its target's art"
        );
    }

    // The two refusals are different problems and say so: a missing target is one the user
    // adds, a chain is one they re-point. They used to share the second sentence.
    #[test]
    fn an_alias_says_which_refusal_it_earned() {
        let store = Store::open_in_memory().unwrap();
        let missing = store
            .set_custom_emoji("ship", None, Some("shipit"), "import", 100)
            .unwrap_err()
            .to_string();
        assert!(missing.contains("already holds"), "{missing}");
        assert!(!missing.contains("point at an alias"), "{missing}");

        store
            .set_custom_emoji("shipit", Some(("image/png", &[1], 8, 8)), None, "upload", 101)
            .unwrap();
        store.set_custom_emoji("ship", None, Some("shipit"), "import", 102).unwrap();
        let chained = store
            .set_custom_emoji("s", None, Some("ship"), "import", 103)
            .unwrap_err()
            .to_string();
        assert!(chained.contains("point at an alias"), "{chained}");
    }

    #[test]
    fn a_nickname_renames_the_sender_of_a_push_notification() {
        // The phone is the one surface the user cannot correct by looking again, so a
        // rename has to reach it. `push_live_message` gets the frame that just arrived
        // rather than a row read back through the store, which is why it resolves the
        // nickname itself — this pins that the resolution and the title agree.
        let store = Store::open_in_memory().unwrap();
        store.set_person_name("8:orgid:rob", Some("Bob"), 1_000).unwrap();
        let message = Message {
            seal: Default::default(),
            id: "m1".into(),
            conversation_id: "19:dm@unq.gbl.spaces".into(),
            seq: 1,
            compose_time: 1_700_000_000_000,
            sender: "Robert SMITH".into(),
            sender_mri: "8:orgid:rob".into(),
            content: "<p>ping</p>".into(),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: "RichText/Html".into(),
            system_event: String::new(),
            thread_root_id: String::new(),
            thread_subject: String::new(),
            deleted: false,
            scheduled_time: 0,
            mentions: "[]".into(),
        };
        let renamed = store
            .person_override(&message.sender_mri)
            .unwrap()
            .map(|o| o.display_name)
            .filter(|n| !n.is_empty())
            .map(|display_name| Message { sender: display_name, ..message.clone() })
            .expect("the override is set");
        // The thread's own title goes through the same resolution, or the push would
        // read "Bob · Robert SMITH": the sender renamed, the chat it arrived in not.
        store
            .upsert_conversation_full(&teams_lite::store::ConversationUpdate {
                id: &message.conversation_id,
                display_name: "Robert SMITH",
                last_message_time: message.compose_time,
                kind: teams_lite::store::ConversationKind::OneOnOne,
                last_message_preview: "ping",
                last_message_sender: "Robert SMITH",
                last_message_sender_mri: "8:orgid:rob",
                last_message_from_me: false,
                is_read: false,
                is_muted: false,
                is_pinned: false,
                is_hidden: false,
                thread_type: "chat",
                picture_url: "",
            })
            .unwrap();
        store.insert_message(&message).unwrap();
        let context = store.conversation_context(&message.conversation_id, "8:orgid:me").unwrap();
        assert_eq!(context, "Bob");

        let notification = push_policy::notification_for(
            &renamed,
            &push_policy::Placement::Chat { title: &context },
            "8:orgid:me",
            false,
            1_700_000_000_000,
            // An unsealed message: the sealed-words setting cannot change its preview.
            false,
        )
        .expect("a chat message always notifies");
        assert!(notification.title.contains("Bob"), "{}", notification.title);
        assert!(!notification.title.contains("Robert"), "{}", notification.title);
    }

    #[test]
    fn repair_broker_passes_with_the_published_token() {
        let params = json!({ "write_token": "tok" });
        assert!(check_write_allowed("repair_broker", &params, Some("tok")).is_ok());
    }

    #[test]
    fn serving_a_sign_in_is_gated_but_is_not_outward_facing() {
        // Nothing here posts to Teams, so none of the four belongs in OUTWARD_METHODS — but
        // each is far past what a client that merely found this socket may do, so all four
        // are MACHINE methods. `signin_frame` especially: its answer is a picture of a
        // password field, which is not a read.
        for method in ["signin_start", "signin_frame", "signin_input", "signin_cancel"] {
            assert!(!OUTWARD_METHODS.contains(&method), "{method} posts nothing to Teams");
            assert_eq!(write_class(method), Some(WriteClass::Machine), "{method}");
            let err = check_write_allowed(method, &json!({}), Some("tok"))
                .expect_err("a missing token must refuse");
            assert!(err.contains("write token"), "{method}: {err}");
            let refused = check_write_allowed(method, &json!({ "write_token": "tok" }), None)
                .expect_err("read-only must refuse");
            assert!(refused.contains("read-only"), "{method}: {refused}");
            // The refusal has to say what THIS method does, or it reads as boilerplate.
            assert!(!machine_effect(method).is_empty(), "{method} has no effect sentence");
        }
        // Asking how a sign-in is going publishes nothing and presses nothing, so it stays
        // open — the reading `write_lock_status` already takes for the same reason.
        assert_eq!(write_class("signin_status"), None);
    }

    #[test]
    fn only_the_failure_a_human_can_answer_offers_a_sign_in() {
        use auth::BrokerFailure::*;
        // Measured: the broker reached AAD and AAD said `interaction_required`. That is the
        // one state where the account exists and only a person can move it on.
        assert!(failure_needs_a_human(Some(Refused)));
        // NoAccount reads like the case that needs a sign-in most, and is deliberately not
        // offered: the enrolment is what is gone, and the interactive request has nobody to
        // name. Everything else is the broker being asleep or unreachable.
        for failure in [Disconnected, Unresponsive, Unreachable, NoAccount, KeyringLocked, Other] {
            assert!(!failure_needs_a_human(Some(failure)), "{failure:?}");
            let state = auth::BrokerState {
                failure: Some(failure),
                detail: String::new(),
                consecutive_failures: 1,
                scope: teams::SKYPE_SCOPE.to_string(),
            };
            // A display that WOULD work, so the only thing deciding here is the failure.
            let ready = teams_lite::xwindow::DisplayState::Ready { display: ":77".into() };
            assert!(!can_sign_in(&state, &ready), "{failure:?}");
            assert!(signin_blocker(&state, &ready).is_empty(), "{failure:?}");
        }
        // And a healthy broker offers nothing at all.
        let ready = teams_lite::xwindow::DisplayState::Ready { display: ":77".into() };
        assert!(!can_sign_in(&auth::BrokerState::default(), &ready));
        assert!(signin_blocker(&auth::BrokerState::default(), &ready).is_empty());
        // The one that DOES offer it — and the display is what can still take it away, with the
        // reason carried in the same payload.
        let refused = auth::BrokerState {
            failure: Some(Refused),
            detail: String::new(),
            consecutive_failures: 1,
            scope: teams::SKYPE_SCOPE.to_string(),
        };
        assert!(can_sign_in(&refused, &ready));
        assert!(signin_blocker(&refused, &ready).is_empty());
        let gone = teams_lite::xwindow::DisplayState::Missing { display: ":77".into() };
        assert!(!can_sign_in(&refused, &gone));
        assert!(signin_blocker(&refused, &gone).contains(":77"));
    }

    #[test]
    fn the_idle_signin_payload_is_a_shape_rather_than_a_null() {
        // The page reads one field to decide whether to draw the panel. `null` would make
        // "no sign-in" and "a backend too old to know about sign-ins" the same answer.
        let idle = signin_idle();
        assert_eq!(idle["phase"], "idle");
        assert!(idle["window"].is_null());
        assert_eq!(idle["waited_ms"], 0);
        // The phase tags the page switches on, in both spellings, so neither side can drift.
        for phase in [
            signin::Phase::Starting,
            signin::Phase::Waiting,
            signin::Phase::Done,
            signin::Phase::Cancelled,
            signin::Phase::Failed(String::new()),
        ] {
            assert_ne!(phase.tag(), "idle", "a live phase must not read as idle");
        }
    }

    #[test]
    fn two_presses_in_the_same_instant_cannot_both_start_a_sign_in() {
        // The claim and the start are under one guard with nothing awaited between them. Two
        // presses would otherwise both pass the check, and since one interactive call is out at
        // a time (`auth::interactive_gate`), the loser would sit holding a window nobody reads.
        let whole = include_str!("server.rs");
        let source = &whole[..whole.find("\nmod tests {").unwrap_or(whole.len())];
        let start = source.find("async fn start_signin").expect("start_signin");
        let body = &source[start..];
        let lock = body.find("self.signin.lock()").expect("the claim");
        let store = body.find("*held = Some(Arc::clone(session))").expect("the store");
        assert!(lock < store, "the slot is claimed before the session is stored");
        assert!(
            !body[lock..store].contains(".await"),
            "nothing may be awaited between claiming the slot and storing the session"
        );
    }

    #[test]
    fn a_sign_in_acquires_the_scope_the_app_is_broken_on() {
        // Not the caller's choice: a client naming a scope would be choosing what this machine
        // authenticates for. With nothing recorded — a healthy broker, or a build that never
        // stored one — it falls back to the scope every live feature needs.
        assert_eq!(Ctx::signin_scope(), teams::SKYPE_SCOPE);
        assert!(Ctx::signin_scope().contains("api.spaces.skype.com"));
        // And what it really reads is the scope the failure was recorded against, because a
        // refusal is per resource: a sign-in for the wrong one would mint a token, clear the
        // state and report success over a feature still dark.
        let whole = include_str!("server.rs");
        let source = &whole[..whole.find("\nmod tests {").unwrap_or(whole.len())];
        let at = source.find("fn signin_scope()").expect("signin_scope");
        let body = &source[at..at + source[at..].find("\n    }").unwrap_or(0)];
        assert!(body.contains("broker_state()"), "the recorded scope decides: {body}");
    }

    #[test]
    fn read_only_mode_refuses_repair_broker_even_with_a_correct_token() {
        // Tooling never repairs the user's sign-in: restarting their container drops
        // the broker, and every session that depends on it, for about a minute.
        let params = json!({ "write_token": "tok" });
        let err = check_write_allowed("repair_broker", &params, None)
            .expect_err("read-only must refuse a repair");
        assert!(err.contains("read-only"), "{err}");
    }

    #[test]
    fn read_only_mode_refuses_even_a_correct_token() {
        let params = json!({ "conversation": "c1", "write_token": "tok" });
        let err = check_write_allowed("send", &params, None).expect_err("read-only must refuse");
        assert!(err.contains("read-only"), "{err}");
    }

    #[test]
    fn read_only_listens_on_its_own_port_so_it_never_takes_the_real_one() {
        assert_eq!(resolve_port(None, false), DEFAULT_PORT);
        assert_eq!(resolve_port(None, true), READ_ONLY_PORT);
        assert_ne!(READ_ONLY_PORT, DEFAULT_PORT);
    }

    #[test]
    fn an_explicit_port_wins_over_both_defaults() {
        assert_eq!(resolve_port(Some("8500"), true), 8500);
        assert_eq!(resolve_port(Some(" 8500 "), false), 8500);
        // Junk falls back to the mode's default rather than panicking.
        assert_eq!(resolve_port(Some("nope"), false), DEFAULT_PORT);
        assert_eq!(resolve_port(Some("0"), true), READ_ONLY_PORT);
    }

    /// The live feed follows the ENDPOINT ID, and a second registration of one id
    /// replaces the first — so two backends on this machine must never derive the same
    /// id from the store they share. They did: the released build (19422) took the feed
    /// from the staged service (19420), and the user's own app stopped showing a message
    /// until the page was reloaded. Reads never noticed, which is what made it invisible.
    #[test]
    fn each_backend_registers_a_messaging_endpoint_of_its_own() {
        let db = "/home/u/.local/share/teams-lite/teams-lite.sqlite";
        let staged = endpoint_id_path(db, DEFAULT_PORT, "");
        let released = endpoint_id_path(db, 19422, "");
        let read_only = endpoint_id_path(db, READ_ONLY_PORT, "");
        assert_ne!(staged, released, "two backends must not share one endpoint id");
        assert_ne!(staged, read_only, "a read-only backend must not take the user's feed");
        assert_ne!(released, read_only);

        // Every port is named, the default one included: a build sharing this machine may
        // predate this fix and still hold the unqualified `teams-lite.epid`, and a backend
        // that kept that name would keep losing its feed to it.
        assert_eq!(staged.file_name().unwrap(), "teams-lite.19420.epid");
        assert_eq!(released.file_name().unwrap(), "teams-lite.19422.epid");

        // A worker is an endpoint too: the calling registration is its own, per backend.
        assert_eq!(
            endpoint_id_path(db, DEFAULT_PORT, "calling").file_name().unwrap(),
            "teams-lite.19420.calling-epid"
        );
        for port in [DEFAULT_PORT, 19422, READ_ONLY_PORT] {
            assert_ne!(
                endpoint_id_path(db, port, ""),
                endpoint_id_path(db, port, "calling"),
                "messaging and calling are two endpoints"
            );
        }
    }

    /// A live frame reaches the pages of the backend that RECEIVED it, whether or not
    /// that backend was the one that wrote the row. Two backends share one store, so
    /// "somebody already inserted it" says nothing about what our own clients have seen
    /// — gating the broadcast on the insert left the loser of that race silent.
    #[test]
    fn a_live_message_is_broadcast_even_when_another_backend_stored_it_first() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let task = code
            .split("// consume trouter messages: persist + broadcast.")
            .nth(1)
            .expect("the live-message task")
            .split("// trouter status -> event")
            .next()
            .expect("the task ends before the status one");

        let emit_at = task.find("emit(\"message\"").expect("the task broadcasts a message");
        let push_at = task.find("push_live_message(").expect("the task pushes");
        assert!(
            !task.contains("if inserted || reacted.is_some() {"),
            "the message broadcast is gated on this process having written the row. Two \
             backends share one store, so the one that loses the insert by a millisecond \
             would show its own pages nothing until a reload."
        );
        // Push and the agent trigger stay behind the insert: those are per-machine
        // actions, and the backend that stored the message has already taken them.
        assert!(emit_at < push_at, "the broadcast must not sit inside the insert-only branch");
        assert!(
            task[emit_at..].contains("if inserted {"),
            "a push (and an agent answer) must still happen only on a fresh insert"
        );
    }

    #[test]
    fn minted_tokens_are_long_and_unique() {
        let (a, b) = (mint_write_token(), mint_write_token());
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// The write lock covers the LOCAL store too: a read-only backend is the one
    /// tooling may start against the user's real database, while the user's own
    /// backend is live on it, so it must not run the row-rewriting cleanups.
    #[test]
    fn read_only_prepare_store_never_rewrites_message_rows() {
        let mut path = std::env::temp_dir();
        path.push(format!("teams-lite-prepare-{}.sqlite", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = path.to_str().unwrap();

        // A stored control frame: exactly what the cleanups delete.
        {
            let store = Store::open(db).unwrap();
            store.upsert_conversation("c1", "Chat", 1).unwrap();
            let mut junk = message(1);
            junk.content = "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:x".into();
            store.insert_message(&junk).unwrap();
        }

        prepare_store(db, false).unwrap();
        {
            let store = Store::open(db).unwrap();
            assert_eq!(
                store.newest_messages("c1", 10).unwrap().len(),
                1,
                "read-only mode must leave the user's rows exactly as they are"
            );
            assert!(
                store.cleanups_pending().unwrap(),
                "...and must not claim the cleanup revision, so the user's own backend still heals"
            );
        }

        // The user's own (write-capable) backend does run them.
        prepare_store(db, true).unwrap();
        {
            let store = Store::open(db).unwrap();
            assert!(store.newest_messages("c1", 10).unwrap().is_empty());
            assert!(!store.cleanups_pending().unwrap());
        }
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    fn message(seq: i64) -> Message {
        Message {
            seal: Default::default(),
            id: format!("m{seq}"),
            conversation_id: "c1".into(),
            seq,
            compose_time: seq,
            sender: "Alice".into(),
            sender_mri: String::new(),
            content: format!("message {seq}"),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            scheduled_time: 0,
            mentions: "[]".into(),
        }
    }

    #[test]
    fn call_capture_line_is_one_self_describing_json_object_per_line() {
        let body = json!({ "evt": "callInvite", "callId": "abc", "from": { "displayName": "Riley" } });
        let line = call_capture_line(1234, "https://x.trouter/NGCallManagerWin", "abc", &body);

        // Exactly one line, newline-terminated (so several frames append cleanly).
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);

        // Round-trips to the {ts_ms, url, call_id, body} envelope with body intact.
        let parsed: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(parsed["ts_ms"], 1234);
        assert_eq!(parsed["url"], "https://x.trouter/NGCallManagerWin");
        assert_eq!(parsed["call_id"], "abc");
        assert_eq!(parsed["body"]["from"]["displayName"], "Riley");
    }

    #[test]
    fn reactions_value_aggregates_count_and_mine() {
        let mut m = message(1);
        m.reactions = r#"[
            {"key":"like","users":[{"mri":"8:me","time":1},{"mri":"8:other","time":2}]},
            {"key":"heart","users":[]}
        ]"#
        .into();

        let v = reactions_value(&m, "8:me", None);
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1, "the empty-user 'heart' emotion is dropped");
        assert_eq!(arr[0]["key"], "like");
        assert_eq!(arr[0]["count"], 2);
        assert_eq!(arr[0]["mine"], true);

        // `mine` is false when our MRI is not among the reactors
        let v = reactions_value(&m, "8:someone_else", None);
        assert_eq!(v.as_array().unwrap()[0]["mine"], false);
    }

    /// A chip has to be able to say WHOSE emoji it is, and the name it says is the one
    /// ladder every other surface uses — so a colleague the user RENAMED is named here
    /// exactly as they are above their own bubbles.
    #[test]
    fn a_reaction_names_the_people_behind_it_through_the_one_name_ladder() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_conversation("c1", "Chat", 0).unwrap();
        let mut wrote = message(1);
        wrote.sender = "Ada Lovelace".into();
        wrote.sender_mri = "8:orgid:ada".into();
        store.insert_message(&wrote).unwrap();

        let mut m = message(2);
        m.reactions = r#"[{"key":"like","users":[
            {"mri":"8:orgid:ada","time":1},
            {"mri":"8:me","time":2},
            {"mri":"8:orgid:stranger","time":3}
        ]}]"#
            .into();

        let users = |store: Option<&Store>| reactions_value(&m, "8:me", store)[0]["users"].clone();

        // In the order Teams listed them, each entry saying whether it is ours — the
        // page reads that to say "You", and the aggregate `mine` cannot say which name.
        let v = users(Some(&store));
        assert_eq!(v[0], json!({ "name": "Ada Lovelace", "mine": false }));
        assert_eq!(v[1]["mine"], true);
        // Somebody this machine has never seen write is carried NAMELESS rather than
        // dropped: the page counts them, and a chip of 3 over two names reads as a bug.
        assert_eq!(v[2], json!({ "name": "", "mine": false }));

        // The user's own name for them wins, here as everywhere else.
        store.set_person_name("8:orgid:ada", Some("Ada"), 1).unwrap();
        assert_eq!(users(Some(&store))[0]["name"], "Ada");

        // With no store there are no names, which is the same shape as the stranger
        // above — never a missing field the page would have to guess at.
        let v = users(None);
        assert_eq!(v[0], json!({ "name": "", "mine": false }));
        assert_eq!(v.as_array().unwrap().len(), 3);
    }

    #[test]
    fn mentions_ride_the_wire_as_a_decoded_list() {
        let mut m = message(1);
        m.mentions =
            r#"[{"itemid":0,"mri":"8:orgid:leonor","kind":"person","display_name":"Leonor"}]"#.into();
        let v = message_json(&m, "Alice", "8:me", None);
        assert_eq!(v["mentions"][0]["itemid"], 0);
        assert_eq!(v["mentions"][0]["mri"], "8:orgid:leonor");
        assert_eq!(v["mentions"][0]["kind"], "person");

        // A message with none, and a row whose value is unusable, both serialize
        // as an empty list — never as a string, and never as an error.
        assert_eq!(message_json(&message(2), "Alice", "8:me", None)["mentions"], json!([]));
        let mut broken = message(3);
        broken.mentions = "{not json".into();
        assert_eq!(message_json(&broken, "Alice", "8:me", None)["mentions"], json!([]));
    }

    /// An EDIT must carry the post's TITLE, and read it from THIS machine's store.
    ///
    /// Measured against the tenant (2026-08-23, `examples/channel_subject_probe.rs`): the
    /// service ASSIGNS `properties` on an edit, so an edit that restates nothing deletes the
    /// title — the line above the body gone for everybody in the thread, on a rewrite of one
    /// word, with nothing anywhere saying so. It comes from the store rather than from the
    /// client because an edit must not be able to RETITLE a post either.
    #[test]
    fn editing_a_titled_post_carries_its_title_from_the_store() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let handler = code.split("\"edit\" => {").nth(1).expect("the edit handler");
        let handler = handler.split("\"react\" => {").next().expect("it ends at the next arm");
        assert!(
            handler.contains("get_message") && handler.contains("thread_subject"),
            "the edit handler must read the message's own stored title, or a rewrite \
             deletes the title of every titled post."
        );
        assert!(
            handler.contains("subject.as_deref()"),
            "the title has to reach `edit_message`; read from the store and dropped on the \
             floor is the same silent loss."
        );
    }

    /// An EDIT may carry a RICH BODY, and it changes nothing else about the edit.
    ///
    /// A game of chess keeps one player's whole record in one message and rewrites it on every
    /// move (see web/src/lib/chess-wire.ts), and that record is a paragraph plus the signed line
    /// the other machine reads back. Escaped as plain text — which is all this handler took — the
    /// line came back as characters rather than as a line, so the game stopped replaying: the
    /// message was still there and every reader had lost the board.
    ///
    /// It is the same trust boundary `send` already draws, and this test is about the three
    /// things that must NOT have moved with it.
    #[test]
    fn an_edit_may_carry_a_rich_body_and_nothing_else_changed() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let handler = code.split("\"edit\" => {").nth(1).expect("the edit handler");
        let handler = handler.split("\"react\" => {").next().expect("it ends at the next arm");
        assert!(
            handler.contains("content_html"),
            "the edit has to take the rich body, or a message whose body is markup cannot be \
             rewritten at all."
        );
        assert!(
            handler.contains("escape_html"),
            "and it still escapes a PLAIN text edit, which is every other edit in the app."
        );
        // The three rails that did not move.
        assert!(
            handler.contains("&[],"),
            "an edit still carries NO mention list: the composer's mentions travel on the send."
        );
        assert!(
            handler.contains("subject.as_deref()"),
            "it still restates the post's own title, read from the store."
        );
        assert!(
            handler.contains("seal_key.as_ref()"),
            "and it is still SEALED where the chat is sealed — fail-closed, exactly as the send \
             is: a rewrite that went out in the clear would publish the words of a message the \
             reader had sealed."
        );
    }

    #[test]
    fn whether_a_message_mentions_the_user_rides_the_wire() {
        // The page applies the user's own per-channel notification setting, and
        // "mentions only" is Teams' default — so it has to know whether a post named
        // them. It cannot work that out: it never learns their MRI, and the body's span
        // carries a display name two colleagues may share. This is the answer, resolved
        // by the same function the push policy reads.
        let mut m = message(1);
        m.mentions =
            r#"[{"itemid":0,"mri":"8:me","kind":"person","display_name":"Alice"}]"#.into();
        assert_eq!(message_json(&m, "Alice", "8:me", None)["mentions_me"], true);
        assert_eq!(
            message_json(&m, "Bob", "8:someone_else", None)["mentions_me"],
            false,
            "a mention of somebody else is not one of ours"
        );

        // A message that mentions nobody, and a row whose list is unusable, both say
        // false rather than nothing — the page reads an ABSENT field as "not known".
        assert_eq!(message_json(&message(2), "Alice", "8:me", None)["mentions_me"], false);
        let mut broken = message(3);
        broken.mentions = "{not json".into();
        assert_eq!(message_json(&broken, "Alice", "8:me", None)["mentions_me"], false);
    }

    #[test]
    fn the_message_type_rides_the_wire() {
        // The front-end needs the Teams type verbatim to know a `Text` body is plain
        // text and must be escaped, not parsed as HTML.
        let mut m = message(1);
        m.message_type = "Text".into();
        m.content = "pour moi c'est <yyyy>-<id>".into();
        let v = message_json(&m, "Alice", "8:me", None);
        assert_eq!(v["message_type"], "Text");
        assert_eq!(v["content"], "pour moi c'est <yyyy>-<id>", "the body is not rewritten");

        // A legacy row carries an empty type — "unknown", not a guess.
        assert_eq!(message_json(&message(2), "Alice", "8:me", None)["message_type"], "");
    }

    #[test]
    fn presence_params_accept_one_or_many_and_refuse_the_rest() {
        // A single mri, or a batch.
        assert_eq!(
            presence_mris(&json!({ "mri": "8:orgid:aaa" })).unwrap(),
            vec!["8:orgid:aaa".to_string()]
        );
        assert_eq!(
            presence_mris(&json!({ "mris": ["8:orgid:aaa", "8:orgid:bbb"] })).unwrap().len(),
            2
        );
        // A thread/channel mri is not a person: refused before it reaches the
        // presence service, as is an empty or over-large batch.
        assert!(presence_mris(&json!({ "mri": "19:abc@thread.tacv2" })).is_err());
        assert!(presence_mris(&json!({ "mris": [] })).is_err());
        assert!(presence_mris(&json!({})).is_err());
        let too_many: Vec<String> = (0..teams_presence::MAX_BATCH + 1)
            .map(|i| format!("8:orgid:{i}"))
            .collect();
        assert!(presence_mris(&json!({ "mris": too_many })).is_err());
    }

    #[test]
    fn profile_and_presence_serialize_every_card_field() {
        let p = teams_profiles::Profile {
            mri: "8:orgid:aaa".into(),
            display_name: "Ada LOVELACE".into(),
            job_title: "Analyst".into(),
            email: "ada@example.com".into(),
            office_location: "London".into(),
            ..Default::default()
        };
        let v = profile_json(&p);
        assert_eq!(v["found"], true);
        assert_eq!(v["display_name"], "Ada LOVELACE");
        assert_eq!(v["job_title"], "Analyst");
        assert_eq!(v["email"], "ada@example.com");
        assert_eq!(v["office_location"], "London");
        // Unreported fields are present but empty, so the UI can just skip them.
        assert_eq!(v["department"], "");

        let pres = teams_presence::Presence {
            mri: "8:orgid:aaa".into(),
            availability: "Busy".into(),
            activity: "InAMeeting".into(),
            last_active_ms: 1_700_000_000_000,
            out_of_office: true,
            out_of_office_note: "Back Monday".into(),
            note: "Heads down".into(),
        };
        let v = presence_json(&pres);
        assert_eq!(v["availability"], "Busy");
        assert_eq!(v["activity"], "InAMeeting");
        assert_eq!(v["last_active_ms"], 1_700_000_000_000i64);
        assert_eq!(v["out_of_office"], true);
        assert_eq!(v["out_of_office_note"], "Back Monday");
        assert_eq!(v["note"], "Heads down");
    }

    #[test]
    fn system_event_rides_the_wire_only_for_events() {
        // A normal chat message carries a null system_event on the wire.
        let chat = message(1);
        assert!(message_json(&chat, "Alice", "8:me", None)["system_event"].is_null());

        // A call event serializes its structured payload for the UI to render.
        let mut call = message(2);
        call.content = String::new();
        call.system_event =
            r#"{"kind":"call","event":"ended","duration_seconds":600,"participant_count":5,"participants":["A"]}"#
                .into();
        let v = message_json(&call, "Alice", "8:me", None);
        assert_eq!(v["system_event"]["kind"], "call");
        assert_eq!(v["system_event"]["event"], "ended");
        assert_eq!(v["system_event"]["duration_seconds"], 600);
        assert_eq!(v["content"], "");
    }

    fn call_message(event: &str) -> Message {
        let mut m = message(2);
        m.sender = "Bob".into();
        m.sender_mri = "8:orgid:bob".into();
        m.content = String::new();
        m.system_event = format!(
            r#"{{"kind":"call","event":"{event}","duration_seconds":0,"participant_count":2,"participants":["Bob","Alice"]}}"#
        );
        m
    }

    #[test]
    fn call_started_from_other_rings() {
        let m = call_message("started");
        let v = call_event_json(&m, "Alice", "8:orgid:me").expect("a started call rings");
        assert_eq!(v["event"], "started");
        assert_eq!(v["conversation_id"], "c1");
        assert_eq!(v["caller"], "Bob");
        assert_eq!(v["caller_mri"], "8:orgid:bob");
        assert_eq!(v["participant_count"], 2);
        assert_eq!(v["participants"][0], "Bob");
    }

    #[test]
    fn call_started_from_self_is_not_rung() {
        // We started the call, so the `started` frame carries us as the sender:
        // teams-lite must not ring us for our own outgoing call.
        let mut m = call_message("started");
        m.sender_mri = "8:orgid:me".into();
        assert!(call_event_json(&m, "Alice", "8:orgid:me").is_none());
    }

    #[test]
    fn meeting_call_marker_does_not_ring() {
        // A meeting-thread call marker is surfaced as a "Call started" line, but it
        // must never raise the incoming-call banner: it has no caller identity and
        // can arrive in backfill. Even from another member it is silent.
        let mut m = call_message("started");
        m.system_event =
            r#"{"kind":"call","event":"started","duration_seconds":0,"participant_count":0,"participants":[],"meeting":true}"#
                .into();
        assert!(call_event_json(&m, "Alice", "8:orgid:me").is_none());
    }

    #[test]
    fn call_ended_dismisses_even_from_self() {
        // Dismissal is keyed by conversation, so an `ended`/`missed` frame is
        // surfaced regardless of who ended it (it only clears a banner).
        let mut m = call_message("ended");
        m.sender_mri = "8:orgid:me".into();
        let v = call_event_json(&m, "Alice", "8:orgid:me").expect("ended clears the banner");
        assert_eq!(v["event"], "ended");

        let missed = call_message("missed");
        assert_eq!(
            call_event_json(&missed, "Alice", "8:orgid:me").unwrap()["event"],
            "missed"
        );
    }

    #[test]
    fn non_call_messages_yield_no_call_event() {
        // A plain chat message (empty system_event) is not a call.
        assert!(call_event_json(&message(1), "Alice", "8:orgid:me").is_none());

        // A non-call system event (e.g. a member change) is not a call either.
        let mut other = message(3);
        other.system_event = r#"{"kind":"member_added","members":["X"]}"#.into();
        assert!(call_event_json(&other, "Alice", "8:orgid:me").is_none());
    }

    #[test]
    fn channels_json_carries_team_grouping_and_read_state() {
        let store = Store::open_in_memory().unwrap();
        store
            .upsert_channel_full(&teams_lite::store::ChannelUpdate {
                id: "19:general@thread.tacv2",
                team_id: "19:team@thread.tacv2",
                team_name: "Engineering",
                team_group_id: "00000000-1111-2222-3333-444444444444",
                display_name: "General",
                is_general: true,
                is_shown: true,
                is_pinned: false,
                team_collapsed: false,
                last_message_time: 1_700_000_000_000,
                last_message_preview: "Ship it",
                last_message_sender: "Alice",
                last_message_sender_mri: "8:orgid:alice",
                last_message_from_me: false,
                is_read: false,
                alerts: teams_lite::store::ChannelAlerts::MentionsOnly,
                team_pos: 0,
                channel_pos: 0,
            })
            .unwrap();

        let v = channels_json(&store.channels().unwrap());
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        let c = &arr[0];
        assert_eq!(c["id"], "19:general@thread.tacv2");
        assert_eq!(c["team_id"], "19:team@thread.tacv2");
        assert_eq!(c["team_name"], "Engineering");
        assert_eq!(c["team_group_id"], "00000000-1111-2222-3333-444444444444");
        assert_eq!(c["name"], "General");
        assert_eq!(c["is_general"], true);
        assert_eq!(c["last_message_preview"], "Ship it");
        assert_eq!(c["last_message_sender"], "Alice");
        assert_eq!(c["is_read"], false);
    }

    #[test]
    fn cached_history_is_served_in_exact_pages_before_network() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_conversation("c1", "Chat", 100).unwrap();
        for seq in 1..=100 {
            store.insert_message(&message(seq)).unwrap();
        }
        store.set_oldest_cursor("c1", Some("1"), false).unwrap();

        let (initial, has_more) = newest_history_page(&store, "c1").unwrap();
        assert_eq!(initial.len(), 40);
        assert_eq!(initial.first().unwrap().seq, 61);
        assert_eq!(initial.last().unwrap().seq, 100);
        assert!(has_more);

        let (page, has_more) = cached_history_page(&store, "c1", 101).unwrap();
        assert_eq!(page.len(), 40);
        assert_eq!(page.first().unwrap().seq, 61);
        assert_eq!(page.last().unwrap().seq, 100);
        assert!(has_more);

        let (last_page, has_more) = cached_history_page(&store, "c1", 21).unwrap();
        assert_eq!(last_page.len(), 20);
        assert_eq!(last_page.first().unwrap().seq, 1);
        assert!(!has_more);
    }

    #[test]
    fn parses_reply_metadata_from_send_params() {
        let reply = parse_reply_to(&json!({
            "compose_time": 1_784_279_090_040_i64,
            "sender": "Alice",
            "sender_mri": "8:orgid:abc-123",
            "preview": "Original message",
            "before": "Draft before",
            "after": "Draft after"
        }))
        .unwrap();

        assert_eq!(reply.compose_time, 1_784_279_090_040);
        assert_eq!(reply.sender, "Alice");
        assert_eq!(reply.sender_mri, "8:orgid:abc-123");
        assert_eq!(reply.preview, "Original message");
        assert_eq!(reply.before, "Draft before");
        assert_eq!(reply.after, "Draft after");
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn active_clients_always_keep_server_alive() {
        assert!(!should_shutdown(1, true, Duration::from_secs(60)));
        assert!(!should_shutdown(2, false, Duration::from_secs(60)));
    }

    #[test]
    fn server_waits_longer_for_its_first_client() {
        assert!(!should_shutdown(
            0,
            false,
            INITIAL_CLIENT_GRACE - Duration::from_millis(1)
        ));
        assert!(should_shutdown(0, false, INITIAL_CLIENT_GRACE));
    }

    #[test]
    fn disconnected_server_exits_after_short_grace() {
        assert!(!should_shutdown(
            0,
            true,
            DISCONNECTED_CLIENT_GRACE - Duration::from_millis(1),
        ));
        assert!(should_shutdown(0, true, DISCONNECTED_CLIENT_GRACE));
    }

    #[test]
    fn no_idle_exit_flag_parsing() {
        // Present + truthy (any non-falsey value) disables idle shutdown.
        for on in ["1", "true", "TRUE", "yes", "on", " 1 ", "anything"] {
            assert!(env_flag_enabled(Some(on)), "{on:?} should enable");
        }
        // Absent or an explicit falsey token keeps the orphan safety net.
        for off in ["", "0", "false", "FALSE", "no", "off", "  "] {
            assert!(!env_flag_enabled(Some(off)), "{off:?} should stay off");
        }
        assert!(!env_flag_enabled(None));
    }

    #[tokio::test]
    async fn disabled_idle_watcher_never_shuts_down() {
        // With idle-exit disabled (TEAMS_NO_IDLE_EXIT), the watcher must never
        // resolve, even with no clients ever connected — only a signal stops the
        // process. A short timeout is enough: the future pends immediately.
        let clients = ClientTracker::new();
        let res = tokio::time::timeout(
            Duration::from_millis(200),
            wait_for_idle_shutdown(clients, true),
        )
        .await;
        assert!(res.is_err(), "keep-alive watcher must stay pending forever");
    }

    #[test]
    fn client_lease_tracks_connection_lifetime() {
        let tracker = ClientTracker::new();
        assert_eq!(tracker.snapshot().0, 0);
        assert!(!tracker.snapshot().1);

        {
            let _lease = tracker.connect();
            assert_eq!(tracker.snapshot().0, 1);
            assert!(tracker.snapshot().1);
        }

        assert_eq!(tracker.snapshot().0, 0);
    }

    // ---- mail (read-only Outlook surface) ----------------------------------

    /// No mail method may ever join the write lock's list — not because mail writes
    /// are gated, but because none exists. If someone adds one, this test is where
    /// they have to come and think about it (and about consent) first.
    #[test]
    fn no_mail_method_is_outward_facing() {
        for method in OUTWARD_METHODS {
            assert!(
                !method.starts_with("mail"),
                "`{method}` suggests the mail surface can act outward. It cannot: the backend \
                 has no send/reply/delete/move path at all (see src/mail.rs). Adding one is a \
                 deliberate feature needing its own consent gate."
            );
        }
        // No mail method needs the token: every one of them reads the mailbox, and
        // `mail_mark_read` — the only one that writes anything — writes one column of
        // our own mirror, which nobody but the user ever sees.
        for method in [
            "mail_folders",
            "mail_list",
            "mail_backfill",
            "mail_body",
            "mail_attachment",
            "mail_mark_read",
        ] {
            assert!(check_write_allowed(method, &json!({}), Some("tok")).is_ok(), "{method}");
            assert!(check_write_allowed(method, &json!({}), None).is_ok(), "{method}");
            assert!(!MACHINE_METHODS.contains(&method), "{method}");
        }
    }

    /// The local read mark must stay local. Graph exposes marking a message read as a
    /// PATCH of `isRead` on the message, and the token this app holds carries
    /// `Mail.ReadWrite` — so the only thing between `mail_mark_read` and the user's
    /// phone clearing its own marker is that no code names that write. Read receipts
    /// on a mail are somebody else's business: publishing one is a deliberate
    /// feature, with its own consent gate.
    #[test]
    fn marking_a_mail_read_never_names_a_graph_write() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let handler = code
            .split("\"mail_mark_read\" =>")
            .nth(1)
            .expect("the mail_mark_read handler")
            .split("\"mail_attachment\" =>")
            .next()
            .expect("the handler ends at the next arm");
        assert!(handler.contains("mark_mail_read_locally"), "scanned the wrong text");
        for named in ["retry_graph", "isRead", "graph.microsoft.com", "http"] {
            assert!(
                !handler.contains(named),
                "the mail_mark_read handler names `{named}`. It must write our own mirror and \
                 nothing else: the mailbox is read-only, and telling Graph a mail was read \
                 clears the marker on every device the user owns."
            );
        }
    }

    // A `send` POSTs a message and Teams gives it no idempotency key, so a retry after a
    // lost answer is a SECOND message in the thread — under the user's name, in front of
    // everybody in it, and nothing takes it back. It reached a real reader as one Enter
    // producing several copies. There is no line this could be enforced by, so the arm is
    // scanned: it must name the policy that retries a refused CREDENTIAL and nothing else.
    #[test]
    fn a_send_is_never_retried_after_an_answer_it_lost() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let handler = code
            .split("\"send\" =>")
            .nth(1)
            .expect("the send handler")
            .split("\"edit\" =>")
            .next()
            .expect("the handler ends at the next arm");
        assert!(handler.contains("teams_send::send_message"), "scanned the wrong text");
        assert!(
            handler.contains("retry::RetryPolicy::auth_only()"),
            "the send handler must run under `RetryPolicy::auth_only()`. The default policy \
             retries a timeout, a reset connection and a 5xx — every one of which means the \
             ANSWER was lost, never that Teams refused the message, so the retry posts it again."
        );
        // The default policy reaches the same code path through the sibling that names no
        // policy at all, so the bare call is what must not come back here.
        assert!(
            !handler.contains(".retry_on_auth("),
            "the send handler names `retry_on_auth(`, which is the DEFAULT policy — the one \
             that retries a transient failure. Use `retry_on_auth_with(RetryPolicy::auth_only())`."
        );
    }

    // Every GitLab payload the page is handed must say who its people are in Teams, or the
    // one answer that forgot is the one surface where a colleague reads as a stranger — and
    // it must be said AFTER the response cache, since `gitlab_reads` outlives a rename (see
    // AGENTS.md § A GitLab user who is also a colleague). Both halves are scanned, because
    // there is no single line either could be enforced by.
    #[test]
    fn every_gitlab_answer_names_its_people_and_never_the_cache() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        // The two places a read leaves the backend: the handler's own answer, and the event a
        // refresh behind the page broadcasts.
        for (function, ends_at, anchor) in [
            ("async fn gitlab_cached(", "/// How long a folded roster", "store.gitlab_read"),
            (
                "async fn gitlab_refresh_behind_the_page(",
                "/// Drop everything cached about",
                "gitlab_refreshing",
            ),
        ] {
            let body = code
                .split(function)
                .nth(1)
                .unwrap_or_else(|| panic!("{function} is gone"))
                .split(ends_at)
                .next()
                .expect("the function ends before the next item");
            assert!(body.contains(anchor), "scanned the wrong text for {function}");
            assert!(
                body.contains("with_teams_people"),
                "`{function}` no longer names `with_teams_people`, so the page would draw \
                 GitLab's own name for a colleague this app already knows."
            );
        }
        // And the four answers that carry people without going through those two.
        for (arm, anchor) in [
            ("\"enrich_link\" =>", "link_preview::enrich"),
            ("\"gitlab_approvals\" =>", "gitlab_approval::fetch"),
            ("\"gitlab_set_approval\" =>", "gitlab_approval::set"),
            ("\"gitlab_mr_comment\" =>", "gitlab_mr_write::comment"),
        ] {
            let handler = code
                .split(arm)
                .nth(1)
                .unwrap_or_else(|| panic!("{arm} is gone"))
                .split("        \"")
                .next()
                .expect("the arm ends at the next one");
            assert!(handler.contains(anchor), "scanned the wrong text for {arm}");
            assert!(
                handler.contains("with_teams_people"),
                "the {arm} answer names people and no longer names `with_teams_people`."
            );
        }
        // The cache keeps GITLAB'S OWN words: an identity written into it would outlive the
        // rename that changed it, on disk, across restarts.
        let cache = code
            .split("async fn gitlab_fetch_and_cache(")
            .nth(1)
            .expect("the caching read")
            .split("/// Refresh one read behind the page")
            .next()
            .expect("the function ends before the next item");
        assert!(cache.contains("put_gitlab_read"), "scanned the wrong text for the cache write");
        assert!(
            !cache.contains("with_teams_people"),
            "`gitlab_fetch_and_cache` names `with_teams_people`, so a Teams name would be \
             stored in `gitlab_reads` and served back after the user changed it."
        );
    }

    // The one method that requests something from a server nobody here configured. Its
    // handler must reach the store BEFORE the network, must reduce the domain first, and
    // must never carry anything about the mail — so the scan looks for both the rails
    // that have to be there and the things that must not.
    #[test]
    fn the_sender_icon_handler_checks_every_rail_before_the_network() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let handler = code
            .split("\"sender_icon\" =>")
            .nth(1)
            .expect("the sender_icon handler")
            .split("\"set_draft\" =>")
            .next()
            .expect("the handler ends at the next arm");
        assert!(handler.contains("fetch_icon"), "scanned the wrong text");
        for rail in [
            "registrable_domain",  // a per-recipient subdomain never reaches the wire
            "is_fetchable_domain", // nor does anything that is not a public domain
            "store.sender_icon",   // asked once per organisation, ever
            "read_only()",         // an automation touches no stranger's server
            "sender_icons_enabled", // and the user can turn it off
        ] {
            assert!(
                handler.contains(rail),
                "the sender_icon handler no longer names `{rail}`. Every one of those is a \
                 rail between a hostile mail and a request made on the user's behalf — see \
                 the header of src/sender_icon.rs."
            );
        }
        // The fetch is of a DOMAIN. Anything about the mail or the reader in it would
        // turn a favicon into the tracking pixel `mail_html` strips out of the body.
        for named in ["message_id", "\"address\"", "mail_body", "recipient"] {
            assert!(
                !handler.contains(named),
                "the sender_icon handler names `{named}`. The request must carry the \
                 organisation's domain and nothing else."
            );
        }
    }

    // The two ways bytes reach the pack from the network must never cross, and the check
    // has to be able to TELL them apart: read whole, the handler names both fetches and
    // says nothing about which branch calls which — so sending a pasted `url` into
    // `teams_media::fetch_media`, the exact mistake made once during this build, would
    // still pass. So each branch is scanned on its own.
    //
    // A STRANGER's URL goes through `sender_icon::fetch_raster`, which carries every rail
    // the sender-icon fetch does — public-IP-only resolution, a raster sniff on the bytes,
    // a byte cap, no cookie or referrer. A TEAMS URL goes through the authenticated
    // `teams_media::fetch_media`, which is host-allowlisted. Crossed over, a Teams URL
    // simply fails, and a stranger's URL takes the user's token off-tenant.
    #[test]
    fn each_emoji_fetch_branch_names_its_own_path_and_not_the_other() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let handler = code
            .split("\"custom_emoji_add\" =>")
            .nth(1)
            .expect("the custom_emoji_add handler")
            .split("\"custom_emoji_remove\" =>")
            .next()
            .expect("the handler ends at the next arm");

        // The branches, in the order the handler writes them: an alias, a stranger's URL,
        // a Teams media URL, then raw bytes.
        let url_branch = handler
            .split("} else if let Some(url) = url {")
            .nth(1)
            .expect("the url branch")
            .split("} else if let Some(media_url) = media_url {")
            .next()
            .expect("the url branch ends at the media_url one");
        let media_branch = handler
            .split("} else if let Some(media_url) = media_url {")
            .nth(1)
            .expect("the media_url branch")
            .split("} else if let Some(data) = data_base64 {")
            .next()
            .expect("the media_url branch ends at the data one");

        assert!(
            url_branch.contains("fetch_raster"),
            "a stranger's URL must reuse sender_icon's rails"
        );
        assert!(
            !url_branch.contains("fetch_media") && !url_branch.contains("skypetoken"),
            "a stranger's URL must never reach the authenticated path — that sends the \
             user's token off-tenant"
        );
        assert!(
            media_branch.contains("is_allowed_media_url") && media_branch.contains("fetch_media"),
            "a Teams URL must be host-checked and fetched with the session credentials"
        );
        assert!(
            !media_branch.contains("fetch_raster"),
            "a Teams URL on the unauthenticated path simply fails"
        );
        assert!(!handler.contains("reqwest::get"), "no second, unrailed fetch");

        // And whatever the bytes came from, they are measured rather than believed. The
        // raw-bytes branch is in here because it is the one the dialog uses, and the one
        // that read its width and height straight out of the params.
        let data_branch = handler
            .split("} else if let Some(data) = data_base64 {")
            .nth(1)
            .expect("the data_base64 branch");
        assert!(
            !data_branch.contains("\"width\"") && !data_branch.contains("\"height\""),
            "the size of an emoji is read from its bytes, never from what a client said"
        );
        for (branch, name) in [(url_branch, "url"), (media_branch, "media_url"), (data_branch, "data_base64")] {
            assert!(
                branch.contains("measure_art"),
                "the {name} branch must measure the bytes it fetched"
            );
        }
    }

    // Everything this app shows is local, so a backend must SERVE while sign-in is
    // broken. It used to die at boot instead: three token calls ran before the store was
    // even opened, each one `?`-propagated, so the ~18-hourly broker outage exited the
    // process. systemd restarted it every five minutes, every start died on the same
    // token, and the app said "Backend lost" in front of a store holding every message
    // the user has. Two halves of the fix, and this pins both.
    #[test]
    fn the_store_opens_before_sign_in_and_a_broken_sign_in_is_not_fatal() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let main = code
            .split("async fn main() -> Result<()> {")
            .nth(1)
            .expect("main")
            .split("\n/// ")
            .next()
            .expect("main ends before the next item");

        let store_at = main.find("prepare_store(").expect("main prepares the store");
        let sign_in_at = main.find("sign_in(&ctx)").expect("main signs in");
        assert!(
            store_at < sign_in_at,
            "main signs in before it opens the store. The store is what the app reads; a \
             broker outage must cost the live feed, never the history."
        );

        assert!(
            !main.contains("sign_in(&ctx).await?"),
            "main propagates a sign-in failure. That exits the process, and the user is \
             shown \"Backend lost\" instead of their stored history — the socket is what \
             carries the reason for an outage to the app."
        );
        // The tokens themselves moved into `sign_in` with the same rule.
        for fatal in ["context(\"ic3 token\")?", "teams::connect(&http).await?"] {
            assert!(
                !main.contains(fatal),
                "main still has `{fatal}`, which is fatal at boot. It belongs in `sign_in`, \
                 whose failure main handles."
            );
        }

        // And the write token is published before that same sign-in, for the other half
        // of the story: minting it REPLACES the file a frontend reads, so until this runs
        // the file still names the process this one replaced. A page reconnecting through
        // the relay in that window holds a dead token and every send it makes is refused
        // — reads keep working, so the app looks healthy and only the composer chimes.
        let arm_at = main.find("match write_token() {").expect("main arms the write lock");
        assert!(
            arm_at < sign_in_at,
            "main signs in before it publishes the write token. Sign-in is a D-Bus call to \
             a broker that can hang for tens of seconds, and this port is already bound — \
             so a page can be served the PREVIOUS backend's token and lose every send."
        );
    }

    // The identity is the ONE thing every local read needs from a session, so it is
    // remembered in the store. Reading it back is what makes a stored conversation
    // openable during an outage — see `Ctx::identity`.
    #[test]
    fn the_account_identity_is_remembered_for_a_signed_out_read() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.remembered_self().unwrap().is_none(), "a fresh store knows nobody");

        store.remember_self("Théophile WALLEZ", "8:orgid:abc").unwrap();
        let me = store.remembered_self().unwrap().expect("remembered");
        assert_eq!(me.name, "Théophile WALLEZ");
        assert_eq!(me.mri, "8:orgid:abc");

        // A session with no mri is not an identity: the mri is what decides whether a
        // stored message is ours, and remembering a blank one would mis-attribute every
        // message in the store to somebody else.
        store.remember_self("", "").unwrap();
        assert_eq!(store.remembered_self().unwrap().unwrap().mri, "8:orgid:abc");

        // A sign-in that resolved the mri and NO name keeps the name already remembered.
        // `/v1/users/ME/properties` stopped sending `userDetails`, so every sign-in since
        // arrives in exactly this shape — and `teams_send::build_body` puts `self_name`
        // in `imdisplayname`, so overwriting it with nothing made this account authorless
        // in every other teams-lite.
        store.remember_self("", "8:orgid:abc").unwrap();
        assert_eq!(store.remembered_self().unwrap().unwrap().name, "Théophile WALLEZ");

        // But NOT across a change of account. The pair is handed to `Store::conversations`
        // as "who we are", so one account's name beside another's mri titles every 1:1
        // after the wrong party — keeping a name is only honest for the same identity.
        store.remember_self("", "8:orgid:someone-else").unwrap();
        let moved = store.remembered_self().unwrap().unwrap();
        assert_eq!(moved.mri, "8:orgid:someone-else");
        assert_eq!(moved.name, "", "a name may never outlive the account it belongs to");
    }

    // The local-first reads must not reach the broker for the identity. `identity()`
    // never rebuilds a session, because a rebuild during an outage costs every read a
    // D-Bus timeout — and the handlers that answer from the store must ask it, not
    // `session()`, or the outage turns a cache hit into an error.
    #[test]
    fn the_local_first_reads_take_the_identity_and_never_the_session() {
        let source = include_str!("server.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);

        let identity = code
            .split("async fn identity(&self)")
            .nth(1)
            .expect("Ctx::identity")
            .split("\n    }")
            .next()
            .expect("the body ends");
        assert!(identity.contains("remembered_self"), "scanned the wrong text");
        assert!(
            identity.contains("self_mri.trim().is_empty()"),
            "Ctx::identity returns the live session unconditionally again. A sign-in whose \
             identity read failed leaves BOTH halves empty (teams::connect is best-effort) \
             and that session is cached for SESSION_TTL — read as authoritative it makes no \
             stored message ours, so the user's own messages are drawn as a colleague's and \
             push sends them their own words. An empty mri must fall through to the store."
        );
        assert!(
            identity.contains("derived_self"),
            "Ctx::identity no longer falls back to the derivation. A store synced before \
             anything recorded an identity is exactly the store an outage finds, so \
             without it the fix helps nobody until the next successful sign-in."
        );
        for reaching in ["teams::connect", "self.session()", "tokens.get"] {
            assert!(
                !identity.contains(reaching),
                "Ctx::identity names `{reaching}`, so reading the identity can reach the \
                 broker. It must answer from the cached session or from the store."
            );
        }

        for (arm, next) in [
            ("\"conversations\" =>", "\"channels\" =>"),
            ("\"open\" =>", "\"backfill\" =>"),
        ] {
            let handler = code
                .split(arm)
                .nth(1)
                .expect("the handler")
                .split(next)
                .next()
                .expect("the handler ends at the next arm");
            assert!(
                handler.contains("ctx.identity()"),
                "the {arm} handler no longer asks `ctx.identity()`. It answers from the \
                 store, so it must not depend on a live session."
            );
        }
    }

    // A domain is asked once, and "there is none" is an answer worth keeping: it is the
    // answer for 7 senders in 18, and re-asking would hit that server on every render.
    #[test]
    fn a_sender_with_no_icon_is_remembered_as_having_none() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.sender_icon("getsentry.com").unwrap().is_none(), "never asked");

        store.put_sender_icon("getsentry.com", None, 1).unwrap();
        let cached = store.sender_icon("getsentry.com").unwrap();
        assert!(cached.is_some(), "the domain was asked");
        assert!(cached.unwrap().is_none(), "and it serves no icon");

        let icon = teams_media::Media {
            content_type: "image/png".into(),
            bytes: vec![0x89, b'P', b'N', b'G'],
        };
        store.put_sender_icon("getsentry.com", Some(&icon), 2).unwrap();
        let held = store.sender_icon("getsentry.com").unwrap().unwrap().unwrap();
        assert_eq!(held.content_type, "image/png");
        assert_eq!(held.bytes, icon.bytes);
    }

    // On unless it was turned off — the opposite of every other switch here, because the
    // user asked for the mark and the rails are what make the request defensible.
    #[test]
    fn sender_icons_are_on_until_they_are_turned_off() {
        let store = Store::open_in_memory().unwrap();
        assert!(sender_icons_enabled(&store).unwrap(), "unset reads as on");
        store.set_setting(SETTING_SENDER_ICONS, "0").unwrap();
        assert!(!sender_icons_enabled(&store).unwrap());
        store.set_setting(SETTING_SENDER_ICONS, "1").unwrap();
        assert!(sender_icons_enabled(&store).unwrap());
    }

    /// On until it is turned off, and published so the switch can draw the truth: a page
    /// that read `false` for the moment before the settings land would tell the user no
    /// emoji is being taken while one is.
    #[test]
    fn the_emoji_auto_import_is_on_until_it_is_turned_off() {
        let store = Store::open_in_memory().unwrap();
        assert!(emoji_auto_import_enabled(&store).unwrap(), "unset reads as on");
        assert_eq!(settings_json(&store).unwrap()["emoji_auto_import"], json!(true));
        store.set_setting(SETTING_EMOJI_AUTO_IMPORT, "0").unwrap();
        assert!(!emoji_auto_import_enabled(&store).unwrap());
        assert_eq!(settings_json(&store).unwrap()["emoji_auto_import"], json!(false));
        store.set_setting(SETTING_EMOJI_AUTO_IMPORT, "1").unwrap();
        assert!(emoji_auto_import_enabled(&store).unwrap());
    }

    /// The pack learns from a message, so the two rails that decide WHETHER it may have to
    /// be in the function that does it — a live frame passes through no dispatch gate, and
    /// a store this app cannot read has not given an answer either way.
    #[test]
    fn taking_an_emoji_from_a_message_checks_the_switch_and_the_lock() {
        let source = include_str!("server.rs");
        /// One function's own source, from its signature to the `}` in column one that
        /// ends it. A fixed window of bytes was tried and is worse: it silently stops
        /// short, so the test fails for its own reason rather than the code's.
        fn body_of<'a>(source: &'a str, signature: &str) -> &'a str {
            let start = source.find(signature).unwrap_or_else(|| panic!("{signature} exists"));
            let end = source[start..].find("\n}\n").expect("the function ends");
            &source[start..start + end]
        }

        let body = body_of(source, "fn import_emoji_from_message(");
        assert!(body.contains("if read_only()"), "a read-only backend writes nothing");
        assert!(
            body.contains("emoji_auto_import_enabled(store).unwrap_or(false)"),
            "an unreadable store is not consent"
        );

        // A REACTION is a source, and on this tenant the commonest one. It is claimed per
        // UPLOAD rather than per message, because a reaction arrives on a message the store
        // already holds — a claim on the message is taken by its own insert, and every later
        // reaction on it would be dropped.
        let sources = body_of(source, "fn inbound_emoji_in(");
        assert!(sources.contains("custom_emoji::art_in_body"), "the body is a source");
        assert!(sources.contains("reaction_keys"), "a reaction is a source");
        assert!(
            sources.contains("custom_emoji::custom_reaction_art"),
            "a reaction's name comes from its key"
        );
        let call_site = body_of(source, "let reactions_changed = reacted.is_some()");
        assert!(
            call_site.contains("if inserted || reactions_changed"),
            "a reaction arrives on a message that is already stored"
        );

        let take_body = body_of(source, "async fn take_emoji_into_pack(");
        assert!(take_body.contains("claim_once"), "two backends share this store");
        assert!(
            take_body.contains("teams_media::is_allowed_media_url"),
            "the session token reaches Teams hosts only"
        );
        assert!(
            take_body.contains("custom_emoji::measure_art"),
            "the bytes are measured, never believed"
        );
        assert!(take_body.contains("custom_emoji::take_as"), "a held name is never overwritten");
    }

    #[test]
    fn page_limit_is_bounded_and_defaults() {
        assert_eq!(page_limit(&json!({}), 40), 40);
        assert_eq!(page_limit(&json!({ "limit": 10 }), 40), 10);
        // A client cannot ask the server (and thus Graph) for an unbounded page.
        assert_eq!(page_limit(&json!({ "limit": 100_000 }), 40), 100);
        assert_eq!(page_limit(&json!({ "limit": 0 }), 40), 1);
        // A nonsensical value falls back to the default rather than erroring.
        assert_eq!(page_limit(&json!({ "limit": "many" }), 40), 40);
    }

    #[test]
    fn mail_has_more_older_reads_both_the_cache_and_the_server() {
        let store = Store::open_in_memory().expect("in-memory store");
        store
            .upsert_mail_folder(&teams_lite::store::MailFolderUpdate {
                id: "f",
                display_name: "Inbox",
                well_known: "Inbox",
                total_count: 0,
                unread_count: 0,
                position: 0,
            })
            .unwrap();

        fn mail<'a>(id: &'a str, received: &'a str) -> teams_lite::store::MailMessageUpdate<'a> {
            teams_lite::store::MailMessageUpdate {
                id,
                folder_id: "f",
                conversation_id: "c",
                subject: "s",
                from_name: "n",
                from_address: "a@b",
                to_addresses: "[]",
                cc_addresses: "[]",
                received,
                is_read: true,
                has_attachments: false,
                importance: "normal",
                preview: "p",
            }
        }
        store.upsert_mail_message(&mail("m1", "2026-07-01T09:00:00Z")).unwrap();
        store.upsert_mail_message(&mail("m2", "2026-07-05T09:00:00Z")).unwrap();
        // History reaches back to m1, and the server holds nothing older.
        store.set_mail_frontier("f", "2026-07-01T09:00:00Z", false).unwrap();

        // A page stopping above the local frontier still has cached mail behind it,
        // so the UI must offer to page further WITHOUT a network round-trip.
        let head = store.mail_page("f", None, 1).unwrap();
        assert!(mail_has_more_older(&store, "f", &head).unwrap());

        // A page that reaches the frontier, with nothing older on the server, is the
        // end of the folder.
        let all = store.mail_page("f", None, 10).unwrap();
        assert!(!mail_has_more_older(&store, "f", &all).unwrap());

        // Once the server reports more, the end of the cache is not the end.
        store.set_mail_frontier("f", "2026-07-01T09:00:00Z", true).unwrap();
        assert!(mail_has_more_older(&store, "f", &all).unwrap());

        // An empty page defers entirely to the server.
        assert!(mail_has_more_older(&store, "f", &[]).unwrap());
        store.set_mail_frontier("f", "2026-07-01T09:00:00Z", false).unwrap();
        assert!(!mail_has_more_older(&store, "f", &[]).unwrap());
    }

    #[test]
    fn a_run_marker_never_leaves_its_directory() {
        // The name comes from a message id, which arrives from the network. A separator
        // in it would put the file — and the deletion that follows — somewhere else.
        assert_eq!(marker_name("1785799174107"), "1785799174107");
        assert_eq!(marker_name("../../write-token"), "______write-token");
        assert_eq!(marker_name("19:c@thread.v2"), "19_c_thread_v2");
    }

    #[test]
    fn a_repair_waits_far_longer_than_a_heartbeat() {
        // The margin IS the safety of the repair: it may only ever close a run whose
        // process is gone, never one that is quietly reading files. A dozen missed beats
        // is the difference between the two.
        assert!(
            AGENT_RUN_ABANDONED_AFTER >= AGENT_RUN_HEARTBEAT * 6,
            "an abandoned run must be many missed beats, not one"
        );
        // And the sweep has to keep coming back: the run killed by a restart still has a
        // fresh heartbeat when the next process boots.
        assert!(AGENT_REPAIR_INTERVAL <= AGENT_RUN_ABANDONED_AFTER);
    }

    /// What a CUSTOM AGENT really changes about the run — the one wiring between
    /// `agent_persona` and `agent::Request`, and each half of it is a way to get the feature
    /// wrong silently.
    #[test]
    fn a_custom_agent_leads_the_prompt_and_names_the_model_and_the_identity() {
        let store = Store::open_in_memory().unwrap();
        // The provider runs on a model of its own, so the persona's has something to win over.
        let mut providers = agent_policy::Providers::default();
        providers.set_model("claude", Some("sonnet"));
        store
            .set_setting(agent_policy::SETTING_PROVIDERS, &providers.to_json())
            .unwrap();

        let mut natacha = agent_persona::Persona {
            name: "natacha".into(),
            label: "Natacha".into(),
            backend: &agent_policy::BACKENDS[0],
            model: Some("haiku".into()),
            preprompt: "/boomer".into(),
            avatar: None,
            added_ms: 0,
            updated_ms: 0,
        };
        let command = |persona: Option<agent_persona::Persona>| agent_policy::Command {
            conversation_id: "19:c@thread.v2".into(),
            message_id: "1000".into(),
            prompt: "coucou".into(),
            answering: None,
            sender: "Théophile".into(),
            sender_mri: "8:orgid:me".into(),
            compose_time: 1,
            backend: &agent_policy::BACKENDS[0],
            persona,
        };

        let asked = agent_request(&store, &command(Some(natacha.clone())), "8:orgid:me").unwrap();
        // The PREPROMPT leads what the CLI is handed, and the request follows it.
        assert!(asked.prompt.starts_with("/boomer"), "{}", asked.prompt);
        assert!(asked.prompt.contains("coucou"));
        // The persona's model wins over the provider's, and the model is who it says it is.
        assert_eq!(asked.model.as_deref(), Some("haiku"));
        assert!(asked.system_prompt.contains("You are Natacha"), "{}", asked.system_prompt);
        // The PROGRAM is still the provider's: a persona names one and never becomes one.
        assert_eq!(asked.backend.name, "claude");

        // A persona naming no model INHERITS the provider's, so one that is only a character
        // does not go stale the day the user changes it in Settings.
        natacha.model = None;
        let inherited = agent_request(&store, &command(Some(natacha)), "8:orgid:me").unwrap();
        assert_eq!(inherited.model.as_deref(), Some("sonnet"));

        // And a plain provider run is untouched: no lead, the provider's model, its own name.
        let plain = agent_request(&store, &command(None), "8:orgid:me").unwrap();
        assert!(plain.prompt.starts_with("coucou"), "{}", plain.prompt);
        assert_eq!(plain.model.as_deref(), Some("sonnet"));
        assert!(plain.system_prompt.contains("You are claude"), "{}", plain.system_prompt);
    }

    #[test]
    fn a_repair_frame_names_the_run_a_page_is_drawing() {
        // A repair has no `Command` left — only the stored row — and a frame whose
        // `run_id` did not match would leave the overlay writing forever.
        let progress = agent::Progress::default();
        let command = agent_policy::Command {
            conversation_id: "19:c@thread.v2".into(),
            message_id: "1000".into(),
            prompt: "hi".into(),
            answering: None,
            sender: "Ada".into(),
            sender_mri: "8:orgid:ada".into(),
            compose_time: 1,
            backend: &agent_policy::BACKENDS[0],
            persona: None,
        };
        let live = agent_stream_frame(&command, "2000", "thinking", &progress, None);
        let repaired = agent_run_frame(
            "19:c@thread.v2",
            "1000",
            "2000",
            "claude",
            "",
            "error",
            &progress,
            Some(agent_policy::INTERRUPTED_REASON),
        );
        assert_eq!(live["run_id"], repaired["run_id"]);
        assert_eq!(live["message_id"], repaired["message_id"]);
        assert_eq!(live["backend"], repaired["backend"]);
        assert_eq!(repaired["phase"], "error");
    }
}
