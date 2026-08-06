# Custom emoji — design

**Date:** 2026-08-05
**Status:** approved for implementation (approach A), pending two measurements
**Scope:** upload, name and use custom emoji and GIFs in teams-lite, copying Slack's
feature and its UI/UX; render them for every teams-lite reader and, where Teams allows
it, for stock Teams clients too.

---

## 1. Goal

Slack's custom emoji, in teams-lite: the user uploads a picture, names it `:shipit:`,
types `:shipit:` in the composer, and the art appears in the message everybody reads.
Aliases, a searchable list to manage them, GIF animation, and a reaction row that can
carry a custom emoji.

The feature is worth building here because the *art must reach other people* — a local
decoration would be a different, smaller feature. That requirement is what the whole
design turns on.

### Non-goals

- No workspace, no roles, no permissions, no "who added it": one machine, one person.
- No rename. Slack has none either — delete and add again.
- No server, no account, no sync service. The pack is a local table.
- No re-encoding, resizing or frame-dropping of the user's image.

---

## 2. The constraint that shapes everything

Microsoft Teams has **no custom-emoji API**. Two consequences, and they pull in
opposite directions:

- **A message body is HTML**, and Teams' own emoji travel in it as
  `<img itemtype="http://schema.skype.com/Emoji" alt="🙂" …>` pointing at their
  personal-expressions CDN. `src/teams_send.rs::upload_image` already puts a user's
  picture on Teams' AMS and references it from a message. So art *can* travel in a
  message body, and `web/src/lib/rich-text.ts::isEmojiImage` already recognises that
  itemtype on the way back in — today it collapses such an image to the character in
  its `alt`.
- **A reaction is not an image.** It is one of Microsoft's emotion keys (`like`,
  `fire`, `yes-tone2`), and a stock Teams client draws it from its own asset catalog.
  It has no fetch path, so no mechanism can make custom art appear in the reaction row
  of stock Teams. That half is closed by their client, not by us.

### Two measurements the design waits on

Both probes are `examples/*.rs` pinned to the sandbox channel const
(`19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2`), which § Sending messages
pre-authorizes, and both writes are reversible.

**Probe 1 — `examples/custom_emoji_send_probe.rs`.** Post one sandbox message whose
body carries **two inline** `<img itemtype="…/Emoji">` mid-sentence, with both AMS
object ids in `amsreferences`; read the stored message back through this crate's own
parser and print what survived: the itemtype, the `src`, `width`/`height`, and the
position of the images inside the text. Then post a second message reusing the first
object id, to learn whether an AMS object can be referenced twice in one conversation.

What it decides: whether the wire format below is real (§ 5), and whether the upload is
per-send or cached (§ 5.3).

**Probe 2 — `examples/custom_emoji_reaction_probe.rs`.** `PUT
…/messages/{id}/properties?name=emotions` with an arbitrary key naming an AMS object
(`tlcustom-https://…/v1/objects/…/views/imgo`) on a message we posted in the sandbox, read
the emotions snapshot back, then clear it with `value: 0`.

What it decides: whether § 7 exists at all, the accepted key length and character set, and
whether the key survives the round trip unchanged.

**Neither probe can see the last thing:** what the user's own phone renders. That would
take the user looking at the sandbox thread in stock Teams while a reaction is set. It has
not happened, so the appearance is recorded below as unobserved rather than guessed at.

---

## 3. Architecture

Five pieces, each with one job.

| Piece | Where | Job |
| --- | --- | --- |
| The pack | `custom_emoji` table in the store (`src/store.rs`) | Hold names, aliases and bytes. One row per emoji. |
| Sources | `custom_emoji_add` in `src/bin/server.rs`, over `src/sender_icon.rs`'s rails and `src/teams_media.rs` | Turn a file, a URL, a clipboard image, a colleague's emoji or a pack file into a row. |
| Insertion | `web/src/lib/custom-emoji.ts`, a `:` suggestion plugin beside `mention-extension.ts`, emoji-mart's own `custom:` prop | Get an emoji into the composer. |
| Outbound | one rewrite function in `src/teams_send.rs`, used by send **and** edit | Substitute each `:code:` the pack holds with Teams' emoji markup, upload the art once per name, fill `amsreferences`. |
| Inbound | one branch in `rich-text.ts::isEmojiImage` + a small renderer | Draw an emoji a message carries, at glyph size. |

The seam that matters: **the page never handles the art on a send.** It serializes the
emoji's *name*; the backend, which already holds the bytes, resolves it. So there is one
place where art becomes an AMS object, and a code that names nothing in the pack stays
plain text — nothing is ever invented.

---

## 4. The pack

```sql
CREATE TABLE IF NOT EXISTS custom_emoji (
  name         TEXT PRIMARY KEY,   -- bare, no colons, lowercase
  alias_of     TEXT,               -- another custom name, or a Unicode emoji; NULL for art
  content_type TEXT,               -- NULL for an alias
  bytes        BLOB,               -- NULL for an alias
  width        INTEGER,
  height       INTEGER,
  source       TEXT NOT NULL,      -- "upload" | "url:<origin>" | "paste" | "message" | "import"
  added_ms     INTEGER NOT NULL
);
```

- **Bytes in the store, not on disk.** The `person_overrides` avatar BLOB is the
  precedent, for its reasons: a path breaks when the file moves, and a URL would make
  drawing an emoji a request to a third party. It also means the always-on service and
  the user's dev backend share one pack over WAL, so the pack is on their phone for
  free.
- **Slack's own limits, copied:** 128 KB per emoji, max 512 px on a side — an image over
  either is **refused with the reason**, never silently scaled, because nothing here
  re-encodes. Types are
  PNG, JPEG, GIF and WebP — one type list the app already has
  (`PERSON_AVATAR_TYPES` / `COMPOSER_IMAGE_TYPES`), never SVG, which is a document
  rather than a bitmap.
- **Never re-encoded.** A GIF re-encode kills the animation and needs a codec; the byte
  cap bounds the cost instead.
- **Name rule:** `^[a-z0-9][a-z0-9_+-]{0,63}$`, unique across names *and* aliases, and
  refused when it collides with a Unicode shortcode — Slack refuses a taken name too,
  with the sentence this app reuses verbatim (§ 8).
- **An alias is one column, resolved at read.** It may point at another custom emoji or
  at a Unicode emoji, exactly as Slack's does. A chain is refused: an alias never points
  at an alias.
- **An alias is resolved before it is serialized**, so it never reaches the wire: picking
  `:ship:` (an alias of `:shipit:`) puts the *target's* markup in the body, and an alias
  of a Unicode emoji puts the character there. Otherwise a reader would receive a name
  only the sender's machine could explain.

---

## 5. Outbound — the wire format

### 5.1 The code IS the wire format, and the chip serializes to it

A custom emoji is an inline tiptap node in the composer — the art, drawn while the user
types, which is what Slack shows. It serializes to the **bare `:shipit:` text**, exactly
what the user would have typed by hand.

This is the `agent-tag-extension.ts` pattern, adopted for its reasons: the chip is a
composer affordance, the words are the contract, and the backend reads them back. It also
matches Slack's real behaviour — a `:shipit:` typed literally, with no autocomplete,
renders as the emoji there too. So the autocomplete is a convenience, never the mechanism.

And it is what makes an **edit** work at all: `edit` sends plain text only
(`src/bin/server.rs:2988` passes `content_html: None`, and `MessageEditor` is a plain-text
box), so an emoji that lived in markup would be destroyed by every edit. A code survives
one, because it is text.

### 5.2 What the backend does

One function, `resolve_custom_emoji(html, store, …) -> (String, Vec<String>)`, called by
the send path **and** the edit path:

1. Walk the outgoing body's **text runs only** — never inside a tag, an attribute or an
   entity — and find `:name:` occurrences the pack holds.
2. Skip three regions, each for its own reason: `<code>` and `<pre>` (Slack does not
   render an emoji inside code either), and a **quote block** (a reply carries a
   colleague's words, and substituting our art into them would rewrite what they wrote —
   the same reason `agent_policy` strips quoted blocks before reading a trigger).
3. For each **distinct** name found, upload the bytes once through the existing AMS path
   and replace each occurrence with Teams' own emoji markup:

```html
<img itemtype="http://schema.skype.com/Emoji" itemid="shipit" alt=":shipit:"
     src="{ams}/v1/objects/{id}/views/imgo" width="20" height="20">
```

4. Collect every object id into `amsreferences` (today an array of one; it becomes an
   array of N).
5. A code the pack does not hold is **left alone as text** — a colleague's `:shipit:`
   is not ours to draw, and inventing art for it would misstate their message.

`send_message`'s existing single trailing-`<p>` image (a photo attachment) is untouched:
it is a different thing and stays where it is.

### 5.3 Upload per send, for now

Each send uploads the emoji it uses (128 KB ceiling each). Reuse — remembering an AMS
object id and referencing it from later messages — is measured by probe 1; if it holds,
it becomes two columns and a cache lookup in the same function, later. Cross-conversation
reuse is deliberately not designed for: it cannot be tested safely, since one
conversation is sanctioned for live writes.

### 5.4 A failed upload fails the send

The composer reports it in one sentence beside the words still in the box (`sendError`,
over `web/src/lib/send-failure.ts`), and the status line keeps the raw failure. The
message is **not** posted with the bare code instead: that would be a message the user
did not write, and § Sending messages forbids posting anything they did not consent to.

---

## 6. Inbound — drawing an emoji a message carries

`isEmojiImage` already matches this itemtype. It gains one branch: when the `src` is an
AMS object rather than the personal-expressions CDN, emit an `emoji` rich node
(`{tag: "emoji", attrs: {src, code}}`) instead of collapsing the image to its `alt`.

The renderer draws it **from the bytes the message carries**, through the authenticated
media proxy the app already has (`src/teams_media.rs`, `controller.loadMedia`, the path
`media-image.tsx` uses) — never from the reader's own pack. A colleague's `:shipit:` is
not ours to redraw; this is the same rule that stops a nickname rewriting the record of
a Teams frame. It also means a teams-lite reader who holds no pack still sees the art.

- 1.15em, vertically aligned like `Emoji` — a glyph, not a picture: no photo frame, no
  click-to-zoom, no lightbox.
- `alt=":shipit:"`, and the code as its title, which is Slack's tooltip.
- Falls back to the literal `:shipit:` text if the image cannot be fetched.
- **An emoji-only message renders jumbo** (Slack's behaviour): a body whose whole
  content is emoji draws them at ~2.5em.

There is **no client-side substitution of `:code:` into art**, and that absence is
load-bearing. This app draws no optimistic echo — a sent message arrives from the
backend's own broadcast, already carrying the rewritten body — so nothing needs it. And a
reader who marked codes locally would draw *their* `:shipit:` over a colleague's words,
which is the one thing § 6 exists to prevent.

---

## 7. Reactions — gated on probe 2

If the emotions property accepts an arbitrary key:

- The key names the art, and only the art: `tlcustom-<objectUrl>`. Reacting uploads the
  emoji first, the same way a send does, and the key is minted from the object URL that
  comes back — so a page can never mint one, and a toggle-off passes the existing key
  back verbatim. The NAME cannot travel in the key: a name may hold digits and hyphens
  (`blob-2`), an AMS id starts with one, and no character in the name charset could
  separate them. Carrying the whole URL also hands a reader something complete to fetch,
  since Teams rewrites the host it serves an object from.
- `reactionEmoji` (`web/src/lib/teams-emoji.ts`) gains a branch for that prefix, and the
  chip draws the art through the same proxy as § 6. Every teams-lite reader sees the art
  in the reaction row.
- What stock Teams draws is whatever probe 2 measured, and the UI **states it** — the
  reaction row says plainly that a custom reaction is only drawn by teams-lite readers,
  because an outward action must never be left looking like something it is not.

If the service refuses the key, the fallback is a one-emoji reply the user sends
themselves — but that is the user's call once the measurement exists, not a silent
substitution. The spec is updated with the finding either way.

---

## 8. UI/UX — Slack's, surface by surface

Slack's own copy is quoted; everything quoted below is what the UI says.

### 8.1 Entry point: the picker's Add Emoji

Slack: the smiley in the message field opens the picker, whose footer holds **"Add
Emoji"**; custom emoji then live under a category tab wearing the workspace's mark.

Ours: the same, inside `emoji-picker.tsx`. emoji-mart already takes a `custom:` prop
with a per-emoji `src` — the same hook the Apple images use — so the Custom category is
configuration, not a new component. The **"Add Emoji"** row sits in the picker's footer.
The category tab wears teams-lite's own mark (there is no workspace).

### 8.2 The Add Emoji dialog

Two tabs, as Slack has: **"Upload Image"** and **"Emoji packs"**.

- **Upload Image** — a click-or-drop zone, then Slack's hint verbatim: *"Square images
  under 128KB and with transparent backgrounds work best."* Then **"Give it a name"**,
  an input showing fixed `:` affixes around the value, a live preview of the art at
  glyph size beside a sample line, and **"Save"**. A taken name is refused with Slack's
  own sentence: *"If your emoji name is taken, choose another."*
- **Emoji packs** — where a pack file is added (**"Add Pack"**). Slack's packs are
  curated by Slack; ours is a file a colleague hands over, so this tab is the import
  half of § 8.5.

The same dialog serves a **pasted URL** (a field beside the drop zone) and a **pasted
image** (Ctrl+V into the zone). One responsive dialog covers the phone too — Slack has a
separate iOS flow and cannot add emoji on Android at all; neither limitation is worth
copying.

### 8.3 Settings › Custom emoji — Slack's Customize › Emoji tab

Slack: workspace name → Customize → the **"Emoji"** tab → search → the delete icon →
confirm **"Delete Emoji"**; aliases are added from the same page with **"Add Alias"** →
**"Choose Emoji"** → **"Enter an alias"** → **"Save"**.

Ours: a Settings section in the shape `renamed-people-settings.tsx` already uses (and
for the same reason it exists: a list has to be findable months later). A search field,
one row per emoji — the art, `:name:`, what it is an alias of, the date added, a delete
icon — and the same two-step confirmation the app's Delete already uses, ending in
**"Delete Emoji"**. **"Add Custom Emoji"** and **"Add Alias"** sit at the top. No
"Added by" column: one person.

### 8.4 Typing one

`:shi` opens a suggestion list above the composer: custom emoji and their aliases first,
then Unicode shortcodes (`:smile:`), each row showing the art or the glyph beside its
`:name:`, keyboard-navigable, Tab or Enter to complete — Slack's typeahead.

Implementation: a second tiptap suggestion plugin beside `mention-extension.ts`. The
Unicode half reads a generated compact index (`web/scripts/generate-teams-emoji.ts` is
the precedent, ~30 KB), **not** emoji-mart's 1.5 MB dataset, which stays the lazy chunk
it is today.

### 8.5 The five sources

| Source | UI | Path |
| --- | --- | --- |
| File | drop zone / file picker | bytes straight up |
| URL (slackmojis included) | URL field in the dialog | backend fetch under `sender_icon`'s five rails |
| Clipboard image | paste into the zone | bytes straight up |
| A colleague's emoji | right-click an inline custom emoji → **"Add to my emoji"** | authenticated `teams_media` proxy |
| Pack file | **"Emoji packs"** tab → **"Add Pack"**; Settings exports one | one JSON with base64 images |

The colleague path is Slack's own: *"in a Slack Connect channel or DM, you can
right-click another org's custom emoji to import it to yours."* It reaches Teams' AMS,
never a stranger's server.

The URL path is the only one that touches a stranger's server, so `src/sender_icon.rs`'s
rails apply again: public-IP-only resolution (a domain pointing at `169.254.169.254`
would make this an SSRF into the cloud metadata endpoint), a raster sniff on the bytes
rather than the content type the server claimed, the byte cap, no cookie, referrer or
query, and a read-only backend never fetches. **No new setting**: sender icons needed one
because they fire when a list *renders*; this fires only on the user's own paste.

### 8.6 Where Slack has no counterpart

Each of these is a deliberate difference, not an omission:

1. **No roles, permissions or "Added by."** One machine, one person.
2. **WebP is accepted** although Slack lists only JPG/PNG/GIF: the app already has one
   image-type list, and refusing a file the user holds would be worse than a superset.
3. **The 50-frame GIF cap is not enforced.** Slack enforces it because it re-encodes;
   we never do, and the 128 KB cap bounds the cost.
4. **An imported pack's emoji are individually removable.** Slack refuses that because
   its packs are curated upstream; ours are ordinary rows.
5. **One responsive dialog**, not Slack's split desktop/iOS flows.
6. **The Custom category wears teams-lite's mark**, there being no workspace icon.
7. **Custom art in a stock Teams reaction row is impossible** (§ 2). Slack parity ends
   exactly there, and the UI says so rather than implying otherwise.
8. **An alias to a Unicode emoji is not implemented.** Slack lets `:+1:` alias 🙂; here an
   alias names another row of the pack and nothing else (`set_custom_emoji` refuses a
   target the pack does not hold). A Unicode alias would need a second kind of row —
   one holding a character rather than art — through the pack, the typeahead, the
   substitution and the reaction key, to save typing an emoji the picker already offers.
9. **A custom reaction is not offered with a highlight.** The key names the uploaded
   object rather than the emoji, so the key on a message says nothing about WHICH of the
   user's emoji made it: the quick row means "react with this one", and removing is done
   from the chip, which hands its own key back. A chip's label is neutral for the same
   reason — resolving a name from the reader's own pack would name their `:shipit:` over
   somebody else's picture.

---

## 9. RPCs and gating

| Method | Set | Why |
| --- | --- | --- |
| `custom_emoji` | open read | The list — names, aliases, dimensions, dates. No bytes. |
| `custom_emoji_image` | open read | Bytes for one name, base64, the `fetch_avatar` pattern: a pack of 100 emoji must not cross the socket on connect. |
| `custom_emoji_export` | open read | The pack file. It returns what the user themselves put in. |
| `custom_emoji_add` | `MACHINE_METHODS` | Writes nothing outward, but it decides what art leaves the machine under the user's name on the next send — the same reason `set_person_avatar` is gated. |
| `custom_emoji_remove` | `MACHINE_METHODS` | Same list. |
| `custom_emoji_import` | `MACHINE_METHODS` | Same list, in bulk. |

No new `OUTWARD_METHODS` entry: `send`, `edit` and `react` are already there, and a
custom emoji rides inside them. A read-only backend refuses all three writes and never
fetches a URL.

`.claude/hooks/guard-live-automation.sh` learns the three write method names in the same
change, with its test — a script must not be able to plant art in the pack of a live
backend.

---

## 10. Error handling

| Failure | What happens |
| --- | --- |
| Name taken / invalid | Dialog refuses before the write, with Slack's sentence. |
| File too large / wrong type | Refused at the dialog, and again in the store (the cap is a store invariant, not a UI nicety). |
| URL fetch fails, resolves private, or is not a raster | Refused with the reason; nothing is stored. |
| AMS upload fails during a send | The send fails; the composer says so and keeps the text (§ 5.4). |
| An emoji's art cannot be fetched on read | The literal `:shipit:` text (§ 6). |
| An emoji is deleted after it was sent | Sent messages are untouched — their art lives in AMS, and this app never rewrites a message it posted. |
| Two backends share the store | The pack is a plain table; no claim protocol needed, unlike a push or an agent run. |

---

## 11. Proof

- **Rust:** store CRUD and every cap; the name rule; alias resolution and the refusal of
  a chain; `resolve_custom_emoji` (each distinct name uploads once, each id lands in
  `amsreferences`, an unknown code stays text, the transform leaves surrounding HTML
  byte-identical); `MACHINE_METHODS` membership; read-only refusal; a scan test that the
  URL fetch names no other verb and checks every rail before the network.
- **Web unit:** name validation, the shortcode index, the suggestion filter's ordering
  (custom before Unicode), the serializer/parser round trip, the jumbo rule.
- **Mock:** `web/mock/server.ts` seeds a pack (two uploads, one alias), a colleague's
  message carrying a custom emoji, and a `{kind: "custom_emoji", clear: true}` test hook
  — which a spec **must** clear, since one mock process serves the whole run.
- **Preview:** `cd web && bun run preview -- --out /tmp/emoji --custom-emoji` captures
  the picker's Custom section and Add Emoji row, the dialog in both tabs, the `:`
  suggestion list, a bubble with an inline emoji, an emoji-only jumbo bubble, the
  Settings pane, and a reaction chip.
- **E2E:** `web/e2e/custom-emoji.spec.ts` pins every rule in § 8, plus the two rules that
  are really promises: a code the pack does not hold stays text, and an inbound emoji is
  drawn from the message's own bytes rather than from the reader's pack.
- **CLAUDE.md** gains a `## Custom emoji` section: the wire format, why the art travels,
  why the reader's pack never redraws a colleague's emoji, the gating, and the two
  measurements.

---

## 12. Build order

0. **Probes.** Both examples, both pinned to the sandbox const, the user checks stock
   Teams, findings written into this spec.
1. **The pack.** Table, caps, name rule, aliases, the three write RPCs and the three
   reads, gating, hook + hook test.
2. **Sources.** File, paste, URL (with the rails), pack import/export,
   "Add to my emoji".
3. **Insertion.** The `:` suggestion plugin, the shortcode index, emoji-mart's Custom
   category, the Add Emoji dialog, the Settings pane.
4. **Outbound.** `resolve_custom_emoji`, N-image `amsreferences`, the edit path, the
   send-failure sentence.
5. **Inbound.** The `isEmojiImage` branch, the glyph renderer, the jumbo rule.
6. **Reactions.** Only what probe 2 proved.

Stages 1–3 and 5 are reviewable against the mock with nothing leaving the machine.
Stage 4 is the first that posts, and it posts to the sandbox chat.

---

## Findings (2026-08-05)

Measured via `examples/custom_emoji_send_probe.rs` and `examples/custom_emoji_reaction_probe.rs`, both run against the live tenant on the sandbox thread.

### Inline custom emoji (probe 1)

**Sent body:**
```html
before <img itemtype="http://schema.skype.com/Emoji" itemid="a" alt=":a:" 
  src="{ams}/v1/objects/{id1}/views/imgo" width="20" height="20"> middle 
<img itemtype="http://schema.skype.com/Emoji" itemid="b" alt=":b:" 
  src="{ams}/v1/objects/{id2}/views/imgo" width="20" height="20"> after
```
With `amsreferences: [id1, id2]`.

**What survived:**
- `itemtype="http://schema.skype.com/Emoji"`: yes
- `src`: yes, but REWRITTEN
- `width` and `height`: yes
- Inline positioning: yes — both images stayed BETWEEN the surrounding words ("before" precedes first image, "middle" sits between the two, "after" follows second)

**The src rewrite:** Teams rewrote the AMS host. What came back was `https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/{id}/views/imgo`, not the `*.asm.skype.com` AMS endpoint the object was created on. The inbound parser must therefore match on `itemtype`, not on the host. `teams_media::is_allowed_media_url` already covers the `asyncgw` form.

**AMS object reuse:** A second message re-referencing the first AMS object id was accepted (200 OK). The upload-once-use-many cache in § 5.3 is viable as a later increment.

**Conclusion:** The wire format in § 5.2 is real. Teams accepts it, keeps all attributes, and inline custom emoji will render correctly in both teams-lite and stock Teams clients.

### Custom emoji reactions (probe 2)

**Key acceptance:** An arbitrary emotion key is accepted (200 OK) and read back in `properties.emotions`. Re-run on 2026-08-05 with the key the app really mints — `tlcustom-<the AMS object URL>`, 116 characters:
```json
[{"key": "tlcustom-https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d2-d37b…/views/imgo",
  "users": [{"mri": "8:orgid:...", "time": ..., "value": "1785960295519"}]}]
```
It comes back byte for byte, which the key shape depends on: the key IS the address of the art, so a key the service normalized or truncated would leave every reader with a URL that fetches nothing.

**Length ceiling:** none below **289 characters**, which was accepted and read back (`tlcustom-` + 280 characters). An object URL is about 100, so the shape has ~170 characters of headroom. No ceiling above that was looked for — there is nothing this feature would do with one.

**Stock Teams appearance: not observed.** Nobody has looked at a stock Teams client while one of these keys was set, on any run of this probe. So what their reaction row draws in place of the art is unknown — likely the key as text, since their client renders a reaction from its own asset catalogue and has no fetch path, but that is a guess and is written here as one. The UI states only what is known: the art is drawn in teams-lite (§ 7).

**Clear behavior:** `value: 0` leaves the entry in `properties.emotions` with our user's value set to `"0"`, which is the server-side shape of a cleared reaction. Re-confirmed on the same run.

**Conclusion:** Custom emoji reactions are viable in teams-lite. What a stock client shows instead is unmeasured, which is why the surface says what teams-lite does rather than what other clients do not.
