# A task list the app fills in for you

A right-hand panel holding the things the user owes somebody. It is filled two ways:
by hand, and by an agent run over the messages and mail that are already on this
machine. Nothing in it reaches Teams, a tracker, or a person.

## Why this shape

The user reads their day out of three places at once — a self-chat they leave notes in,
the threads colleagues ask them things in, and a mailbox. Every one of those is already
synced into this app's SQLite store, so the extraction is a read over local rows rather
than a new integration. That is the whole reason this feature is small.

Two things it deliberately is not:

- **It is not a Linear client.** `Linear -> task` is one GraphQL query away and still
  out of scope here (see § Out of scope), because the interesting half — ticking a task
  and having Linear agree — is a write to the user's workspace and needs the consent
  gate a merge-request approval got, not a checkbox on this feature.
- **It is not a second calendar.** The Today section reads the events this app already
  syncs. A Google calendar is its own OAuth subsystem and its own spec.

## Scope

In:

- A local `tasks` table, and a panel that lists it.
- A two-tier extractor over `messages` and `mail_messages`: a keyword prefilter in Rust,
  then one agent run over what the prefilter kept.
- A `suggested` state — an extracted task appears immediately, cited to the message it
  came from, and one click accepts or dismisses it.
- A Today section pairing today's already-synced calendar events with tasks due today.
- Four RPCs, three of them write-token gated.

Out, each its own spec if it is ever wanted:

- Linear in either direction.
- Google Calendar, or any second calendar provider.
- Tasks drawn as blocks on the calendar grid.
- Recurring tasks, priorities, projects, tags, sub-tasks.
- Sharing a task with a colleague, or anything else that leaves the machine.
- A scheduled scan beyond the debounce described below.

## The data

One table, and no migration: `CREATE TABLE IF NOT EXISTS` never alters an existing
table, so nothing here adds a column to `messages`.

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id                     TEXT PRIMARY KEY,   -- minted here
  title                  TEXT NOT NULL,
  body                   TEXT,               -- the user's own notes
  state                  TEXT NOT NULL,      -- suggested | open | done | dismissed
  due_date               TEXT,               -- 'YYYY-MM-DD': a day, never a time
  source_conversation_id TEXT,               -- NULL on a hand-typed task
  source_message_id      TEXT,
  source_mail_id         TEXT,
  asked_by_mri           TEXT,               -- an MRI, never a name
  created_at             INTEGER NOT NULL,
  done_at                INTEGER
);
```

Three choices in it are load-bearing:

- **`asked_by_mri` holds an MRI, and the name is resolved in the store's own read**
  (through `nicknamed!`, like `SELECT_COLS` and every other query that states a person).
  A rename the user made must cover this row the way it covers a bubble, a sidebar
  preview and a typing line — and the reason that placement is right is the reason
  § Renaming a person gives: applied at render time, it has to be applied at every
  render site, and the one that gets forgotten is the bug.
- **A candidate message is derived, never flagged.** The scan reads messages newer than
  a watermark held in `settings`, filtered by the prefilter's own SQL shape. No column,
  no migration, no second source of truth about what has been looked at.
- **`dismissed` rows are kept.** They are what stops a re-scan re-suggesting what the
  user already refused. The watermark alone would do it for the ordinary forward pass;
  the row is what holds when a scan is re-run over the same window.

## The extractor

`src/tasks.rs`, and the interesting half of it is pure.

### Tier 1 — the prefilter

`tasks::looks_actionable(&str) -> bool`. No I/O, microseconds, and used in exactly two
places: at ingest, to decide whether to *arm* a scan, and in the candidate sweep, to
decide what a scan *reads*. One function for both on purpose — two spellings of "this
message looks like a request" drift apart at the first phrasing nobody thought of, and
then the trigger and the input disagree about what a candidate is.

It is a keyword and shape test, not a classifier: an ask ("can you", "could you",
"please"), a deadline word or date shape, an explicit "todo"/"to do"/"what to do", a
question mark in a message that mentions the user. It is allowed to be generous — its
output is a candidate, not a task.

Its honest fallback matters: a candidate with no agent run behind it is still a message
the user can turn into a task by hand. The feature degrades to a highlight, not to
nothing.

### Tier 2 — one agent run, with no tools at all

```rust
agent::Request {
    backend: agent_policy::default_backend(stored.as_deref()),
    prompt: tasks::build_prompt(&candidates),
    system_prompt: tasks::SYSTEM,
    permissions: agent::Permissions::Granted(vec![]),
    resume_session: None,
    workspace: agent::default_workspace(),
    model: stored_model,
}
```

Four things about that request:

- **`Granted(vec![])` is the whole security story.** `agent.rs` documents an empty
  allowlist as a legitimate choice — "an agent that only talks" — and that is exactly
  what this is. No file reads, no MCP servers, no shell. The write token is already
  stripped from every child. So a run started by a colleague's words can do nothing but
  answer a question about text this app handed it.
- **It never posts.** The posting and editing live in `agent_reply`, and this route does
  not touch it. There is no Teams message anywhere in this feature.
- **The provider is the user's default one**, resolved by
  `agent_policy::default_backend` from `SETTING_DEFAULT_PROVIDER` with its stored model.
  No second provider setting: a surface with room for one choice reads the one the user
  already made.
- **The text travels as DATA**, said so in the system prompt, bounded, and inside its own
  delimiter — the rule the thread transcript already follows, for the same reason: the
  people in a thread never agreed to be able to steer a program on this machine.

The prompt is bounded on both axes — a maximum number of candidates per run and a
maximum length per candidate — so a busy week cannot turn one scan into an unbounded
prompt.

### Parsing, and what a bad answer costs

`tasks::parse_extraction(&str) -> Result<Vec<Extracted>>`. It accepts the JSON the
system prompt asked for, including wrapped in a fenced code block, because a CLI's final
text often is. Anything else is an `Err`.

**A parse failure does not advance the watermark and does not invent tasks.** The panel
says the scan failed, the same candidates are read on the next scan, and nothing is
written. A model that answers prose instead of JSON must cost nothing at all — an empty
list here would silently mark that window as scanned and lose it for good.

### When a scan runs

- **On demand**, from a button in the panel. Uncapped: a button the user pressed is the
  user.
- **Automatically**, armed by a Tier-1 hit at ingest and then **debounced** (a quiet
  window, or enough candidates piled up) and **rate-capped** per hour. Never one run per
  message.

The cap is not a nicety. A colleague's message reaching the prefilter means somebody
else's words can start a process on this machine. It is not remote code execution — the
prompt is fixed and the run holds no tools — but it is a resource trigger the user does
not control, and the cap is what bounds it. This is the same hole the agent trigger's
`from_me` rule closes for the feature that *can* run tools; here the tool list is empty
instead, and the cap covers the rest.

**An automatic scan is claimed before it runs.** Both backends sharing this machine's
store receive every live frame independently — one endpoint id per backend, by rule — so
without a claim they would both spend a run and both insert the same suggestions. The
claim is a compare-and-set on a `settings` row carrying a holder and a deadline, taken in
one `UPDATE ... WHERE`, and it expires so a backend that died mid-scan does not block the
next one. It is the same hazard `push_deliveries` solves for a push and the agent trigger
solves for a reply.

## The RPCs

| Method | Class | Why |
| --- | --- | --- |
| `tasks` | open | Returns the user's own rows and no secret. |
| `task_save` | `MACHINE_METHODS` | Writes a row attributed to a colleague. |
| `task_delete` | `MACHINE_METHODS` | Same. |
| `tasks_scan` | `MACHINE_METHODS` | Starts a process on this machine, and it costs money. |

**`OUTWARD_METHODS` is untouched**, and that is the honest classification rather than a
convenience: nothing in this feature posts, publishes a read, notifies a person or writes
to a tracker.

`task_save` and `task_delete` are gated for the reason `set_person_name` is, and it is
not that they write to the store — it is *what* they write. A client that could set
`asked_by_mri` could make one colleague appear to have asked for something another
colleague never mentioned, in the panel and in the notification a phone draws from it.
Authorship is the one thing this app never misstates. A read-only backend refuses all
three, so a screenshot script cannot rewrite the user's list.

The three writes join the automation guard's blocked-against-a-live-port list
(`.claude/hooks/guard-live-automation.sh`), and its python test grows the cases.

## The panel

`web/src/components/tasks-panel.tsx`, over a pure `web/src/lib/tasks.ts` that holds the
grouping, the section order and the day formatting. The pure half is where the unit tests
live; the component draws what it returns.

**One `<aside>`, two shapes.** On a wide screen it is `relative w-[22rem] shrink-0`
with a left border, so opening it narrows the message pane rather than covering it. On a
narrow one it is `fixed inset-0 z-40` — a full-screen sheet, because there is no room for
a third column on a phone and this app is used from one daily. No new primitive and no
new dependency: there is no sheet or drawer in `components/ui`, and Radix's `Dialog`
would make the panel modal, which is wrong for something the user reads beside a thread.

**The toggle is a bare `t`**, plus a button in the header, plus Escape to close. Bare
keys are the scheme `app.tsx` already uses for `j`/`k` navigation, and they are ignored
while focus is in an input. Every modifier pair worth having is unavailable: `⌘K` and
`⌘P` are bound in this app, `⌘T` / `⌘⇧T` / `⌘J` belong to the browser, and `⌘B` is bold
in the composer.

Four sections:

- **Suggested** — what the last scan produced, each row citing its source, with accept
  and dismiss. It sits at the top because it is the only section that needs a decision.
- **Today** — today's events from `calendar_events` (already synced, read-only, filtered
  to the visible calendars exactly as the calendar pane does) with the tasks due today
  under them. This is the section that answers "what is my day".
- **Open** — everything else, soonest due first, undated last.
- **Done** — folded, the recent ones.

A row states where it came from and jumps there on click: `/c/$conversationId` for a
message, `/m/$mailId` for a mail. Both routes already exist. The person who asked is
drawn with the avatar and the name every other surface uses, so a local nickname holds
here too.

On a coarse pointer the row's menu comes from a long press (`use-long-press.ts`), the
split the chat list already makes — a menu behind hover alone is a feature that does not
exist on a phone.

Every glyph comes from Hugeicons, like every other glyph in this app.

## Verification

Rust:

- `tasks.rs`: the prefilter's hits **and** its misses (small talk must not arm a scan),
  the prompt's two bounds, a fenced-JSON parse, and prose parsing to `Err` rather than to
  an empty list.
- The store: a round-trip per state, the name resolving through a person override, and
  the claim's compare-and-set refusing a second holder and yielding after its deadline.
- `src/bin/server.rs`: the three writes refused read-only and refused without the token,
  `tasks` answered without one, and `OUTWARD_METHODS` unchanged.

Web:

- `web/src/lib/tasks.test.ts` over the pure grouping and formatting.
- `web/mock/server.ts` serves the table and simulates a scan, behind a test hook a spec
  must clear — one mock process serves the whole run, and a task left behind moves every
  later sidebar.
- `bun run preview -- --out /tmp/tasks --tasks` captures the panel, the suggested rows,
  the Today section and the phone's sheet.
- `web/e2e/tasks.spec.ts` pins the toggle, accept and dismiss, the jump to a source, and
  the mobile sheet with its long press.

Hook:

- `python3 .claude/hooks/guard-live-automation.test.py`, extended with the three new
  methods against a live port, and with the ordinary work that must keep running.
