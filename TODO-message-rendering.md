# TODO — message types we still render badly

Audit of the **5450 messages** in the local store
(`~/.local/share/teams-lite/teams-lite.sqlite`, snapshot of 2026-07-25) run through
the real web rendering pipeline (`parseRichMessage` → `parseRichHtml` →
`RichContent`), cross-checked against the Rust ingestion path.

This list is tracked in the repo so the work survives across sessions and
checkouts. Tick items off as they land; keep the counts as the "before" evidence,
and note the commit that fixed an item next to it.

Counts are occurrences in that snapshot, so they are a lower bound on how often
each shape shows up in real usage.

---

## P1 — wrong on almost every conversation

### [ ] 1. Teams emoji are `<img>`, rendered as picture cards — 247 messages

Teams sends inline emoji as
`<img itemtype="http://schema.skype.com/Emoji" itemid="smile" alt="🙂"
src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/…/20_f.png"
style="width:20px; height:20px">`.

`TAG_MAP` maps `img` → `img` (`web/src/lib/rich-text.ts:43`), and
`rich-content.tsx:192` hands it to `MediaImage`, whose wrapper is
`block w-fit max-w-full` (`web/src/components/media-image.tsx:85`). Result: every
emoji **breaks the line**, gets `rounded-xl shadow-card`, and is click-to-zoom.

Fix: recognise the Emoji `itemtype` (or the `personal-expressions` CDN path) in
the parser and emit the `alt` text as a plain text node.

Repro ids: `1784645601649`, `1784627239695`, `1784279169798`.

### [ ] 2. Emoji-only messages render as framed photos — 17 messages

Follows from #1: with the emoji counted as an image, `hasNonImageContent` is
false → `imageOnly` is true (`message-bubble.tsx:208`) → the bubble chrome is
dropped and the 20 px emoji is framed on the "atelier mat" like a picture. Their
sidebar preview is also empty (see #16).

Fixed for free by #1.

Repro ids: `1781625043581`, `1782984079975`, `1784810713129`.

### [ ] 3. Tables are flattened to one cell per line — 35 messages

`table`/`thead`/`tbody`/`tr`/`td`/`th`/`colgroup`/`col` are absent from
`TAG_MAP`, so they are unwrapped and every cell lands on its own line:

```
Total
61
Pass
31
51%
```

Fix: allowlist the table tags and render a real (scrollable, max-width) table;
drop `&nbsp;`-only cells so empty cells don't add blank lines.

Repro ids: `1776787594282`, `1776978121549`, `1779287383679`.

### [ ] 4. Adaptive cards show only the Skype fallback — 43 messages

`<URIObject type="SWIFT.1">` bodies (polls, `n-Alerts` monitoring alerts,
GitHub/Figma/Sentry app cards) render as
`Card - access it on https://go.skype.com/cards.unsupported.` The real payload is
base64 in `<Swift b64="…">` (an Adaptive Card JSON).

Also leaks into the sidebar: the *GitHub Notifications*, *Figma* and *Sentry*
channels currently preview as `Card - access it on … cards.unsupported. Card`.

Fix: decode `<Swift b64>` in the backend, store a structured card payload, and
render at least title + text + facts + actions. Minimum viable: surface the
card's `summary`/`text` instead of the fallback sentence.

Repro ids: `1781257277685` (poll), `1710459702206` (monitoring alert).

---

## P2 — structural: messages filed or grouped wrong

### [ ] 5. Phantom conversations from channel thread links — 14 rows, 71 messages

14 rows in `conversations` have an id of the form
`19:…@thread.tacv2;messageid=<rootId>` — that is a **channel thread** id, not a
chat. For all 14 the parent channel already exists in `channels`. So 71 channel
posts are filed under a nameless `kind='unknown'` chat that pollutes the chat
list, instead of appearing in their channel.

Cause: the `;messageid=` suffix of `conversationLink` is not stripped when the
live feed derives the conversation id.

Fix: strip at `;` when deriving the id, route the post to the channel, and add a
migration that deletes the phantom rows after re-parenting their messages.

Repro ids: `19:fb9105cfa1da4bf3a69fdc52cc39e605@thread.tacv2;messageid=1784879567087`
and 13 more (`select id from conversations where id like '%;messageid=%'`).

### [ ] 6. 498 channel messages have no `thread_root_id` — and can never heal

12 channels hold posts stored before channel threading landed
(`General` 82, `🚩 Sentry notifications 2` 40, `📚 Literature` 40, `n-Alerts` 40,
…), while newer ones are complete (`🤔 Questions` 40/40, `🍚 Ricing` 31/31).
`groupThreads` falls back to `m.id` (`web/src/lib/threads.ts:29`), so each reply
becomes its own single-post pseudo-thread and replies are detached from roots.

They will **never** heal: the upsert at `src/store.rs:941` only updates `content`
and `deleted` on conflict — never `thread_root_id`, `thread_subject`, or
`attachments`.

Fix: a targeted healer (same shape as `convert_legacy_call_events`) that
backfills thread fields from a refetch, or widen the `ON CONFLICT` update.

---

## P3 — control/system frames rendered as chat

### [ ] 7. Stored typing/presence frames show as empty bubbles — 25 messages

`b306c02` stopped ingesting `Control/*` frames, but nothing cleans the rows
already in the store (22–23 July, mostly *St🐀umn Core*). They render as an empty
bubble whose sender name is a raw
`https://notifications.skype.net/v1/users/ME/contacts/8:orgid:…` URL.

Fix: one-shot migration deleting rows with empty content + no attachment + no
system event + a `notifications.skype.net` sender.

### [ ] 8. ThreadActivity frames stored as raw JSON — 10 messages

Two shapes leak into bubbles as literal JSON:

- `{"eventtime":…,"initiator":"8:orgid:…","members":[…]}` (member added) — 8
- `{"eventtime":…,"userId":"8:orgid:…","operation":"pinned"}` (pin) — 2

Fix: recognise them in `parse_message` (a JSON body carrying `eventtime` +
`members`/`operation`), and either drop them or turn them into a `system_event`
rendered as a centered line like call events. Purge the existing rows.

Repro ids: `1781884089268` (pinned), `1781160917613`-era member adds.

### [ ] 9. Meeting activity messages show a URL as author — 3 messages

`Scheduled a meeting`, `The meeting "LAB GEN AI Monthly " is cancelled`: plain
bodies whose `imdisplayname` is empty, so `sender` falls back to the raw
`…/users/ME/contacts/8:orgid:…` URL (`src/teams_read.rs:1104`).

Fix: never fall back to a contacts URL as a display name (blank it, like the
recording path does), and ideally render these as system lines.

Repro ids: `1778059385348`, `1778059464183`, `1778070909111`.

### [ ] 10. 20 blank bubbles from real senders — cause unknown

`content=''`, `attachments='[]'`, `deleted=0`, real sender (Matthieu GAUCHER ×9,
Théophile WALLEZ ×4, …) → an empty coloured pill. Most likely payload-only
messages: a file whose `objectUrl` was missing (dropped by `file_to_attachment`),
a voice memo, or an app card.

Not diagnosable from the store: we persist neither `messagetype` nor the raw
frame. Two things to do:

1. Keep enough provenance to debug this (store `messagetype`, or log dropped
   payloads).
2. Never render a message with no visible payload at all — skip it or show an
   explicit "unsupported message" placeholder.

Repro ids: `1784641849906`, `1784641998899`, `1784876742142`, `1784903835935`.

---

## P4 — formatting fidelity

### [ ] 11. Plain-text messages are parsed as HTML — literal `<…>` eaten

`messagetype: Text` bodies are not HTML, but the web parses them as such, so any
angle-bracketed text disappears: `pour moi c'est <yyyy>-<id>` renders as
`pour moi c'est -`. Hits generics (`Vec<String>`), HTML snippets, placeholders.

Fix: persist `messagetype` and render `Text` bodies as text (escape, no parse).

Repro id: `1775231521568`.

### [ ] 12. Headings flattened — 32 messages

`h1`/`h2`/`h3` are unwrapped, so a release-note style post loses all hierarchy.
Fix: allowlist them with a modest bump in weight/size (they sit inside a bubble,
so don't scale like page headings).

Repro ids: `1779292826769`, `1784797533519`.

### [ ] 13. Relayed HTML emails are a wall of text — 26 messages

The `🚩 Sentry notifications 2` channel receives full HTML emails
(`div itemtype="http://schema.org/EmailMessage"`): the `display:none` preheader
is rendered as visible text ("New issue from internal."), layout tables are
flattened (#3), logos and tracking pixels become large zoomable image cards, and
every tag value gets a favicon chip.

Fix: detect the `schema.org/EmailMessage` wrapper and render a compact summary
(subject + `ViewAction` link) instead of the email body; honour
`style="display:none"` on the way in.

Repro ids: `1755770894847`, `1755770531556`.

### [ ] 14. Forwarded messages have no "forwarded" header — 6 messages

`parseRichMessage` only recognises `blockquote itemtype=".../Reply"`
(`web/src/lib/protocol.ts:448`); a `.../Forward` blockquote falls through to a
generic quote block with no attribution.

Repro ids: `1784304655568`, `1784622433979`.

### [ ] 15. Small stuff

- `<hr>` is dropped entirely (2 messages) — no separator rendered.
- `<small>` renders at body size (26 messages).
- Teams code blocks (`p itemtype=".../CodeBlockEditor"` + `<pre><code>`, 14
  messages) stack the `pre` and `code` backgrounds — pick one.
- App link-unfurl cards (`span itemtype=".../InputExtension"`, 6 messages)
  render as nothing; the card content is lost.

---

## P5 — sidebar previews

### [ ] 16. A reply previews as its quoted message, author glued on — 3 conversations

`preview_from_html` (`src/teams_read.rs:1427`) strips tags with no separator and
does not skip the `Reply` blockquote, so the preview shows the **quoted** text
prefixed by the quoted author with no space:
`Matthieu GAUCHERSi je vais le faire intervenir…`.

Fix: drop the reply blockquote before previewing (and insert a space at block
boundaries).

### [ ] 17. 42 conversations/channels have messages but an empty preview

17 chats + 25 channels: the last message is emoji-only, image-only, or a card, so
`preview_from_html` yields nothing. Fix: fall back to a typed label
(`📷 Image`, `📎 File`, the emoji itself, the card title).

---

## Verified clean

Mentions, `Reply` quotes, reactions, inline AMS images (361), file attachments,
meeting recordings, and call event lines all render correctly across the whole
snapshot.

## Unrelated bug spotted during the audit

### [x] French UI strings in the deleted-message component

`web/src/components/message-bubble.tsx` — "Masquer", "Révéler", "Ce message a été
supprimé" / "Vous avez supprimé ce message" violated the English-only rule in
`AGENTS.md`. Already fixed on `master` by `c65d236`
("fix(web): translate the deleted-message UI to English").

---

## How to re-run the audit

```bash
cp ~/.local/share/teams-lite/teams-lite.sqlite /tmp/tl.sqlite   # never read the live file
# then a bun script importing web/src/lib/rich-text.ts + protocol.ts over
# `select id, content, attachments, system_event, deleted from messages`
```
Counting through the real parser (not regexes) is what makes the numbers above
trustworthy: it applies the same allowlist, unwrapping and `normalize()` the UI does.
