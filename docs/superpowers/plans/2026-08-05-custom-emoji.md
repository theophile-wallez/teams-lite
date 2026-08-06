# Custom Emoji Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload, name and use custom emoji and GIFs in teams-lite the way Slack does, with the art travelling inside the message so every teams-lite reader — and, where Teams permits, every stock client — sees it.

**Architecture:** The pack is a local SQLite table holding bytes. A custom emoji reaches the wire as the literal text `:shipit:`, and the backend substitutes each code the pack holds with Teams' own inline-emoji markup pointing at an AMS object it uploads. Inbound, that markup is drawn as a glyph from the bytes the *message* carries, never from the reader's pack.

**Tech Stack:** Rust (rusqlite, reqwest, tokio) backend; TypeScript + React + tiptap + emoji-mart web app; Bun for scripts and tests; vitest (unit) and Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-08-05-custom-emoji-design.md` — read § 2 and § 8 before starting; the copy strings in § 8 are Slack's own and are not to be paraphrased.

## Global Constraints

- **English only** in every string, comment, identifier, log line and commit message. Non-English text in a committed file is a bug (AGENTS.md § Language policy).
- **Hugeicons only.** Every glyph comes from `@hugeicons/core-free-icons` drawn through `<HugeiconsIcon icon={…} />`; an icon held as a value is typed `IconSvgElement`. `web/src/lib/icon-library.test.ts` fails on a second icon package.
- **Slack's copy, verbatim:** `"Square images under 128KB and with transparent backgrounds work best."` / `"Give it a name"` / `"Add Emoji"` / `"Upload Image"` / `"Emoji packs"` / `"Add Pack"` / `"Save"` / `"Add Custom Emoji"` / `"Add Alias"` / `"Choose Emoji"` / `"Enter an alias"` / `"Delete Emoji"` / `"If your emoji name is taken, choose another."` / `"Add to my emoji"`.
- **Limits:** `MAX_CUSTOM_EMOJI_BYTES = 128 * 1024`, `MAX_CUSTOM_EMOJI_DIMENSION = 512`, types PNG/JPEG/GIF/WebP only (never SVG). Over either limit is **refused with the reason**, never scaled — nothing here re-encodes.
- **Name rule:** `^[a-z0-9][a-z0-9_+-]{0,63}$`, unique across names *and* aliases, refused when it collides with a Unicode shortcode.
- **Gating:** `custom_emoji_add` / `custom_emoji_remove` / `custom_emoji_import` are `MACHINE_METHODS` entries. Reads stay open. A read-only backend refuses all three and never fetches a URL.
- **No new port, no new dependency.** emoji-mart, tiptap, rusqlite and reqwest are already here; emoji-mart's 1.5 MB dataset stays behind `lazy(() => import("./emoji-picker"))`.
- **Commits:** Conventional Commits, no AI attribution, no `Co-Authored-By`.
- **Test gate before merge:** `cargo test`, and in `web/`: `bun run test`, `bun run typecheck`, `bun run test:e2e`. Plus `python3 .claude/hooks/guard-live-automation.test.py` (Task 4 touches the hook).
- **`CLAUDE.md` is a symlink to `AGENTS.md`** — edit `AGENTS.md`.

## File Structure

**Create:**
- `src/custom_emoji.rs` — the pure half: name rule, caps, type list, the `:code:` substitution walker, the row type. No I/O.
- `web/src/lib/custom-emoji.ts` — the port of the name rule and the code scanner, plus the pack's client-side types. Pinned to the Rust module case for case by its tests (the `agent_markdown.rs` ↔ `agent-markdown.ts` precedent).
- `web/src/lib/emoji-shortcodes.ts` — GENERATED: `name → native` for Unicode shortcodes.
- `web/scripts/generate-emoji-shortcodes.ts` — writes the file above from emoji-mart's dataset.
- `web/src/components/custom-emoji.tsx` — one custom emoji drawn as a glyph (the `emoji.tsx` sibling).
- `web/src/components/custom-emoji-extension.ts` + `custom-emoji-chip.tsx` — the composer's inline node and its view (copy of the `agent-tag-extension.ts` / `agent-tag.tsx` pair).
- `web/src/components/emoji-suggestions.tsx` — the `:` typeahead list (sibling of `mention-suggestions.tsx`).
- `web/src/components/add-emoji-dialog.tsx` — the Add Emoji dialog, both tabs.
- `web/src/components/custom-emoji-settings.tsx` — Settings › Custom emoji.
- `examples/custom_emoji_send_probe.rs`, `examples/custom_emoji_reaction_probe.rs` — the two measurements.
- `web/e2e/custom-emoji.spec.ts`.

**Modify:** `src/store.rs` (table + CRUD), `src/bin/server.rs` (RPCs, `MACHINE_METHODS`, `machine_effect`, send/edit wiring), `src/teams_send.rs` (N images, substitution call), `src/lib.rs` (module), `web/src/lib/rich-text.ts` (inbound branch + node type), `web/src/lib/protocol.ts` (types), `web/src/lib/store.ts` (controller methods), `web/src/lib/ws-client.ts` (backend calls), `web/src/components/rich-content.tsx` (render the node), `web/src/components/emoji-picker.tsx` (Custom category + Add Emoji row), `web/src/components/rich-editor.tsx` (register the extension), `web/src/components/message-bubble.tsx` (Add to my emoji row), `web/src/components/settings-pane.tsx` (register the section), `web/mock/server.ts`, `web/scripts/preview.ts`, `web/package.json` (one script), `.claude/hooks/guard-live-automation.sh` + its test, `AGENTS.md`.

---

### Task 0: The two measurements

**Files:**
- Create: `examples/custom_emoji_send_probe.rs`
- Create: `examples/custom_emoji_reaction_probe.rs`

**Interfaces:**
- Consumes: `teams_lite::{auth, teams, teams_send, teams_read}` as `examples/agent_stream_probe.rs` does — read that file first for the session/token boilerplate and copy it.
- Produces: two findings written into the spec, which Task 5 (`width`/`height`/`itemtype` survival) and Task 13 (reactions) depend on.

**Why this is first:** the wire format in § 5.2 of the spec is an assumption until probe 1 runs, and Task 13 does not exist unless probe 2 succeeds.

- [ ] **Step 1: Read the probe that already exists**

Read `examples/agent_stream_probe.rs` end to end. Copy its session setup, its sandbox constant style, and its output style.

- [ ] **Step 2: Write `custom_emoji_send_probe.rs`**

Hard-code the sandbox thread as a const and name no other conversation — the automation hook refuses any other shape, including a target taken from an argument:

```rust
/// The ONE conversation this probe may write to (AGENTS.md § Sending messages).
const SANDBOX: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";
```

It must:
1. Upload two small PNGs (build them inline as bytes; a 1×1 and a 2×2 are enough) through `teams_send::upload_image`'s AMS path — expose it for the probe if it is private, or duplicate the two requests in the example.
2. POST one message to `SANDBOX` whose content is `before <img itemtype="http://schema.skype.com/Emoji" itemid="a" alt=":a:" src="{ams1}" width="20" height="20"> middle <img … itemid="b" … src="{ams2}" …> after`, with `amsreferences: [id1, id2]`.
3. Read the thread back with `teams_read` and print the stored body verbatim, then print, one line each: whether `itemtype` survived, whether `src` survived, whether `width`/`height` survived, and whether both images are still *between* the words.
4. POST a second message referencing `id1` again, and print whether it was accepted.

- [ ] **Step 3: Run probe 1**

```bash
. bin/broker-env.sh && teams_lite_export_broker_bus && \
  cargo run --example custom_emoji_send_probe
```

- [ ] **Step 4: Ask the user what stock Teams drew**

No probe can see this. Ask them to open the sandbox thread in real Teams (phone or desktop) and report: are the two images inline and glyph-sized, or blown up / attached / missing?

- [ ] **Step 5: Write `custom_emoji_reaction_probe.rs`**

Same const. It must: post one message to `SANDBOX`; `PUT …/messages/{id}/properties?name=emotions` with `{"emotions":{"key":"tlcustom-shipit-<the ams id from probe 1>","value":<now_ms>}}`; read the message's `properties.emotions` back and print it; then clear with `value: 0` and print the snapshot again. Print the HTTP status and body of every call — a refusal's shape is the finding.

- [ ] **Step 6: Run probe 2 and ask again**

```bash
. bin/broker-env.sh && teams_lite_export_broker_bus && \
  cargo run --example custom_emoji_reaction_probe
```

Then ask the user what the stock client showed in the reaction row while the key was set.

- [ ] **Step 7: Write both findings into the spec**

Add a `## Findings (2026-08-05)` section to `docs/superpowers/specs/2026-08-05-custom-emoji-design.md` stating, in plain sentences: what the sanitizer kept, whether AMS objects can be re-referenced, whether an arbitrary emotion key is accepted, its length ceiling if one appeared, and what stock Teams drew in both cases. If probe 1 shows the markup does not survive, **stop and report** — the spec's § 5 needs the fallback in its approach C, and that is a decision for the user.

- [ ] **Step 8: Commit**

```bash
git add examples/custom_emoji_send_probe.rs examples/custom_emoji_reaction_probe.rs docs/superpowers/specs/2026-08-05-custom-emoji-design.md
git commit -m "chore(emoji): measure what Teams keeps of an inline custom emoji"
```

---

### Task 1: The pure module — name rule, caps, code scanner

**Files:**
- Create: `src/custom_emoji.rs`
- Modify: `src/lib.rs` (add `pub mod custom_emoji;` in alphabetical position)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub const MAX_CUSTOM_EMOJI_BYTES: usize = 128 * 1024;`
  - `pub const MAX_CUSTOM_EMOJI_DIMENSION: u32 = 512;`
  - `pub const CUSTOM_EMOJI_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];`
  - `pub fn is_valid_name(name: &str) -> bool`
  - `pub fn codes_in_body(html: &str) -> Vec<String>` — every distinct `:name:` in the body's text runs, outside tags, outside `<code>`/`<pre>`, outside a quote block, in first-appearance order.
  - `pub fn substitute_codes(html: &str, art: &dyn Fn(&str) -> Option<String>) -> String` — replaces each such code with the emoji markup, where `art(name)` returns the AMS `src` for a name the pack holds and `None` otherwise.
  - `pub struct CustomEmoji { pub name: String, pub alias_of: String, pub content_type: String, pub width: u32, pub height: u32, pub source: String, pub added_ms: i64 }`

- [ ] **Step 1: Write the failing tests**

Create `src/custom_emoji.rs` with the module doc comment (say *why* the code is the wire format — the agent-tag precedent — and why quotes and code blocks are skipped) and this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn art(name: &str) -> Option<String> {
        match name {
            "shipit" => Some("https://ams.example/v1/objects/0-a/views/imgo".into()),
            "party" => Some("https://ams.example/v1/objects/0-b/views/imgo".into()),
            _ => None,
        }
    }

    #[test]
    fn a_name_is_lowercase_and_short() {
        assert!(is_valid_name("shipit"));
        assert!(is_valid_name("ship-it_2+"));
        assert!(is_valid_name("0"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("ShipIt"), "uppercase is not a Slack emoji name");
        assert!(!is_valid_name("-ship"), "must start alphanumeric");
        assert!(!is_valid_name("ship it"));
        assert!(!is_valid_name("ship:it"), "a colon would end the code early");
        assert!(!is_valid_name(&"a".repeat(65)));
    }

    #[test]
    fn codes_are_read_from_text_runs_only() {
        assert_eq!(codes_in_body("<p>ship :shipit: now</p>"), vec!["shipit"]);
        // Twice in the body is ONE upload.
        assert_eq!(codes_in_body("<p>:shipit: :shipit:</p>"), vec!["shipit"]);
        // First-appearance order, so a body's own reading order decides.
        assert_eq!(codes_in_body("<p>:party: :shipit:</p>"), vec!["party", "shipit"]);
        // Not inside a tag or an attribute.
        assert_eq!(codes_in_body(r#"<img alt=":shipit:" src="x">"#), Vec::<String>::new());
        // Not a code the pack does not hold — that filtering is the caller's, so the
        // scanner reports every well-formed code and `substitute_codes` decides.
        assert_eq!(codes_in_body("<p>:nope:</p>"), vec!["nope"]);
    }

    #[test]
    fn code_blocks_and_quotes_are_left_alone() {
        assert_eq!(codes_in_body("<pre><code>:shipit:</code></pre>"), Vec::<String>::new());
        assert_eq!(codes_in_body("<p>a <code>:shipit:</code> b</p>"), Vec::<String>::new());
        let quote = r#"<blockquote itemtype="http://schema.skype.com/Reply">:shipit:</blockquote><p>:party:</p>"#;
        assert_eq!(codes_in_body(quote), vec!["party"], "a colleague's words are not ours to redraw");
    }

    #[test]
    fn substitution_emits_teams_own_emoji_markup() {
        let out = substitute_codes("<p>ship :shipit: now</p>", &art);
        assert_eq!(
            out,
            "<p>ship <img itemtype=\"http://schema.skype.com/Emoji\" itemid=\"shipit\" \
             alt=\":shipit:\" src=\"https://ams.example/v1/objects/0-a/views/imgo\" \
             width=\"20\" height=\"20\"> now</p>"
        );
    }

    #[test]
    fn an_unknown_code_stays_text() {
        let out = substitute_codes("<p>:nope: :shipit:</p>", &art);
        assert!(out.contains(":nope:"), "a code the pack does not hold is the user's own text");
        assert!(out.contains("itemid=\"shipit\""));
    }

    #[test]
    fn everything_around_a_code_is_byte_identical() {
        let body = "<p>a &amp; b <strong>c</strong> :nope: <a href=\"http://x/:shipit:\">l</a></p>";
        assert_eq!(substitute_codes(body, &art), body, "no code the pack holds, no change");
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test custom_emoji`
Expected: FAIL — the module's functions do not exist.

- [ ] **Step 3: Implement the module**

One scanner, used by both public functions, so `codes_in_body` and `substitute_codes` can never disagree about where a code is. Sketch:

```rust
/// A region the substitution never enters, and why: `code`/`pre` because Slack does not
/// render an emoji inside code either, and a REPLY QUOTE because it holds a colleague's
/// own words — substituting our art into them would rewrite what they wrote.
const SKIPPED_TAGS: [&str; 3] = ["code", "pre", "blockquote"];

/// Walk `html` once, handing every text run outside a tag and outside a skipped region to
/// `on_text`, and every other byte to `on_raw`. This is the only place that knows how a
/// body is traversed.
fn walk(html: &str, mut on_raw: impl FnMut(&str), mut on_text: impl FnMut(&str)) { … }
```

Rules the implementation must hold, each already pinned above: a tag's interior is raw; a skipped tag's whole subtree is raw until its matching close tag (count nesting by name); a code is `:` + a valid name + `:`; a name is scanned with `is_valid_name`'s own character set so the two cannot drift.

- [ ] **Step 4: Run the tests**

Run: `cargo test custom_emoji`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/custom_emoji.rs src/lib.rs
git commit -m "feat(emoji): read a custom emoji code out of a message body"
```

---

### Task 2: The pack in the store

**Files:**
- Modify: `src/store.rs` — the schema block (beside `person_overrides`, ~line 93), and a new impl section
- Test: `src/store.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `custom_emoji::{CustomEmoji, is_valid_name}` (Task 1).
- Produces:
  - `pub fn custom_emoji(&self) -> Result<Vec<CustomEmoji>>` — every row, `name` ascending, bytes excluded.
  - `pub fn custom_emoji_art(&self, name: &str) -> Result<Option<(String, Vec<u8>)>>` — `(content_type, bytes)`, following one alias hop.
  - `pub fn set_custom_emoji(&self, name: &str, art: Option<(&str, &[u8], u32, u32)>, alias_of: Option<&str>, source: &str, now_ms: i64) -> Result<()>`
  - `pub fn remove_custom_emoji(&self, name: &str) -> Result<bool>`

- [ ] **Step 1: Write the failing tests**

Add to `src/store.rs`'s test module. Follow the neighbouring `set_person_avatar` tests for the in-memory store helper:

```rust
#[test]
fn a_custom_emoji_round_trips_with_its_bytes() {
    let s = test_store();
    let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47];
    s.set_custom_emoji("shipit", Some(("image/png", png, 128, 128)), None, "upload", 100).unwrap();
    let all = s.custom_emoji().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "shipit");
    assert_eq!(all[0].width, 128);
    assert_eq!(all[0].source, "upload");
    assert_eq!(s.custom_emoji_art("shipit").unwrap().unwrap(), ("image/png".to_string(), png.to_vec()));
}

#[test]
fn an_alias_resolves_to_its_targets_art() {
    let s = test_store();
    let png: &[u8] = &[1, 2, 3];
    s.set_custom_emoji("shipit", Some(("image/png", png, 64, 64)), None, "upload", 100).unwrap();
    s.set_custom_emoji("ship", None, Some("shipit"), "upload", 101).unwrap();
    assert_eq!(s.custom_emoji_art("ship").unwrap().unwrap().1, png.to_vec());
}

#[test]
fn an_alias_never_points_at_an_alias() {
    let s = test_store();
    s.set_custom_emoji("shipit", Some(("image/png", &[1], 8, 8)), None, "upload", 100).unwrap();
    s.set_custom_emoji("ship", None, Some("shipit"), "upload", 101).unwrap();
    assert!(
        s.set_custom_emoji("s", None, Some("ship"), "upload", 102).is_err(),
        "a chain would make one read walk an unbounded graph"
    );
}

#[test]
fn a_name_is_validated_in_the_store_too() {
    let s = test_store();
    assert!(s.set_custom_emoji("Ship It", Some(("image/png", &[1], 8, 8)), None, "upload", 1).is_err());
}

#[test]
fn removing_one_says_whether_it_was_there() {
    let s = test_store();
    s.set_custom_emoji("shipit", Some(("image/png", &[1], 8, 8)), None, "upload", 100).unwrap();
    assert!(s.remove_custom_emoji("shipit").unwrap());
    assert!(!s.remove_custom_emoji("shipit").unwrap());
    assert!(s.custom_emoji().unwrap().is_empty());
}

#[test]
fn an_emoji_is_either_art_or_an_alias() {
    let s = test_store();
    assert!(
        s.set_custom_emoji("x", None, None, "upload", 1).is_err(),
        "a row that is neither art nor an alias names nothing"
    );
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test custom_emoji --lib`
Expected: FAIL — no such methods.

- [ ] **Step 3: Add the table**

In the schema block, beside `person_overrides`, with a comment saying why bytes and not a path or a URL (the `person_overrides` comment above it is the model to follow):

```sql
CREATE TABLE IF NOT EXISTS custom_emoji (
    name         TEXT PRIMARY KEY,
    alias_of     TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT '',
    bytes        BLOB,
    width        INTEGER NOT NULL DEFAULT 0,
    height       INTEGER NOT NULL DEFAULT 0,
    source       TEXT NOT NULL DEFAULT '',
    added_ms     INTEGER NOT NULL DEFAULT 0
);
```

`CREATE TABLE IF NOT EXISTS` covers old stores — no `migrate()` ALTER is needed for a brand-new table. Check `src/store.rs`'s schema-parsing test (~line 4285) still passes; it reads this batch.

- [ ] **Step 4: Implement the four methods**

`set_custom_emoji` validates: the name, that exactly one of `art` / `alias_of` is present, that an `alias_of` naming a custom emoji is not itself an alias, and the dimension cap. It does **not** validate the byte cap or the content type — that is the RPC's job, where a client's input arrives (this is the split `set_person_avatar` already documents).

- [ ] **Step 5: Run the tests**

Run: `cargo test custom_emoji --lib`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/store.rs
git commit -m "feat(emoji): hold the pack in the store, bytes and all"
```

---

### Task 3: The RPCs and their gate

**Files:**
- Modify: `src/bin/server.rs` — `MACHINE_METHODS` (15 → 18), `machine_effect`, the dispatch match, and the header comment at the top of the file that lists the read methods
- Test: `src/bin/server.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: Task 1's constants and `is_valid_name`; Task 2's four store methods.
- Produces these wire methods:
  - `custom_emoji` → `{ "emoji": [{ name, alias_of, content_type, width, height, source, added_ms }] }`
  - `custom_emoji_image { name }` → `{ "content_type": "image/png", "data_base64": "…" }` or `{ "content_type": "", "data_base64": "" }` when there is none
  - `custom_emoji_export` → `{ "emoji": [{ name, alias_of, content_type, data_base64, width, height }] }`
  - `custom_emoji_add { name, alias_of?, content_type?, data_base64?, width?, height?, url?, media_url?, source }` → `{ "added": true }`
  - `custom_emoji_remove { name }` → `{ "removed": bool }`
  - `custom_emoji_import { emoji: [ …export shape… ] }` → `{ "added": <count> }`

- [ ] **Step 1: Write the failing tests**

The existing tests that iterate the two method lists are the model — find them by `grep -n "MACHINE_METHODS" src/bin/server.rs`. Add:

```rust
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test writing_the_emoji_pack --bin server`
Expected: FAIL — `write_class` returns `None` for the writes.

- [ ] **Step 3: Add the three names to `MACHINE_METHODS` and `machine_effect`**

Bump the array length to 18. Add a paragraph to the doc comment above the array explaining why these three write-only-to-the-store methods are gated — the same reasoning `set_person_name` / `set_person_avatar` carry, but for a different thing: *the pack decides what art leaves this machine under the user's name on the next send.* The effect string for all three:

```rust
"custom_emoji_add" | "custom_emoji_remove" | "custom_emoji_import" => {
    "decides which pictures this machine can post as emoji under the user's name"
}
```

- [ ] **Step 4: Implement the six handlers**

Copy the shape of `"set_person_avatar"` (`src/bin/server.rs:2878`) for the base64 decode and the type check. Validation order in `custom_emoji_add`, all before the store call:

1. `custom_emoji::is_valid_name(&name)`, else `"an emoji name may hold lowercase letters, numbers, dashes and underscores"`.
2. The name is free — no row and no alias holds it, else the error is Slack's own sentence: `"If your emoji name is taken, choose another."`
3. Exactly one source among `data_base64`, `url`, `media_url`, `alias_of`.
4. `CUSTOM_EMOJI_TYPES.contains(&content_type)`, else `"an emoji must be a PNG, JPEG, GIF or WebP image"`.
5. `bytes.len() <= MAX_CUSTOM_EMOJI_BYTES`, else `"an emoji must be 128 KB or smaller"`.
6. `width <= MAX_CUSTOM_EMOJI_DIMENSION && height <= …`, else `"an emoji must be 512 pixels or smaller on a side"`.

Leave `url` and `media_url` returning `anyhow::bail!("not implemented")` for now — Task 4 fills them. `custom_emoji_import` runs the same validation per entry and reports how many were added; an entry that fails is skipped and named in the returned error only if *none* was added (a pack with one bad row still imports the rest).

Broadcast a `custom_emoji_changed` event after every successful write, so a second open page and the other backend's pages re-read. Follow `person_override_changed` (`grep -n person_override_changed src/bin/server.rs`).

- [ ] **Step 5: Run the tests**

Run: `cargo test --bin server`
Expected: PASS, including the three existing list-iterating tests.

- [ ] **Step 6: Commit**

```bash
git add src/bin/server.rs
git commit -m "feat(emoji): read and write the pack over the socket, writes gated"
```

---

### Task 4: The two fetching sources, and the hook

**Files:**
- Modify: `src/bin/server.rs` — the `url` and `media_url` branches of `custom_emoji_add`
- Modify: `.claude/hooks/guard-live-automation.sh` (line ~497, both alternation lists)
- Test: `.claude/hooks/guard-live-automation.test.py`

**Interfaces:**
- Consumes: `sender_icon::{fetch_icon, MAX_ICON_BYTES}` — read `src/sender_icon.rs` first; the fetch it performs is the one to reuse, and its five rails are the reason it exists. `teams_media::{fetch_media, is_allowed_media_url}` for the other path.
- Produces: `custom_emoji_add` accepting `url` and `media_url`.

- [ ] **Step 1: Write the failing hook test**

In `.claude/hooks/guard-live-automation.test.py`, beside the cases that already cover `set_person_avatar`:

```python
def test_blocks_a_script_that_writes_the_emoji_pack():
    assert blocked('bun -e \'ws.send(JSON.stringify({method:"custom_emoji_add"}))\' 127.0.0.1:19420')
    assert blocked('bun -e \'ws.send(JSON.stringify({method:"custom_emoji_import"}))\' 127.0.0.1:19440')

def test_allows_reading_the_emoji_pack():
    assert not blocked('bun -e \'ws.send(JSON.stringify({method:"custom_emoji"}))\' 127.0.0.1:19430')
```

Match the file's own helper names and style — read it before writing.

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 .claude/hooks/guard-live-automation.test.py`
Expected: FAIL on the two `blocked` assertions.

- [ ] **Step 3: Add the three method names to the hook**

Both alternation lists on line ~497 get `custom_emoji_add|custom_emoji_remove|custom_emoji_import`. Add a comment above, in the file's voice, saying why: *a script that could plant art in the pack could post a picture under the user's name on the next send.*

- [ ] **Step 4: Run the hook test**

Run: `python3 .claude/hooks/guard-live-automation.test.py`
Expected: PASS.

- [ ] **Step 5: Implement the URL branch**

Refactor `sender_icon`'s fetch so the rails are shared rather than copied: extract its request-and-check body into `pub async fn fetch_raster(http: &reqwest::Client, url: &str, max_bytes: usize) -> Result<Option<Media>>` and have `fetch_icon` call it. **Every rail must still hold** and the existing scan test `the_sender_icon_handler_checks_every_rail_before_the_network` must still pass — public-IP-only resolution, the raster sniff on the bytes rather than the claimed type, the byte cap, no cookie/referrer/query. Then `custom_emoji_add { url }` calls `fetch_raster(http, url, MAX_CUSTOM_EMOJI_BYTES)` and stores what comes back, with `source = "url:<host>"`.

- [ ] **Step 6: Implement the media_url branch**

`media_url` is a Teams-hosted image — a colleague's own custom emoji, lifted from a message. Refuse anything `teams_media::is_allowed_media_url` rejects, then `teams_media::fetch_media(&http, &session, url)`, then the same type/byte/dimension checks. `source = "message"`.

- [ ] **Step 7: Write the Rust tests**

```rust
#[test]
fn adding_an_emoji_from_a_url_never_names_a_second_fetch_path() {
    // The URL source must go through the module that holds the rails, and nothing else.
    let src = include_str!("server.rs");
    let handler = handler_source(src, "custom_emoji_add");   // reuse the helper the
    // `marking_a_mail_read_never_names_a_graph_write` test already uses; grep for it.
    assert!(handler.contains("fetch_raster"), "the URL source must reuse sender_icon's rails");
    assert!(!handler.contains("reqwest::get"), "no second, unrailed fetch");
}
```

- [ ] **Step 8: Run everything touched**

Run: `cargo test` and `python3 .claude/hooks/guard-live-automation.test.py`
Expected: PASS, `sender_icon`'s own scan test included.

- [ ] **Step 9: Commit**

```bash
git add src/bin/server.rs src/sender_icon.rs .claude/hooks/guard-live-automation.sh .claude/hooks/guard-live-automation.test.py
git commit -m "feat(emoji): take an emoji from a URL or from a colleague's message"
```

---

### Task 5: Substitution on the way out

**Files:**
- Modify: `src/teams_send.rs` — `ImageUpload` call path, `build_body`, `send_message`, `edit_message`
- Modify: `src/bin/server.rs` — the `"send"` and `"edit"` handlers
- Test: `src/teams_send.rs` tests

**Interfaces:**
- Consumes: `custom_emoji::{codes_in_body, substitute_codes}` (Task 1); `Store::custom_emoji_art` (Task 2).
- Produces: `pub struct EmojiArt { pub name: String, pub content_type: String, pub bytes: Vec<u8> }` and
  `pub async fn resolve_custom_emoji(http, session, ic3, conversation_id, html, art: &[EmojiArt]) -> Result<(String, Vec<String>)>` — the rewritten body and the AMS ids for `amsreferences`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_body_with_no_code_is_untouched_and_references_nothing() {
    let (html, refs) = rewrite_for_test("<p>hello</p>", &[]);
    assert_eq!(html, "<p>hello</p>");
    assert!(refs.is_empty());
}

#[test]
fn each_distinct_code_uploads_once_and_lands_in_amsreferences() {
    let art = [art_of("shipit"), art_of("party")];
    let (html, refs) = rewrite_for_test("<p>:shipit: :party: :shipit:</p>", &art);
    assert_eq!(refs.len(), 2, "twice in one body is one object");
    assert_eq!(html.matches("itemid=\"shipit\"").count(), 2, "both occurrences are drawn");
}

#[test]
fn the_body_carries_every_reference_it_names() {
    let art = [art_of("shipit")];
    let (html, refs) = rewrite_for_test("<p>:shipit:</p>", &art);
    for id in &refs {
        assert!(html.contains(id.as_str()), "an amsreference no body names is a leak");
    }
}

#[test]
fn build_body_takes_many_amsreferences() {
    let body = build_body_for_test_with_refs(&["0-a".into(), "0-b".into()]);
    assert_eq!(body["amsreferences"], json!(["0-a", "0-b"]));
}
```

Write `rewrite_for_test` as a thin harness over the pure half (the upload is I/O; split `resolve_custom_emoji` so the substitution and the reference collection are testable with a stub `art` closure, exactly as Task 1 did).

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test teams_send`
Expected: FAIL.

- [ ] **Step 3: Widen `amsreferences` from one to N**

`build_body` currently sets `body["amsreferences"] = json!([image.id])`. Make it take a `&[String]` of ids and merge the attachment image's id with the emoji ids. The existing attachment tests must keep passing untouched — a photo send is unchanged.

- [ ] **Step 4: Implement `resolve_custom_emoji`**

For each name in `codes_in_body(html)` that `art` holds: upload once through the same AMS path `upload_image` uses (extract the two requests into a private `async fn upload_ams_object(http, session, ic3, conversation_id, name, bytes) -> Result<String>` and have `upload_image` call it too — one uploader, not two). Then `substitute_codes` with a closure mapping name → the object's `views/imgo` URL. Return the rewritten html and the ids.

- [ ] **Step 5: Wire the send handler**

In `"send"`: after reading `content_html`, load the pack's art for the codes the body names (`store.custom_emoji_art` per code from `codes_in_body`), and pass it in. A failed upload propagates — the send fails, `sendError` shows it at the composer, and nothing is posted (spec § 5.4). Do **not** catch it into a partial send.

- [ ] **Step 6: Wire the edit handler**

`"edit"` sends plain text today (`content_html: None`). Escape the text as it already does, run the same substitution over the escaped body, and pass the result as `content_html` so the emoji survives an edit. Update the local row with the same rewritten body it sent, so the row and the network agree — the handler already comments on exactly that.

- [ ] **Step 7: Run the tests**

Run: `cargo test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/teams_send.rs src/bin/server.rs
git commit -m "feat(emoji): post a custom emoji as Teams' own inline emoji"
```

---

### Task 6: Drawing one that arrived

**Files:**
- Modify: `web/src/lib/rich-text.ts` — `isEmojiImage` region (~line 240) and the `img` branch (~line 406), plus the `RichTag` union and `serializeRichNodes`
- Create: `web/src/components/custom-emoji.tsx`
- Modify: `web/src/components/rich-content.tsx` — render the node
- Test: `web/src/lib/rich-text.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the read path).
- Produces: rich node `{ type: "element", tag: "customEmoji", attrs: { src: string, code: string } }`, and `export function CustomEmoji(props: { src: string; code: string; jumbo?: boolean })`.

- [ ] **Step 1: Write the failing tests**

```ts
const EMOJI_IMG =
  '<img itemtype="http://schema.skype.com/Emoji" itemid="shipit" alt=":shipit:" ' +
  'src="https://eu-api.asm.skype.com/v1/objects/0-a/views/imgo" width="20" height="20">';

it("keeps a custom emoji as art, not as its alt text", () => {
  const nodes = parseRichHtml(`<p>ship ${EMOJI_IMG}</p>`);
  const emoji = findNode(nodes, (n) => n.type === "element" && n.tag === "customEmoji");
  expect(emoji).toBeTruthy();
  expect(emoji.attrs.code).toBe(":shipit:");
  expect(emoji.attrs.src).toContain("/v1/objects/0-a/views/imgo");
});

it("still collapses Teams' own emoji to its glyph", () => {
  const teams =
    '<img itemtype="http://schema.skype.com/Emoji" alt="🙂" ' +
    'src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/emoticons/smile/default/20_f.png">';
  expect(nodeText(parseRichHtml(`<p>${teams}</p>`))).toBe("🙂");
});

it("is not a picture: never an img node, so it is never zoomable", () => {
  const nodes = parseRichHtml(`<p>${EMOJI_IMG}</p>`);
  expect(findNode(nodes, (n) => n.type === "element" && n.tag === "img")).toBeUndefined();
});

it("reads as its code in copyable text", () => {
  expect(nodeText(parseRichHtml(`<p>a ${EMOJI_IMG}</p>`))).toBe("a :shipit:");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && bunx vitest run src/lib/rich-text.test.ts`
Expected: FAIL — the parser collapses the image to its `alt`.

- [ ] **Step 3: Implement the parser branch**

In the `img` branch: when `isEmojiImage(attrs)` **and** the `src` is not the personal-expressions CDN (so it is our AMS-hosted art), emit the `customEmoji` node carrying `safeSrc(attrs["src"])` and the `alt`. Everything else in that branch is unchanged. Add `"customEmoji"` to `RichTag`; `nodeText` returns its `code`; `serializeRichNodes` (line ~1071) writes it back as the same `<img itemtype=… >` it came from, so an edit or a quote of a message keeps the emoji.

- [ ] **Step 4: Write `custom-emoji.tsx`**

Model it on `emoji.tsx` — the doc comment there explains why every reaction surface shares one glyph, and this component is its sibling for art a message carries. It is **a glyph, not a picture**: `size-[1.15em]`, `align-[-0.15em]`, `select-none`, `draggable={false}`, `title={code}`, `alt={code}`, no lightbox, no download, no zoom. `jumbo` draws it at `size-[2.5em]`. The `src` is a Teams host, so it goes through the media proxy the way `media-image.tsx` does — `controller.retainMedia` / `loadMedia` / `releaseMedia`, and on failure it renders the bare `code` as text.

- [ ] **Step 5: Render it, and add the jumbo rule**

In `rich-content.tsx`, `case "customEmoji"` renders `<CustomEmoji />`. Jumbo: a body whose every node is a `customEmoji` or whitespace draws them jumbo — one pure helper in `web/src/lib/custom-emoji.ts`, `export function bodyIsOnlyEmoji(nodes: RichNode[]): boolean`, with its own unit test (one emoji → true; emoji plus a word → false; two emoji and a space → true).

- [ ] **Step 6: Run the tests**

Run: `cd web && bunx vitest run src/lib/rich-text.test.ts src/lib/custom-emoji.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/rich-text.ts web/src/lib/custom-emoji.ts web/src/lib/custom-emoji.test.ts web/src/components/custom-emoji.tsx web/src/components/rich-content.tsx web/src/lib/rich-text.test.ts
git commit -m "feat(emoji): draw a custom emoji from the bytes its message carries"
```

---

### Task 7: The pack in the page, and in the mock

**Files:**
- Modify: `web/src/lib/protocol.ts`, `web/src/lib/ws-client.ts`, `web/src/lib/store.ts`
- Modify: `web/mock/server.ts`
- Test: `web/src/lib/custom-emoji.test.ts`

**Interfaces:**
- Consumes: Task 3's six wire methods and the `custom_emoji_changed` event.
- Produces:
  - `export type CustomEmoji = { name: string; aliasOf: string; contentType: string; width: number; height: number; source: string; addedMs: number }`
  - Controller: `loadCustomEmoji(): Promise<CustomEmoji[]>`, `customEmojiUrl(name: string): Promise<string | null>` (a cached blob URL, the `fetchAvatar` pattern — read it and follow its cache), `addCustomEmoji(input)`, `removeCustomEmoji(name)`, `importCustomEmoji(entries)`, `exportCustomEmoji()`, `onCustomEmojiChange(fn)`.

- [ ] **Step 1: Write the failing test**

```ts
it("names a taken emoji with Slack's own sentence", () => {
  expect(customEmojiNameError("shipit", ["shipit"])).toBe("If your emoji name is taken, choose another.");
  expect(customEmojiNameError("Ship It", [])).toMatch(/lowercase/);
  expect(customEmojiNameError("shipit", [])).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && bunx vitest run src/lib/custom-emoji.test.ts`
Expected: FAIL.

- [ ] **Step 3: Port the name rule**

Add `isValidCustomEmojiName` and `customEmojiNameError` to `web/src/lib/custom-emoji.ts`, with a comment saying it is a port of `custom_emoji::is_valid_name` and must move with it. Pin the port with a test that walks the same table of names the Rust test uses — the `agent-markdown.ts` tests are the precedent for pinning a port case for case.

- [ ] **Step 4: Add the protocol types and the controller methods**

Follow `personOverride` / `fetchAvatar` in `store.ts` for the cache-and-evict shape: `customEmojiUrl` caches blob URLs by name, and `onCustomEmojiChange` **evicts them** — without that, a replaced emoji keeps its old art until a reload, which is the exact bug `forgetPerson` exists to prevent.

- [ ] **Step 5: Teach the mock**

In `web/mock/server.ts`, seed a pack of three (`:shipit:` PNG, `:partyparrot:` GIF, `:ship:` as an alias of `shipit` — synthesize tiny data URLs as the mock already does for sender icons), answer all six methods, and emit `custom_emoji_changed`. Add a `{kind: "custom_emoji", clear: true}` test hook beside the `person_overrides` one (line ~4799) — **a spec MUST clear it afterwards**, since one mock process serves the whole run. Also seed one message from a colleague whose body carries the emoji markup, so Task 6's render path is exercised with nothing leaving the machine.

- [ ] **Step 6: Run the tests**

Run: `cd web && bunx vitest run src/lib/custom-emoji.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/protocol.ts web/src/lib/ws-client.ts web/src/lib/store.ts web/src/lib/custom-emoji.ts web/src/lib/custom-emoji.test.ts web/mock/server.ts
git commit -m "feat(emoji): carry the pack to the page, and to the mock"
```

---

### Task 8: Typing one — the `:` typeahead

**Files:**
- Create: `web/scripts/generate-emoji-shortcodes.ts`, `web/src/lib/emoji-shortcodes.ts` (generated)
- Create: `web/src/components/custom-emoji-extension.ts`, `web/src/components/custom-emoji-chip.tsx`, `web/src/components/emoji-suggestions.tsx`
- Modify: `web/src/components/rich-editor.tsx`, `web/package.json`
- Test: `web/src/lib/custom-emoji.test.ts`

**Interfaces:**
- Consumes: `loadCustomEmoji`, `customEmojiUrl` (Task 7).
- Produces: `export function emojiSuggestions(query: string, pack: CustomEmoji[], unicode: ReadonlyArray<[string, string]>, limit = 10): EmojiSuggestion[]` where `EmojiSuggestion = { kind: "custom"; name: string } | { kind: "unicode"; name: string; native: string }`.

- [ ] **Step 1: Write the failing test**

```ts
it("offers custom emoji before Unicode ones", () => {
  const pack = [emoji("smirk-cat"), emoji("shipit")];
  const unicode: [string, string][] = [["smile", "😄"], ["smiley", "😃"]];
  const out = emojiSuggestions("sm", pack, unicode);
  expect(out[0]).toEqual({ kind: "custom", name: "smirk-cat" });
  expect(out.map((s) => s.name)).toContain("smile");
});

it("matches an alias by its own name", () => {
  const pack = [{ ...emoji("ship"), aliasOf: "shipit" }];
  expect(emojiSuggestions("shi", pack, [])).toEqual([{ kind: "custom", name: "ship" }]);
});

it("offers nothing for an empty query, so a lone colon opens no menu", () => {
  expect(emojiSuggestions("", [emoji("shipit")], [])).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && bunx vitest run src/lib/custom-emoji.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `emojiSuggestions`**

Prefix matches first, then substring, custom before Unicode in each band, capped at `limit`. An empty query returns nothing.

- [ ] **Step 4: Generate the Unicode index**

Write `web/scripts/generate-emoji-shortcodes.ts` in the voice of `generate-teams-emoji.ts` — module doc explaining why a generated compact index exists rather than emoji-mart's 1.5 MB dataset (which must stay behind the picker's lazy import). It reads `@emoji-mart/data`, emits `name<space>native` lines for every emoji id and alias into one exported string constant, and prints the byte count. Add `"generate:emoji-shortcodes": "bun run scripts/generate-emoji-shortcodes.ts"` to `web/package.json`. Run it and commit the output.

- [ ] **Step 5: Build the chip node**

Copy `agent-tag-extension.ts` + `agent-tag.tsx` to `custom-emoji-extension.ts` + `custom-emoji-chip.tsx`. Keep every property that made the tag right and change only what differs: the node is an inline atom, it **serializes to the bare `:name:` text** (its `renderHTML` emits a span our own parser unwraps, exactly as the tag does), one Backspace removes it whole, and the view draws the art from `customEmojiUrl`. Register it in `rich-editor.tsx` beside the mention and agent-tag extensions.

- [ ] **Step 6: Build the suggestion list**

`emoji-suggestions.tsx` mirrors `mention-suggestions.tsx`: a tiptap suggestion plugin on the `:` character, keyboard navigation, Tab or Enter to complete, each row showing the art (custom) or the glyph (Unicode) beside its `:name:`. A custom pick inserts the chip node; a Unicode pick inserts the character. `data-testid="emoji-suggestions"`, one row per `data-testid="emoji-suggestion-<name>"`.

- [ ] **Step 7: Run the tests**

Run: `cd web && bunx vitest run && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/scripts/generate-emoji-shortcodes.ts web/src/lib/emoji-shortcodes.ts web/src/lib/custom-emoji.ts web/src/lib/custom-emoji.test.ts web/src/components/custom-emoji-extension.ts web/src/components/custom-emoji-chip.tsx web/src/components/emoji-suggestions.tsx web/src/components/rich-editor.tsx web/package.json
git commit -m "feat(emoji): complete an emoji code as you type it"
```

---

### Task 9: The picker's Custom section and Add Emoji

**Files:**
- Modify: `web/src/components/emoji-picker.tsx`
- Create: `web/src/components/add-emoji-dialog.tsx`

**Interfaces:**
- Consumes: Task 7's controller methods; `web/src/lib/composer-image.ts`'s `loadComposerImage` and `imageFileError` for the file half (reuse them; do not write a second reader).
- Produces: `export function AddEmojiDialog(props: { open: boolean; onClose: () => void })`.

- [ ] **Step 1: Add the Custom category to the picker**

emoji-mart already takes a `custom:` prop, per-emoji `src` — the same hook the Apple images use, documented in `emoji-picker.tsx`'s own comment. Pass the pack as one category (`id: "custom"`, name `"Custom"`, teams-lite's own mark via `categoryIcons`), which puts it first in the nav. No new picker component.

- [ ] **Step 2: Add the Add Emoji row**

In the picker's wrapper div, under `<Picker>`: a footer button reading **"Add Emoji"** (`data-testid="add-emoji"`), opening `AddEmojiDialog`.

- [ ] **Step 3: Build the dialog**

Two tabs, Slack's own words:

- **"Upload Image"** — a click-or-drop zone that also accepts a paste (`onPaste` reading `event.clipboardData.files`), a URL field beside it, the hint verbatim: *"Square images under 128KB and with transparent backgrounds work best."* Then **"Give it a name"**, an input with fixed `:` affixes, a live preview of the art at glyph size, and **"Save"**. Errors render under the field, from `customEmojiNameError` and from the backend's own sentence on refusal.
- **"Emoji packs"** — a file input taking the export JSON and an **"Add Pack"** button, plus a line saying how many emoji the file holds before it is added.

`data-testid`s: `add-emoji-dialog`, `add-emoji-tab-upload`, `add-emoji-tab-packs`, `add-emoji-name`, `add-emoji-save`, `add-emoji-error`.

- [ ] **Step 4: Verify against the mock**

```bash
cd web && bun run preview -- --out /tmp/emoji-dialog --settings
```

Open the picker in the captured page and confirm the Custom category and the Add Emoji row are drawn. (Task 12 adds the dedicated capture flag.)

- [ ] **Step 5: Run the checks**

Run: `cd web && bun run typecheck && bunx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/emoji-picker.tsx web/src/components/add-emoji-dialog.tsx
git commit -m "feat(emoji): add an emoji from the picker, Slack's two tabs"
```

---

### Task 10: Settings › Custom emoji

**Files:**
- Create: `web/src/components/custom-emoji-settings.tsx`
- Modify: `web/src/components/settings-pane.tsx`

**Interfaces:**
- Consumes: Task 7's controller methods; `AddEmojiDialog` (Task 9).
- Produces: `export function CustomEmojiSettings()`.

- [ ] **Step 1: Build the section**

Copy the structure of `renamed-people-settings.tsx` (its own doc comment explains why a list belongs in Settings when a card has to be found — the same reason applies to an emoji nobody remembers naming). Slack's Customize › Emoji tab, surface for surface:

- Header: **"Custom emoji"**, and a sentence saying the art travels with the message so everybody sees it, and that the pack itself never leaves this machine.
- **"Add Custom Emoji"** and **"Add Alias"** buttons at the top; a search field filtering the list.
- One row per emoji: the art at glyph size, `:name:`, what it aliases when it is an alias, the date added, and a delete icon.
- Delete is **two steps**, the pattern Delete already uses: the first select arms the second, and the confirming label is **"Delete Emoji"**.
- An **"Export pack"** action at the foot, downloading `exportCustomEmoji()` as a JSON file.
- Add Alias: a small form — **"Choose Emoji"** (a picker of the existing custom emoji plus a Unicode one), **"Enter an alias"**, **"Save"**.
- Loading state: two quiet bars, so the section never flashes "nothing" at a user who has emoji.

`data-testid`s: `custom-emoji-settings`, `custom-emoji-search`, `custom-emoji-row-<name>`, `custom-emoji-delete-<name>`, `custom-emoji-confirm-delete`, `custom-emoji-export`, `add-alias-open`.

- [ ] **Step 2: Register it**

Add the section to `settings-pane.tsx` in the order the other sections use.

- [ ] **Step 3: Capture it**

```bash
cd web && bun run preview -- --out /tmp/emoji-settings --settings
```

Confirm the section renders with the mock's three seeded emoji, in both themes.

- [ ] **Step 4: Run the checks**

Run: `cd web && bun run typecheck && bunx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/custom-emoji-settings.tsx web/src/components/settings-pane.tsx
git commit -m "feat(emoji): manage the pack from Settings, Slack's Emoji tab"
```

---

### Task 11: Add to my emoji

**Files:**
- Modify: `web/src/components/message-bubble.tsx`
- Modify: `web/src/components/custom-emoji.tsx`

**Interfaces:**
- Consumes: `addCustomEmoji({ mediaUrl, name })` (Task 7 → Task 4's `media_url` branch).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the action**

A custom emoji in a message carries its own code and its own src, so the row needs nothing else. Slack's own gesture is a right-click on the emoji; add it to the message's `⋯` actions menu as **"Add to my emoji"** when the message body holds a custom emoji this pack does not already have, wearing the same shape as the other rows. On a coarse pointer it is reached from the long press the menu already uses (`use-long-press.ts`) — a right-click-only affordance does not exist on a phone, and this app is used from one.

- [ ] **Step 2: Prefill the name and let it be changed**

The code the message carries is the proposed name; if it is taken, the dialog opens with Slack's sentence rather than silently overwriting. Never overwrite an existing emoji.

- [ ] **Step 3: Run the checks**

Run: `cd web && bun run typecheck && bunx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/message-bubble.tsx web/src/components/custom-emoji.tsx
git commit -m "feat(emoji): take a colleague's emoji into your own pack"
```

---

### Task 12: Reacting with one — only what probe 2 proved

**Files:** decided by Task 0's finding. If the emotions property accepted the key: `web/src/lib/teams-emoji.ts`, `web/src/components/message-bubble.tsx` (`ReactionChips`, `ReactionBar`), `src/bin/server.rs` (`"react"`), `src/teams_send.rs`.

**Interfaces:**
- Consumes: Task 0's measured key ceiling; Task 5's uploader.
- Produces: `export function customReactionKey(name: string, amsId: string): string` and `export function customReactionArt(key: string): { name: string; src: string } | null` in `web/src/lib/teams-emoji.ts`.

- [ ] **Step 1: Re-read the finding**

Read the `## Findings` section written in Task 0 Step 7. **If the service refused the key, stop here and report** — the fallback (a one-emoji reply the user sends) is the user's decision, not this task's.

- [ ] **Step 2: Write the failing tests**

```ts
it("names the art in the key, and reads it back", () => {
  const key = customReactionKey("shipit", "0-weu-d1-abc");
  expect(customReactionArt(key)).toEqual({ name: "shipit", src: expect.stringContaining("0-weu-d1-abc") });
});

it("leaves Microsoft's own keys alone", () => {
  expect(customReactionArt("like")).toBeNull();
  expect(customReactionArt("yes-tone2")).toBeNull();
  expect(reactionEmoji("like")).toBe("👍");
});
```

- [ ] **Step 3: Implement, then say what it costs**

Reacting uploads the art first (Task 5's uploader), then PUTs the key. The reaction bar's Custom section says plainly that a custom reaction is drawn by teams-lite readers only, and — from the measurement — what a stock client shows instead. An outward action that lands differently than it looks must never be left implying otherwise.

- [ ] **Step 4: Run the tests**

Run: `cargo test && cd web && bunx vitest run && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(emoji): react with a custom emoji, and say who sees it"
```

---

### Task 13: Captures and the E2E suite

**Files:**
- Modify: `web/scripts/preview.ts` (a `--custom-emoji` flag, following `--person` at line ~1845)
- Create: `web/e2e/custom-emoji.spec.ts`

**Interfaces:**
- Consumes: every surface built above, plus the mock's `{kind: "custom_emoji", clear: true}` hook.
- Produces: the captures a reviewer reads.

- [ ] **Step 1: Add the capture flag**

`bun run preview -- --out /tmp/emoji --custom-emoji` walks: the picker's Custom category, the Add Emoji row, the dialog in both tabs, the `:` suggestion list mid-type, a bubble with an inline custom emoji, an emoji-only jumbo bubble, and the Settings section. Both themes, via `setTheme` — which calls `page.emulateMedia`, never writing `data-theme` (a capture that writes the attribute leaves the app's own `resolvedTheme` disagreeing with the palette).

- [ ] **Step 2: Write the spec**

`web/e2e/custom-emoji.spec.ts` pins the rules that are really promises, one test each:

1. A code the pack holds becomes art in a sent message; a code it does not hold **stays text**.
2. An inbound custom emoji is drawn from the message's own `src` — assert the rendered `img`'s source is the one the body carried, not a pack blob.
3. A code inside a code block and a code inside a reply quote **stay text**.
4. An emoji-only message renders jumbo.
5. The `:` list offers custom emoji above Unicode ones, and Enter inserts the chip.
6. A taken name is refused with *"If your emoji name is taken, choose another."*
7. Delete asks twice and ends in **"Delete Emoji"**.
8. One Backspace removes a whole chip.

The spec **must** call the `{kind: "custom_emoji", clear: true}` hook in `afterAll` — one mock process serves the whole run, and a pack left behind changes every later spec's sidebar and composer.

- [ ] **Step 3: Run the suite on explicit free ports**

```bash
cd web && E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468 bun run test:e2e -- custom-emoji
```

`reuseExistingServer` is on outside CI, so another session's mock would otherwise be adopted and the specs would run against code that is not under test.

- [ ] **Step 4: Commit**

```bash
git add web/scripts/preview.ts web/e2e/custom-emoji.spec.ts
git commit -m "test(emoji): capture and pin every custom emoji surface"
```

---

### Task 14: Document it, then the gate and the PR

**Files:**
- Modify: `AGENTS.md` (`CLAUDE.md` is a symlink to it)

- [ ] **Step 1: Write the `## Custom emoji` section**

Place it after `## @mentions` and before `## Tagging an agent` — it belongs beside the other two features that put something in a message body. In this file's voice, and covering only what a later reader could get wrong:

- **The code is the wire format.** `:shipit:` goes out as text and the backend substitutes Teams' own inline-emoji markup for it, which is why an edit survives and why a `:shipit:` typed by hand works exactly like one picked from the list — the same choice the agent tag makes, for the same reason.
- **The art travels with the message.** A reader needs no pack to SEE an emoji, only to USE one. That is what makes this feature worth having rather than a local decoration.
- **A colleague's emoji is drawn from their message's bytes, never from the reader's pack** — and there is deliberately no client-side substitution, because it would redraw their words with our art.
- **Three regions are never substituted:** `<code>`, `<pre>`, and a reply quote.
- **The writes are gated** and why: the pack decides what art leaves this machine under the user's name.
- **The URL source is the one that touches a stranger's server**, and it reuses `sender_icon`'s five rails rather than copying them.
- **Custom art in a stock Teams reaction row is impossible**, with what the probes measured.
- The probe commands, verbatim, as § The local agent lists its own.

- [ ] **Step 2: Run the whole gate**

```bash
cargo test
cd web && bun run test && bun run typecheck && E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468 bun run test:e2e
python3 .claude/hooks/guard-live-automation.test.py
```

All must be green. A failure means no merge — leave the branch and report what failed.

- [ ] **Step 3: Commit and open the PR**

```bash
git add AGENTS.md
git commit -m "docs(emoji): say why the code is the wire format"
git push -u origin HEAD
gh pr create --title "feat(emoji): custom emoji, Slack's feature and its UI" --body "$(cat <<'EOF'
## Summary
Upload, name and use custom emoji and GIFs, copying Slack's feature and its UI. The art
travels inside the message as Teams' own inline-emoji markup, so every teams-lite reader
sees it and a reader needs no pack of their own.

## How it works
- `:shipit:` reaches the wire as text; the backend substitutes the markup and uploads the
  art to AMS, once per name per message. An edit survives, and a code typed by hand works
  like one picked from the list — Slack behaves the same way.
- Inbound, an emoji is drawn from the bytes its own message carries, never from the
  reader's pack. `<code>`, `<pre>` and reply quotes are never substituted.
- Pack writes are `MACHINE_METHODS` entries; the URL source reuses `sender_icon`'s five
  rails.

## Measured against the tenant
See the findings in the spec: what Teams' sanitizer keeps of an inline custom emoji, and
what its reaction property accepts.

## Test plan
- `cargo test`
- `cd web && bun run test && bun run typecheck && bun run test:e2e`
- `python3 .claude/hooks/guard-live-automation.test.py`
- Captures: `cd web && bun run preview -- --out /tmp/emoji --custom-emoji`
EOF
)"
```

---

## Self-Review

**Spec coverage:** § 2 measurements → Task 0. § 4 pack → Task 2, with § 4's caps and rules in Task 1. § 5 outbound → Tasks 1 and 5. § 6 inbound → Task 6. § 7 reactions → Task 12 (probe-gated). § 8.1 picker and 8.2 dialog → Task 9. § 8.3 Settings → Task 10. § 8.4 typeahead → Task 8. § 8.5 sources: file/paste/URL → Tasks 4 and 9, lift-from-message → Tasks 4 and 11, pack file → Tasks 3 and 9/10. § 8.6 deviations → documented in Task 14. § 9 gating → Tasks 3 and 4. § 10 error handling → the validation order in Task 3 Step 4, the send failure in Task 5 Step 5, the fetch failures in Task 4. § 11 proof → Tasks 7 (mock), 13 (captures and E2E), and the per-task tests. § 12 build order → the task order.

**Placeholders:** none. Task 12's file list is deliberately conditional on a measurement that does not exist yet, and its Step 1 halts rather than guessing — that is a decision gate, not a gap.

**Type consistency:** `CustomEmoji` is the row type in Rust (Task 1) and the wire/page type in TypeScript (Task 7) with camelCase fields, and the JSON in Task 3 uses snake_case — the boundary is `protocol.ts`, as everywhere else in this app. `substitute_codes` / `codes_in_body` (Task 1) are consumed under those exact names in Task 5. `customEmojiUrl` (Task 7) is used in Tasks 8, 9, 10. `emojiSuggestions` (Task 8) is consumed only inside Task 8.
