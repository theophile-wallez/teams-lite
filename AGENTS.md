# teams-lite — agent guidelines

## Sending messages (MANDATORY)

- **Never send a message without the user's explicit consent for that exact
  message.** Sends go out through the user's *personal* Teams account, so every
  send is a real, visible action performed as them — this applies to channels and
  to one-to-one/group chats alike.
- This covers anything that posts to Teams on the user's behalf — new messages,
  replies, reactions, edits, deletions — whether triggered through the UI, the backend
  `server`, a script, or a direct API/WebSocket call.
- **A deletion is the one outward action nothing takes back.** `delete`
  (`teams_send::delete_message`, `DELETE …/conversations/{id}/messages/{id}`) removes a
  message from the thread for everybody in it, on every device, and no later call
  restores it — an edit rewrites, a reaction toggles off, a deletion is final. It is an
  `OUTWARD_METHODS` entry, the UI asks for a second explicit confirmation before it
  calls, and the backend refuses a message that is not the user's own before the
  network (Teams itself would let a team owner delete a colleague's channel post; this
  app never offers that). The local row is FLAGGED, never dropped: Teams keeps the
  message and marks it, which is what the "You deleted this message" placeholder — and
  its Reveal of the cached body — is built on. `examples/message_delete_probe.rs` pins
  that server-side shape against the real tenant — it posts to the sandbox channel and
  removes what it posted, and it is the only sanctioned way to try the call live:

      . bin/broker-env.sh && teams_lite_export_broker_bus && \
        cargo run --example message_delete_probe
- **Marking a conversation read counts.** `mark_read` publishes the user's own
  consumption horizon (`PUT …/properties?name=consumptionhorizon`, in
  `src/teams_readstate.rs`): the unread marker clears on every device they are signed
  in on, and the sender is shown a read receipt saying their message was read. It is
  an `OUTWARD_METHODS` entry for that reason, and the hook blocks the endpoint on a
  command line too. Reading horizons (`GET …/consumptionhorizons`, which is how "seen
  by" works) stays open. **Ghost mode** — a setting, off by default — makes a read
  local: the marker clears in this app only, and Teams is never told.
- **The one standing exception is the designated sandbox chat**
  `19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2`, at this address:

      https://theophile-remote.taild26c06.ts.net:8443/c/19%3A21d2695ae8ff4e25ace9c662e5c326cb%40thread.v2

  Sending there is pre-authorized — it is the only place a send is allowed without
  asking first. Treat every other channel and chat as off-limits absent explicit
  consent. (That URL is the tailnet front of the always-on web unit; the same
  conversation on this machine's own front is
  `http://127.0.0.1:19440/c/19%3A21d2695ae8ff4e25ace9c662e5c326cb%40thread.v2`.
  One chat, two doors.)
- **A chat feature that must be exercised against the real account is exercised in
  that chat and nowhere else.** One thread, chosen once, so a mistake lands where a
  mistake is harmless. The mock comes first — `cd web && bun run preview` exercises
  send, edit, delete and react with nothing leaving the machine — and prod is only for
  what the mock cannot show.
- **`cd web && bun run sandbox` is the only sanctioned way to type into the live
  app.** It opens the URL above, reads the open conversation id out of the app's own
  state (`[data-testid="composer-shell"]`'s `data-conversation-id`) and refuses every
  keystroke unless it is the sandbox thread — the live counterpart of the MOCK
  sentinel in `web/scripts/preview.ts`. Add `--local` when the tailnet name does not
  resolve on this machine: it is the same chat through `127.0.0.1:19440`, which is
  what `tailscale serve` proxies 8443 to. Never click through the sidebar of a live
  app, and never drive a live page with the browser MCP tools: neither can prove
  which conversation a keystroke lands in.
- Reading, searching, drafting, and showing a proposed message to the user for
  review are always fine. Only the actual send requires a green light.
- **A send that FAILS says so at the composer**, in one sentence beside the words that
  are still in the box (`sendError`, over `web/src/lib/send-failure.ts`). It is the mirror
  of the rule above: this app never posts without the user, so it must never leave them
  believing it did — and a message that did not leave is invisible to them, because the
  composer keeps their text either way. It used to be reported by the status line alone —
  eleven truncated pixels at the foot of the sidebar, which on a phone is not on screen at
  all — so the whole event was an error chime. The status line still carries the RAW
  failure for whoever reads a screenshot; the composer carries the half the user acts on.
  Never trade one for the other, and never swallow a send failure into a cue.
- Outside the sandbox chat, consent is per-message and never standing: approval
  to send one message is not permission to send others. When in doubt, draft it and
  ask first.
- The one feature that posts on its own is the local agent (§ The local agent). It
  is not an exception to the rule above: it answers only a message the USER wrote,
  only in a conversation the user opted in, and the sandbox channel is the only one
  opted in out of the box.

## The local agent (`@claude` in a thread)

The user can summon a coding agent that runs on this machine from any Teams client —
their phone included — by writing `@claude <prompt>` or `@opencode <prompt>` in a
thread. The backend runs that CLI, posts one message, and EDITS it as the answer
arrives, so everybody in the thread watches the reply being written.

`src/agent.rs` runs the CLI, `src/agent_policy.rs` decides whether a message asked for
one, `src/agent_markdown.rs` turns the answer into the HTML a Teams message renders,
and `agent_reply` in `src/bin/server.rs` posts and streams it.

**In teams-lite itself the answer is drawn being written.** The edited message is the
lowest common denominator — one HTML body, once a second, for clients we do not write.
This app is on the same machine as the CLI, so `agent_reply` also broadcasts the whole
run on the local `agent_stream` event (`agent_stream_local`, over `agent::Progress`):
the answer so far, the phase, the tool in flight, and the TRANSCRIPT — the model's
reasoning and every tool call, interleaved in the order they happened (`agent::Step`). The
web UI renders it word by word under the CLI's own mark (`web/src/components/agent-reply.tsx`
and `agent-logo.tsx`, over `web/src/lib/agent-run.ts` and `agent-markdown.ts` — a port
of the Rust markdown subset, pinned to it case for case by its tests). Five rules hold
that surface together:

- **The stream is an overlay on the posted message, never a message of its own.** The
  row in the history IS the Teams message; only its body is replaced while a run is
  live. So there is nothing to reconcile, nothing to clean up when a frame is lost, and
  a reply this app never watched being written renders identically from the message
  alone.
- **A reply is recognised from the line it signs itself with**, not from a flag
  (`web/src/lib/agent-message.ts`). That line exists for honesty about authorship and
  is required above; reading it back is what makes every reply ever posted render as
  one — including the ones answered from a phone while this app was closed, which is
  most of them. In the bubble the words are replaced by the CLI's own mark and
  "Claude by <the account it went out under>", which says the same two things in less
  space; the line itself is stripped from the body so it is never stated twice.
  It is read on EVERY message, not only on ours: a colleague in the thread may run
  teams-lite too, and their agent's answer arrives signed exactly the same way. Read as an
  ordinary message it hands the reader that raw line tucked against that colleague's own
  words, as if they had typed it. Whose machine wrote it is never guessed — the mark names
  the message's own sender beside it, so a reply of theirs is attributed to them.
- **The answer sits on the LEFT.** The message is genuinely the user's — it went out
  through their account and a colleague sees their name on it — but they did not write
  it, and putting it beside the things they did write is the one place this app would be
  lying to the person it belongs to.
- **The work is a transcript: it is KEPT while the run goes, and folded once the answer
  arrives.** The reasoning streams into a panel above the answer, at the pace the answer
  is revealed at, with a row per tool call in place — so a reader watches the run being
  worked out. It used to be one 160-character line of reasoning and one tool chip, each
  replaced by the next: every sentence the model wrote and every file it read went past
  and was gone, which made the most interesting part of a run the part nobody could read.
  Four things hold the panel up, and `web/e2e/agent.spec.ts` pins each: it is BOUNDED and
  scrolls itself (it sits in a virtualized history, and an unbounded bubble would push the
  conversation around a frame at a time), it follows the newest line only while the reader
  has not scrolled back inside it, the fold is automatic ONCE and the reader's own click
  wins from then on, and the header names the tool in flight only while the rows are folded
  — open, the rows say it better. The reasoning is drawn as data, never through the Markdown
  renderer: it is what the model said to itself, not this app's voice. And it is an overlay
  like everything else here, so it goes with the run: the Teams message holds the answer and
  never the reasoning, which is why there is no disclosure on a stored reply.
- **The terminal frame goes out after the final edit, and it carries the transcript.** A
  finished run stops being an overlay, so the message it falls back to has to already hold
  the whole answer — and the last frame is the last chance to state the transcript, so a
  `done` that dropped it would blank the panel a beat before the app lets the run go.

`web/mock/server.ts` reproduces that flow (`simulateMockAgentRun`) with no CLI and no
tenant, which is what makes the surface reviewable — `cd web && bun run preview --
--out /tmp/reply --agent-reply` walks one run through every phase (`--agent` captures the
menu instead), and `web/e2e/agent.spec.ts` pins it.

Five rules hold it together. Each one is load-bearing, and each is pinned by a test:

- **Only the user may summon it.** The trigger requires the message to be ours
  (`from_me`). A prefix written by anybody else is ignored — the agent runs a program
  with the user's files in reach, so a trigger a colleague could type is remote code
  execution with a friendly syntax. Never relax this to "a mention of the app", and
  never to "an allowlist of colleagues".
- **A conversation must be opted in.** The default is `off` everywhere. The sandbox
  channel is the single built-in exception, because § Sending messages pre-authorizes
  it. Anything else needs `agent_set_mode`, a write-token-gated `MACHINE_METHODS`
  entry — which is the consent gate for this whole feature, and the reason it is not a
  standing licence to post. The user turns one thread on from that thread's own header
  (`web/src/components/agent-menu.tsx`, over `web/src/lib/agent.ts`), never from a
  global list of ids: the consent belongs where they can see who reads the thread. The
  switch stays off and disabled until `agent_status` answers, because `off` is what the
  backend defaults to and a hopeful switch would misstate where a machine posts.
- **The tool allowlist is read-only until the user widens it.** `Read`, `Glob`, `Grep`
  and nothing else (`agent::DEFAULT_TOOLS`), and Claude Code is pinned to
  `--permission-mode default` so anything outside the list is refused rather than
  prompted for. Widening the list is `agent_set_tools`, gated the same way — and it is
  *offered* as named read-only groups (`agent::TOOL_GRANTS`, switched on from the same
  thread menu), because a consent the user can only give through a hand-crafted RPC is a
  consent they cannot give. Every tool in every group reads: the child loads the user's
  own MCP servers, so a group spelled `mcp__grafana` would hand over `update_dashboard`,
  `create_incident` and `grafana_api_request` with it. `every_granted_tool_reads` pins
  the shape — three segments, never a whole server, and a verb that reads. The RPC still
  accepts any list, which is the deliberate escape hatch for a tool no group names.
- **The user may hand it their own configuration, and only they may.**
  `agent_set_unrestricted` (a `MACHINE_METHODS` entry, off in a fresh store) switches the
  child to `agent::Permissions::OwnConfig`: this app then passes NEITHER
  `--allowed-tools` NOR `--permission-mode`, so the CLI resolves every MCP server, every
  tool and the permission mode from `~/.claude/settings.json` — the run the user gets in
  their own terminal, which is what they asked for. Three things about it, all
  load-bearing:
  - **The app still never spells an escalation.** No `bypassPermissions`, no
    `--dangerously-skip-permissions`, no opencode `--auto`, in either mode
    (`no_mode_ever_spells_an_escalation`). What the setting opens is what the user's own
    settings open, so editing those settings takes it back. A flag written here would
    keep deciding after they changed their mind.
  - **It accepts a real risk, and the menu says so.** The thread transcript travels with
    every prompt, and the people in the thread never agreed to be able to steer a program
    on that machine. With the user's own config that program can write files and run
    commands, and it can read the 0600 write token and post to any chat around every gate
    above. That is why the setting is off by default, why it is per machine and asked for
    from the thread's own menu, and why the backend prints one `UNRESTRICTED` line at
    startup. Never make it the default, never turn it on for the user, and never widen it
    to a per-thread automatic.
  - **The narrow state is what an unanswered status means.** `agentIsUnrestricted` is
    false until the backend reports `true`, exactly like the mode switch: a hopeful
    `true` would tell the user their own configuration is in force while the allowlist
    is.
- **The child never inherits the write token.** `TEAMS_LITE_WRITE_TOKEN` is removed
  from its environment: an agent holding it could `send` to any chat directly, around
  every gate above. A read-only backend never answers at all.

Five more things worth knowing before touching it:

- **The providers live in Settings, and the model with them.** Settings › AI providers
  (`web/src/components/ai-providers-settings.tsx`) shows every CLI in
  `agent_policy::BACKENDS`, says which ones this machine actually holds
  (`agent::is_available`, so a missing CLI is stated instead of offering a dead switch),
  and lets the user turn one off or choose the model it runs — `agent_set_provider`, a
  third write-token-gated `MACHINE_METHODS` entry, because it decides which program a
  chat message starts and which model reads the thread. Two defaults are deliberate and
  run opposite ways: a **conversation** is off until the user names it, and a
  **provider** the machine holds is on out of the box (`agent_policy::Providers`) — the
  first is consent to post, the second is only which installed CLI answers once that
  consent exists. A disabled provider ignores its own prefix everywhere, and says so in
  the journal.
- **The model is picked from THIS machine's list, and the list is never the limit.**
  `agent_status` publishes, per provider, the models it can offer with what a reader
  needs to choose one — the vendor's own name for the model, whose mark to draw, and
  what it holds (`agent_models::Choice`). Two halves, for two reasons. `claude` takes
  four documented aliases, so `agent_policy::BACKENDS` names them once and carries their
  labels and limits with them; each alias follows its family, so a label goes stale the
  day a new model ships. `opencode` takes `provider/model` for whichever providers THAT
  machine authenticated, so a hard-coded catalogue would be wrong on the next machine —
  `agent_models` reads opencode's own files instead (the models.dev catalogue it caches,
  its `auth.json`, and the user's `opencode.json`). It reads them and nothing else: no
  `opencode models` subprocess, because a settings pane must not wait seconds on a CLI,
  and no fetch, because displaying this app makes no network request. The parse is cached
  against the files' own timestamps, since `agent_status` is answered on every connect
  and the catalogue is megabytes of JSON. **A model nobody listed is still accepted**:
  the picker's search field doubles as the free-form entry, and every model — listed or
  typed — is shape-checked (`agent_policy::is_valid_model`) at the RPC and again in
  `agent::model_of`, so it can never arrive at the CLI as another flag. The picker offers
  only what that check would accept, because a control that saves nothing reads as a bug.
  Picking is the write, so the pane holds no Save button and shows the stored model at
  all times — a refused write leaves the old one on screen.
- **The CLI has to be on the backend's own PATH, and a service has almost none.** The
  systemd user manager's PATH holds neither `~/.local/bin` (where `claude` installs
  itself) nor `~/.bun/bin`, so the always-on service found no program, dropped every
  trigger with one journal line, and the thread stayed silent — a broken feature with no
  visible cause. The unit therefore carries `Environment=PATH=@AGENT_PATH@`
  (`bin/teams-lite-service.sh` substitutes it, and a test in `agent::tests` pins both
  halves), and every backend says at startup which CLIs it resolved and to where.
- **The thread transcript travels with the prompt, and it is DATA.** The appended
  system prompt says so explicitly, because the people in a thread never agreed to be
  able to steer an agent on the user's machine. Keep that instruction, keep the
  transcript bounded, and never move it out of its `<thread>` delimiter. A trigger written
  as a REPLY carries one more block, `<answering>` — the message it replies to, read back
  out of the quote by `agent_policy::answering` — under the same three rules, because
  without it a request that says "answer this message" names nothing (see "Answer with
  <agent>" under § Tagging an agent).
- **The reply signs itself.** The message is posted under the user's name, so the last
  line says a machine wrote it (`— claude, via teams-lite`). That is honesty about
  authorship, not decoration.
- **A run is bounded by SILENCE, not by a clock.** A question that needs an hour of tool
  calls gets the hour: the child is killed when the CLI emits nothing at all for
  `agent::RUN_IDLE_TIMEOUT` (30 min), and the deadline moves forward on every event, so
  only a CLI that stopped ever hits it. `RUN_MAX_DURATION` (8 h) is the backstop for the
  opposite failure — a loop that never stops talking — and is never the cap on real work.
  A wall-clock cap on the whole run was the first design and it was wrong: it cut a
  40-minute question at 10 minutes, mid-answer, and the thread was told the run failed.
  Three numbers follow from that and must move together:
  - **The page counts missed frames, never run time.** A quiet run repeats its latest
    frame every `AGENT_STREAM_KEEPALIVE` (15 s, `agent_stream_local`), so
    `AGENT_RUN_STALE_MS` (2 min) is eight missed beats — a backend that is gone. That is
    what lets a bubble follow an hour-long run without ever giving up on it, and
    `the_pages_staleness_window_is_several_keepalives_wide` pins the pair across the
    socket.
  - **The store heartbeat is the same idea, for the other reader** (see below): a beat
    every 5 s, abandoned after 60, so a run reading files in silence is never mistaken
    for a dead one.
  - **The restart waits longer than a run is likely to take** — 40 minutes
    (`AGENT_WAIT_SECONDS`), because a wait shorter than a run kills exactly the long
    answers the wait exists to protect.
- **A run does not survive its process, so a restart is handled on both sides.** The
  child dies with the backend, the final edit never goes out, and the thread keeps the
  `claude is thinking…` placeholder — for everybody in it, for good. It happened: a
  re-stage restarted the service mid-answer and the user waited ten minutes in front of a
  frozen message. Two halves fix it, and neither replaces the other:
  - **The restart waits.** `bin/teams-lite-service.sh update` holds the `try-restart`
    while a run is writing (`wait_for_quiet_agent`), because nothing can resume a run —
    waiting is the only way the reader gets the answer they asked for. A live run
    publishes a marker file under `$XDG_RUNTIME_DIR/teams-lite/agent-runs/` naming its
    pid, which is what lets a SHELL see it without opening the store. The wait is bounded
    and then proceeds: a stuck run must not keep the user's phone on an old commit.
    `--now` skips it and is the user's switch — the automation hook refuses it.
  - **What is left behind is closed.** Every run is recorded in `agent_runs` while it is
    in flight, with a heartbeat, so a run whose process is GONE can be told from one that
    is quietly reading files. Whichever backend comes up sweeps for the quiet ones and
    rewrites their message with `agent_policy::interrupted_html`
    (`repair_abandoned_agent_runs`). That body is deliberately the failure shape every
    client already reads, so no client needed a new case — and it says to ask again,
    because that is the one thing the reader can do. It sweeps rather than checking once
    at boot: the run this restart killed still has a fresh heartbeat a second later.

`examples/agent_stream_probe.rs` drives the whole chain against the real tenant —
pinned to the sandbox channel, and the only sanctioned way to try it live:

```
. bin/broker-env.sh && teams_lite_export_broker_bus && \
  cargo run --example agent_stream_probe -- "your prompt" [claude|opencode] [model]
```

It also pins the fact the streaming rests on: a send returns no `id`, only
`{"OriginalArrivalTime": …}` — and a Teams message id IS its arrival time in epoch
ms, which is what the edits address.

## Mail is READ-ONLY (MANDATORY — no exception, not even a sandbox)

The app reads the user's Outlook mailbox over Microsoft Graph (`src/mail.rs`). It
must never write to it.

- **Never send, reply to, forward, delete, move, or mark-as-read a mail.** There is
  no sandbox mailbox and no pre-authorized recipient: unlike the Teams sandbox
  channel, mail has *no* standing exception at all. A mail leaves the user's personal
  address, reaches people who never agreed to be part of a test, and cannot be
  recalled.
- **The unread marker is the one thing this app moves, and it moves it HERE ONLY.**
  Opening an unread mail clears its marker, because a mail client that leaves a read
  mail bold is broken — but the read is recorded in our own mirror
  (`mail_messages.local_read`, written by `Store::mark_mail_read_locally` behind the
  `mail_mark_read` RPC) and Graph is never told. So Outlook keeps the mail unread on
  the user's phone, and the sender is shown nothing. Three rails hold that apart from
  a real mark-as-read, and each is pinned by a test: the server's own flag lives in
  its own column (`is_read`) so a poll and a local read can never clobber each other,
  the effective state is the OR of the two in ONE place
  (`MailMessageRow::is_read`), and the `mail_mark_read` handler names no HTTP client,
  no Graph host and no `isRead` — `marking_a_mail_read_never_names_a_graph_write`
  scans it. A read-only backend refuses the call outright, so a screenshot script
  cannot clear the user's markers. Publishing a read to the MAILBOX stays forbidden:
  it clears the marker on every device the user owns, and it is a deliberate feature
  with its own consent gate, never a widening of this one.
- The broker token this app already holds carries **`Mail.ReadWrite` and
  `Mail.Send`** (verified — see `examples/graph_mail_scopes.rs`). So nothing at the
  API level stops a send. What stops it is that **no code names the endpoint**:
  `src/mail.rs` issues GET requests only, and two tests enforce that mechanically —
  one scans the module for any other verb, the other scans the whole crate for the
  Graph mail-send endpoint. Do not weaken, skip, or work around either.
- Reading, searching, and rendering mail are fine and are what the feature is for.
  If mail *sending* is ever wanted, it is a deliberate feature: its own consent gate,
  its own entry in `OUTWARD_METHODS`, its own write-lock coverage — never a quiet
  addition to the read path. The same applies to publishing a read state, a flag, a
  category or a folder move: each one is a write to the user's mailbox.
- Mail bodies are sanitized server-side and stripped of every remote reference, so
  **displaying a mail makes no network request**. That is a privacy guarantee (a
  remote image is a read receipt for its sender), not an optimization: never add a
  "load remote images" action, and never let a body reach a browser unsanitized.
- **A mail shows a real face, and the lookup behind it is a TEAMS read.** A mail names
  its people by SMTP address while a photo is addressed by mri, so `people_by_address`
  resolves one to the other: the short-profile endpoint asked with `isMailAddress=true`,
  which is the whole difference from the `profile` method
  (`teams_profiles::fetch_profiles_by_address`, proven against the tenant by
  `examples/mail_avatar_recon.rs`). Three things hold it in place. It reaches Microsoft's
  directory and never the sender, so the guarantee above is untouched — a face costs a
  colleague nothing and tells the sender nothing. A colleague resolves while an external
  sender, a distribution list and a shared mailbox do not, and an address the directory
  cannot name keeps its tinted initials rather than a guessed face. And a card is only
  attributed to an address that asked for it (matched on `email`, then
  `userPrincipalName`), because the wrong face on a name is worse than no face. The
  lookups are batched, so a screenful of mail costs one request.
- **A sender the directory cannot name is drawn from its DOMAIN.** Locally first
  (`mailAvatarSeed` / `mailAvatarInitials` in `web/src/components/avatar.tsx`): the tint
  is seeded by the REGISTRABLE domain, so `notifications@linear.app` and
  `security@updates.linear.app` are one colour and one sender, and the letters come from
  the display name, then from an address that spells a person (`reva.singh` → RS), then
  from the organisation (`no-reply@sns.amazonaws.com` → AM) — never from a local part
  every alert mailbox shares. It costs a colleague nothing: measured on this tenant,
  every internal address the directory resolves has a photo, and a photo covers the tint.
- **And its real mark is fetched from its own domain — the ONE request this app makes to
  a stranger's server.** `sender_icon` (`src/sender_icon.rs`) GETs
  `https://{domain}/favicon.ico`, then `/apple-touch-icon.png`; 11 of the 18 domains that
  write to this mailbox answer, and the rest keep the tinted initials
  (`examples/sender_icon_probe.rs` measures both halves, and reading a home page's
  `<link rel="icon">` was measured too and rejected — without a real parser it mistook a
  stylesheet for an icon). A favicon request is a request to the SENDER, so five rails
  hold it apart from the tracking pixel `mail_html` strips out of the body, and
  `the_sender_icon_handler_checks_every_rail_before_the_network` scans the handler for
  every one of them:
  - **Only the registrable domain is ever requested.** A per-recipient host
    (`mail.a1b2c3.example.com`) is reduced to `example.com` before anything is fetched,
    so the token that would identify this reader never reaches the wire. Verified live.
  - **Once per organisation, ever.** The answer — including "there is none" — lives in
    `sender_icons`, so the number of requests is the number of organisations that write
    to the user, not the number of mails they send.
  - **The reader's behaviour is not in it.** The icon is asked for when a mail LIST
    renders, never when a body is opened, so the request cannot say a mail was read.
  - **Nothing about the mail travels**: no cookie, no referrer, no query, no mail id, no
    address. And nothing is fetched for a HUMAN — an address that spells a person keeps
    their initials (`mailAddressSpellsAPerson`), because an employer's logo on somebody's
    message misattributes it.
  - **It is a setting** (Settings › Sender icons, on by default), and a read-only backend
    never fetches whatever the setting says: an automation must not touch a stranger's
    server on the user's behalf.
  Two more rails guard this machine rather than the user's privacy: the host must resolve
  to a PUBLIC address (a hostile domain pointing at `169.254.169.254` would make this an
  SSRF into the cloud metadata endpoint), and the bytes must sniff as a raster image
  under a size cap — never SVG, and never on the strength of the content type the server
  claimed. **A third-party icon service is not an alternative**: Google's or
  DuckDuckGo's would be told the domain of every person who mails the user.
  In the UI a mark is drawn on a rounded SQUARE while a face stays a circle, so the shape
  says whether a person or a machine wrote — `web/mock/server.ts` synthesizes one per
  domain, so the whole surface is reviewable with nothing leaving the machine.

## The calendar is READ-ONLY (MANDATORY — no exception, not even a sandbox)

The app reads the user's Teams/Outlook calendar over Microsoft Graph
(`src/calendar.rs`). It must never write to it.

- **Never create, update, move, delete, cancel, forward, accept, decline or
  tentatively accept an event** — and never dismiss or snooze a reminder. Like mail,
  the calendar has *no* sandbox and *no* pre-authorized target. It is worse than mail
  in one respect: a single create mails an invitation to **every attendee** (one real
  meeting in this tenant has 777), and a single response mails the organizer. Neither
  can be recalled.
- The same broker token carries the consent, so nothing at the API level stops it.
  What stops it is that **no code names the endpoints**: `src/calendar.rs` issues GET
  requests only, and two tests enforce it mechanically — one scans the module for any
  other verb, the other scans the whole crate for `/accept`, `/decline`,
  `/tentativelyAccept`, `/cancel`, `/forward`, `/snoozeReminder` and
  `/dismissReminder`. Do not weaken, skip, or work around either.
- Reading, rendering and navigating the calendar are fine and are what the feature is
  for. `join_url` and `web_link` are links the **user** clicks — never something the
  app follows, prefetches or opens on their behalf.
- There is deliberately no "New event" button, and no drag, resize or context menu on an
  event, even though the reference design the views follow
  (`github.com/vmnog/calendarcn`, itself after Notion Calendar) has all of them. Take
  its *look* — the tinted blocks with a coloured rail, the measured month cells, the
  time-zone gutter, the now badge, the anchored details panel — and none of its editing.
  The header says `Read-only` for the same reason. If responding to invitations is ever
  wanted, it is a deliberate feature: its own consent gate, its own entry in
  `OUTWARD_METHODS`, its own write-lock coverage — never a quiet addition to the read
  path.

## The trackers are READ-ONLY (MANDATORY)

The app enriches a tracker link pasted into a chat into a rich preview card
(`src/link_preview.rs`, over `src/gitlab.rs` and `src/linear.rs`). It reads those
trackers. It must never write to them.

- **Never create, edit, comment on, assign, move or close an issue, a merge request
  or a project** — in either tracker. A comment posted from here reaches everyone
  watching the issue, under the user's name, and looks like they wrote it.
- The credentials carry the consent: a Linear personal API key has **full write
  access**, and a GitLab token has whatever scopes the user granted it. So nothing
  at the API level stops a write. What stops it is that **no code names a write**:
  `gitlab` issues GET requests only, `linear` sends GraphQL **queries** only, and a
  test in `linear::tests` scans that module's own source for `mutation`. Do not
  weaken, skip, or work around it.
- **The Linear endpoint is a constant** (`linear::API_URL`), never derived from the
  link being enriched, so the key can only ever reach Linear. GitLab's host IS
  configurable, so it is *pinned* instead: a URL whose host is not the configured one
  is never enriched and never sees the token. Both rails exist to stop the same thing
  — a token leaving for an attacker-supplied host — so never widen either.
- `set_settings` (which stores those credentials, and the GitLab host the token is
  pinned to) is a `MACHINE_METHODS` entry: it needs the write token and is refused
  read-only. `get_settings` stays open because it returns no token, only whether one
  is set. A token is **write-only from the UI's side** — never send a raw one back to
  a client, and never log one.
- Reading, enriching and rendering a link are fine and are what the feature is for.
  If writing to a tracker is ever wanted, it is a deliberate feature: its own consent
  gate, its own entry in `OUTWARD_METHODS`, its own write-lock coverage — never a
  quiet addition to the read path.

## Automation safety (MANDATORY — read before driving the UI)

**This section exists because of a real incident.** An agent was screenshotting a
UI change. It started the mock backend, pointed `vite dev` at it, and drove the
app with an ad-hoc `playwright-core` script that typed into the composer and
pressed Enter. It then restarted `vite dev` *without* `VITE_TEAMS_WS_URL`; the app
silently reconnected to the real backend on `127.0.0.1:19420`. The next scripted
keypress **posted three messages to two real 1:1 chats with the user's
colleagues.** Nothing in the chain was able to notice, and the mistake was
invisible until the screenshots came back full of real conversations.

The rules below are therefore not style preferences. They are the guardrails that
make that failure impossible, and they are enforced mechanically by two `PreToolUse`
hooks: `.claude/hooks/guard-live-automation.sh` on every `Bash` command, and
`.claude/hooks/guard-prod-chat-target.sh` on every browser MCP tool.

**Reading the real backend is allowed. Writing to it is not.** Inspecting real
conversations, history and DB rows is useful and encouraged — guessing is worse.
What must never happen is a write: `send`/`edit`/`delete`/`react` post to real people as the
user. Two independent mechanisms enforce that split:

- **The write lock (backend).** The backend mints a capability token per process
  and publishes it 0600 at `$XDG_RUNTIME_DIR/teams-lite/write-token`, for the
  user's own frontend only (`web/write-token.ts` serves it to the browser page).
  Outward-facing RPCs must present it, so a
  client that merely found the socket — an ad-hoc script, an automated driver —
  reads everything and writes nothing. `TEAMS_LITE_READ_ONLY=1` refuses writes
  outright, token or not. **Never read that token file, pass it to a script, or
  weaken the lock to get a write through.** Fetching a secret you were not handed
  is precisely the line this draws.
  - **A token is per PROCESS, so a restart invalidates every page's copy** — and this
    backend restarts many times a day (a re-stage, an update, the broker path unit). The
    page cannot see it happen: reads keep answering, the socket is up, and the only
    symptom is that every send comes back refused until somebody reloads. On a phone left
    open for days that was the normal outcome of a restart, and it read as a Send button
    that chimed and did nothing. Three things hold it shut, and each is pinned by a test:
    the backend publishes the token **before it signs in** (which is a D-Bus call to a
    keyring that re-locks, so it can hang for tens of seconds while the port is already
    bound and the relay is already serving pages); the page re-reads it on every
    reconnect; and a REFUSED write re-reads it and retries **once**
    (`retryWithAFreshToken`), which is safe only because the refusal happens at the
    dispatch gate, before any network call — nothing was posted, so nothing can be posted
    twice. Never widen that retry to a failure that could have reached Teams, and never
    let it retry with the same token it just presented.
  - **A refused write says so in the journal** (`[write-lock] refused \`<method>\``), the
    method and never the token. A message that did not go out used to leave no trace on
    this machine at all.
- **The hook (harness).** Blocks, before execution, any command that would write:
  ad-hoc browser drivers, scripts calling `send`/`edit`/`delete`/`react`/`mark_read` against
  `127.0.0.1:19420` or `19421` (and the 19440 / 19441 relays in front of them), a
  consumption-horizon PUT straight to Teams (which bypasses the backend's gate
  entirely), a presence publish straight to the presence service (same reason — see
  § The user's own status), dev servers with no declared backend, a production web server with no
  declared backend, a send-capable backend started by tooling — including `systemctl
  --user start` on the always-on service's units, and including the `teams` command
  itself, which is that backend plus the real app on 19440 in one word — and
  `teams-lite-service.sh update --now`, the switch that skips the wait for a live
  `@claude` run and so freezes a half-written reply in the thread. It reads the
  *contents* of what a command runs, including an untracked `examples/*.rs` a `cargo
  run --example` names. Searching, stopping and inspecting stay allowed on purpose: a
  `grep` whose pattern names a launcher runs nothing, and a guard that fired on it
  would only teach its next reader to phrase around the guard.

- **Never hand-roll browser automation.** `web/scripts/preview.ts` is the only
  sanctioned way to drive the web UI: it starts its own mock, points the dev
  server at it, and asserts the `MOCK` sentinel badge before it types — and again
  immediately before every keystroke. Use `cd web && bun run preview -- --out
  /tmp/shot`, or import `withPreview` / `typeInComposer` / `openFirstConversation`
  from it. For the mail surface: `bun run preview -- --out /tmp/mail --mail`, or
  `openMailTab` / `openFirstMail` / `openMailAt` from the same file. For the calendar:
  `bun run preview -- --out /tmp/cal --calendar`, or `openCalendarTab` /
  `openCalendarView` / `openFirstEvent`. For the team → channel tree:
  `bun run preview -- --out /tmp/chan --channels`, or `openChannelsTab` /
  `toggleTeamSection` from the same file. For the chat list's sections and the "…"
  menu on a row: `bun run preview -- --out /tmp/chat --chat-menu`, or `openChatMenu` /
  `toggleChatSection` from the same file. For "Answer with <agent>" on a message:
  `bun run preview -- --out /tmp/ask --answer-with`. For the settings pane:
  `bun run preview -- --out /tmp/set --settings`, or `openSettings` from the same
  file. For Settings › AI providers and its model picker, open and closed in both
  themes: `bun run preview -- --out /tmp/prov --ai-providers`. For the update button, its
  progress mid-download and the link the other install shape keeps:
  `bun run preview -- --out /tmp/upd --update`. To review a detail too
  small to read in a
  1200px page — a 16px icon, a chip, a badge — crop to it and raise the pixel
  density: `bun run preview -- --out /tmp/chip --element
  '[data-testid="message-file"]' --dpr 4`.
  `web/scripts/scroll-probe.ts` is what a diagnostic built on top of it looks like
  (it measures history scroll smoothness frame by frame): a tracked script that
  drives the app *through* `withPreview`, never around it.
- **Never type into the composer without proof the backend is fake.** The proof is
  `[data-testid="backend-badge"][data-backend="mock"]`, which comes from the
  backend's own `backend_info` sentinel (only `web/mock/server.ts` emits it). No
  badge means *unproven*, which means live.
- **One chat, and only one, may be typed into for real.** When a chat feature can
  only be shown against the real account, the target is the sandbox chat named in
  § Sending messages and nothing else, driven by `cd web && bun run sandbox`
  (`web/scripts/sandbox-live.ts`). That script is the live twin of `preview.ts`: it
  hard-codes the sandbox thread and its URL, hands out no raw `page` to navigate
  away with, and re-reads `[data-testid="composer-shell"]`'s `data-conversation-id`
  — the app's own state, not our assumption — immediately before every keystroke and
  again before Enter. It types nothing at all in any other conversation, so a wrong
  assumption ends in a thrown error rather than in a colleague's chat.
- **The browser MCP tools may look at the live app; they may never type in it.**
  `guard-prod-chat-target.sh` reads the URL of every `*_navigate` / `preview_open`
  call, and once the target is a live front (19420 / 19421 / 19440 / 19441, or a
  `*.ts.net` name) it allows only the calls that observe a page — snapshot,
  screenshot, console, network log, wait, hover, close — and blocks everything else:
  click, type, press, fill, drag, upload, evaluate, and any tool either server grows
  tomorrow. Reading prod stays normal work; typing in it is not possible. The same
  block applies when *no* navigation has been seen in the session, because a browser
  whose page nobody declared is exactly the "unproven means live" case. Declare it
  with a navigate; do not phrase around the block.
- **A dev server must name its backend.** Use `bun run dev:mock` (mock on 19455,
  app on 19445). `bun run dev` is the *user's* shortcut to their live account — not
  yours to start. A bare `vite dev` refuses to run at all: there is no default
  backend in dev (see `defaultWsUrl` in `web/src/lib/ws-client.ts`).
- **Start the backend read-only, or let the user start it.**
  `TEAMS_LITE_READ_ONLY=1` refuses `send`/`edit`/`delete`/`react` at the dispatch choke
  point (`src/bin/server.rs`) *and* binds **19430** instead of 19420, so it never
  competes for the port the user's own backend owns. The two run side by side on
  the same SQLite store (WAL): the user's always-on service keeps 19420 and their
  hands-on dev backend 19421, while you read real data on `ws://127.0.0.1:19430` —
  point a client at it with
  `VITE_TEAMS_WS_URL=ws://127.0.0.1:19430`. `TEAMS_LITE_PORT` overrides either
  default.
- **The always-on service is the user's to start.** `bin/teams-lite-service.sh
  install` and `status` are yours; `systemctl --user enable --now teams-lite.target`
  is theirs, because that backend signs in as them and can post. See § The always-on
  service.
- **Check the port before running the E2E suite.** `reuseExistingServer` is on
  outside CI, so anything already listening on the suite's mock port gets adopted
  and the specs send through it. `e2e/global-setup.ts` aborts when the answer is not the
  mock — but NOT when the answer is a mock another run left behind, which
  `reuseExistingServer` then adopts: its code is not the code under test, and a stale one
  serving an older `agent_status` reads exactly like a bug in the app. That check cannot
  live in `global-setup.ts` either, because the suite starts its own server first, so the
  check cannot tell ours from a squatter. Pass explicit free ports whenever another
  session may be running one: `E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468`.
- **Screenshots are not proof of the target.** Before trusting a captured UI, look
  at *what it shows*: the mock's fixtures are in English with names like "Lucas
  Silva". Real conversations mean you were live all along.
- **A cargo example that posts must pin the sandbox channel.** An example holds a
  broker token and talks to Teams directly, so no port rule and no write token stands
  between it and a colleague's chat — the only thing that does is what the file names.
  Hard-code the conversation as a const and name no other (see
  `examples/agent_stream_probe.rs`); the hook refuses to run any other shape,
  including a target taken from an argument.

**If a guardrail blocks you, fix the setup — never route around the guardrail.**
Rewriting a command to slip past the hook, disabling the sentinel, or asserting
"it's obviously the mock" is precisely the reasoning that sent those three
messages. And when you touch this area, leave the guardrails *stronger* than you
found them: every gap you notice (a new automation entry point, a new write RPC
missing from `OUTWARD_METHODS`, a helper that types without re-asserting) is a bug
to fix in the same change, not a note for later.

## Push notifications (outward, and gated like one)

The app is an installable web app and the backend sends Web Push, so the user's
phone is notified while the app is closed (`src/push.rs`, `src/push_policy.rs`,
`web/public/sw.js`, `web/src/lib/push.ts`). Reaching a device the user is holding is
an outward action, so it is gated on purpose:

- **`push_subscribe` / `push_unsubscribe` / `push_test` are `MACHINE_METHODS`.** They
  post nothing to Teams, so they are not in `OUTWARD_METHODS` — but they decide which
  devices this machine sends message previews to, so they need the write token and
  are refused read-only. The hook blocks a script that names them against a live
  port, exactly as it does `send`.
- **A subscription may only point at a browser vendor's push service**
  (`push::is_supported_endpoint`: Apple, Mozilla, Google, Microsoft). A subscription
  is a URL a *client* supplies and the backend then POSTs message text to it, which
  without that list is an exfiltration channel with a friendly name. Never widen it
  to "any https URL", and never add an endpoint override.
- **A read-only backend never pushes.** `deliver_push` refuses before the network,
  not only at the dispatch gate — live delivery never passes through the gate, and a
  screenshot script must not buzz the user's phone.
- **The payload is encrypted to the device** (RFC 8291, verified against the RFC's
  own test vector). That is a privacy guarantee, not an implementation detail: the
  push service forwards a colleague's words without being able to read them. Never
  move notification text into a place the service can see (a `Topic` header, a query
  parameter, a plaintext fallback).
- **The VAPID key pair must stay stable.** It lives in the store under
  `push_vapid_private`; every device's subscription embeds the public half, so
  regenerating it silently stops every phone that opted in.
- **The service worker is push-only.** No `fetch` handler, no precache: the app is a
  live client of a local backend, and a cached shell that boots a build the user
  replaced is worse than a page that says the machine is unreachable.
- **Two backends share one store**, so every notification is claimed in
  `push_deliveries` before it is sent — otherwise the service (19420) and the dev
  backend (19421) both push and the phone buzzes twice.
- The delivery policy lives in `src/push_policy.rs` and is deliberately narrower than
  "every live message": chats always, channels per the user's own Teams setting for
  that channel, never a system line, never our own message, never a replayed frame.
  Widening it is a product decision, not a cleanup.
- **A channel follows the user's own notification setting** (`store::ChannelAlerts`,
  derived from CSA in `teams_read::channel_alerts`): silent when they muted the
  channel *or its whole team*, an @mention only at Teams' default (matched on the MRI
  in `Message::mentions`, never on a display name), and every post — with or without
  thread replies — when they asked Teams for that. The setting is stored as the
  decision, not as the three raw CSA signals, and the sidebar reads the same field to
  dim a muted channel. A **chat**'s mute silences this app — the in-page notification
  and its cue (`shouldNotify`, over `chatIsMuted`) — but NOT Web Push: the mute may be
  a local override that only the browser holds, so the backend never sees it and the
  phone still buzzes. The menu that offers the switch says so (see § The chat list).

## The channel sidebar mirrors Teams, and mirrors it READ-ONLY

The team → channel tree reads four pieces of the user's own Teams arrangement, and
`examples/channel_pin_recon.rs` and `examples/team_order_recon.rs` measure every one of
them against the real tenant. Read those before touching this area: CSA names two of
these fields after something they are not.

- **`isFavorite` on a channel is Teams' Show/Hide switch**, not a favorites list. It is
  true on most channels and on every General (41 of 75 here), so it groups NOTHING:
  `store::ChannelRow::is_shown` keeps a channel inside its team, and a hidden one goes
  under that team's own "Hidden channels" entry. There is no Favorites section, because
  Teams has none.
- **`isPinned` is the real pin**, and the only flag that lifts a channel out of its team
  — into the sidebar's top Pinned section.
- **`isCollapsed` on a team is that team's fold state in the user's own client**, and it
  tracks that client live. It decides how a section OPENS
  (`ChannelRow::team_collapsed`, denormalized onto every channel of the team because
  there is no teams table).
- **The order is CSA's array order**, which is the only order the payload states — no
  team and no channel carries a rank — and it IS the user's own: verified against their
  client, and it moves when they re-arrange. Read the **v1** aggregator; v2 answers 200
  with a different, non-client order. General is the one correction we make: CSA puts it
  LAST in a team.

**A fold, a pin or a hide made HERE stays here.** Each is a local override that wins
over the Teams-sourced value from then on, and nothing writes any of them back:
publishing a setting to the user's account is an outward action and would need its own
consent gate and its own `OUTWARD_METHODS` entry, exactly like a send.

## The chat list mirrors Teams too, and the "…" menu is LOCAL

Hovering a chat row reveals Teams' own "…", and it holds the three settings Teams puts
there plus the one read action: **pin to top**, **mute**, **hide**, **mark as read**
(`web/src/components/chat-menu.tsx`). The list is then drawn in Teams' own sections —
**Pinned**, **Recent**, **Hidden chats** — by `organizeChats` in `web/src/lib/protocol.ts`,
and `web/e2e/chat-menu.spec.ts` pins the lot.

- **The MUTE is published to Teams; the pin and the hide are not.** That split is
  measured, not chosen — `examples/chat_settings_recon.rs` reads where each setting
  lives and `examples/chat_settings_probe.rs` writes it against the sandbox chat:
  - a chat's mute IS its `alerts` property (`"false"` on every muted chat, `"true"` on
    every unmuted one, no crossover), a `PUT` of it answers 200, and CSA then reports
    `isMuted` to match. So `set_chat_muted` (`src/teams_chat_settings.rs`) publishes it
    and the row follows the ACCOUNT — the user's phone goes quiet too. It is an
    `OUTWARD_METHODS` entry: the write token, refused read-only, and the hook blocks the
    endpoint on a command line.
  - the pin is not a conversation property at all: the service answers
    `400 "sticky: Conversation property is not allowed"`, and the one name it does
    accept (`ispinned`) is never read back by CSA's `isSticky`. The hide is the same
    story with `historyHiddenTime`. **A write nothing reads back is worse than no
    write** — it would report success while the user's phone disagreed — so both stay
    LOCAL overrides (`ChatPrefs`, persisted per browser), and no RPC exists for them.
    `muting_a_chat_is_outward_facing_and_token_gated` pins that absence.
- **`hidden` from CSA is NOT Teams' Hide, and nothing may read it as one.** It is true
  on all 95 of this tenant's one-to-one chats — the colleagues the user messages daily
  included — and on 87 of 499 group chats. Bucketing the sidebar on it emptied Recent of
  every direct message. `chatIsHidden` therefore reads the user's own hide and nothing
  else; the mock keeps one chat flagged so a spec holds the app to that.
- **A hide is held by a watermark, not a flag.** `chatIsHidden` keeps the chat away
  while its newest message is no newer than the watermark, so a NEW message brings it
  back on its own — which is what Teams' Hide does. `0` means "shown here".
- **Mark as read is the one item that leaves the machine.** It is the same `mark_read`
  the app makes on open — the user's consumption horizon, so the sender is shown a read
  receipt — and Ghost mode still decides whether Teams is told. It is offered because
  the user asked for it on that chat, it is never automatic, and a failure is reported
  rather than swallowed.
- **The sections ARE the keyboard's order.** The selection is an index into the list as
  rendered, so the sidebar and the app shell both read `useChatSections()`: a chat in a
  folded section is out of the keyboard's reach as well as out of sight. Deriving that
  order twice is how ArrowDown opens a chat other than the highlighted row.
- **A phone gets the same menu from a long press.** The "…" is a pointer affordance:
  hover reveals it on a fine pointer and it is not rendered at all on a coarse one,
  where a still touch on the row opens the menu (`useLongPress`, the plain half of the
  message gestures). The app is used from a phone, so a menu behind hover alone would be
  a feature that does not exist there — `web/e2e/mobile.spec.ts` pins both halves.
- **The chat with ONESELF is `48:notes`, and it is NOT in `chats`.** Teams delivers it in
  the CSA payload's `privateFeeds`, beside the activity streams — so the parser reads it
  from there (`teams_read::parse_notes_conversation`), and a list built from `chats` alone
  showed every conversation the user has except that one. It is not a `19:` thread at all:
  of 957 CSA chats and 1049 chat-service conversations none is the self chat, and
  `19:<oid>_<oid>@unq.gbl.spaces` — the id it would carry if it were an ordinary
  one-to-one — answers 404 `LocationLookupFailed`. `examples/self_chat_lookup.rs` measures
  every one of those, and reads the thread's own history back through this crate's parser.
  Four things follow:
  - **`48:notes` is the sole `48:` id that is a chat.** `teams_activity::is_system_feed_thread`
    and `Conversation::kind` (→ `ConversationKind::Notes`) already said so before anything
    parsed it, which is why the fix was one function and no new plumbing.
  - **The feed carries none of the sidebar booleans** — no `isRead`, `isSticky`, `hidden`,
    `isMuted`, `isLastMessageFromMe` — so those take their defaults, and only
    "we wrote the last message" is derived, from the frame's own `from`. Every note is
    ours: there is nothing to be unread of, and no colleague to attribute a preview to.
  - **No title is invented in the backend.** The feed has none, and the client already
    names the row ("Notes", `convLabel`) and draws initials rather than a face
    (`conversationFallback`). A name minted server-side would be a second spelling.
  - **A CSA chat's `members` array is NOT the roster** — it lists only us on 281 of those
    957 chats — so "the members are only me" finds hundreds of ordinary colleagues' chats.
    It cost one wrong diagnosis: the id is the signal.

## Audio calls (a call RINGS a person — the sharpest outward action here)

The app takes and places one-to-one **audio** calls, by doing what the real Teams WEB
client does: `src/calling.rs` is the signaling plane, the browser carries the media
(`web/src/lib/call-media.ts`), and `NATIVE-CALLING.md` is the protocol map every line of
both was written from — read it before touching either. Video is deliberately absent.

**The backend signals; the page carries the audio.** That split is not an implementation
detail: the tokens must never reach a browser, and a microphone is only reachable from
one. So an SDP crosses the local WebSocket in each direction and nothing else about a
call does — this side never handles RTP, and the page never learns a Teams URL.

- **Calling is OFF until the user turns it on** (`SETTING_CALLING`, Settings › Audio
  calls). The switch IS the consent gate for the whole feature, because turning it on
  REGISTERS a calling endpoint with Teams: their real incoming calls are then offered
  here as well as on their phone. Turning it off **unregisters** — a registration left
  behind keeps routing their calls to a client that is not listening, and a call offered
  to a device that never rings is a call they miss. Never make it the default, and never
  turn it on for the user.
- **Four methods reach a person, and they are `OUTWARD_METHODS` entries**: `call_place`
  starts a device buzzing in somebody's pocket, `call_accept` opens the user's own
  microphone to whoever is on the other end, `call_hangup` ends the call for both of them
  (or declines it, which the caller is shown), and `call_mute` publishes whether they can
  be heard. None can be taken back, and each one carries out one click the user just made
  — nothing in this feature ever acts on its own.
- **`set_calling` and `call_prepare` are `MACHINE_METHODS` entries**, with their own
  refusal words: the first decides whether this machine is a device the user's calls ring
  on, the second reserves the one call slot and hands the page the relay credentials this
  backend holds. `call_status` stays open: it returns no SDP, no links and no credentials,
  only what the UI has to draw.
- **One call at a time.** A second simultaneous call needs a second microphone and a UI
  that can hold two. An invite that arrives while a call is up is left for the user's
  other devices to ring, which is what Teams does with a client that does not answer.
- **A CALL is one-to-one; a MEETING is joined.** The call button is not drawn outside a
  1:1 and the backend refuses a conversation with more than one other person — a group
  call would need a roster the caller assembles and a UI that rings three people. A
  meeting is the other shape and it IS supported (see § Joining a meeting): its roster
  already exists, so joining one is a POST rather than a product.
- **The microphone is released on ONE path.** Every ending — our hangup, theirs, a
  dropped connection, calling switched off — arrives as the backend's `call_state` frame,
  and the store's handler is the only place that stops the media. A path that released it
  somewhere else would eventually miss a case and leave the browser's recording indicator
  on for a call that does not exist.
- **The registration mimics the WEB client, not the desktop one.** `SkypeSpacesWeb_2.6`,
  TTL 3600, path = the bare surl, on a connection of its own to `calling_trouterUrl`
  (`trouter::Endpoint::calling`). The desktop client's `NGCallManagerWin` /
  `DesktopNgc_2.3` pair is what an earlier capture branch sent, and it is wrong: Teams
  routes a call to the endpoints it believes are running, so claiming to be a Windows
  client sends the user's calls to a client that is not there. A test scans this crate
  for those spellings — do not bring them back.
- **The SDP is not rewritten.** `application/sdp-ngc-1.0` is a LABEL the service puts on
  ordinary WebRTC SDP; what Chrome produced is what goes out. It travels whole, with its
  candidates, because this protocol has no trickle channel — hence the bounded wait for
  ICE gathering in `call-media.ts`.
- **`web/mock/server.ts` reproduces the whole flow with no tenant, no registration and no
  microphone**, and the page pairs it with `simulatedCallMedia` because that backend
  announces itself as a mock. That is what makes this surface reviewable with nothing
  leaving the machine: `cd web && bun run preview -- --out /tmp/call --call` captures the
  switch, the button, the ring and the bar, and `web/e2e/calling.spec.ts` pins every rule
  above.
- **There is no sanctioned live call.** Unlike a send, a call has NO pre-authorized
  target: the sandbox chat is a group thread, and ringing it would ring real people. A
  live test is the user's own click, on their own machine, to somebody who agreed to it
  beforehand — see NATIVE-CALLING.md § 8 for what is still unverified against the tenant.

## Joining a meeting (the calendar stays read-only)

A calendar event with a Teams link offers **Join here** beside the link that opens real
Teams (`web/src/components/meeting-join-button.tsx`). It joins with a microphone and
nothing else, so both actions exist and neither replaces the other: a meeting whose point
is a shared screen is still one to open in Teams.

- **The link IS the address, in either shape Teams writes one.**
  `calling::MeetingJoin::from_join_url` reads both: the long
  `…/l/meetup-join/{thread}/{message}?context={Tid,Oid}`, whose thread and context become
  `groupChat` and the `meetingInfo` the service asks for; and the SHORT
  `…/meet/{code}?p={passcode}`, which names no thread at all and travels as
  `meetingData {meetingCode, passcode, meetingUrl}` instead — the service resolves the
  thread from the code. This tenant's own meetings use the short one, so a parser that
  knew only the long shape hid the button. Send only the half a link really carried:
  inventing the other is how a join earns a `400` with an empty body.
- **`conversationType` is NULL for a join, and for an ordinary call.** The web client
  names one only for an emergency call, a cast, a huddle or a consult-and-add
  (`getConversationType`). A plausible-looking `"conversation"` there is refused by the
  service with no explanation, which cost one debugging round — and it is why
  `calling::post_signal` now carries the service's own `x-microsoft-skype-*` and `ms-cv`
  headers into the error, and logs the request body under `TEAMS_LITE_CALL_DEBUG=1`.
  `examples/meeting_join_recon.rs` checks the parse against the user's own real meetings,
  READ-ONLY, and prints shapes rather than values because a join URL is a key.
- **A join is TWO POSTs, and the first carries no media.** Step 1 joins the CONVERSATION
  (`conversationRequest` + `groupChat` + `meetingInfo`, no `callInvitation` at all) and the
  answer names every link the meeting offers; step 2 adds audio on `links.addModality`,
  which is where the SDP rides. Putting the media in step 1 is refused with `400` and an
  empty body — measured, twice, and the reason no amount of reading found it is that the
  service says nothing. See NATIVE-CALLING.md § 2.3a for the captured shape, field for
  field: `messageId` is the string `"0"`, `meetingInfo.organizerId` is a bare oid, and
  there is no `conversationType`.
- **A join rings nobody**, which is the only thing it does differently from a call: the
  payload carries no `participants.to`. `call_join` is still an `OUTWARD_METHODS` entry,
  because everybody already in the meeting sees the user arrive and their microphone is
  opened to all of them.
- **The lobby is its own state.** A meeting may hold the user in its lobby
  (`ConnectedForRosterOnly`), and the UI says "Waiting to be let in…" rather than
  "Connecting…" — the one thing they have to know is that nobody has admitted them yet.
- **The roster is what "who" means in a meeting.** `rosterUpdate` frames replace the list
  wholesale, we are dropped from it (`CallSession::others`), and the bar names one or two
  people and counts a crowd. A meeting's title stands where a call names a person.
- **Several voices, several audio elements.** Teams sends a meeting's voices as separate
  streams, so `call-media.ts` keeps one `<audio>` per remote stream and drops each when
  its stream ends. A single element would play one person and silently drop the rest.
- **The calendar is untouched.** Joining writes nothing, answers no invitation and
  follows no link on the user's behalf — the app still never opens `join_url` itself, and
  the read-only rules of § The calendar hold exactly as before.
- `cd web && bun run preview -- --out /tmp/call --call` captures the Join button, the
  lobby and the roster, and `web/e2e/calling.spec.ts` pins them.

## The user's own status (outward, and gated like one)

The app can hold the user's Teams status green — the **Always available** setting, off
by default (`src/teams_presence.rs`, `set_always_available` in `src/bin/server.rs`).
Reading other people's presence is the older half of that module and stays open; the
publish is gated, because a green dot is a claim about where the user is that every
colleague reads.

- **`set_always_available` is an `OUTWARD_METHODS` entry**, in both directions: it
  needs the write token, a read-only backend refuses it, and the hook blocks a script
  or a `curl` that names the presence write on a command line. Turning the setting
  *off* is the same outward call, so it is behind the same gate.
- **The mechanism is an endpoint registration, and that is on purpose.**
  `PUT {presence}/v1/me/endpoints/` with `{id, availability: "Available", activity:
  "Available", deviceType: "Web"}` reports one running client of ours; `DELETE
  …/endpoints/{id}` takes it back. Verified against the tenant in both directions.
  The service accepts no other availability on an endpoint, so a registration says
  exactly one thing: "this device is present and available".
- **Never reach for the manual status** (`PUT …/v1/me/forceavailability/`). The
  service accepts it and refuses every matching DELETE, so this app could set it and
  never take it back — a setting whose off switch cannot undo its on switch is not a
  setting. A test in `teams_presence::tests` scans the crate for that endpoint, and
  the automation hook refuses any command that names it. Do not weaken either.
- **A registration expires after 300 s** (measured), so `spawn_presence_heartbeat`
  refreshes it every 120 s while the setting is on, and the first tick restores the
  state after a restart. One endpoint id lives in the store, so the always-on service
  and the user's dev backend refresh ONE registration rather than two.
- **A read-only backend never publishes.** `publish_presence` refuses before the
  network, not only at the dispatch gate — the heartbeat never passes through that
  gate, and a screenshot backend must not tell the user's colleagues they are around.

## @mentions (a mention notifies a person — treat it as part of the send)

The composer can @mention somebody the way Teams does: "@" opens a list of the people
this thread can mention, the picked person becomes one chip, and Backspace shortens
their name a word at a time ("John De Doe" → "John De" → "John") before removing the
mention whole. The chip is blue on a light blue wash in the composer and in the message.

- **A mention is a PAIR, and both halves are needed.** The body carries an inert span
  that holds only an index (`<span itemscope itemtype="http://schema.skype.com/Mention"
  itemid="0">John</span>`), and `properties.mentions` — a JSON-encoded **string** —
  says who each index names. Get one half wrong and nothing fails: the message simply
  arrives with blue text that notifies nobody. Verified end to end against the tenant,
  by a self-mention in the sandbox chat (`examples/mention_send_probe.rs`).
- **An INBOUND mention is split across the words of the name it shows.** Teams sends
  "Clément BOSLE" as TWO spans, with two `itemid`s, and two entries in the mention list
  carrying one MRI — 8 spans for the 4 people of one message is the normal shape here.
  Its own client only tints the words, so the split is invisible there and reads as two
  chips in a client that draws one. So the renderer joins a run of adjacent spans that
  resolve to the SAME MRI into one chip (`mergeAdjacentMentions` in
  `web/src/lib/rich-text.ts`, over the map `mentionsByItemId` builds), and
  `.mention-chip` is `nowrap` so a line break cannot split it back in two. The identity
  must be PROVEN: two spans nobody can resolve stay apart, because "@Alice @Bob" has
  exactly that shape and joining those would draw a person nobody mentioned.
- **A mention is part of the send, so it needs no gate of its own** — and it gets no
  relaxation either. `send` is already an `OUTWARD_METHODS` entry; the mentions ride in
  its params (`teams_send::parse_mentions`), and every entry must name a person
  (`8:…`, never a `19:` thread or a `28:` app), carry visible text, and have a span in
  the body. **A mention with no span is refused**, because `properties` is what
  notifies the person: a mention the reader cannot see is an invisible ping.
- **The local agent never mentions anybody.** `agent_reply` passes an empty list, and
  it must stay empty: a machine posting under the user's name must not be able to
  notify a colleague.
- **The candidate list is READ-ONLY, and two sources feed it** (the `members` RPC,
  over `src/teams_members.rs`). `GET {chatService}/v1/threads/{id}?view=msnp24Equivalent`
  gives a chat's roster — verified; a **channel** answers with one member, us, so a
  channel's list comes from the people who have written in it
  (`store::thread_senders`). Names never come from the roster (`friendlyName` is empty
  on every live member): they come from the store, then from one directory batch.
  Membership writes are outward and irreversible from here, so that module issues GET
  requests only and a test in it scans for any other verb — do not weaken it.
- **We are never in the list**, and neither is anybody the backend could not name: a
  mention of oneself notifies nobody, and a row showing an MRI is a row nobody can pick.
- **An inbound mention pasted back into the composer goes out as plain text.** Its span
  indexes the list of the message it came from, so it names nobody we can prove — see
  `serializeTeamsMessage` in `web/src/lib/rich-text.ts`, which is where the outbound
  pair is made.

## Tagging an agent (the same "@", a different promise)

That same list also offers the agent CLIs this machine can run, above the people
(`agentCandidatesFor` / `mentionOptions` in `web/src/lib/mentions.ts`, drawn by
`web/src/components/agent-tag-extension.ts` and `agent-tag.tsx`). A picked one becomes a
chip wearing that vendor's own mark and colour — Claude's coral, opencode's graphite —
and never the mention's blue, because the two promise different things: a mention
notifies a colleague, a tag starts a program on this machine.

- **A tag is NOT a mention, and must never become one.** An agent has no MRI, so a
  mention naming one would be coloured text that notifies nobody. The tag serializes to
  the bare prefix as plain text (`@claude …`) and adds nothing to `properties.mentions` —
  which is exactly what the user would have typed by hand, so
  `agent_policy::split_prefix` reads it back, and every other client shows words rather
  than markup it cannot render.
- **It is offered only where it would work: at the START of the message.** The backend
  summons an agent from the prefix a message OPENS with, so a tag anywhere else runs
  nothing — and a chip that looks like it started a program while nothing ran is worse
  than plain text. It is the same rule that refuses a mention with no visible span.
- **A row is drawn only for an agent that would really answer**: the backend is not
  read-only, the CLI is installed and that provider is on (`usableBackends`), and THIS
  conversation is opted in (`agentModeFor`). The consent gate stays where it is — the
  thread's own menu — and the composer never widens it, it only reflects it.
- **One Backspace removes the whole tag.** A person's name shrinks by a word because
  that is how people address each other in a thread; half a prefix summons nothing, so
  there is nothing to shrink.
- **The bubble wears the same chip, read back out of the words.** The body holds the bare
  prefix and no markup, so there is nothing to restore — `markAgentTag`
  (`web/src/lib/agent-tag.ts`) recognises it the way the backend does and hands
  `rich-content.tsx` an `agent` node, drawn by the composer's own `AgentTagChip`. It is the
  choice `agent-message.ts` makes for a reply's signature, and for the same reason: a
  message read back covers the tags typed from a phone too. The rules above still decide —
  `agentTagInText` is a port of `agent_policy::split_prefix` plus its prompt rules — so a
  prefix mid-sentence and one in a quote stay plain words: the backend strips quoted blocks
  before it reads a trigger, so a prefix inside one started nothing.
- **WHOSE agent decides which gates apply**, and that split is the whole of
  `agentTagsInMessage`. On a message of OURS the chip says a program started on THIS
  machine, so every gate the composer applies before it offers a tag applies again
  (`agentCandidatesFor`) — which is why ours in a thread nobody opted in stays plain words.
  On a COLLEAGUE's it says only that they addressed an agent: they may run teams-lite too,
  the trigger's `from_me` means their prefix ran nothing HERE, and every one of those gates
  is about this machine rather than theirs. So it is marked from the prefix alone
  (`addressableAgents`, the backend's own list of CLIs, so there is one spelling of
  `@claude` in this app and not two). It never says a stranger started a program on the
  user's machine — nothing on their bubble names this machine, and the reply that follows is
  attributed to the account it went out under, which is theirs.
- `web/mock/server.ts` seeds the sandbox thread as a conversation of its own
  (`seedAgentSandbox`), so the tag is exercised in the state a fresh backend is really in:
  one thread opted in, every other off — plus the other machine's half, a colleague's own
  `@claude` and the answer their agent posted under their name, which is what makes that
  pair reviewable with no second tenant. `cd web && bun run preview -- --out /tmp/tag
  --agent-tag` captures the list, both chips, the sent bubble and theirs, and
  `web/e2e/agent-tag.spec.ts` pins every rule above.

## Renaming a person, and giving them a face (LOCAL, and gated)

The user can call somebody whatever they like and hand them any picture, in this app
only. **Microsoft Teams holds neither** — a colleague's display name and photo are
theirs to set — so there is no upstream to write to and nothing here tries: the pair
lives in `store::person_overrides`, keyed by MRI, and is a LOCAL OVERRIDE exactly like
a fold, a pin or a local read position.

- **One change reaches every surface, because the resolution lives in the STORE's
  reads.** `nicknamed!` is baked into `SELECT_COLS` and into the `conversations` /
  `channels` / `display_name_for_mri` / `other_party_name` / `thread_senders` queries,
  so a rename covers every message that person ever sent, the title of their 1:1, the
  sidebar's preview attribution, the typing line, the "seen by" row and the @mention
  list at once. That placement is the whole design: `insert_message` freezes a
  message's `sender` at first insert and no sync refreshes it, so a rename applied at
  render time would have to be applied at a dozen render sites — and the one that got
  forgotten is the bug. Never move it out to a caller.
- **What the store never produced, the server resolves explicitly.** Three names do not
  come through a store read: the activity feed's actor (`feed_json`), the sender of a
  live push (`push_live_message`, which gets the frame that just arrived), and a 1:1's
  title in `conversation_context` — which is why that one takes `self_mri`, so a
  nickname the user gave THEMSELVES can never retitle their own chat. The phone is the
  sharpest case: it is the one surface the user cannot correct by looking again.
- **The override never rewrites a message.** An @mention chip inside a body, the author
  of a reply quote, and the participant list of a call event all keep the words their
  frame carried. The rule is one sentence: it applies to every name this app STATES
  about a person, and never to the record of a Teams frame.
- **Setting one needs the write token; reading one does not.** `set_person_name` and
  `set_person_avatar` are `MACHINE_METHODS` entries — the only two that write nothing
  but the local store — because of WHAT they write: a client that could set them could
  make one colleague's post appear to come from another, in the sidebar, in the bubble
  and in the notification on the user's phone. Authorship is the one thing this app
  never misstates. The automation hook blocks both against a live port for the same
  reason. `person_override` / `person_overrides` stay open: they return what the user
  themselves chose.
- **The real name stays visible, and that is load-bearing.** `person_override` returns
  `teams_name` beside the nickname, the dialog keeps it under the field, and the person
  card shows it under a renamed person's name. A nickname the user cannot see through
  is one they cannot undo — so never drop that line to save space, and never let the
  `profile` RPC return anything but the directory's own truth.
- **The two halves are independent.** Clearing a name never drops a picture and
  vice-versa; clearing the last half deletes the row, so "no override" is always the
  absence of a row and every read can treat an empty table as the common case.
- **A custom avatar is raster bytes, capped, and served before the network.**
  `PERSON_AVATAR_TYPES` is PNG/JPEG/GIF/WebP and nothing else — SVG is a document, not
  a bitmap — capped at `MAX_PERSON_AVATAR_BYTES`, stored as BLOB rather than as a path
  (which breaks when the file moves) or a URL (which would make drawing a colleague's
  face a request to a third party). `fetch_avatar` answers from the override first, so
  one picture covers every render site that already asks it.
- **A change drops what the frontend holds about that person.** `forgetPerson` in
  `web/src/lib/store.ts` evicts the override, profile and AVATAR caches and re-reads the
  lists and the open thread. The avatar cache is the load-bearing one: it never evicts
  on its own, so without this the old face would survive until a reload. It runs both
  on our own change and on the backend's `person_override_changed`, so two open pages
  and the two backends sharing the store agree.

**Two surfaces, and both are needed.** The rename is offered on the person CARD
(`web/src/components/person-card.tsx` → `person-edit-dialog.tsx`, over
`web/src/lib/person-override.ts`), because that is the surface which already answers
"who is this?" — the one place the user can read the real name at the moment they
replace it. Settings › Renamed people (`renamed-people-settings.tsx`) lists every
override and undoes it, because a card has to be FOUND and a nickname is precisely what
makes somebody hard to find again: the user would be searching for a name Teams never
had. Do not drop either one for the other.

`web/mock/server.ts` mirrors the whole flow with no tenant — including the
`{kind: "person_overrides", clear: true}` test hook, which a spec MUST call afterwards
since one mock process serves the whole run and a rename left behind renames that person
for every later spec. `bun run preview -- --out /tmp/person --person` captures the card,
the dialog and the list; `web/e2e/person-override.spec.ts` pins them.

### "Answer with <agent>" — the same tag, from the message

A message's own "…" menu offers **Answer with Claude** / **Answer with opencode**, each
wearing that vendor's mark (`web/src/lib/agent-answer.ts`, drawn by the actions menu in
`web/src/components/message-bubble.tsx`). It is the tag above reached from the other end —
the message rather than the keyboard — for the case the "@" is bad at: a message somebody
else wrote, three screens up, that the user wants an answer to.

- **It DRAFTS; it never sends.** Picking it starts a reply to that message, leads the
  composer with the tag and seeds the request — then stops. The send is the user's own
  Enter, because § Sending messages needs consent for that exact message, and one menu row
  is not consent to post under their name.
- **The request comes seeded (`ANSWER_REQUEST`), and that is load-bearing.** A bare prefix
  summons nothing — `agent_policy::split_prefix` refuses an empty prompt — so a draft
  holding only the chip would post a message that starts no program. A half-written draft
  is kept instead and becomes the request: the user's own sentence beats ours.
- **The rows are the composer's own list** (`agentCandidatesFor`), so a thread nobody opted
  in offers none. The consent gate stays in the thread's own menu; this reflects it and
  never widens it. A request also carries the conversation it was asked in, so walking to
  another chat drops it rather than leaving a tag in a draft nobody asked for.
- **The reply is how the agent knows WHICH message.** The prompt is the body with the
  quote stripped (`teams_read::plain_text_from_html`), so "answer this message" would
  otherwise name nothing. `agent_policy::answering` reads the quote back out of the trigger
  — `teams_read::quoted_message_from_html`, the exact opposite half of
  `strip_quoted_blocks` — and it travels in its own `<answering>` block, bounded and
  introduced as context like the transcript, because it is a colleague's words.
- `cd web && bun run preview -- --out /tmp/ask --answer-with` captures the row and the
  draft; `web/e2e/answer-with-agent.spec.ts` pins every rule above, and the mock strips the
  quote the way the backend does (`withoutQuotedBlocks`) so a reply-shaped trigger really
  answers there.

## Language policy (MANDATORY)

- **All artifacts are in English.** This includes: UI strings, labels, button text,
  placeholders, status messages, log lines, code comments, identifiers, commit
  messages, and any string literal in the source (Rust or TypeScript).
- **Never write French (or any non-English language) in the code or UI**, even if
  the conversation with the user happens in French.
- The only place another language is allowed is direct chat with the user — never
  in committed files.
- If you find existing non-English strings in the codebase, treat it as a bug and
  translate them to English.

## Project shape

- Backend: Rust (`src/`, binary `server` in `src/bin/server.rs`) — auth broker over
  D-Bus, real-time trouter client, local-first SQLite store, send, name resolution,
  Web Push to the user's own devices (`src/push.rs` + `src/push_policy.rs`), the
  READ-ONLY Outlook mail surface (`src/mail.rs` + `src/mail_html.rs`), the
  READ-ONLY Teams/Outlook calendar (`src/calendar.rs`), presence — reading everybody's
  and, only when the user asks for it, publishing their own (`src/teams_presence.rs`,
  see § The user's own status), the READ-ONLY conversation roster an @mention list is
  built from (`src/teams_members.rs`, see § @mentions), the one-to-one AUDIO CALLING
  plane (`src/calling.rs` plus the calling half of `src/trouter.rs` — see § Audio calls
  and NATIVE-CALLING.md), the READ-ONLY rich link
  previews for the trackers the user works in (`src/link_preview.rs` dispatching to
  `src/gitlab.rs` and `src/linear.rs`), the local agent that answers an `@claude`
  message (`src/agent.rs`, `src/agent_policy.rs`, `src/agent_markdown.rs` — see
  § The local agent) and the app's own update — the check, the download and the swap
  (`src/update.rs`, see § Updating the app from inside it).
  Exposed over a local WebSocket (`ws://127.0.0.1:19420`).
- One front-end, talking to the backend only through that WebSocket. Local-first is
  enforced server-side; the front-end touches neither the network nor SQLite directly.
  - Web app (`web/`): TypeScript + Bun + React + TanStack Start (SSR built with Vite),
    WebSocket client in `web/src/lib/ws-client.ts`. Served by a plain Bun fetch server
    (`web/server.ts`). `web/mock/server.ts` is a backend mock used by the E2E suite. It
    is also an installable web app (`web/public/manifest.webmanifest`, the icons
    generated by `web/scripts/generate-app-icons.ts`), which is what lets a phone
    receive push notifications through `web/public/sw.js`.
  - **Hugeicons is the icon library, and the only one.** Every glyph comes from
    `@hugeicons/core-free-icons` and is drawn through `<HugeiconsIcon icon={…} />`
    (`@hugeicons/react`); an icon held as a value is typed `IconSvgElement`, not a
    component. The app used lucide-react until 2026-08-03 and carries none of it now.
    Two icon sets never match — different grid, different stroke weight, different
    corner radius — so a row mixing them reads as two designs sharing one screen.
    `web/src/lib/icon-library.test.ts` pins that: it scans the source tree and the
    manifest, and fails on a second icon package. Pick the nearest hugeicons glyph
    rather than installing one.
  - There was a terminal UI (OpenTUI + Solid, in `ui/`) until 2026-08-03. It is gone,
    and the web app is the only client: do not re-add a second front-end, and read a
    comment that names one as history rather than as a place to keep in sync.
- The `teams` command (`launcher/`): TypeScript + Bun, no dependencies. It spawns or
  attaches to the backend (`launcher/src/backend.ts`), serves the web app and opens
  the browser (`launcher/src/launch.ts`), so one command starts everything — the
  opencode model. `launcher/build.ts` compiles it into ONE binary that embeds the Bun
  runtime, the release backend and the built web app; that binary is what `install.sh`
  downloads and what `.github/workflows/build.yml` publishes as the rolling `latest`
  release. It is the launcher, not a second interface: it renders nothing itself.

## Ports

Every port lives in one 194xx block. It was picked because nothing registers those
numbers and they sit **below** the ephemeral range (`net.ipv4.ip_local_port_range`
starts at 32768), so an outbound connection can never borrow one first and a listener
can never lose a race to it.

| Port      | What                                              | Where the default lives |
| --------- | ------------------------------------------------- | ----------------------- |
| **19420** | Backend, send-capable — the always-on service      | `src/bin/server.rs` `DEFAULT_PORT` |
| **19421** | Backend, send-capable — the user's hands-on dev one | `bin/teams-dev-server.sh` |
| **19422** | Backend, send-capable — the RELEASED build beside it | `bin/teams-lite-service.sh` `APP_BACKEND_PORT` |
| **19430** | Backend, read-only (`TEAMS_LITE_READ_ONLY=1`)      | `src/bin/server.rs` `READ_ONLY_PORT` |
| **19440** | Web app, production — the always-on service, and `teams` | `web/server.ts`, `launcher/src/launch.ts` |
| **19441** | Web UI, `vite dev`                                 | `web/vite.config.ts` `DEV_PORT` |
| **19442** | Web app — the RELEASED build's own front            | `bin/teams-lite-service.sh` `APP_WEB_PORT` |
| 19455 / 19445 | `bun run dev:mock` — mock backend / app        | `web/package.json` |
| 19456 / 19446 | `bun run preview` — mock backend / app         | `web/scripts/preview.ts` |
| 19457 / 19447 | E2E — mock backend / app                       | `web/playwright.config.ts` |
| 8443      | Tailnet HTTPS front for the web UI (`tailscale serve`) | `bin/teams-lite-service.sh` |

**The x420/x440 pair is the service; x421/x441 is the user's dev pair; x422/x442 is the
RELEASED build.** All three are send-capable backends on one SQLite store, so they must
never share a port: the service holds 19420 for weeks, `bin/teams-dev-server.sh` plus
`bun run dev` step aside to 19421/19441, and `teams-lite-app.service` takes 19422/19442
(see § Running the released build beside the staged one). Read-only is the exception that
keeps its own 19430 — and `teams-dev-server.sh` deliberately does not pin
`TEAMS_LITE_PORT` when `TEAMS_LITE_READ_ONLY=1`, because an explicit port would drag it
off 19430.

`TEAMS_LITE_PORT` overrides a backend's, `PORT` a web server's,
`E2E_MOCK_PORT` / `E2E_WEB_PORT` the suite's. Change a default in code and this table
in the same commit — and check both hooks: `guard-live-automation.sh` and
`guard-prod-chat-target.sh` match 1942[0-2] and 1944[0-2] by number, so a new
send-capable port they do not know is a hole in the guard.

## Updating the app from inside it (two clicks, and one install shape)

There is no version number: teams-lite ships as a ROLLING `latest` GitHub release, so a
build IS the commit it was compiled from (`TEAMS_BUILD_REV`, baked by build.rs). The
backend checks once at startup whether `latest` names a different commit and, if it does,
the sidebar offers the update as a blue button above the status line
(`web/src/components/update-button.tsx`, over the pure `web/src/lib/update.ts`).

**It is two clicks, and each one is the user's.** `update_download` streams the release
asset into `~/.cache/teams-lite/updates` and reports progress as a fill inside the button;
`update_apply` puts it in place and restarts onto it. Nothing happens on its own: the
download is ~130 MB (measured on the published release) and this machine may be on a
metered link, which is why the first
button says what it costs before it is pressed.

- **No state ever spells the build.** The control says `Update available`, never the commit
  the release was compiled from: a sha reads as a fault code in the middle of a plain
  sentence, and there is one release to take, so it names nothing the user can act on.
  `latest` stays in the payload because the BACKEND compares it with its own build to
  decide there is an update at all. A test in `web/src/lib/update.test.ts` scans every
  phase for it.
- **The progress takes the place of the label, and the button does not move.** The percent
  is drawn where the pressed words were, over the fill, and the second line keeps its
  height while there is nothing in it — the control is anchored above the status line and
  grows upward, so a line that came and went would shift the button under the pointer that
  just pressed it. `web/e2e/update.spec.ts` measures both halves.

- **Both RPCs are `MACHINE_METHODS`** — the write token, refused read-only, and the
  automation hook blocks a script that names either against a live port. `update_apply`
  replaces the binary the user's whole Teams account runs through and then restarts it,
  which would also cut a live `@claude` reply in half: the same failure
  `teams-lite-service.sh update --now` is blocked for.
- **The swap is a RENAME, never a write into the running file.** Every running process
  keeps the inode it started from — overwriting the bytes of a running executable is how a
  process gets a `SIGBUS` — and the next start gets the new build
  (`update::install_binary`, pinned by an inode assertion).
- **What is downloaded is checked before it can be installed**: the byte count must match
  the size the release published, and the first four bytes must be an ELF header. Neither
  alone is enough — a captive portal's login page is the wrong shape, and a cut-off
  transfer of the real asset is the right one — and a file that fails is deleted rather
  than kept, because the next click would install it.
- **The RESTART is the launcher's, and only the launcher's** (`launcher/src/update.ts`).
  The web server runs inside that process and the backend is its child, so it is the one
  process that can free both ports and bring both back: the backend asks with an
  `update_restart` event on the keepalive socket it already holds, and the launcher stops the
  web server, kills the backend, spawns the new build detached with `--no-open`, and exits.
  The order is the feature — a listener still up when the new process starts makes it die
  on `EADDRINUSE`, which would leave the user with no app rather than an updated one — and
  the backend's exit is AWAITED (`BackendHandle.waitForExit`), because a signalled process
  still holds its port for a moment and the new build's first act is to ask whether
  something is listening on it: a yes makes it attach to the backend we just killed.
- **`Restarting…` is the one state that outlives the socket.** Applying takes the backend
  and the web server down together, so the page is disconnected for a few seconds; every
  other phase hides itself when the socket is down (a stale "update available" is a claim
  we cannot make), and this one must not, or the user's click would be followed by the
  control vanishing. `installed` is the honest end when nothing restarted the app.
- **ONE install shape can do this: the `teams` command from install.sh.** That binary IS
  the release asset, byte for byte, so replacing it is the whole update — and the backend
  knows the path only because the launcher named it (`TEAMS_LITE_LAUNCHER_BIN`, set for a
  compiled binary only). A **staged always-on service cannot**: it runs a separate backend
  binary, a web bundle, wrapper scripts and unit files built from a checkout, and the
  release asset holds none of that shape. So `can_install` is false there and the notice
  stays the LINK it always was — a button that reported success while the service kept
  running what it had would be worse than no button, exactly like the chat pin Teams
  accepts and never reads back. That install is updated by `bin/teams-lite-service.sh
  update` (see § The always-on service), and widening the in-app update to cover it is a
  deliberate feature — the release would have to carry the scripts and units too — never a
  quiet swap of a staged file. What the user gets INSTEAD is both at once: the released
  build runs beside the staged pair on ports of its own, and updates itself there (see
  § Running the released build beside the staged one).
- The notice used to be an eleven-pixel link that REPLACED the status line, where it hid
  the truncated `error:` a sign-in outage puts there (see `broker-banner.tsx`). It has its
  own row now, and `web/e2e/update.spec.ts` pins that it never covers that line again.

`web/mock/server.ts` reproduces the whole flow with no GitHub and no binary (armed with
the `{kind: "update"}` test hook, which a spec MUST clear afterwards — one mock process
serves the whole run, and a left-behind update moves every later sidebar). `cd web && bun
run preview -- --out /tmp/upd --update` captures the button, the download mid-transfer, the
restart it offers next, and the link the other install shape keeps.

## The always-on service

The user runs teams-lite as a permanent background service, reachable from their
phone. `bin/teams-lite-service.sh` owns it and `packaging/systemd/` holds the units.

- **It runs staged artifacts, not the checkout.** `install`/`update` build, then copy
  the release binary and the web bundle into `~/.local/share/teams-lite/service`, with
  the commit recorded in `VERSION`. That is deliberate: a `git pull`, a rebuild, or an
  E2E run (which rewrites `web/dist` with its mock's URL baked in) would otherwise
  change what the service serves at a moment nobody chose.
- **`VERSION` names the commit that was BUILT, and the script reads `HEAD` once.** The
  build takes about a minute, and a hook, another session's push or the user's own
  `git pull` can fast-forward the checkout inside it. A second read at staging time
  therefore wrote a `VERSION` naming a commit the binary did not hold — and nothing
  healed it, because the auto-update hook compares `VERSION` with `HEAD`, read the two
  as equal and never rebuilt. The service served a backend from before a feature while
  `VERSION` named the commit that added it, so a new RPC answered `unknown method` in
  the user's own app while every test passed. `BUILD_REV` pins the commit before the
  build, `build_artifacts` builds again when the tree moved under it, and
  `update::tests::the_installer_stages_the_commit_it_built` pins both halves.
- **Re-staging is automatic; starting is not.** `.claude/hooks/sync-service-to-master.sh`
  (a `PostToolUse` hook on `Bash`) fires after a git command that can move master. It
  fast-forwards the checkout, compares `VERSION`'s commit with `HEAD`, and on a gap runs
  `update` in a detached background job — because staging by hand is a step nobody
  remembers, and the failure is invisible: every test passes while the phone serves a
  commit from days ago. It acts **only when a unit is already active** and **only from a
  clean `master`**, so it can neither bring the send-capable backend up nor promote a
  working tree. `.claude/hooks/sync-service-to-master.test.py` pins both refusals.
- **The restart waits for a live `@claude` run.** A run dies with the process it is in,
  and the reply it was writing keeps its "thinking…" body in front of the whole thread, so
  `update` holds the `try-restart` until the agent is quiet — bounded, then it proceeds
  (see § The local agent for the other half, which closes what a restart did leave
  behind). `--now` skips the wait and is the user's: the hook refuses it.
- **It is not the only install on this machine.** `teams-lite-app.service` runs the
  RELEASED build beside it, on 19422/19442, and the same script owns that unit — see
  § Running the released build beside the staged one for what keeps the two apart.
- **What is yours:** `install`, `update`, `units`, `status`, `logs`, `stop`,
  `uninstall`, and every `systemctl --user status|cat|show` /
  `journalctl --user -u …`. Diagnosing the service is normal work.
- **What is the user's:** `systemctl --user enable --now teams-lite.target`. That
  backend is send-capable, so the hook blocks every start/restart/enable spelling —
  including the service script's own `start` subcommand.
- **Two things it must never lose.** `TEAMS_NO_IDLE_EXIT=1` in the backend unit (or
  the process exits seconds after every start, since a service has no owning
  frontend), and `HOST=127.0.0.1` on the web unit (it serves the write token and
  relays WebSockets to the send-capable backend, so a public bind would hand the
  account to anything that can reach the port).
- **The broker bus moves.** It lives at `/proc/<container-leader>/root/run/user/0/bus`
  and that PID changes on every Intune container boot, so `bin/broker-env.sh` resolves
  it at each start and `teams-lite-broker-bus.path` restarts the backend when
  `rootless.json` changes. Without that the backend stays up, unauthenticated, and
  silent.
- **The keyring re-locks, and that is repaired automatically.** The container's login
  keyring locks itself every ~18 hours; the broker then answers every token call with
  `NoReply`, and the app shows nothing. `bin/teams-lite-broker-check.sh` reads the
  keyring's own `Locked` property — the cause, not a symptom — and three triggers share
  one rate-limited `teams-lite-broker-repair.service` (3/hour): the backend on that
  signature, `teams-lite-broker-health.timer` every 15 min, and the app's own
  **Repair sign-in** button (`repair_broker`, a `MACHINE_METHODS` entry). **Restarting
  the container is not yours to do** — it takes the user's sign-in down for a minute,
  so the hook blocks `intune-container stop|start|restart` and
  `teams-lite-broker-check.sh --repair`. `intune-container status|doctor` and the bare
  check stay open, because diagnosing is the normal way to answer "why is it empty".
- **Tailscale, never Funnel.** `tailscale serve` is tailnet-only, behind Tailscale's
  own authenticated HTTPS. `tailscale funnel` would publish the user's Teams account
  to the internet, send included.

## Running the released build BESIDE the staged one

`teams-lite-app.service` runs the single `teams` binary install.sh downloads — the GitHub
release asset itself — on ports of its own, at the same time as the staged pair. Two
installs, one machine, and each answers a question the other cannot:

- **the staged pair (19420 / 19440)** follows the checkout: a push, and the phone is on
  that commit a minute later through `tailscale serve`. It cannot update itself.
- **the released build (19422 / 19442)** follows CI, and it is the ONLY shape that can
  update itself from inside the app (see § Updating the app from inside it) — so it is
  also the only way to find out that the published artifact is broken before somebody
  else does.

`bin/teams-lite-service.sh` owns the unit like the others (`units`, `status`, `logs`,
`stop`, `uninstall` all cover it), and starting it stays the user's:
`systemctl --user enable --now teams-lite-app.service`. Four things hold the two apart,
and `update::tests::the_released_build_runs_beside_the_staged_one_and_never_over_it` pins
every one:

- **Ports of its own, stated rather than defaulted.** The default IS the staged backend's
  port, and a second backend that bound it would either fail to start or — worse — be
  ATTACHED to by the wrong launcher (`ensureBackend` attaches to whatever already listens).
- **No `TEAMS_NO_IDLE_EXIT`, which is the opposite of the staged backend unit** where it is
  mandatory. The launcher holds its own keepalive, so nothing idles out while the unit
  runs; and the idle exit is what clears a backend whose launcher died. One left holding
  19422 would be attached to by the next start, and an attached backend published its own
  write token — so the page would be handed a token that backend refuses and every send
  would come back refused, with nothing looking wrong.
- **Not `PartOf=teams-lite.target`.** Restarting or enabling the staged pair's target must
  not reach a second app the user did not ask for.
- **No unit at all when the binary is absent.** `install_units` skips it rather than
  writing a unit systemd rejects and whose start would fail with 203/EXEC.

**The write token is what makes sharing a machine safe**, and it is the one thing that had
to change for this: there is ONE token file per machine, so a second backend that
published would overwrite the first one's token — and the first one's own frontend would
then be refused every send while reads kept working, which on the always-on service means
the user's phone quietly losing the ability to answer anybody. So a PINNED token is never
published (`write_token` in `src/bin/server.rs`, pinned by
`a_pinned_write_token_is_never_published`): the launcher mints one per backend it spawns
and hands the same value to the web server it runs in-process, and the staged service's
file is left alone.

What the two DO share is the SQLite store, deliberately — that is a shape this app already
has, and every duplication hazard is handled where it belongs: a live notification is
claimed in `push_deliveries` before it is pushed, an `@claude` trigger is claimed before it
is answered, and the presence endpoint id lives in the store so both backends refresh ONE
registration. Two things are deliberately NOT shared: the tailnet mapping (give the
released one its own port if the phone should reach it) and calling, which stays off in
that unit — two registered calling endpoints on one machine would ring both.

## A broken sign-in costs the LIVE feed, never the history

Everything this app shows is local, so the backend serves the store whether or not it
can sign in. It did not always: three token calls ran before the store was even opened,
each one `?`-propagated, so an outage the keyring repair above could not fix exited the
process at boot. systemd restarted it every five minutes, every start died on the same
token, and the app the user opened said **Backend lost** in front of a store holding
11 739 of their messages. The boot order is the fix — store, then serve, then sign in —
and `the_store_opens_before_sign_in_and_a_broken_sign_in_is_not_fatal` pins it.

- **Nothing polls the broker to recover.** `trouter::run` asks for credentials before
  every connection attempt and backs off to 30 s, so the first attempt that succeeds
  fills the session in (`Ctx::adopt_session`) and the app catches up with no restart.
  A `sign_in` retry loop beside it would be a second thing hammering the same bus.
- **The identity is the ONE thing a local read needed from the session**, which is why
  an outage broke reads at all: the mri decides whether a stored message is ours, and a
  1:1 is titled after the other party. It lives in the store now
  (`Store::remember_self`, written on every successful sign-in) and `Ctx::identity`
  answers from the live session, then from that copy — **never from the network**. A
  stale session is deliberately not rebuilt there: a rebuild reaches the broker, and a
  broker that is down would cost every read its D-Bus timeout.
- **A store synced before any of this still states whose it is.** `Store::derived_self`
  reads it back out of the history: a one-to-one thread is `19:<oid>_<oid>@unq.gbl.spaces`
  and the user is one of its two parties, so the oid in EVERY one of them is theirs.
  Measured on this tenant — 95 threads intersect to exactly one oid, and `8:orgid:<it>`
  is the sender of 4716 stored messages, under the name that read then takes. It is
  strict on purpose (two threads at least, exactly one common oid, else `None`): a wrong
  answer would draw the user's own messages as a colleague's, and authorship is the one
  thing this app never misstates. What it derives is written down, so it runs once.
- **A read-only backend derives but never records it**, like every other write.
- **Send, mail, calendar and the agent still fail, and the banner says so.** It is not
  an offline mode with a queue: an unsent message that leaves later, at a moment nobody
  chose, is exactly the outward action § Sending messages forbids. `broker-banner.tsx`
  therefore says the history on screen is what this machine stored, and that nothing
  arrives or leaves until sign-in works — it used to claim the app could read nothing,
  which was the sentence that made a stale app read as a broken one.

## Conventions

- Conventional commits. No AI attribution / Co-Authored-By lines.
- De-risk before building: prove the risky piece with a spike, then implement.
- Verify against the real tenant when possible; don't over-promise.

## Git workflow

- Every new session/task MUST start from a dedicated git worktree created off
  `master`, never work directly on `master` or in the main checkout, so an
  in-progress session can't leave `master` in a broken state and parallel
  sessions never collide. Create it with a branch off `master`, for example:
  `git worktree add .worktrees/<task-name> -b <branch> master`.
- Once the branch is merged into `master`, delete its worktree to keep the
  checkout clean: `git worktree remove .worktrees/<task-name>` (and prune the
  branch once it is no longer needed).
- Before treating a task as done, run the tests that cover the parts you changed
  as a hard gate: only merge into `master` when they are green. Match the test
  scope to the change scope — do not run everything by reflex:
  - Backend (`src/`, Rust): `cargo test`.
  - Web app (`web/`): `bun run test` (unit) plus `bun run typecheck`; add
    `bun run test:e2e` when behavior or flows change.
  - The `teams` command: `bun test` plus `bun run typecheck` (run in `launcher/`).
  - The automation guard (`.claude/hooks/`): `python3
    .claude/hooks/guard-live-automation.test.py` whenever you touch the hook, a
    launcher name, or a port. It pins both halves — what must block, and the ordinary
    work that must not. Run `python3 .claude/hooks/guard-prod-chat-target.test.py`
    alongside it when you touch the browser-MCP guard, and `python3
    .claude/hooks/sync-service-to-master.test.py` when you touch the service
    auto-update hook or `teams-lite-service.sh`.
  - A change that only touches a frontend does not need `cargo test`, and a
    backend-only change does not need the frontend suites. When a change spans
    both (e.g. a protocol or WebSocket contract), run the suites on both sides.
- If the tests you ran fail, do not merge. Leave the worktree and branch intact
  and report what failed.
- This is a convention the agent follows, not an enforced guarantee — the
  authoritative check that keeps `master` green belongs in CI or a pre-push hook.

## Working style (MANDATORY)

- **Act autonomously.** For every prompt, drive the task to completion without
  waiting for hand-holding. Investigate, decide, implement, and verify on your own.
- **Always write clean code.** Favor clear naming, small focused units, and proper
  separation of concerns over quick hacks.
- **Choose the professional solution.** When you spot a problem, fix it properly.
  Never take a shortcut just because it is easier or faster.
- **Address root causes, not symptoms.** If a proper fix requires more work, do the
  work rather than patching around the issue.
