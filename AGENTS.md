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
- **`cd web && bun run join-live` is its twin for the one outward action a chat cannot
  cover: JOINING a meeting.** Same shape and same rails — the meeting is a constant in the
  file, no argument can aim it elsewhere, the button's own address (`data-join-url`, or
  `data-meeting-thread` under `--from-chat`) is re-read immediately before the click, and it
  hangs up on every path out. It exists because that
  feature is untestable anywhere else (see § Joining a meeting), and it is what took the
  user out of a loop where every protocol fault cost them a click and a paste. A NEW live
  driver earns its place the same way: a constant target, proved from the app's own state
  at the moment of the action, and then named in the guard's allowlist — never by being
  tracked, and never by a name the allowlist happens to match.
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
- **A send that WORKS takes back the words that left, and only those.** The network takes
  as long as it takes, and the reader keeps writing meanwhile — or their phone's keyboard
  commits a correction as Enter is pressed — so the box can hold more than the message did.
  The sent range is followed through every change the document takes while it travels
  (`removeSentWords` in `web/src/components/rich-editor.tsx`, over ProseMirror's own
  `Mapping`) and exactly that range goes — and only while it still holds exactly the words
  that left, so a draft the reader REWROTE meanwhile is left whole. The two shortcuts are
  both wrong and both happened: clearing the whole box erases words nobody sent, and
  clearing nothing leaves the message that just left sitting there, so the next Enter posts
  it twice.
- **ONE ENTER IS ONE MESSAGE, and the two halves of that live on opposite sides of the
  socket.** A reader who presses Enter and sees nothing happen presses it again — the send is
  still travelling, so the words are still in the box — and every duplicate that ever reached
  a colleague came out of that moment. Each half is pinned by a test:
  - **The PAGE refuses a send while one is out.** `sendingRef` in
    `web/src/components/composer.tsx` is set in `send`'s own synchronous prefix, so a press
    that lands in the same millisecond cannot pass it, and the rich editor's `sentRef` covers
    the same window in the field (`web/e2e/messaging.spec.ts` hammers Enter against a held
    send and counts the RPCs, not the bubbles — a page that posted twice and drew one row
    would pass an assertion about the thread alone).
  - **The BACKEND never retries a POST that CREATES a message.** `send` runs under
    `retry::RetryPolicy::auth_only()`, never the default one: a timeout, a reset connection
    and a 502 all mean the ANSWER was lost and say nothing about whether Teams accepted the
    message, and there is no idempotency key on that endpoint — so the default policy's three
    attempts were three messages in the thread from one press, with the reader hammering
    Enter through the back-off because nothing had happened yet. A **401** is the opposite and
    is still refreshed and retried: the request was refused before anything was created, and
    the broker's tokens expire hourly. Every other write here is a PUT or a DELETE and keeps
    the default policy, because repeating one of those changes nothing.
- **A reply puts the caret in the box, in the same task as the click that asked.** Every
  path that drafts on a message asks for it (`doReply`, and the two "… with <agent>" rows),
  and `focusEditor` focuses the field itself before it places the caret: TipTap finishes
  its own focus in a `requestAnimationFrame`, and a frame is long enough to type into — on
  a phone it is worse, because a keyboard is raised only for a focus inside the gesture
  that asked for one. `web/e2e/messaging.spec.ts` pins both rules by typing with no wait
  at all.
- Outside the sandbox chat, consent is per-message and never standing: approval
  to send one message is not permission to send others. When in doubt, draft it and
  ask first.
- The one feature that posts on its own is the local agent (§ The local agent). It
  is not an exception to the rule above: it answers only a message the USER wrote,
  only in a conversation the user opted in, and the sandbox channel is the only one
  opted in out of the box.

## Pictures in a message (up to ten, and the ceilings are a set)

A message carries as many pictures as the user pasted — the clipboard's images in one
paste, several pastes one after another, or a multi-file pick — previewed above the field
and uploaded by the backend as part of the same `send` (`teams_send::send_message`, over
`parse_images`; the composer's half is `web/src/components/composer.tsx` and
`web/src/lib/composer-image.ts`). It needs no gate of its own: `send` is already an
`OUTWARD_METHODS` entry and the pictures ride in its params, exactly as a mention does.
The second paste used to REPLACE the first, which made a message meant to carry three
screenshots carry the last one.

- **THREE ceilings, and they must CLOSE.** Ten pictures per message
  (`teams_send::MAX_IMAGES`), 10 MiB each (`MAX_IMAGE_BYTES`), 30 MiB for all of them
  (`MAX_IMAGES_TOTAL_BYTES`) — and above every one of them the socket's own read limit
  (`MAX_REQUEST_BYTES` in src/bin/server.rs, the number the relay in web/server.ts already
  used). Closing means the largest batch the first two admit cannot build a frame the
  socket refuses to READ: tungstenite's defaults are 16 MiB per frame and one 10 MiB image
  is 13.33 MiB once base64-encoded, so a send carrying two was already over — and a frame
  over the limit is a PROTOCOL error, which DROPS the connection instead of answering. The
  page then reports an unreachable backend, which is both wrong and unactionable, so the
  set is what makes a refusal readable at all. It nearly did not close: ten pictures of 10
  MiB are 133 MiB encoded against a 128 MiB limit, and the third ceiling was the backend's
  alone — enforced after the frame is read, which is too late to state anything.
  `composer-image.test.ts` now pins the arithmetic; move one of these numbers and it fails.
- **The composer states all three, the backend enforces them.** A batch that crosses the
  count or the weight keeps the pictures that fit and says so beside them
  (`COMPOSER_IMAGE_MAX_COUNT` and `COMPOSER_IMAGE_MAX_TOTAL_BYTES`, over
  `imageBatchError`), so the eleventh — and the one that would make the request unsendable
  — is refused before a send rather than by one. One bad file in a batch costs that file
  and nothing else. The mock mirrors every refusal (`parseSendImages`), because a mock that
  accepts what the backend refuses hides the bug instead of failing a test.
- **A page too old to carry pictures is REFUSED, never quietly emptied.** The RPC took a
  single `image` before it took `images`, and an open tab keeps its old JavaScript across a
  backend restart (§ Automation safety). Reading `images` alone would call that page's
  screenshot "no pictures" and post the caption by itself, answered `sent: true` — so
  `parse_send_images` reads the whole params object and refuses the old shape with a
  sentence that says to reload.
- **One AMS upload per picture, in the order they were added**, and that order is what the
  body's `<img>` tags carry. `amsreferences` was ALREADY an array, so nothing about the
  Teams shape is invented here. An upload that fails happens before the message POST, so
  nothing is posted and what did upload is an unreferenced blob — and the failure names
  WHICH picture (its position and its name), because with ten of them "the send failed"
  leaves the reader removing pictures at random to find the one the tenant refused.
- **A send takes back exactly the pictures that left**, matched by the id the pending list
  keys on — the rule `removeSentWords` follows for the words. Clearing the box would erase
  a screenshot pasted while the request was travelling; clearing nothing would leave the
  ones that left sitting there, so the next Enter posts them twice.
- **Several are drawn SMALLER than one.** Ten thumbnails at the height a single one gets is
  a composer that has eaten the conversation.
- **The decode counter is never reset, only decremented.** A batch still reading files
  decrements itself when it ends, so switching conversation must not zero the count under
  it: the next batch's own decrement would then take it to zero while that batch's picture
  is still missing, which enables Send and posts a message one picture short. What a reset
  would buy is Send enabled a moment earlier in the new conversation.
- `cd web && bun run preview -- --out /tmp/pics --compose-images` captures the row in both
  themes and the sentence a full box earns; `web/e2e/composer-images.spec.ts` pins every
  rule above except the two that are cheaper to pin without a browser — the combined weight
  and the arithmetic that closes the set live in `web/src/lib/composer-image.test.ts`, and
  the old page's refusal in `teams_send::tests`. That spec deliberately does NOT send its ten-picture message: one mock
  process serves the whole run, and a message ten pictures tall is shared state — it makes
  the deep-link scroll in `notifications.spec.ts` time out, which is a fragility of the
  virtualized history worth its own look and NOT something a test should hide.

## A channel post has a TITLE (its own field in the composer, a heading above the body)

A post in a CHANNEL carries a title — the line an announcement draws above its words — and a
chat message does not. That is Teams' own split, and until this both halves of it were
missing here: the composer was the same box in an announcement channel as in a 1:1, so a post
could not be titled at all, and an INBOUND title was drawn at 13px above the thread, which
reads as metadata rather than as the heading of what follows.
`web/src/lib/post-subject.ts` holds the pure decisions, `teams_send::SUBJECT` and
`parse_subject` the wire and the trust boundary, the field is `composer-subject` in
`web/src/components/composer.tsx`, and the heading is `thread-subject` in
`message-pane.tsx`.

**THE TITLE IS A PROPERTY OF THE MESSAGE, NEVER WORDS IN ITS BODY.**
`properties.subject` — exactly where the read path has always found one (`parse_thread` in
src/teams_read.rs, over `Message::thread_subject`, which is what a channel thread has been
named after since channels existed here). A composer that wrote the title as a first line of
the body would show a colleague a bold sentence instead of a titled post, and the thread
would have no name at all: nothing in the body is ever read as one.

**EVERY FACT BELOW IS MEASURED**, by `examples/channel_subject_probe.rs` — the sanctioned way
to try it live, pinned to the sandbox chat, and it removes both messages it posts:

    . bin/broker-env.sh && teams_lite_export_broker_bus && \
      cargo run --example channel_subject_probe

Measured 2026-08-23 on the real tenant, plus one count off this machine's own store:

- **`properties.subject` on a SEND is the title**, accepted byte for byte and read back as
  one. A wrong spelling would not fail — the message would simply post untitled, which is the
  one outcome this feature exists to prevent.
- **AN EDIT DELETES IT.** The service ASSIGNS `properties` rather than merging it, so the
  edit that restated nothing came back with no title: a rewrite of one word silently removing
  the line above the body, for everybody in the thread. The same edit carrying the title KEPT
  it. That is not a new hazard either — every edit this app made before today would have
  stripped the title off a post the user had titled in real Teams.
- **A title is a LINE, not a paragraph**: over the 80 titled posts this store holds they run
  from 11 to 108 characters (mean 46), and the subject appears in the message body in 2 of
  them — a coincidence of wording, not markup.

Twelve rules hold it, and each is pinned by a test:

- **The EDIT carries the title, and it comes from the STORE.** The `edit` handler reads the
  message's own row (`Store::get_message`) and `build_edit_body` restates it, so an edit made
  from any surface keeps it — and a client cannot RETITLE a post, because it never supplies
  the value. `editing_a_titled_post_carries_its_title_from_the_store` scans the handler for
  both halves, since reading it from the store and dropping it on the floor is the same
  silent loss.
- **It needs no gate of its own.** `send` is already an `OUTWARD_METHODS` entry and the title
  rides in its params, exactly as a picture and a mention do — the title is part of the
  message being posted, not a second action.
- **A REPLY carries none, on both sides.** A thread has one title and it belongs to its first
  post, so `parse_subject` refuses a `subject` beside a `reply_to` and the field is not drawn
  while a reply is being written. Hidden, not emptied: a title typed before the reader pressed
  Reply is still there when they cancel it, and it is not smuggled onto the reply meanwhile.
- **A CHAT never offers one**, because Teams has no such field there and the send would carry
  a property nothing draws.
- **It is bounded and one LINE at the trust boundary** (`MAX_SUBJECT_CHARS`, 250 — a sanity
  bound well clear of every real title, catching a whole message pasted into the field), and
  `POST_SUBJECT_MAX_CHARS` states the same number as the field's native `maxLength`, so the
  251st character is refused as it is typed rather than by a send.
- **A title alone is not a post.** Send stays disabled until there are words: a titled empty
  message is a heading over nothing.
- **The field is where the reader's press LANDS, and it clears the touch floor.** The
  composer focuses the message field on any click in its box that is not a control, so the
  title had to be excluded — without that it is unusable by pointer, which is how the box
  behaves on a phone too. It is 44px tall and set at 16px, the two rules every other target
  and every other field here holds (a thumb, and no iOS zoom on focus), and Enter inside the
  title moves to the words rather than posting.
- **A title belongs to the conversation it was written in.** Walking away drops it, exactly as
  a pasted picture is dropped — a title must not follow the reader into somebody else's
  channel.
- **A send takes back exactly the title that left**, and only while the field still holds it:
  the rule `removeSentWords` follows for the words, so a title the reader REWROTE while the
  request travelled is left alone.
- **The heading is drawn AS a heading** — the size and weight Teams gives an announcement's
  headline, and `web/e2e/channels.spec.ts` MEASURES it against the post's own body text
  rather than trusting a class list, because "it reads as a title" is the whole feature.
- **A titled post SURVIVES THE QUEUE.** Both actions on a message Teams is HOLDING are a
  re-send (§ Sending a message LATER), so both carry the title the service already stored:
  "Send now" posts it with the words, and "Edit" hands it back into the field — through
  `composerRestore`, since a draft is words and the title is not one of them. Without either,
  a reader taking their own announcement out of the queue would re-post it with the heading
  silently removed.
- **The mock mirrors every refusal and ECHOES a titled post** as the root of its own thread
  carrying that title (`parseSendSubject`, and `scheduleSendEcho`), which is what the tenant
  really answers with — a mock that withheld it would let a broken heading pass every test.

`cd web && bun run preview -- --out /tmp/chan --channels` captures the field empty and filled,
the post it becomes in both themes, and the composer at a PHONE's width, where the box gains a
row; `web/e2e/channels.spec.ts` pins every rule the page owns and
`web/src/lib/post-subject.test.ts` the pure ones. **What is UNVERIFIED against the tenant is a
titled post in a real CHANNEL**: there is no sandbox channel, so what the probe measures is
the service accepting the property on the messages endpoint — one endpoint for a chat and a
channel alike — and one titled post in an announcement channel stays the user's own click, in
their own app.

## A SEALED chat (the words are encrypted before they reach Teams)

A chat is not sealed by default. The user marks one, sets or generates a passphrase, and from
then on every message this app POSTS to that conversation carries a ciphertext where its words
used to be. Each participant who also runs teams-lite adds the same passphrase and reads the
conversation in the clear; the tenant, Microsoft, and anybody reading the thread in a stock
client sees one opaque token. `src/seal.rs` holds the envelope and every crypto decision,
`Store::seal_keyring` and `msg_reader` (src/store.rs) the read, `teams_send::seal_body` the
write, and `web/src/lib/seal.ts` every decision the page makes.

**THE THREAT IS THE TENANT, NEVER THE MACHINE.** Everything else this app holds is already in the
clear on this disk — the store keeps every message the user ever synced — so encrypting at rest
here would be theatre. What is bought is that the words never exist on Microsoft's side at all.
Three things follow, and they are the whole architecture:

- **The BACKEND is the encryption boundary**, exactly as it is the custom-emoji substitution
  boundary: the page sends plaintext over the local socket and the backend seals it before the
  POST. So the page holds no crypto at all, and the agent — which runs HERE — can seal what it
  posts.
- **The KEY lives in the local store**, so the passphrase is entered ONCE and covers the phone and
  the laptop alike, which reach one backend. A per-browser key would be entered per device, which
  is the opposite of what the feature promises.
- **The store keeps the CIPHERTEXT and decrypts on READ.** That is what makes "add the passphrase
  later and every message already received becomes readable" work, and it is why there is nothing
  to migrate when a key arrives.

**EVERY FACT ABOUT THE CARRIER IS MEASURED**, by `examples/sealed_message_probe.rs` — the sanctioned
way to try it live, pinned to the sandbox chat, and it removes every message it posts:

    . bin/broker-env.sh && teams_lite_export_broker_bus && \
      cargo run --example sealed_message_probe

Measured 2026-08-24 on the real tenant, and each number decides something:

- **THE BODY IS A CARRIER.** A base64url token came back BYTE FOR BYTE at 374 characters and at
  10 923, through Teams' own server-side sanitizer and through `teams_read`'s parse. An AEAD has no
  partial credit — one byte changed anywhere and the message is unreadable for everybody, for ever
  — so this is the fact the whole feature rests on.
- **AN EDIT KEEPS IT**, identically. That is the agent path, whose every streaming frame is a
  re-seal.
- **THE CEILING IS 102 400 BYTES**, the service's own `MessageSizeExceeded` on a whole message. base64
  is four bytes out for three in, so `seal::MAX_SEALED_PLAINTEXT` (64 KiB) bounds a body on this side
  and `the_ceilings_close` pins the arithmetic — the rule the composer's three picture ceilings hold.
- **THE SENDER'S MRI ROUND-TRIPS IDENTICALLY**, which is what made it safe to BIND the sender into
  the envelope (below).
- **A CUSTOM `properties.tlsealed` IS KEPT** byte for byte, on a SEPARATE and much smaller budget
  (28 672 bytes). It is the prettier carrier — a stock client would draw no base64 at all — and it is
  deliberately NOT what ships: it is an undocumented field, and the day the service drops one the
  message is lost for everybody with nothing to report, while the body is the field the service has
  never dropped.

**THE BODY CARRIES NO READABLE TEXT: no notice, no words, no name of this app.** One opaque
base64url token is the whole body. A sentence saying "sealed with teams-lite" would be the one
readable part of a sealed message — it would tell the tenant which client the user runs and tell
everybody that this conversation has something to hide. What marks the message is inside the token,
where nobody can read it: `seal::MAGIC` and a version in its first decoded bytes. The cost is stated
where the rule is: a colleague on a stock client is shown a token with nothing to explain it, and
this app's own reader draws a locked row instead.

Fourteen rules hold it, and each is pinned by a test:

- **A conversation is sealed IFF it holds a CURRENT key.** One state rather than two, because
  "sealed with no key" is a chat nothing can be sent to and "a key but not sealed" is a chat whose
  reader cannot tell what the next Enter publishes. Turning sealing off clears the flag and KEEPS
  every key, so the messages already in the thread stay readable — dropping one is `seal_forget`,
  which is the single act here that nothing takes back.
- **EVERY read of a body goes through ONE place** (`msg_reader`), which is the rule `SELECT_COLS`
  holds for a person's name and for its reason: a resolution the CALLER has to remember is one a
  caller will forget, and the read that forgot this one would hand a page, a notification or an
  agent a base64 token in place of somebody's words.
  `every_read_of_a_body_goes_through_the_seal` scans the file so a new read cannot skip it.
- **The SEAL runs LAST on the way out**, after every check and every property that reads the body.
  `attach_mentions` requires each mention to have a span in the body and finds none in a ciphertext,
  so sealing before it would refuse every send in a sealed chat that mentions anybody. Sealing after
  keeps the check honest — the span really is there, in the plaintext — and keeps the name out of
  the clear.
- **It is FAIL-CLOSED at every POST.** A body over the ceiling, a key that cannot be used, or a
  store this backend cannot read all REFUSE the send with the words still in the composer. Falling
  through to the plaintext body would post in the clear to a chat the reader believes is sealed,
  which is the one outcome this whole feature must never have.
- **The SENDER is bound into the envelope**, because Microsoft routes the message and owns the
  `from` field. Without it the tenant could re-deliver one colleague's envelope under another
  colleague's name: the tag verifies, the words open, and the history draws the wrong person saying
  them — with a padlock beside it, which lends them MORE credibility than an ordinary message.
  Authorship is the one thing this app never misstates (§ Renaming a person), so it is bound rather
  than trusted. The conversation is bound too, so a ciphertext cannot be moved to another chat.
- **A PASSPHRASE IS CASE- AND SEPARATOR-INSENSITIVE**, and that is not a nicety. Reading one off a
  laptop and typing it into a phone is THE commonest path through this feature, and a phone keyboard
  capitalizes the first character of a field — so without it `Abcd-efgh-…` is a different key, every
  message reads as one sealed under a passphrase the reader does not hold, and the app blames them
  for a passphrase they typed correctly. What it costs is the entropy of the case and the separators
  of a passphrase the USER invented, which is why a GENERATED one is what the dialog offers first:
  20 symbols of a lowercase alphabet, a little under 100 bits, with nothing to lose.
- **The payload is PADDED to 64 bytes.** Otherwise the ciphertext's length IS the plaintext's, to the
  byte, for ever, in the hands of the party the words are kept from — and over a chat whose answers
  are "ok", "yes" and "no", the length alone tells them apart with no key at all. It hides the exact
  length and never the order of magnitude, and saying otherwise would be a claim it does not earn.
- **The KDF cost is part of the FORMAT.** Argon2id at 64 MiB, t=3, p=4, and the key id comes out of
  its output — so a build with different parameters derives a DIFFERENT key from the SAME passphrase,
  and both machines then tell their reader they have not added a passphrase they typed correctly.
  `the_kdf_cost_is_pinned_to_the_version` makes that impossible to do by accident. `p` is 4 rather
  than 1 because lanes cost an attacker nothing and buy the defender wall clock back.
- **A locked message's `content` is EMPTY on the wire, never the token.** The store keeps the
  ciphertext on disk, so a passphrase added tomorrow still opens it — and no page, sidebar preview or
  notification is ever handed base64.
- **THE SIDEBAR SHOWS THE WORDS, and that takes TWO halves that only work together.** It is the
  shortest path the envelope has to a reader's eye, and it is not the history: the CSA snapshot
  carries Teams' OWN copy of a chat's newest message, so for a sealed chat that body is the
  envelope — and the row's second line was 374 characters of base64. `parse_last_message` therefore
  stores NOTHING for a sealed body (and `preview_for_message` does the same for the local path),
  because a non-empty stored preview is exactly what stops `Store::derived_preview` from running —
  and that is the read which goes through `msg_reader` and so through the seal. Empty means the
  sidebar falls through to it and draws the message in the clear, on every read, with nothing to
  migrate when a passphrase arrives. `the_sidebar_previews_a_sealed_chat_with_its_words` drives
  both halves at once, because either alone leaves the token on the row.
- **FOUR outcomes, not a boolean** (`MessageSeal`): an ordinary message, one this machine OPENED, one
  sealed under a passphrase it does not hold, one from a newer build, and one whose bytes fail their
  own authentication. Each is a different sentence and a different next move, and collapsing them
  into "this message cannot be read" is what makes an encrypted chat feel broken.
- **NOTHING IS DRAWN ON A MESSAGE, and nothing is WRITTEN in the composer.** Both were tried
  louder and both were cut back on one argument: a padlock on every row of a sealed chat repeats
  one fact as many times as there are messages — which is what a stamp per bubble was already
  fixed for (§ When a message was sent) — and a line above the field is furniture on every message
  of every sealed chat, which also pushed the field down. What is left is the smallest thing that
  still answers: the message carries `SEAL_MARK_LABEL` as a plain `title`, and the composer carries
  ONE low-contrast mark in the corner of its box (`composer-seal-mark`) whose own title says which
  state it is in. The WORDS live where they are acted on, which is the dialog. A DISAGREEMENT is
  the same quiet mark and never a red line, because a red line in the box the reader is typing in
  is the interruption the mark exists to avoid. The cost is stated: there is no hover on a phone,
  so a phone reader meets both facts in the dialog behind the header's menu — which is where the
  passphrase is, and the level a per-CONVERSATION fact really lives at.
- **THE SHARPEST FAILURE IS TWO PEOPLE WITH TWO PASSPHRASES**, and it is the one thing that would
  otherwise be silent: each posts messages the other cannot read, both see locked rows, and each
  believes the other's app is broken. `Store::seal_key_ids_in_use` reads the key ids off the messages
  the thread ALREADY holds, `seal_set` answers whether the new passphrase opens them, and the
  composer's own mark carries `SEAL_MISMATCH_HINT` in its title while it does not.
- **A PICTURE is not sealed, and the composer says so.** Its bytes are uploaded to Microsoft's own
  object store, so nothing in this module can cover them. It is allowed rather than refused — the
  user's own decision — and a message that looked sealed while carrying a readable screenshot would
  be a lie, so `SEAL_COMPOSER_HINT` names it — in the dialog that seals the chat, and in the title
  of the composer's mark.
- **A @MENTION is allowed, and its span travels SEALED.** `properties.mentions` stays in the clear,
  which is what makes the notification happen, so Teams learns WHO was mentioned and not what was
  said. The person is notified and sees a locked message until they have the passphrase.
- **The AGENT reads in the clear and its REPLY is sealed.** That is the user's own decision: the
  prompt carries the thread to the model provider, and what the agent POSTS goes through the same
  seal as anything else — including the streaming edits, about one a second, each with a fresh nonce.

**What a sealed chat does NOT hide**, and each is a deliberate stated limit rather than an oversight:
WHO said something, WHEN, in WHICH conversation and roughly how long it was (Teams routes the
message; the metadata is the routing); the ORDER of messages and whether one was DELETED (the tenant
holds the transport); a REPLAY of the same bytes into the same chat at a later moment — binding the
clientmessageid would close that, it is measured to come back on a read, and `teams_read` parses none
off an inbound message yet, so it is a stated gap rather than an unknown one; and WHO ELSE holds the
passphrase — everybody who has it can read every message ever sealed under it and can seal one
themselves, so a padlock is a claim about who can READ and never about who wrote. There is no forward
secrecy, and there cannot be while the requirement is "add the passphrase later and every message
already received becomes readable": that requirement is the exact negation of it.

**The GATES.** `seal_status` is OPEN — a page has to know whether a chat is sealed in order to draw a
padlock, and it never needs the secret to do it (the rule `get_settings` holds for a token, and no
key or passphrase is ever in that answer). `seal_set`, `seal_off`, `seal_forget` and `seal_reveal` are
`MACHINE_METHODS`: the write token, refused read-only, and the automation hook blocks each against a
live port. Each one decides something a client that merely found this socket must not decide —
whether the next message goes out in the clear, under which passphrase, and whether a key that opens
a thread's history is dropped for good — and `seal_reveal` is there because its ANSWER is the
passphrase. That reveal exists for one reason: a colleague who joins the conversation next month has
to be GIVEN something, and a passphrase this app could not show again would force a rotation of the
whole chat to share it. The passphrase is no wider a secret than the derived key in the same row —
either one opens every message — which is why it is a press rather than a field of a status payload.

**A PUSH notification hides the words by default, and it still notifies.** The backend holds the key,
so it could publish them either way, and the payload is encrypted to the device (RFC 8291) — what the
setting decides is whether the words of a chat the user deliberately sealed appear on a locked screen.
Silence would be worse than a preview that says nothing, so a sealed message notifies with a neutral
sentence; `SETTING_SEALED_PUSH_WORDS` (Settings, off by default) asks for the words. A message this
machine cannot READ lands on that same sentence rather than falling through the empty-body gate, which
would have made it silent.

**A CHANNEL cannot be sealed yet**, and the reason is the one a channel holds no game of chess: its
history is drawn as THREADS, so a sealed post there has to answer a different question about where
the padlock sits. The backend refuses it at the RPC and `sealCanBeUsed` never offers it, so it is a
stated limit rather than a control that reports a refusal. Notes offers none either: there is nobody
to share a passphrase with.

`web/mock/server.ts` reproduces the whole flow with no tenant and no crypto, with a sealed fixture
carrying all four message states at once and a `{kind:"seal"}` hook a spec MUST reset. `cd web && bun
run preview -- --out /tmp/seal --seal` captures the menu row, the dialog in both themes, a generated
passphrase, the four states, the composer's mark, the mismatch warning, the armed forget and the
dialog at a phone's width; `web/e2e/seal.spec.ts` pins every rule the page owns and
`web/src/lib/seal.test.ts` the pure ones.

**THE WHOLE CHAIN IS VERIFIED AGAINST THE TENANT, through the code that ships.** The probe's last
measurement seals a real message with `seal::seal`, posts it through `teams_send`, reads it back
through `teams_read` and opens it with `seal::open`: it came out word for word, and the same message
read with no passphrase answers `UnknownKey`, which is the locked row naming which passphrase is
missing. What is still UNVERIFIED is the PAIRING BETWEEN TWO MACHINES: nobody has sealed a message in
one install and opened it in a colleague's, because that needs a second machine running this app. Two
things rest on that and are inferred rather than measured — that a colleague's `sender_mri` is spelled
for their reader exactly as their own session spells it (proven for one's OWN message, and the failure
would be visible rather than silent: their message reads as damaged and its token stays on disk), and
that two people typing one passphrase land on one key (pinned in Rust, and the same code on both
sides).

## Sending a message LATER (the SERVICE holds it, and this app can take it back)

The composer can hand a message to Teams to deliver at a moment the user picked — Slack's
"Schedule for later". The chevron ATTACHED to Send opens a short menu of moments; the press
posts the message once, with the moment in it, and the service holds it until then. What is
waiting is stated above the composer and listed in full behind that banner, where it can be
sent now, taken back into the composer, or cancelled.
`web/src/lib/schedule-send.ts` holds every pure decision,
`web/src/components/schedule-send-menu.tsx` draws the menu,
`scheduled-messages-dialog.tsx` the list, and the backend's half is one optional field on
the send that already existed (`teams_send::parse_scheduled_time`) plus one column
(`Message::scheduled_time`).

**THE WHOLE SEND IS ONE FIELD, and every ACTION on it is an RPC this app already had.**
Nothing waits here, nothing is queued on this machine, and the app can be closed, updated or
restarted between the press and the delivery — the message is already Teams', held by the
same service that holds it for their own client. A hold-and-post scheduler in this backend
was the obvious other shape and it is much worse: it would post at a moment nobody was
present for, which is exactly the outward action § Sending messages forbids, and it would
fail silently whenever the machine was asleep. No new gate was needed either: the send is
`send`, the cancel is `delete`, sending now is `delete` + `send`, and handing the words back
is `delete` + `set_draft` — each already an `OUTWARD_METHODS` entry or a local write.

**EVERY FACT BELOW IS MEASURED**, by `examples/scheduled_send_probe.rs` — the sanctioned way
to try it live, pinned to the sandbox channel, and it cancels or removes everything it posts:

    . bin/broker-env.sh && teams_lite_export_broker_bus && \
      cargo run --example scheduled_send_probe

Measured 2026-08-17 and again END TO END on 2026-08-18, on the real tenant:

- **`properties.scheduledsendtime`, a QUOTED epoch-millisecond string, is the field**
  (`teams_send::SCHEDULED_SEND_TIME`). Every top-level spelling —
  `scheduledsendtime`, `scheduledSendTime`, `deliverytime` — is IGNORED and the message posts
  **immediately**, which is the one outcome this feature must never have. The
  `/scheduledmessages` collection paths all answer 404; held messages read back with
  `?view=scheduled`, which returns the thread's own messages with a hold on some of them.
- **DELIVERY WORKS**: a message queued 75 s out arrived in the ordinary history at its moment,
  and the property SURVIVES delivery — so "still waiting" is that moment being in the future
  and never a flag something has to clear.
- **A HELD MESSAGE COMES BACK IN THE ORDINARY HISTORY.** This is the fact that shaped the
  whole surface: the read path stored it like any other message, so a message queued for
  tomorrow morning sat in the thread as though it had been sent, and the app could not say
  which one was waiting. `Message::scheduled_time` (schema v17) keeps the moment and
  `Store::NOT_STILL_HELD` leaves such a row out of the history until it passes — a comparison
  against the clock, so the message appears on its own with nothing to clear.
- **`DELETE` CANCELS one**: its `scheduledsendtime` is gone and a `deletetime` is set, so the
  one call both stops the delivery and takes the row out of the list.
- **An EDIT RELEASES it** — accepted, and the hold is dropped, so the message is delivered at
  once. That is why nothing here offers an in-place edit: a pencil that quietly sent
  tomorrow's message today is the sharpest mistake this feature could make.
- **A `properties` PUT of the moment is REFUSED**, `400 InvalidMessagePropertyType`. So there
  is no reschedule to offer either.

Nine rules hold it, and each is pinned by a test:

- **The moment is bounded at the TRUST BOUNDARY, and stated on both sides.** In the future and
  at most 120 days ahead — Slack's own ceiling (`teams_send::MAX_SCHEDULE_AHEAD_MS`, mirrored
  by `scheduleRefusal` and by the picker's own `min`/`max`). The bound is what catches a UNIT
  error: seconds where milliseconds were meant lands in 1970 and is refused as past,
  milliseconds multiplied again lands in the year 56 000 and is refused as too far.
- **`properties` is MERGED, never assigned** (`teams_send::set_property`). Both halves this
  app writes live there — who a mention names, and when the message goes — so an assignment
  silently drops whichever was written first, and both failures are invisible (blue text
  notifying nobody, or a message posted at once).
- **A PRESS is the whole action**, and the menu row names the moment ONCE. It used to carry a
  name beside a time ("Tomorrow morning" and "tomorrow at 09:00"), which is one fact twice and
  wide enough to wrap the row in two.
- **The control is ONE PILL, split in two** — Send, and the chevron that discloses "later".
  They answer one question, so two separate buttons would ask the reader to tell them apart;
  `web/e2e/scheduled-send.spec.ts` measures the two boxes against each other — their WIDTHS
  included, so a chevron narrowed back below Send's own square fails rather than shipping.
  **And the rule between them is INSET rather than an edge**, which is the other half of making
  one pill aimable: a full-height border cut the pill in two and left the two glyphs a hairline
  apart, so a press meant for Send opened the menu. Slack's own shape is a short rule standing
  in whitespace, and it costs neither half its size — the gap is drawn, not taken from a target.
- **The BANNER above the composer is DERIVED from the queue, never announced by the send**
  (`scheduledBanner`). That is the rule that makes it honest, and both other shapes were
  wrong: a line set by the send went stale the moment the message was cancelled from the list,
  and said nothing at all when the app was reopened with something already waiting. It is
  above the box rather than inside it — inside, it read as part of the message being written —
  it counts what is queued and names the SOONEST, and it carries the one way into the list.
- **A held frame is not news, and the page is what says so** (`messageIsHeld`). The service
  broadcasts it like any other message, so it never joins the thread, never chimes and never
  bumps a preview — it refreshes the list instead. The backend's own read already excludes a
  held row from a history page, so the page's rule covers the LIVE frame, which the backend
  cannot exclude without hiding a message from itself.
- **The list is ACROSS conversations and costs no network read** (`Store::scheduled_messages`,
  answered by the open `scheduled_messages` RPC). A held message is in the ordinary history, so
  the store already holds every one of them — the very rows the thread leaves out. The page
  names each one's thread from the lists it already has, so nothing about a conversation is
  resolved twice.
- **Three actions, and the set is what the SERVICE allows.** Send now (`delete` + `send`, two
  writes rather than resting on the edit's release — which would be a silent no-op the day the
  tenant stopped doing it), Edit (cancel, then hand the words back to that thread's composer,
  which is the one row covering both rewriting and re-timing), and Delete, which asks twice
  like every other deletion here. The words are handed back through `composerRestore` and a
  token, because the editor seeds its content at MOUNT — writing the draft of the thread
  already on screen changed nothing the reader could see.
- **The presets are honest rather than tidy** (`schedulePresets`): this evening, tomorrow
  morning, Monday morning — a row already in the PAST is dropped rather than shifted, and one
  landing on the same moment as another is dropped too (on a Sunday, "tomorrow morning" IS
  Monday morning).
- **A ROW'S ACTIONS CARRY THEIR WORDS, and the destructive one is pushed away from the other
  two** (`RowAction`, `ml-auto`). They were three unlabelled 28px glyphs four pixels apart,
  which put "post this to everybody now" beside "delete it for good" and asked the reader to
  decode a 16px mark to tell them apart — on a phone that is a mis-tap that sends. They are
  drawn at rest rather than on hover, for the reason the chat row's "…" splits that way: this
  app is read from a phone, where there is no hover.
- **Every target this feature adds clears the touch floor.** The chevron is the Send button's
  own 32px square (it was 24px, which made it the narrowest control in the app, at the very
  edge of the screen), and a menu row and the picker are 44px tall. The one place the reader
  is not reaching for a control is the BANNER, whose "See all scheduled messages" FLOWS inside
  its own sentence rather than sitting pinned at the right: pinned, a phone drew the count on
  one line and the way into the list against the far edge of another.

**"Custom time" is a ROW that opens a DIALOG, and that is a bug fix rather than a
preference.** The native picker sat inline in the menu first and could not be used at all:
pressing it opens the browser's OWN calendar, which is not in the document, so Radix read
that press as an interaction OUTSIDE the popover and dismissed the menu — taking the
half-filled field with it. The reader saw the menu vanish and nothing happen. A dialog is
dismissed only by a press it can really see, so the picker inside one survives; it is also
the shape the reference has. Two things follow: the dialog is a SIBLING of the popover (a
child would be unmounted by the very close that makes room for it), and **Cancel is the way
out that always works**, because a native date input consumes Escape for its own calendar —
a dialog whose only exit was Escape would read as stuck while the field had focus.

The picker itself is the **native** `<input type="datetime-local">`: a date-picker component
would be a second calendar in an app that needs none, and the native one is a phone's own
wheel, which is where this app is read.

`web/mock/server.ts` reproduces the whole flow with no tenant, and the important half is that
it ECHOES a scheduled send as a held message in the thread's own history — because that is
what the tenant really does. A mock that withheld it would let a broken exclusion pass every
test; instead it mirrors the backend's read (`delivered()`) and answers the list from the
threads' own messages, so a cancel takes a row out of it with nothing to keep in step. It also
does what the tenant does about the SIDEBAR: a held message never becomes a conversation's
preview (its `recompute()` runs below the echo's own early return), because a row reading
"You: Ship it in the morning" for a message nobody has sent is exactly the claim the whole
banner exists to correct. Its `{kind:"scheduled", clear:true}` hook drops everything held, and
**a spec MUST call it**: one mock process serves the whole run, and a queued message outlives
the page — it would sit in every later spec's banner.
`cd web && bun run preview -- --out /tmp/sched --schedule` captures
the pill, the menu in both themes, the custom-time dialog in both themes, a moment that has
passed being refused, the queued banner in both themes, the list in both themes, an armed
deletion — and the banner, the menu, the custom-time dialog and the list again at a PHONE's
width, because every defect this surface shipped was one only 390px showed;
`web/e2e/scheduled-send.spec.ts` pins every rule above and `web/src/lib/schedule-send.test.ts`
the arithmetic.

**What is verified against the tenant and what is not.** The whole chain is measured through
this crate's own `send_message` (above) — the field, the delivery, the hold appearing in the
history, and all three writes. What is UNTESTED is the pairing: one queue-and-cancel in the
user's own app, over the socket, which is their own click.

## A picture somebody SENT is drawn WHOLE (the view is a display decision)

An inline picture travels as an AMS object, and one object serves several VIEWS of itself.
The view a Teams client writes on the `<img>` is not the picture: measured on this tenant by
`examples/inline_image_recon.rs` — READ-ONLY, over the store's own 857 inline pictures, and
it prints byte counts and pixel shapes rather than anybody's screenshot:

    . bin/broker-env.sh && teams_lite_export_broker_bus && \
      cargo run --example inline_image_recon

Measured 2026-08-07 in region `fr`: `views/imgo` is a **JPEG whose long side is capped at
800 px**, and `views/imgpsh_fullsize_anim` carries the pixels the sender uploaded, in the
format they uploaded. Of 24 pictures, **10 arrived between 1.49x and 2.83x smaller** than the
object holds — and the 14 that fitted still came re-encoded, so a screenshot's text carried
JPEG ringing every single time. The whole picture costs **3.90x the bytes** over that sample
(475 KB → 1.85 MB for 24), which is what the rules below are weighed against. `imgpsh_mthumb`,
`original` and `thumbnail` answer **400** here, so the view table is not a guess either.

- **The choice is a DISPLAY decision, and the body keeps what Teams wrote.**
  `fullSizeMediaUrl` (`web/src/lib/protocol.ts`) names the whole view; the stored frame is
  untouched, which is the rule § Renaming a person states for a name — this app never rewrites
  the record of a Teams frame.
- **One place asks, and it keys on the MESSAGE's own URL.** `TeamsController.loadPicture` is
  it, so the picture's identity in the media cache is the URL the message carries and never
  the view that answered — which is what lets `MediaImage` retain and release it without
  knowing. The LIGHTBOX is the same blob, so opening a picture magnifies real pixels: it grows
  one up to `MAX_UPSCALE`, and 3x of an 800px JPEG is the mush that rule exists to avoid.
- **The reduced view is the FALLBACK, so this can never cost a PICTURE.** An object whose full
  view the store refuses — too large for `MAX_MEDIA_BYTES`, or a shape this tenant does not
  publish — draws exactly as it did before, one request later.
- **Only the media proxy's own hosts are ever touched** (`mediaNeedsProxy`), and only a view
  measured to be a reduction (`imgo`, `imgt1`, `imgt1_anim`, `imgpsh_mthumb`,
  `imgpsh_mobile_save_anim`). An attachment's `views/original`, an avatar's
  `views/avatar_fullsize` and a picture on a stranger's server are left alone: asking somebody
  else's server for a "view" would be this app inventing a URL for their file.
- **A custom EMOJI keeps the cheap view.** It is a 20px glyph, so it goes through
  `loadMedia` — the full PNG of an emoji is bytes nobody can see.
- **The picture holds its own ROOM, out of the size the sender's client stated.** The parse
  keeps `width`/`height` (`pixelAttr` in `web/src/lib/rich-text.ts`, which ROUNDS the fraction
  Teams writes on a picture the sender resized: `width="521.5654952076677"`), and drops both
  when it cannot use both — an aspect ratio needs the pair. Before this the words around a
  picture re-flowed when its bytes landed, which is the defect a GitLab upload's own
  `{width=… height=…}` was already fixed for.
- **And that stated size is brought UNDER the height ceiling before it is drawn, in BOTH
  directions** (`drawnPictureBox` in `web/src/lib/media-size.ts`, the one place `max-h-80` is
  spelled as a number). A stated width makes the CSS width DEFINITE, so `max-height` clamped the
  height alone and `object-contain` fitted the picture inside a box far too wide for it: a photo
  from a phone — 640x1000, the commonest picture in a real chat — was drawn 204 px wide inside a
  640 px box, so the mat framed it with a hand's width of hatch either side and the words below
  reserved room nothing used. Scaling BOTH numbers keeps the ratio the browser derives from them,
  so the box is the picture. Three things follow, and each is pinned by a test: the LOADING box
  is that same box (one clamp, not two, or the room reserved is again wider than what lands in
  it), the cap FLOORS the width (rounded up, the height sits a fraction over the ceiling and the
  clamp is back), and a picture that states NOTHING is untouched — with no definite width the
  browser shrinks the box itself, which is why a landscape fixture could never show this.

`web/mock/server.ts` reproduces the object store's two resolutions with no tenant
(`mockInlinePicture`: 160px for a reduced view, 640px for the whole one) and REFUSES the full
view of its second inline fixture (`MOCK_NO_FULL_VIEW`), so both rules are numbers a spec can
measure — `web/e2e/media.spec.ts` reads `naturalWidth` rather than trusting either. That same
fixture is the TALL one (`MOCK_TALL_PICTURE`): a photo from a phone, stating its own size, in
the ratio its bytes really hold, so any room left beside it is the app's own doing. Both facts
ride an existing fixture on purpose: one mock process serves the whole run, and a picture added
to the seeded history moves every row a later spec counts on.

## A quote is a POINTER to a message (click it, and three lines of it)

The recessed block above a reply is not a copy of what somebody said — it is the address of
it. Clicking it takes the reader to that message, centred and briefly highlighted, and the
block itself shows at most three lines. `message-bubble.tsx` draws the block and decides
whether it is a control; `message-pane.tsx` owns the scroll and resolves the target;
`web/e2e/quote-jump.spec.ts` and `web/src/components/message-bubble.test.tsx` pin both.

- **Jumpability is a property of the PAYLOAD, not of the UI.** Teams composes a reply with
  the quoted message's id in the blockquote's `itemid` and again in `itemprop="time"`, and
  that id IS the message's ms-epoch compose time — measured on the real history, `itemid`
  equals the `itemprop="time"` id in 1174 of 1174 replies, and no stored message has an id
  that differs from its compose time. A **FORWARD** carries no author, no time and no id
  (see `seedForwardedMessages` in the mock): the message it holds was said somewhere else,
  so a forward is never offered as a control and stays the recessed block it always was.
- **The pane is the only surface that offers it**, because it is the only one with a history
  to move. `onQuoteJump` is a prop, absent everywhere else, and a bubble without it draws the
  plain block — no `role`, no focus ring, no pointer.
- **The loaded id comes first, the compose time second.** `doQuoteJump` looks the quoted
  message up among the loaded ones by `compose_time` and asks for its real id; only when the
  message is not loaded does it pass `String(quote.time)`, which the existing deep-link
  effect then pages older toward (bounded by `MAX_SCROLL_PAGES`). One machine, `requestScrollToMessage`,
  serves the notification bell and this alike.
- **A click that already means something keeps meaning it.** A link, a tracker chip, the
  quoted author's own hover trigger: the guard walks up from the clicked node and stops at
  the block itself, which the block must exclude — it is a `role="button"` now, so a guard
  that did not would read every click as somebody else's.
- **The clamp is CSS only.** `line-clamp-3` shortens what is DRAWN; the whole quoted text
  stays in the DOM, so copying and find-in-page still see all of it, and the jump is how a
  reader gets the rest. **A quote that is a PICTURE is not clamped** — cropping would cut a
  forwarded screenshot rather than shorten it, and the screenshot is often the whole quoted
  message.

## When a message was sent (a mark per BLOCK, never a stamp per bubble)

The history says when it happened the way Instagram's own threads do: one small centred
line above the first message of a stretch, and nothing above the rest of it.
`web/src/lib/message-time.ts` decides which messages earn one and what each says, and
`message-pane.tsx` draws it — nothing about a bubble changed.

- **A block begins for two reasons, and both are the reader's question rather than a round
  number.** The DAY changed (23:55 and 00:10 are ten minutes apart and belong to two days,
  which is the one thing the words can never say), or the two messages are at least
  `TIME_MARK_GAP_MS` apart — an hour, below which a slow exchange over lunch would be cut
  into stamped fragments. A stamp on every message is the same fact ten times over.
- **A mark needs the message BEFORE it**, so the oldest loaded row never carries one: the
  history pages older as the reader scrolls up, and a mark drawn on whatever happens to be
  at the top would be taken away again by the page that arrives above it. What that costs
  is a thread whose whole loaded page sits inside one hour of one day — a conversation
  being had right now, where the answer is "just now".
- **It says only as much date as the reader needs** — the time for today, "Yesterday" for
  yesterday, the weekday inside the week, then the date, and the year only beyond this one
  — in the reader's own locale and zone, over the epoch ms the wire carries. The exact
  moment is on the mark's `title`, so one reading "Yesterday 14:32" still answers which day
  that was.
- **The mark BREAKS a same-author run, in both directions.** Two messages an hour apart are
  two things somebody said, and tucking the second against the first at continuation
  spacing — under a line saying the day changed — would draw them as one.
- **The marks are a PASS over the history, not a decision per bubble** (`messageTimeMarks`,
  computed where `trackerProjects` is and for its reason): the pane re-renders on every
  frame of a live agent run and on every scroll that mounts a row, while a mark changes only
  when the messages do. It is taken over the history AS DRAWN — one run for a chat, one per
  thread for a channel, since a reply's neighbour is the reply above it inside its own
  thread.
- **Its height is a CONSTANT the row estimate knows** (`TIME_MARK_ROW_PX`, added by
  `estimateSize` for exactly the rows that carry one). A row taller than its estimate is
  corrected by writing `scrollTop` the moment it is measured, and that correction is the
  twitch `e2e/history.spec.ts` exists to catch — so the mark is held at its own height
  rather than at whatever the line happens to measure.

**Adding it also mended the twitch test's own arithmetic**, which is worth knowing before
touching either. That test wheels the history up under an 8x CPU throttle and used to hold
every frame outside a 140ms window around each notch to "nothing moved". A fixed window is
not a fact about the browser: under the throttle a long task defers a notch and its scroll
is delivered a frame or two later — measured at 149ms and 579ms after the notch that asked
for it, with the scroller moving its own full 90px on that very frame — so the reader's own
wheel was reported as a jump of exactly one notch, and it took a 36px line to expose it. The
frames now carry `scrollTop` and every scroll the virtualizer performs ITSELF (`scrollTo` is
patched, as `scripts/scroll-probe.ts` already does), and each frame is held to what the
content was SUPPOSED to do: the wheel moves the viewport over a still list, so the content
moves by what the wheel asked; the app's own write re-anchors the reader over a list that
grew above them, so `scrollTop` jumps and the content must not move at all. Anything left
over is the history moving on its own. It is SHARPER than the window it replaced rather than
looser — reintroducing the original defect (`directDomUpdates: false`) is caught at 3640px,
where the old metric needed luck about timing to see it at all.

## WHO said it (a name per BLOCK too, and only where there is a question)

A multi-party thread names the author above the first bubble of their run — WhatsApp's and
iMessage's own shape, and the one the time mark already follows for "when". `nameShown` in
`web/src/components/message-bubble.tsx` decides whether one is drawn and the pane feeds it
`showSenderName` / `continuesAbove`.

- **It is drawn where the reader cannot know**: an incoming message, in a GROUP CHAT or a
  channel. Never on the user's own — they wrote it — never in a 1:1 or Notes, where the
  thread's own title is the answer, and never on a continuation, because the same fact ten
  times over is the noise a stamp per bubble already taught this history to avoid. An
  agent's reply carries its own mark instead, in every thread rather than only in a group:
  WHO wrote that one is the whole point of the label there.
- **A multi-party thread is `isGroupChat`, so an `unknown` kind COUNTS.** That is what the
  backend writes for a thread it has synced an id for and nothing else, and every such row
  observed so far is a MEETING thread — several people in it, which is exactly where the
  name is the reader's question. Spelled `kind === "group"` in the pane, it was the one
  multi-party shape in the app that drew no sender at all.
- **A NAME IS NOT AN IDENTITY, and it took a real thread to show it.** Teams carries the
  author's name in `imdisplayname` and in nothing else, so a frame without one is stored
  with a blank `sender` — measured on this tenant, 273 of the 899 messages of the busiest
  group chat, every one of them from somebody the store CAN name off their other messages.
  A name is frozen per row at insert and no sync refreshes it, so a blank stayed blank and
  the bubble said nothing: the whole feature was missing exactly where it was wanted. Two
  halves fix it, and each is pinned by a test:
  - **The read resolves it from the sender's own MRI** — the `nicknamed!` ladder in
    `src/store.rs`: the user's nickname, then the row's own name, then the newest name that
    identity wrote under. It sits in the column list, so a message page, a single row
    re-read after an edit (which is what the live feed broadcasts) and the row a push is
    built from all state the same name, and it is the ladder
    `Store::display_name_for_mri` already answered a typing signal with — spelled once,
    because two answers to "who wrote this?" is the bug. An EMPTY mri resolves to nobody:
    a recording and a thread activity carry no author at all, and reading them as one
    person would lend the newest of them its name to all the rest — a blank says nothing,
    a wrong name says something false.
  - **A RUN is keyed on the identity** (`sameAuthor` in `message-pane.tsx`), and only on
    the name where the store holds no identity. On that same store 35 adjacent pairs were
    two DIFFERENT colleagues both blank: chained as one person talking twice, at
    continuation spacing, with the second one's label suppressed as a repeat of the first's.
    Two colleagues who really share a display name are the same failure with a rarer cause.
- **The mock needed no half of its own**, and that is deliberate: the ladder is a store
  READ and a mock reimplementation of it would be a second spelling of the one policy. Its
  7 group chats of 3–5 people already draw the label, `web/e2e/media.spec.ts` pins that an
  incoming group message carries one and the user's own does not, and the resolution itself
  is pinned in `store::tests`.

## WHO reacted (a chip says it on hover, and a custom one says its own name)

A reaction chip carries a count and no names, which answers "how many" and never the
reader's actual question. Pointing at one now says both: "Ada Lovelace and you reacted
with :shipit:". `reactions_value` (src/bin/server.rs) resolves the people,
`reactionTitle` / `reactionReactors` / `reactionLabel` (`web/src/lib/teams-emoji.ts`)
write the phrase, and the chip in `message-bubble.tsx` carries it as a plain `title`.

- **The names are the BACKEND's, through the one ladder.** The stored emotion holds
  each reactor's MRI (`teams_read::parse_emotions`) and nothing else, so the wire gains
  a `users` list resolved by `Store::display_name_for_mri` — which is why a colleague
  the user RENAMED is named here exactly as they are above their own bubbles. The page
  is never handed the MRIs: one answer about a name in this app, and a reaction is not
  a person card. It is what made the two history handlers hold their store open until
  the page is serialized — a message now states something a store read answers.
- **`mine` travels per USER as well as per reaction.** The page puts "You" first, where
  Teams puts it and where a reader looks, and the aggregate flag cannot say which of
  several names is theirs.
- **A reactor with no name is COUNTED, never dropped** — somebody this machine has
  never seen write, and a backend too old to carry the list at all: "Ada and 2 others",
  "3 people". A chip saying 3 over two names reads as a chip with a bug.
- **A CUSTOM reaction names its own `:code:`**, which is the second half of the reason
  its key carries a name (§ Custom emoji): the art is the sender's and is never
  resolved from the reader's pack, but the key's own name is what lets the tooltip say
  which emoji it is rather than "custom emoji" and nothing else. A key written before
  the name travelled still says the neutral phrase.
- **It is the ART that carries the tooltip on a custom chip**, not only the button: the
  glyph fills the pill, so the button's own `title` is the one a pointer never lands on
  (`CustomEmoji`'s `title`, which defaults to its label everywhere else).
- **A screen reader is handed the names too.** `aria-label` REPLACES `title` for
  assistive tech, so it carries the action and then who is behind the chip — the emoji
  once, not twice, and no names at all on a reaction that is only ours, where "Remove
  your :shipit: reaction" has already said whose it is.

The mock keeps the reactors' MRIs and resolves them at its own read boundary
(`reactionWithPeople` in `nicknamed`), which is the split the backend has; `emitReaction`
takes `mris` so a spec can name them or leave them unnamed. `web/e2e/reactions.spec.ts`
and `custom-emoji.spec.ts` pin the phrases, and the ladder itself is pinned in
`server::tests`. There is no capture: a native tooltip is not something a screenshot
holds.

## The local agent (`@claude` in a thread)

The user can summon a coding agent that runs on this machine from any Teams client —
their phone included — by writing `@claude` anywhere in a message in a thread. The backend
runs that CLI, posts one message, and EDITS it as the answer arrives, so everybody in the
thread watches the reply being written.

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
of the Rust markdown subset, pinned to it case for case by its tests). Seven rules hold
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
- **The bubble's own EDGE says an answer is being written into it.** A light travels the
  hairline the agent's bubble already wears — magicui's `ShineBorder`, added from their
  registry (`web/src/components/magicui/shine-border.tsx`, with the `shine` keyframes and
  `--animate-shine` in `web/src/styles/app.css`) and kept as the vendor's file: the app's own
  half is `AgentBubbleShine` in `web/src/components/agent-reply.tsx`. It carries the fact the
  breathing mark carries, in the one place that covers the whole message: on a long answer the
  signature scrolls out of the top of the bubble and the edge is still there to say which
  message is live. Five things hold it, and `web/e2e/agent.spec.ts` pins each:
  - **A run this app cannot SEE is still a run.** The light is drawn while a run streams into
    the page, and also on a reply whose stored body says its answer is unfinished
    (`agentAuthorship(...).pending` — the message signed `claude is writing…` rather than
    `— claude, via teams-lite`). That second one is the common case, not an edge case: the
    point of the feature is asking from a phone, so most replies are watched by no page at
    all. A run that DIED is in neither, because whichever backend comes up rewrites its
    message with the failure body (`repair_abandoned_agent_runs`) — so a body still pending
    is one nobody has closed.
  - **The words beside it stay still.** `still being written…` gets no shimmer and the answer
    no caret when nothing is arriving HERE; the edge is the one thing that speaks for a run
    this page is not being fed.
  - **It is the CLI's own colour** (`agentShineColor`), so the edge and the mark inside the
    bubble name one vendor — the choice the composer's tag chips already make. Anything that
    is not Claude takes the app's accent, because opencode's graphite travelling round a grey
    bubble is a light nobody can see.
  - **Only the BACKGROUND moves.** The element is masked down to the ring and the gradient
    slides across it, so a message in a virtualized history is never re-laid-out by it.
  - **It is not drawn at all under `prefers-reduced-motion`** — not merely held still, because
    stopped the sweep is a smear of colour over one corner rather than a light going round an
    edge.
- **The work is a transcript: it is OPEN for the whole run, and folded once the run ENDS.**
  The reasoning streams into a panel above the answer, at the pace the answer is revealed
  at, with a row per tool call in place — so a reader watches the run being worked out. It
  used to be one 160-character line of reasoning and one tool chip, each replaced by the
  next: every sentence the model wrote and every file it read went past and was gone, which
  made the most interesting part of a run the part nobody could read. And it used to fold
  itself the moment the first word of the answer arrived, which took the work away at the
  one moment it explained what was being written — the panel now holds its room for as long
  as anything is arriving into it, and closes when nothing is. Four things hold it up, and
  `web/e2e/agent.spec.ts` pins each: it is BOUNDED and scrolls itself (it sits in a
  virtualized history, and an unbounded bubble would push the conversation around a frame
  at a time), it follows the newest line only while the reader has not scrolled back inside
  it, the fold is automatic ONCE — at the END of the run — and the reader's own click wins
  from then on, and the header names the tool in flight only while the rows are folded —
  open, the rows say it better. The reasoning is drawn as data, never through the Markdown
  renderer: it is what the model said to itself, not this app's voice.
  **The collapse itself is motion, and it is ONE movement**: the height on a strong
  ease-out (`TRANSCRIPT_EASE`), the opacity quicker than the height and led by it, a close
  shorter than the open, the chevron on the same curve, and a row already on screen when the
  panel opens rides that animation instead of running its own — two animations for one event
  read as a stutter.
- **The transcript OUTLIVES the run, without ever becoming part of the message.** The
  overlay goes when the run ends and the Teams message takes its body back — but the
  reasoning exists nowhere else, so what this app watched is kept in the page
  (`agentTranscripts`, keyed by the message, bounded by `AGENT_TRANSCRIPTS_KEPT`) and drawn
  folded between the quoted request and the answer: the same place it stood while the run
  was going, so nothing moves at the swap (`AgentStoredTranscript`). It is gone on a reload,
  and a reply this app never watched — answered from a phone, or before the page loaded —
  has no panel at all. That is the honest shape: the disclosure exists exactly when there is
  something behind it. The reader's fold is held per message alongside it, because the panel
  is remounted at that swap and again on every pass of the virtualized history — a fold kept
  inside the panel would reset under them both times.
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
- **The user can NAME their own agents, and each name is one more address.** `@bebou` runs a
  provider this machine already holds, wearing a face, a label, a model and an instruction the
  user wrote (see § CUSTOM AGENTS). Every rule in this section applies to one unchanged,
  because a persona changes only WHICH NAME is looked for — the program still comes from the
  static table, the conversation still has to be opted in, and the reply still signs itself,
  with the persona's name inside the signature.
- **The address may sit ANYWHERE in the message, and that is all it takes.** `@claude` is
  read as a word of its own wherever it stands, and the prompt is the whole message minus
  that word (`agent_policy::split_prefix` / `address_in` / `prompt_without`): "which port
  does it use, @claude?" is the same request as "@claude which port does it use?", because
  a person writing to somebody does not always open with their name. The earliest address
  wins when a message names two, the match ignores case, and the punctuation an address is
  written with belongs to it — the `:` or `,` after the name and the vocative `,` before
  it. The cost is stated where the rule is: a message ABOUT the agent now reads as a
  message TO it, which the text alone can never tell apart. Two things pay for it. It is a
  WORD — it opens the text or follows whitespace, and it ends the text or is followed by
  something that ends a word — so `ping@claude.example` and `@claudette` summon nothing.
  And the one shape that arrives `from_me` without the user writing it, an ANSWER, is
  refused by name (`agent_policy::is_agent_answer`, which reads the signature line the way
  `web/src/lib/agent-message.ts` does): an answer is free to write `@claude` in its own
  words, and without that gate a run would summon itself. The old rule — the address had
  to OPEN the message — prevented that loop by accident; now it is prevented on purpose.
- **A conversation must be opted in.** The default is `off` everywhere. The sandbox
  channel is the single built-in exception, because § Sending messages pre-authorizes
  it. Anything else needs `agent_set_mode`, a write-token-gated `MACHINE_METHODS`
  entry — which is the consent gate for this whole feature, and the reason it is not a
  standing licence to post. The user turns one thread on from that thread's own MENU
  (`web/src/components/conversation-menu.tsx`, over `web/src/lib/agent.ts`), never from a
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
- **One provider is the DEFAULT, and it is Claude Code out of the box**
  (`agent_policy::DEFAULT_BACKEND`, stored under `SETTING_DEFAULT_PROVIDER`, moved by
  `agent_set_provider {default: true}` from the same pane). It takes nothing away: every
  enabled provider still answers its own prefix, and the composer's "@" still offers all of
  them. What it decides is which single one a surface with room for ONE row names — a
  message's "…" menu, whose "Answer with" and "Review with" rows come from
  `defaultAgentCandidatesFor` rather than `agentCandidatesFor`. That menu is a column of
  actions on one message, and a row per vendor asks the reader to choose a program before
  they have said what they want. Three rules hold it, and each is pinned by a test: there
  is always exactly ONE — an unknown stored name, and a backend too old to name one, both
  read as Claude Code, because a typo must not empty a menu; `default: false` is refused,
  so the way to move it is to name the other provider; and the preference LOSES to the
  older rule that a row must really answer — a default whose CLI this machine lacks, or
  which the user switched off, hands the menu back to what does answer
  (`defaultUsableBackends`), because a row that summons nothing is worse than two that
  work.
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
- **AND THE AGENT IS TOLD WHO IS IN THE ROOM, by the names the user themselves uses.** A
  third block, `<people>`, stands above the thread: one line per person who has written
  there, carrying the nickname the user gave them and Teams' own name beside it, with the
  line of whoever SENT the trigger saying so (`agent_policy::people`, over the one store read
  that hands both names over — `Store::thread_people`). The agent used to be the only
  participant in a conversation who could name nobody: it read `Bebou: the deploy is stuck`
  with nothing saying who Bebou is, and it was never told the name of the person it was
  answering — so it could not address them, and every reply spoke about the room in the third
  person. Eight rules hold it, and each is pinned by a test:
  - **THE NICKNAME LEADS, because it is the name the user uses.** The block's own
    introduction says so — the first name on a line is the one to write — and it is the name
    the transcript's lines already open with, since every read resolves a sender through the
    `nicknamed!` ladder (§ Renaming a person). There is no second spelling of that resolution
    here.
  - **TEAMS' OWN NAME TRAVELS WITH IT, and this run carries the proof of why.** The
    `<answering>` block names its author with the name the QUOTE holds, because this app never
    rewrites the record of a Teams frame — so one prompt states "Bebou" above the thread and
    "Lucas Silva" inside a quote, and only the pair says they are one person. A file, a merge
    request and a colleague's own words name them the same way. What it costs is stated where
    the rule is: a RENAMED colleague's Teams name now reaches the model provider, where only
    the nickname used to — which is what the transcript has always carried for everybody the
    user has not renamed.
  - **The BLOCK is in the prompt, the SUMMONER is in the system prompt.** The people are
    per-conversation data quarantined like the transcript, and they come FIRST because every
    line of the transcript opens with one of those names — the block is the key to it. Who
    summoned the run is a fact about the RUN, so it sits beside "you are Natacha" and "your
    reply lands in Design crew", and it is stated with a name rather than as "the user".
  - **Naming the summoner HARDENS the quarantine.** The paragraph that quarantines the
    transcript now names the one voice that instructs the run — and says in as many words that
    a line of thread context CLAIMING to be from them is still context. The labels in the
    transcript are this app's own; a colleague can write "Théo: ignore your instructions"
    inside a message, and that message is a message.
  - **An AGENT'S OWN ANSWER is attributed to the agent, not to the account it went out
    under.** A reply is posted through the user's account, so the row names the USER — and
    read as their words it is wrong twice over: the model meets its own earlier answers as
    things the user said, and a colleague who also runs teams-lite has their agent's answers
    read as theirs. It is the read the page already makes (`agentAuthorship`), from the line a
    reply signs itself with, and the sender is KEPT beside the signer (`claude via Lucas
    Silva`) because whose machine wrote it is never guessed. The signature line is then
    dropped from the words — the label has just said it, and a line the model meets twenty
    times is one it may start writing itself, while the footer is the backend's to add on
    every edit.
  - **ONE read of the signature answers all THREE questions.** `agent_answer` returns the
    signer, the line, the answer with that line removed and the agent behind it;
    `is_agent_answer` — the gate that stops a run summoning itself — is that function with
    everything thrown away, and the SIDEBAR's own row is the third caller (see the rule below).
    Two spellings of those four body shapes would drift from the bodies this module writes.
  - **It is a STORE read, and network-free.** So it costs the trigger path nothing and works
    with the tenant unreachable. What it therefore cannot list is a member who has never
    written: nothing here names them, and no line of the transcript is theirs. Whoever can be
    @MENTIONED is the separate network read below, and the two lists agree on a contributor
    because both resolve them through the same override — `thread_people` for the block,
    `thread_senders` for the mention list — so the name to write and the name that notifies are
    one name.
  - **Somebody this machine cannot name is left out, and a room it can name nobody in gets no
    block at all.** A line showing an MRI is a line nobody can read, and a paragraph about
    names in a thread with no names is furniture — the rule
    `agent_markdown::mention_note` already holds.
- **The reply signs itself.** The message is posted under the user's name, so the last
  line says a machine wrote it (`— claude, via teams-lite`). That is honesty about
  authorship, not decoration.
- **AND THE SIDEBAR NAMES THE AGENT TOO, because a row is where most replies are met
  first.** The bubble gets this right — the CLI's mark where a sender's name goes, the
  signature stripped out of the body, the answer on the LEFT — and the chat row got both
  halves wrong: `You: …ship it — claude, via teams-lite`, the account because the reply
  really is posted through it, and the machinery because a preview is the body's own words.
  A row now reads `Claude: ship it` (a custom agent's own label where this machine still
  holds the record — `agentPreviewName`, which is the bubble's own rule spelled once). Five
  things hold it, and each is pinned by a test:
  - **The BACKEND decides, because only it can.** A preview is the body's first 120
    characters and the signature is at its END, so a page cannot see one at all on an answer
    of any length. `agent_policy::agent_answer` is the ONE reader of that line — the loop
    guard, the sidebar and a bubble now share it — and `teams_read::preview_of_message` uses
    it to preview the ANSWER and name the agent beside it.
  - **The words and WHO wrote them come from ONE message.** `Store::derived_preview` answers
    both together; resolved apart, a name read off one message would stand over another
    message's words.
  - **So the CSA snapshot previews an agent's answer as NOTHING**, which is exactly the rule
    a SEALED body already follows and for the same mechanical reason: a non-empty stored
    preview is what stops that derived read from running. Teams' own copy of the newest
    message has nowhere to put the second half.
  - **A run with no words yet is STATED, never blank**: `Writing an answer…`, and
    `Could not answer — <reason>` for one that failed. Empty, the derived read would fall
    back to the message BEFORE it and the row would show the request while its answer was
    arriving.
  - **A message that merely ends in italics is nobody's answer.** The whole rule rests on
    that trailing line, so a colleague's own emphasis must not hand their words to a
    machine's name — and a preview from a backend too old to strip one is shown verbatim
    rather than guessed at. The mock states both halves itself (`mockAgentPreview`), because
    a mock that previewed a reply the way the page wishes it were previewed would let a
    broken row pass every test; `--agent-reply` captures the row in both themes.
- **The answer can @mention the people of ITS OWN thread, and it is the one part of a
  reply that acts on somebody.** A mention notifies the person it names, so the
  capability is bounded by code and not by the prompt. The candidates are resolved once
  per run by `thread_mentionable_people` — the same list the composer's "@" offers, so a
  machine and a person can name exactly the same people — and travel two ways: into the
  system prompt as the names that may be written (`agent_markdown::mention_note`, because
  a capability nothing states is a capability nothing uses), and into the renderer as the
  only names that resolve. Five rules, each pinned by a test in `src/agent_markdown.rs`:
  - **A name the thread does not hold stays plain text.** `@Alan Turing` in a thread
    without one is the words it is. A model cannot reach anybody the conversation does
    not contain, and the roster module it comes from is GET-only by construction.
  - **An ambiguous name names NOBODY.** Two Adas and a bare `@Ada` resolve to neither:
    notifying the wrong colleague is worse than notifying none. `@[Ada Byron]` — the
    explicit form — resolves it.
  - **The span shows the name the THREAD holds**, never the text the model typed, so a
    message can never show one person's name over another person's MRI.
  - **A mention inside a code span is code.** An answer explaining the syntax must not
    ping anybody while it does so.
  - **The edit carries the pair.** An agent's body only exists after the edit, so
    `build_edit_body` writes `properties.mentions` and refuses a mention with no span in
    the body, exactly as a send does. Before this, an edit dropped `properties` entirely
    and an answer's mention would have been blue text notifying nobody.
- **The user can STOP a run mid-answer, and the half-answer is KEPT.** A **Stop** button
  sits on the live bubble's own header (`AgentStream` in `web/src/components/agent-reply.tsx`,
  drawn on both the pending bubble and the posted message, so one control covers the phone
  and the desktop), and pressing it flips the run's own switch. `agent_stop` is the RPC —
  a write-token-gated `MACHINE_METHODS` entry, refused read-only, blocked against a live
  port by the automation hook — and it does nothing but flip the switch: the run's own path
  writes the body, so there is no double-edit to race. Six things hold it, and each is
  pinned by a test:
  - **The switch cancels the RUN FUTURE, and the CLI dies with it.** `agent_runs_inflight`
    on `Ctx` keys a `watch::<bool>` sender by `run_id` (the `conversation/trigger_id` every
    frame already carries), and `agent_run_to_completion` runs `agent::run` in a `select!`
    against it. A flip drops that future, and the child — spawned `kill_on_drop` in
    `src/agent.rs` — is killed with it. No pid, no signal: dropping the future is the whole
    mechanism, which is why `src/agent.rs` needed no change.
  - **A stop is a run that ENDED EARLY, not a fifth shape.** It finalizes down the SAME path
    a finish takes — one final edit, one terminal `agent_stream` frame — and ends as `done`,
    not `error`: the partial answer is real and the overlay tears down through `onSettled` /
    `forgetAgentRun` exactly as a normal finish does. `AgentStopped` (a typed marker on the
    run's error) is what tells the two apart, never a string match.
  - **The body keeps the partial and signs off** (`agent_policy::stopped_body`): the answer
    so far, a `— stopped by you` note, and the DONE signature LAST — because
    `agentAuthorship` reads authorship and settled-state off the TRAILING `<p><em>…</em></p>`
    (`web/src/lib/agent-message.ts`), so a note left last would leave the reply looking
    pending for ever (`agent-stalled`) or not an agent's at all. An empty partial (stopped
    while thinking) is the note over the signature alone — never the `thinking…` placeholder,
    which reads as live.
  - **The registry is per-PROCESS, and `stopped: false` says so honestly.** It holds only
    runs THIS backend owns; a run streaming on the other install (19422) is simply not in it,
    and the RPC answers `stopped: false` rather than pretending. No pid-signal fallback:
    killing by signal would trip `repair_abandoned_agent_runs` and post the wrong "backend
    restarted" body. The agent path is single-backend in the real deployment (a phone reaches
    19420 through the relay), so this is the normal case.
  - **The token is registered before the run starts and removed on every exit path**, beside
    `begin_agent_run` / `finish_agent_run` — a token left in the map would let `agent_stop`
    "stop" a run that already finished.
  - `web/mock/server.ts` reproduces it with no CLI (`mockAgentRunning` / `mockAgentStopped`,
    checked between steps in `simulateMockAgentRun`), so the whole surface is reviewable —
    `cd web && bun run preview -- --out /tmp/reply --agent-reply` captures the button in both
    themes, and `web/e2e/agent.spec.ts` pins that the overlay tears down and the reply is a
    settled agent message that kept the answer.
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

## The trackers are READ-ONLY, save what the USER clicks (MANDATORY)

The app enriches a tracker link pasted into a chat into a rich preview card
(`src/link_preview.rs`, over `src/gitlab.rs` and `src/linear.rs`), and it holds a whole
merge-request page (§ The GitLab page). Either card names its own person — a merge request's
author, an issue's assignee — as the colleague this app already knows, with their Teams face and
the name the user gave them: § A tracker user who is also a colleague, applied to the surface
most merge requests and issues are met on. It reads those trackers. It writes **seven** things
to GitLab and nothing else, ever — a merge request's approval (described at the end of this
section) plus the page's merge, comment, comment edit, comment deletion, thread resolution and
close — and each one happens on a click the user just made, never on its own. A comment is a
comment wherever it is written: one on a DIFF LINE (§ A comment on a diff LINE) is the same
write in another of GitLab's own shapes, not an eighth.

- **LINEAR IS READ-ONLY, with no exception at all.** Nothing in this app writes to it.
- **Never create, edit, assign, move or label an issue, a merge request or a project** —
  in either tracker. What IS written to GitLab is the seven actions above and nothing
  beyond them: a comment posted from here reaches everyone watching the merge request,
  under the user's name, and looks like they wrote it, which is why it is gated like a
  send and offered only from the page's own composer.
- The credentials carry the consent: a Linear personal API key has **full write
  access**, and a GitLab token has whatever scopes the user granted it. So nothing
  at the API level stops a write. What stops it is that **no code names a write**:
  `gitlab` issues GET requests only (`gitlab::tests::module_issues_only_get_requests`
  scans its source for every other verb), `linear` sends GraphQL **queries** only, and a
  test in `linear::tests` scans that module's own source for `mutation`. Do not
  weaken, skip, or work around either.
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
  Any FURTHER write to a tracker is a deliberate feature: its own consent gate, its own
  entry in `OUTWARD_METHODS`, its own write-lock coverage — never a quiet addition to
  the read path, and never an edit to `src/gitlab.rs`, `src/gitlab_mr.rs` or
  `src/linear.rs`. That is how the five that exist were built: the approval in
  `src/gitlab_approval.rs`, the page's four in `src/gitlab_mr_write.rs`, each in a module
  of its own with a test scanning the rest of the crate for its endpoints.

### The first write: approving a merge request

A message that names a merge request offers **Approve !42** in its own "…" menu, wearing
GitLab's own mark (`ApprovalAction` in `web/src/components/message-bubble.tsx`, over
`src/gitlab_approval.rs`). It is the single exception to everything above, it was built
as the deliberate feature the paragraph above demands, and six things hold it up:

- **It is REVERSIBLE, and that is why it was the FIRST one.** GitLab publishes `/approve`
  and `/unapprove`, so the row the app leaves behind is **Revoke approval** — the same call
  with `approved: false`. A write whose off switch cannot undo its on switch is refused
  here on principle: it is the reason `forceavailability` is banned in
  § The user's own status. Exactly one write in this app breaks that principle, on the
  user's own instruction — the MERGE on the page below — and it carries four rails in
  place of the undo it cannot have. An assignment, a label or a rebase still has neither,
  and none of them is here.
- **It is gated like a send.** `gitlab_set_approval` is an `OUTWARD_METHODS` entry — the
  write token, refused read-only — and the automation hook refuses a command line, an
  ad-hoc script or a cargo example that names the endpoint or a Linear `mutation`. There
  is **no sandbox project** and no pre-authorized merge request, so pinning a target
  cannot make a probe safe the way it can for a send: an approval against the real
  tracker is the user's own click and nothing else.
- **The write lives in its own module.** `src/gitlab.rs` stays GET-only and its own scan
  test says so; `gitlab_approval` names the two approval endpoints and no other verb, and
  a second test scans the whole crate to keep `/approve` out of every other file. The
  host pinning is unchanged, because the parse is still `gitlab::parse_url` — the token
  reaches one host, and one resource kind.
- **The user asks twice, and the row says what it costs.** The first select arms the
  second (the pattern Delete uses), and the sentence under it names the consequence:
  everybody watching the merge request is told, and a project rule may act on it.
- **The outcome is reported where the click was made.** The menu is HELD open for
  GitLab's own answer — approved, revoked, or the refusal sentence — for the reason
  § Sending messages gives for the composer: an outward action that failed must never be
  left looking like it worked, and the status line is eleven pixels at the foot of a
  sidebar. That line still carries the raw sentence too, for whoever reads a screenshot.
- **It is offered only where it would work.** The state is read first
  (`gitlab_approvals`, an ordinary read that also says whether the user's own approval is
  already on, matched on GitLab's user id and never on a display name), and no state means
  no row — not a merge request on the configured host, no token, or a project the token
  cannot see. A MERGED or closed merge request offers nothing either, since GitLab would
  only refuse.

`web/mock/server.ts` reproduces the whole flow with no GitLab and no token
(`mockApprovalResult`, plus the `{kind:"gitlab_approval"}` test hook for a refusal and for
a machine with no token — a spec MUST clear it afterwards). `cd web && bun run preview --
--out /tmp/mr --merge-request` captures the rows, the confirmation and the outcome, and
`web/e2e/merge-request.spec.ts` pins every rule above. **It has never been run against a
real GitLab project**: doing that is the user's own click, in their own app.

## The GitLab page (a sidebar of merge requests, and the six writes it offers)

The sidebar's fifth tab is GitLab: the merge requests that are **not merged**, and one of
them in full — its description, its live pipeline, its approvals, its comments — with the actions
GitLab's own page offers, and its **diff** on a full-screen page of its own (§ The DIFF is a PAGE).
One merge request is FOUR pages, named by a sub-header (§ The four PAGES of a merge request), and
one JOB of its pipeline is a fifth surface under them (§ A job's LOG is a page of its own).
`src/gitlab_mr.rs` holds every READ, `src/gitlab_mr_write.rs` the six writes,
`web/src/lib/gitlab-mr.ts` the pure decisions the surface is built from (`gitlab-diff.ts` the
diff's own, `gitlab-mr-pages.ts` the page set's, `gitlab-pipeline-graph.ts` the pipeline graph's,
and `gitlab-job-log.ts` a job log's), and `web/src/components/gitlab-sidebar.tsx` /
`gitlab-pane.tsx` draw it.

**The split between the two backend modules is the whole safety story**, and it is the one
in § The trackers: reading a tracker is what the feature is for, and writing to one is the
user's own click. The seven reads (`gitlab_mr_list`, `_detail`, `_notes`, `_pipeline`, `_diff`,
`_upload`, `_job_log`) are open like every other read; the six writes (`gitlab_mr_merge`, `_comment`,
`_edit_comment`, `_delete_comment`, `_resolve_thread`, `_set_state`) are `OUTWARD_METHODS`
entries — the write token, refused read-only, and the automation hook refuses a command line, a
script or a cargo example that names their endpoints. `_comment` covers three shapes of ONE act
— a comment of its own, a reply into a thread, and a thread on a DIFF LINE (§ A comment on a
diff LINE) — because they reach the same people and the same deletion undoes each.

**THE MERGE IS THE ONE ACTION IN THIS APP THAT NO LATER CALL TAKES BACK**, beside a message
deletion. § The trackers refuses an irreversible write on principle; this one exists because
the user asked for the page to do what GitLab's own does, and it carries four rails in place
of the undo it cannot have. Each is pinned by a test:

- **The head commit travels with it.** `sha` is required by
  `gitlab_mr_write::merge` and by the handler, and it is the commit the PAGE drew — GitLab
  answers `409` when it is not the branch's head, so a merge request that moved after the
  reader looked is refused rather than landed. Never send a freshly-read sha to "fix" a 409:
  that would merge exactly the commit nobody reviewed.
- **The user asks twice.** The first click arms; the second lands the branch, and the
  sentence under it names both branches and says no later click takes it back. Delete's own
  pattern.
- **It is offered only where GitLab would accept it.** `mergeVerdict` reads GitLab's own
  `detailed_merge_status`, and an UNKNOWN status is never a green light — a state this app
  has not heard of leaves the button disabled with GitLab's word on it, because "I do not
  recognise this" must never resolve to "go ahead".
- **The outcome is reported beside the button**, in GitLab's own words on a refusal
  (`gitlab-action-error`). An outward action that failed must never be left looking like it
  worked.

**The MERGE and the APPROVAL stand in the page's own HEADER**, at its right, before the reload
and the way out to GitLab (`MergeRequestActions` in `web/src/components/gitlab-pane.tsx`). They
are the two decisions a reader opens a merge request to make, so they are what the page states
first rather than what it states four panels down — and the header does not scroll, so the merge
is still there at the foot of a long conversation. Nothing about either gate moves with them:
they are the same two writes, behind the same write token, and each is drawn ONCE. What the move
costs is that a header row is wide enough for a control and never for a sentence, so five rules
hold it and `web/e2e/gitlab.spec.ts` pins each:

- **The WORDS stay in the article** (`ActionPanel`, still `gitlab-actions`): GitLab's reason for
  refusing before the press, what the armed press costs, and GitLab's own answer after it. That
  panel keeps the CLOSE too, because a close is what is left to do to a merge request rather
  than a decision the page is opened for.
- **The page brings those words to the reader at the two moments they are owed.** The press is
  made in a header that does not scroll, so the sentence explaining it may be a screen away: the
  panel scrolls ITSELF into view when the merge is armed and when GitLab has answered one of the
  panel's own writes — `nearest`, so nothing moves when the words are already readable, and
  never for a comment's failure, which is reported at the box the words are still in.
- **They are offered on the OVERVIEW alone.** Commits and Pipelines carry neither sentence, and
  an outward action must not be taken where its outcome cannot be reported. The other pages are
  one press away on the strip.
- **The armed press says what it costs ON the button** — the short spelling of it below `md`,
  where the same sentence stands under the page in full.
- **The row never widens the header.** The controls hold their width and the TITLE is what gives
  way (the lesson § A long TITLE already taught this page), and the approval's WORD goes below
  `sm` rather than the control: a phone's header already carries a back button, a title and two
  icons, and a label that squeezed the title to nothing would cost the reader which merge
  request they are on.

The other five are ordinary gated writes because each has an undo, on the same page: a comment
is deleted by `gitlab_mr_delete_comment`, a close is undone by a reopen, a resolution by opening
the thread again. **The EDIT is the one with an asterisk** — `gitlab_mr_edit_comment` can be
edited back, but the words that were there are gone, since GitLab keeps no history this API can
read. That is exactly where a Teams message edit sits (§ Sending messages: an edit rewrites, a
reaction toggles off, a deletion is final), so it is offered the same way: one press, on the
user's OWN comment only, checked against GitLab before the network like the deletion. Asking
twice for a rewrite while a message that reaches the same people asks once would teach the
reader that the dialog means nothing. Nine more rules hold the page together:

- **A comment is deleted or EDITED only when it is the USER'S OWN**, and whose it is comes
  from GitLab (`note.mine`, matched on the account's id) read BEFORE the write — not from what
  the client claimed. GitLab would let a maintainer rewrite or remove a colleague's note; this
  app never offers that, exactly as it refuses to delete a Teams message that is not the user's
  own. Both writes go through ONE check (`require_own_gitlab_note`), because a second copy of
  it is a second chance to get it wrong.
- **A RESOLUTION is offered only where GitLab would take one.** It marks the NOTES rather than
  the thread, so a thread is resolvABLE when any note is and RESOLVED when every one of those
  is (`threadResolution`, and `thread_is_resolved` on the answer) — reading `resolved` off the
  first note would call a thread settled while an objection under it still stands. A standalone
  comment carries no such state and GitLab answers `400`, so no control is drawn on one:
  measured over this instance, 207 threads are resolvable and 573 conversations are not.
- **A reply lands in the thread it answers.** `discussion_id` decides the endpoint, because
  a reply posted as a new comment lands in the wrong place and nothing reports it.
- **Nothing on this page is fetched FROM GITLAB by the browser.** Its `avatar_url` travels and
  nothing requests it — an avatar on a private instance answers 401 without a session — and
  the description and every comment go through the app's own markdown parser
  (`parseGitLabMarkdown`), never GitLab's rendered HTML, which would bring remote references
  with it. A real FACE **is** drawn, and it is a
  TEAMS read: it goes through the backend's own `fetch_avatar` like every other avatar in this
  app, it tells the GitLab instance nothing, and it is what § A GitLab user who is also a
  colleague is about. A PICTURE somebody pasted is drawn the same way — through the backend
  (§ A pasted PICTURE), which is the rule rather than an exception to it.
- **The list can never ask for merged merge requests.** `ListScope` and `ListState` are
  closed Rust sets and `merged` is not among them, so the page's whole promise is enforced by
  the type rather than by a filter somebody could widen.
- **A long DESCRIPTION opens FOLDED to eight lines, and the last three of them fade out.**
  Measured on the tenant, a description here is a whole document — a summary, a table of every
  ticket the branch closes, a fenced command line and a task list (see
  `examples/merge_request_markdown_recon.rs`) — and drawn whole it pushed the pipeline, the
  Merge button and the conversation off the first screen of every merge request anybody opened.
  `descriptionIsFoldable` and the three numbers above it are the pure half
  (`web/src/lib/gitlab-mr.ts`), and `web/e2e/gitlab.spec.ts` pins each rule:
  - **The window is a CONSTANT, and the first paint is already it.** Eight lines of the type
    this surface sets itself (`DESCRIPTION_FONT_PX` over `DESCRIPTION_LINE_HEIGHT`, set from
    those constants rather than from a class so the fold and the text it folds cannot
    disagree), held before the words are measured by a plain CSS clamp AT that height.
    Measuring first would draw the document and clip it a frame later, which is a jump the
    reader watches — and it would do it again on every open of the page.
  - **The fade sits INSIDE the eight**, over the last three, so a folded description reads as
    five clear lines running out rather than as eight lines cut off by a rule. It runs to the
    page's own background, and it is drawn only where there is something behind it.
  - **A description that is not really longer keeps NO control.** One that fits, and one that
    overruns by less than a single line, are both left whole: a click that reveals half a line
    from under a gradient covering three costs the reader more than it saves — the rule the
    split-layout toggle already follows, that a control which changes nothing reads as a bug.
  - **A PRESS is the only thing that moves this box.** The fold on mount is a STATE, and it used
    to be drawn as a movement: the box was held at the window by a CSS ceiling until the words
    were measured, and the measurement then lifted that ceiling and handed Motion the whole
    document's height to come down from — so opening a merge request played a collapse nobody
    asked for. It reached the user. Three things hold it shut, and `web/e2e/gitlab.spec.ts`
    measures the box on every frame of an open rather than trusting any of them: the height is
    animated only once the reader has pressed (`everPressed`), the ceiling is lifted only while
    a press is TRAVELLING (`animating`, given back by `onAnimationComplete`), and it is ON
    before anything is measured — which is what makes the first paint the window rather than the
    document. A description shorter than the window is clamped by nothing at any moment.
  - **The two states are ONE movement**, on the transcript panel's own curve (`FOLD_EASE`) with
    a close shorter than the open: the height carries it, the gradient and the label are quicker
    and led by it, and the chevron turns on the same curve. Two disclosures on one screen must
    not move at two different speeds.
  - **The DURATION is the distance, not a constant** (`descriptionFoldSeconds`, clamped between
    `FOLD_MIN_SECONDS` and `FOLD_MAX_SECONDS`). A description here is a whole document, and a
    fixed 0.26 s over a thousand pixels is 100 px a frame — a jump cut with an easing curve on
    it. Under `prefers-reduced-motion` there is no movement at all, which is the one state in
    which this control has no transition: a reader who sees an instant fold has asked for one.
  - **The control is CENTRED under the words it opens**, because it belongs to the whole width
    rather than to the first word of the line above it — and a control tucked against the left
    edge of somebody's document reads as part of the document.
  - **The fold is the reader's from then on.** Nothing re-folds a description they opened, and
    ANOTHER merge request opens folded: this pane is not re-created when the open merge request
    changes, so the description is keyed by it (`mergeRequestId`) — without that key a reader
    who opened one description found the next one already open.
- **An author who is also the ASSIGNEE is named once.** Most merge requests on this instance
  are written by the person they are assigned to, and the header spelled that one name twice a
  centimetre apart — `Author <Ada>  Assignees <Ada>` — which asks the reader to compare two
  chips to learn one fact and reads at a glance as two people. `mergeRequestPeopleLines`
  (`web/src/lib/gitlab-mr.ts`) decides which rows there are, the capture is
  `${out}-people-{light,authored-light,authored-dark}.png`, and `web/e2e/gitlab.spec.ts` pins
  each of the three rules:
  - **Whose the two accounts are is PROVEN** (`samePerson` in `lib/tracker-people.ts`): the
    handle GitLab keys the account on, then the mri this app keys a colleague on, and NEVER a
    display name — two colleagues may share one, and saying somebody assigned their own merge
    request when they did not is the wrong-face rule of `tracker_people` again.
  - **A SECOND assignee keeps both rows**, because merging them would then drop a name, and who
    else the work sits with is the whole fact an assignee row carries.
  - **REVIEWERS are untouched, whoever they are.** Authoring what one reviews is a different
    statement about a merge request, and GitLab lists the same person as both far less often.
- **A long TITLE is shortened by the header and wrapped by the page, and widens neither.** An
  author here writes the summary and then every ticket the branch closes, so a title runs to
  150 characters — and `truncate` shortens NOTHING while its container is free to grow: a
  flex item may not shrink below its own content, and a one-line title is one unbreakable
  line as wide as its words. The whole detail column grew to that width, which put the
  article, the Merge button and the reload off the right of the screen — on a phone, where
  that column is the only one there is, and on a desktop alike. The fix is `min-w-0` on the
  shell's `detail-pane` (`components/app.tsx`), which is the link ABOVE every pane: each pane
  already declares its own, so a long mail subject and a long chat title were one fixture
  away from the same failure. The heading below keeps the title in FULL over as many lines as
  it takes, with `break-words` for what a title carries besides words — a branch name, a URL,
  a bracketed list of tickets is one token, and a token wider than the article scrolls the
  page sideways. A fixture carries a title that length (!297), the capture is
  `${out}-long-title-{light,mobile-light}.png`, and `web/e2e/gitlab.spec.ts` measures the
  boxes against the WINDOW — on this page and on the diff's own header — because what broke
  was the geometry and only the geometry says it is mended.
- **The TAB wears the tanuki in two spellings, and the section's own state picks.** A section
  that merges under the user's GitLab account has to say GitLab (see `GitLabLogo`) — but this
  is the one place that mark stands in a row of the app's own glyphs, and a strip of tabs says
  which section is current. Full-colour at all times made GitLab the only lit tab of the five,
  which reads as the selected one. So the tanuki is GitLab's LINE at rest —
  `GitLabLogoOutline`, one `currentColor` stroke at the weight hugeicons draws, so it dims and
  hovers with its four neighbours — and GitLab's three fills once the section IS current,
  where every other tab takes the accent. Nothing is recoloured: the mark is either GitLab's
  or it is the app's own line, and there is no third, half-tinted spelling of it. The geometry
  is theirs in both — the outline is their own contour path, and only that one: the four
  creases their fills meet along cross in the middle of a 17px mark and read as bars over it.
  The two boxes are one size in one place, so the swap changes the ink and never the target.
  `web/e2e/gitlab.spec.ts` measures that.

### A tracker user who is also a colleague is drawn as the colleague

Most people on a merge request or a Linear issue are the user's own colleagues, and this app
already knows them: their Teams face, and the name the user themselves gave them (§ Renaming a
person). So a tracker's user is matched to a Teams person **by their real name**, and the
surface then draws that person — `src/tracker_people.rs` decides who somebody is,
`with_teams_people` in `src/bin/server.rs` puts the answer on every payload that carries
people, and `personFace` in `web/src/lib/tracker-people.ts` is the one place a surface reads it.

**Three surfaces, one rule.** The merge-request PAGE and its sidebar (a row's author, the
reviewers, every comment's author, whoever approved), the GitLab CARD in a chat, and the LINEAR
CARD — whose owner is whichever of `assignee` / `lead` / `creator` the resource has. Both cards
wear the same chip (`CardPerson` in `web/src/components/card-person.tsx`), because a GitLab card
naming its author one way and a Linear card naming its assignee another would be two answers to
"who is this?" in one thread. A card is where most people MEET a merge request or an issue in
this app, so a face there is the point rather than a decoration.

**The match is MEASURED, by `examples/gitlab_teams_people_recon.rs`** — READ-ONLY, over the
merge requests the token can see and the store's own people. Measured 2026-08-06 on
`git.sia.partners` against 12 603 stored messages naming 294 people: of the 26 people named on
200 merge requests, **18 resolve, 0 are ambiguous, 8 do not** — and all 8 of those are a GitLab
import's `Placeholder <name>` account. All 18 are spelled identically on both sides, because
this instance is provisioned from the same directory Teams is. Run it again rather than
widening the key on a hunch; what the numbers already refused is accent folding.

**LINEAR's half is not measured the same way, and it cannot be.** There is no "list every
issue" read in this app — `linear` enriches one link at a time — so nothing here can count a
workspace's people. What is known: Linear's `assignee { name displayName }` is the same
real-name/handle pair GitLab gives (its `name` on this workspace is the tenant's own spelling,
because Linear signs in through the same directory), and
`examples/linear_live_check.rs` now prints the verdict for any real issue URL it is passed —
READ-ONLY, the handle and the verdict, never a colleague's name. That is the honest check
available; do not write a number into this file that nothing measured.

Seven rules hold it, and each is pinned by a test:

- **The identity is only ever ADDED to what the tracker said.** Its own `name` and `username`
  travel untouched beside it, the handle stays in the chip's title on the page (it is how a
  colleague is found over there), and a person the store cannot name keeps the tracker's own
  words over tinted initials.
- **An AMBIGUOUS name names nobody**, and **only a PERSON is ever matched** (`8:…`, so a Teams
  app can never lend its face to a tracker account). The wrong face on a name is worse than no
  face — the rule § @mentions already applies to a mention.
- **What is compared is TEAMS' own name; what is DRAWN is the user's.** The roster is built
  from `Store::named_people` with no nickname applied, because what is being matched is two
  systems' record of one person — and the name the page shows then goes through
  `Store::display_name_for_mri`, so a rename wins here exactly as in a chat, and a custom
  avatar wins because `fetch_avatar` serves the override first.
- **It is stitched on at the ANSWER, never into the cache.** `gitlab_reads` keeps GitLab's own
  words (§ Performance); the identity is local and current, so freezing it on disk would
  outlive a rename. That is also why a rename re-reads the page from the backend's cache and
  asks GitLab nothing (`rereadGitLabPeople`).
- **One walk reaches every person, because there is ONE person type.**
  `tracker_people::Person` is it — `gitlab::Person` and `gitlab_mr::Person` are re-exports of
  that one struct, and `linear` fills the same shape from `name` / `displayName` — and the walk
  keys on the shape: an object carrying both a `name` and a `username`. So a row's author, a
  merge request's reviewers, every comment's author, whoever APPROVED, a GitLab card's author
  and a Linear card's owner are covered by one rule, and a field added later is covered too. A
  CI job has a name and no handle, and a Linear label has neither, so both are left alone. That
  is why `Approval.approved_by`, `gitlab::LinkMetadata.author` and Linear's three people carry
  people rather than the bare names they used to: one shape means one rule, and the sentence
  "Approved by …" would otherwise be the one place on this page that still names a renamed
  colleague by their old name.
- **A stale identity is REPLACED rather than kept**, so a payload that carried one from an
  earlier pass can never show a colleague under a name they no longer have.
- **The roster is cached for a minute** (`TEAMS_PEOPLE_TTL`), because building it reads every
  person this machine was ever told about and the page asks on every answer, pipeline poll
  included. What that minute costs is that a colleague whose FIRST stored message just arrived
  is a stranger for up to a minute; it costs nothing about a rename, since only the matching
  keys are cached.

`web/mock/server.ts` reproduces it with no tenant, no GitLab and no Linear
(`withMockTeamsPeople`, over the mock's own people): one colleague with a Teams photo, one
without, the user themselves, and Ada, Grace and a bot who are on the tracker only — so all four
shapes are on screen at once. `web/e2e/gitlab.spec.ts`, `gitlab-links.spec.ts` and
`linear-links.spec.ts` pin them, and `web/e2e/person-override.spec.ts` pins that a rename
reaches the page with no reload.

**The markdown is real GFM, and its subset is MEASURED rather than guessed**
(`web/src/lib/gitlab-markdown.ts`, over the shared inline scanner in `markdown-inline.ts`).
GitLab hands us what the author typed, and this app renders it — so the parser has to cover
what the authors on this instance write. `examples/merge_request_markdown_recon.rs` counts
that, READ-ONLY, over the 40 newest open merge requests (measured 2026-08-06: of the 36
descriptions with words in them, 32 hold a heading, 32 inline code, 29 emphasis, 28 a bullet,
24 a **table**, 19 a **fenced block**, 18 a task list, 16 a numbered item, 14 a thematic
break, 10 a nested bullet). It used to go through `parseCardMarkdown`, which makes ONE BLOCK
PER LINE — the right rule for a card, which arrives pre-flattened, and the wrong one here: a
heading kept its hashes, a table came out as a wall of pipes with its `|---|` row silently
dropped, a fenced block became one paragraph per line with the markdown inside it parsed, and
a `---` disappeared. Four things follow, and each is pinned by a test:

- **The inline half is shared, the block half is not** (`markdown-inline.ts`, used by both
  `card-markdown.ts` and `gitlab-markdown.ts`). What `**bold**` and `[label](url)` mean is
  the same everywhere; how a line becomes a block is exactly what these two surfaces disagree
  about. Two copies of the emphasis scanner would drift apart at the first `snake_case`
  somebody reports.
- **The three constructs measured at ZERO decide as much as the others.** Indented code is
  NOT a block — every four-space line in that sample was a list item's own continuation or
  the inside of a fence, so the rule would draw sub-bullets as grey slabs and no author asked
  for it; raw HTML and an HTML comment stay the author's literal text, because parsing HTML
  here would be the second renderer this page exists to avoid. Do not add a rule the recon
  cannot find an author for — run it again instead.
- **A list's content is parsed by the same function**, which is what makes a sub-list, or a
  fence inside a bullet, work with no rule apiece. A task list's state is a glyph in the
  item's own words (`☑`/`☐`): the renderer has no checkbox, and a description here is read,
  never ticked.
- **The description names itself** (`data-testid="gitlab-description"`) and carries `min-w-0`,
  so a wide table and a long fenced line scroll INSIDE it. Without that the article widens
  and takes the page's own controls off a phone's screen — `bun run preview -- --out /tmp/mr
  --gitlab` captures it at 390px for that reason.

### A pasted PICTURE is drawn, and its bytes come through the backend

An author pastes a screenshot into a description or a comment and GitLab writes
`![image.png](/uploads/<secret>/image.png){width=777 height=312}`. The page used to print that
whole line as TEXT — a relative address is not a link a browser could follow, so the parser left
it the characters it is — which made the most useful part of a review invisible. It is a picture
now: `web/src/lib/gitlab-upload.ts` decides WHICH upload one is, `gitlab_mr::fetch_upload` gets
the bytes, and `web/src/components/gitlab-image.tsx` draws them through the chat image's own
component, so the loading box, the failure sentence and the lightbox are the ones this app
already has.

**It is the sixth READ and nothing more** — no gate of its own, because it publishes nothing and
writes nothing (`gitlab_mr_upload`, open like every other read of this page). What it needed
instead is the measured fact, and `examples/merge_request_image_recon.rs` is where every rule
below comes from — READ-ONLY, over the 40 newest open merge requests, printing counts, statuses
and shapes and never an upload path, because a path IS the whole authorization to read that file:

    cargo run --example merge_request_image_recon

Measured 2026-08-06 on `git.sia.partners` (18.6.4-ee), and each rule is pinned by a test:

- **The bytes come from GitLab's own API route, and from nothing else.** The web path the
  markdown writes answers **404** three ways — the `PRIVATE-TOKEN` header, `?private_token=`,
  and no credential at all — while `GET /api/v4/projects/:id/uploads/:secret/:filename` answers
  200 with the picture (104 KB at 777x312, and the attribute block claimed exactly that). So
  the browser could never have drawn it whatever this app did, and a request built from the
  markdown's own address would be a broken picture on every merge request that carries one.
- **The upload is named by PRIMITIVES**, never by a URL a client assembled: the project,
  GitLab's own secret, the filename (`gitlab_mr::UploadRef::parse` checks each part — a hex
  secret, and a filename that is one path segment). The endpoint is spelled from
  `gitlab::api_base`, so the token still reaches one host, and no client can aim it at
  something other than one upload of one project. It is the rail `gitlab_diff_anchor` already
  holds for a comment's position.
- **The bytes must SNIFF as a raster image** (`sender_icon::image_kind`, never SVG) under a cap
  (`MAX_UPLOAD_BYTES`, the composer's own per-picture ceiling, checked against the length GitLab
  publishes before the bytes are read). This instance answers an upload
  `application/octet-stream`, so the claimed type says nothing at all.
- **An image on somebody ELSE's host stays a LINK.** Measured: every image in a description was
  a project upload, and every image in a comment was an absolute URL elsewhere — a badge, a
  screenshot host. Fetching one would tell that host the user read this page, which is the read
  receipt § Mail strips out of every body. The rule is the parser's
  (`markdown-inline.ts`): an image becomes a picture only where the caller can name one whose
  bytes come through the backend, and a card passes no resolver at all, so a connector card's
  images are links exactly as before.
- **GitLab's `{width=… height=…}` block is CONSUMED, and it holds the picture's room.** Printed,
  it reads as something the author typed beside their screenshot; used, it is what stops the
  words around a picture from moving when the bytes land. A value this app cannot turn into
  pixels — a percentage, a unit — is dropped rather than guessed at.
- **A picture that cannot be read costs the PICTURE and nothing else.** The words around it stay
  drawn and the failure names the file, which is the contract the diff's own failure already
  holds. `parseGitLabMarkdown` also keeps one out of a fence and out of an inline code span, exactly
  as it keeps a heading's hashes out of them.

`web/mock/server.ts` reproduces the whole flow with no GitLab and no token (`mockUploads`, which
draws a real PNG at the size the markdown claims, plus `refuse_upload` on the `{kind:"gitlab_mr"}`
hook — a spec MUST clear it). `cd web && bun run preview -- --out /tmp/mr --gitlab` captures the
picture in a description in both themes and the comment that carries one beside a link, and
`web/e2e/gitlab.spec.ts` pins every rule above. **The READ is verified live through this app's own
function**: the recon's fifth attempt is `gitlab_mr::fetch_upload` itself, and on 2026-08-06 it
answered `image/png · 104 097 bytes · 777x312` for a real description's screenshot. What is still
untested is the pairing — one open of a real merge request in the user's own app, where the page
asks for that picture over the socket.

**Performance is a durable cache plus one live read**, and three measured facts shaped it:

- **`gitlab_reads` is a response cache in SQLite** (schema v14). Every read answers from it
  at once and refreshes behind the page — stale-while-revalidate — so a re-opened merge
  request paints from disk and the fresh copy arrives on a `gitlab_mr_updated` event. The
  window is per KIND, by what a stale answer costs: 60 s for the list, 30 s for the detail
  and the comments, **5 s for the pipeline** and **120 s for the diff** (the longest, because a
  diff moves only when somebody pushes and it is the biggest read). A write drops every read of
  the merge request it changed, through the one prefix they share (`gitlab_mr::cache_prefix`).
- **Refreshes are single-flight** (`Ctx::gitlab_refreshing`). A page polls its pipeline while
  CI runs and two open pages poll the same one; without it, one merge request under two
  readers would ask GitLab twice a second and earn the token a rate limit.
- **The LIST endpoint carries no pipeline.** Measured on this tenant: no `head_pipeline` and
  no `pipeline` on a row of `GET /merge_requests`, so a badge per row would cost one request
  per merge request — 109 on the first screen. The row states `detailed_merge_status`
  instead, which IS on the row and is what GitLab's own merge button reads. Do not "fix" the
  missing badge by fetching per row.
- **`scope=all` is what makes it a dashboard.** GitLab's default is `created_by_me`, and
  measured here that is 12 rows and one author against 109 rows and 25 authors. A page that
  forgot it looks like a page with a bug in its query.
- **The live pipeline poll is armed only while something is in flight** (`pipelineIsLive`,
  which reads the JOBS too — GitLab reports a pipeline `success` while a job allowed to fail
  still runs) and it stops when the page closes, so a page nobody is looking at asks GitLab
  nothing. Its interval (6 s) sits ABOVE the backend's 5 s window on purpose: below it, every
  poll would be served the same cached answer and the panel would look frozen.

### The four PAGES of a merge request (a sub-header, and one that holds nothing yet)

One merge request is four surfaces, exactly as GitLab's own is: **Overview**, **Commits**,
**Pipelines**, **Diffs** — named by a sub-header under the header that says WHICH merge
request. `web/src/lib/gitlab-mr-pages.ts` holds the set and every pure fact about it,
`web/src/components/gitlab-mr-pages.tsx` draws the strip and the page that holds nothing, and
the four routes are the files under `web/src/routes/_app.mr.$mergeRequestId*`. **Pipelines is
the pipeline GRAPH** (§ The pipeline is a GRAPH); COMMITS is deliberately empty today, which is
the shape this strip was built for — the strip and the routes came first, so the reads are added
one page at a time without moving anything the reader has learned. Six rules hold it, and
`web/e2e/gitlab.spec.ts` pins each:

- **Every page is a ROUTE, never a piece of state.** Three things follow and none is available
  to a `useState`: a page survives a reload, it can be sent to a colleague, and the browser's
  own Back leaves it. That is the rule the diff already earned its own route with, applied to
  all four — so `/mr/<id>` IS the Overview, and the other three hang off it.
- **The strip is on ALL FOUR, the full-screen diff included** — and on a JOB's log, which hangs
  under Pipelines and keeps it current (§ A job's LOG is a page). A sub-header that named the
  pages of a merge request and then vanished on one of them would leave the reader with a Back
  button where they wanted a Commits tab. It is one component drawn everywhere, so there is one
  spelling of the four routes.
- **It is drawn as soon as a merge request is OPEN, before its detail arrives.** The URL
  already says which merge request the pages belong to, and a strip that waited on a read
  would trap the reader on the page they are waiting on.
- **All four are offered whatever a read answered.** A tab is where the reader goes rather
  than an invitation into content, so a strip whose shape changed per merge request would move
  the target between two of them — and what a page could not read, that page says (the diff's
  own failure already does). The `ChangesPanel`'s "Review the changes" keeps the opposite rule,
  because THAT one is a press into content.
- **A page that holds nothing SAYS so, and offers GitLab's own for it**
  (`unbuiltMergeRequestPage`, `gitlabPageUrl` — built from the merge request's own `web_url`,
  never from the configured host and an assembled path). Drawn blank it would read as a read
  that failed. Only COMMITS says it today, and the sentence names the page rather than the app:
  a reader is told what is missing, not that something went wrong.
- **It IS the app's own `Tabs` primitive, and the tabs stand in the sub-header rather than in
  a CARD** (`TabsList surface={false}`). A card floating inside a header row is two nested
  surfaces for one thing, and the row already has its own bottom border. It is a PROP of the
  primitive rather than a className the caller overrides, for two reasons: `shadow-chip` and
  `shadow-none` both survive tailwind-merge — a project shadow is not a name it can resolve —
  so the class list would carry a contradiction; and the choice decides how the CURRENT tab is
  drawn as well, which is why it travels to the trigger by context. Inside a card the selected
  tab is a raised tile (`bg-background` plus the shadow); with no card it is the accent wash,
  because a raised tile needs something to be raised from. The row SCROLLS sideways rather
  than widening: four labels are wider than a 320 px phone, and a header that grows past its
  column takes the page's own controls off the right of the screen (the lesson the long title
  already taught this page).
- **`aria-controls` is kept TRUE, which is what using the primitive costs.** Every trigger
  names a panel, so the CONTENT of each page carries that id (`mergeRequestPagePanel`, over
  the constant base id both halves share) — the Overview's scroller, the Pipelines graph, the
  page that holds nothing, and whatever the diff page can draw. It resolves inside one
  document on all four, because
  each page draws its own strip beside its own content, and a unit test pins the two spellings
  together. A dangling `aria-controls` is what a `nav` of buttons was chosen to avoid before
  the primitive was; wiring the panel is the better answer.

`cd web && bun run preview -- --out /tmp/mr --gitlab` captures the strip in both themes, the
page that holds nothing, and the strip at a phone's width (`openMergeRequestPage` is its
helper); the Pipelines one has its own capture under § The pipeline is a GRAPH.

### The DIFF is a PAGE of its own (`/mr/<id>/diff`)

The diff takes the WHOLE screen: the changed files down an inner left sidebar, and every one of
them read on the right as one FEED. It is the one part of this app drawn by somebody else's
renderer — **`@pierre/trees`** for the tree ([trees.software](https://trees.software)) and
**`@pierre/diffs`** for the patches ([diffs.com](https://diffs.com), Shiki underneath) — and the
seam is where all the care is. `src/gitlab_mr.rs` holds the read and WRITES the patch,
`web/src/lib/gitlab-diff.ts` every pure decision, `web/src/components/gitlab-diff-page.tsx` the
page, `gitlab-changes.tsx` the one-line summary and the way in on the merge request above it,
and `gitlab-diff-view.tsx` the whole of this app's contact with either package.

**A review is READ BY SCROLLING, and the tree says where the reader is.** The right column holds
every changed file one after another — GitLab's own shape — because a reviewer's question is "what
does this branch do", which is answered by reading the files in order rather than by pressing a
row for each. The two columns are a PAIR, and the two directions between them are what make it
one: the row of the file at the top of the feed is lit (`activeDiffFeedFile`, over the renderer's
own measured layout), and a press on a row brings that file to the top at once. Neither fetches
anything — the whole diff arrives with the merge request, so a press is a scroll. The one
exception to "the file at the top" is the file the reader ASKED for while the feed is pinned at
its END: the last screenful holds several files and the scroll runs out before any of them
reaches the top, so without it a press on any but one of them would light a row nobody pressed.
Six rules hold the pair, and `web/e2e/gitlab.spec.ts` pins each:

- **The FEED is the vendor's own `CodeView`, and choosing it over a virtualizer of this app's is
  the whole design decision.** The room a file needs cannot be known before that file is
  highlighted, which is what makes a hand-rolled virtual list wrong here: it would reserve a
  guessed height, mount the file, measure it, and correct the scroll under the reader, once per
  file, for 149 files. `CodeView` was built for this list — it reserves room from the line counts
  its own parser read, mounts only what the viewport can hold, pools the elements it unmounts,
  anchors the scroll while a measurement corrects a row above, and pre-warms the highlighter of a
  file somebody jumped to. What stays this app's is the MEANING: which file the reader is at, and
  when an item has really changed. The metrics it reserves room WITH are app.css's own
  (`DIFF_FEED_METRICS`, measured against the rendered rows) — a stylesheet that changed the type
  and left them behind would have every file measure differently from its estimate, and the
  scrollbar would jump under the reader.
- **A file with NO patch is still IN the feed** — a binary file, one GitLab collapsed. The tree
  lists it, so a feed that skipped it would make the tree lie about where the reader is. It
  becomes an item with no hunks, which is exactly what pierre's own parser returns for a pure
  rename, and its header states why there is nothing under it (`FileHeaderNote`, in the
  `renderHeaderMetadata` slot). Nothing here invents a patch to draw one with: writing git's own
  header is the backend's job and happens in exactly one place.
- **A REFLECTION is not a press, and in a feed that rule earns its keep every few seconds.** The
  tree reports the row lighting itself and the row a reader pressed through one callback, so the
  two are told apart by what the report SAYS: a press names exactly one row, and never the row
  the page already says is current. Read wrong, the row lighting itself as the reader scrolled
  came back as a press and threw them to the top of the diff every few files — and before that it
  made the page unreachable on a phone (Back showed the files, mounting the tree reflected the
  selection, and the patch took the screen again in the same frame). Exactly ONE row is lit, which
  is why the old one is deselected first: the item's own `select()` ADDS, and an accumulating
  selection is what reported that stale first path.
- **An item is handed to the renderer again only when that file really CHANGED**
  (`diffFeedVersions`, over `sameDiffFile`). Both halves of that bargain were got wrong once: a
  version that does not move when the file did left the expanded read drawing the sentence that
  stood in for the code, and a version that moves for nothing hands the renderer all 149 files
  again — for one comment box, or for a background read that changed nothing. Every read is fresh
  JSON several times a minute, so the comparison is by CONTENT.
- **The feed is put where it opens once the renderer has DRAWN something** (`onPostRender`), at
  the file the reader was last at on this merge request — and never at the first file, because a
  feed already opens there. A programmatic scroll is HELD by the renderer until it can carry it
  out, so one asked for too early is applied against a layout nothing has measured, and the
  correction that follows puts the reader back at the top: a press that looks like it did nothing.
- **A comment being written STAYS where its code is.** The reader never leaves a file in a feed,
  so pressing another row moves the feed and leaves the box under the line it is about, with the
  words still in it. It used to be thrown away, which was right while the page drew one file at a
  time and would now cost a half-written comment to a scroll.

**It is a page rather than a panel, and that shape is the point.** The diff was a section inside
the merge request's scrolling article first, and that was wrong twice over: a 149-file tree and a
900-line patch have no room inside a column that also carries a description, a pipeline, the
actions and a conversation — and it put Shiki on the path of every merge request anybody opened,
whether or not they meant to read code. Five rules follow, and `web/e2e/gitlab.spec.ts` pins
each:

- **A ROUTE, never a piece of state** (`routes/_app.mr.$mergeRequestId.diff.tsx`, which makes the
  merge-request route a layout with an `index` and a `diff` child). Three things come with the
  URL and none is available to a `useState`: it survives a reload, it can be sent to a colleague,
  and the browser's own Back leaves it. The shell draws it INSTEAD of the sidebar and the pane
  (`onDiffRoute` in `components/app.tsx`) rather than over them, so there is no overlay to
  dismiss and no third column competing with its own two.
- **Each column scrolls ITSELF, and the page never scrolls.** The header stays, the tree keeps
  its place while the feed is read, and a file picked after ten minutes of scrolling does not put
  the reader back at the top of anything. That is what the `h-full` / `min-h-0` chain down both
  columns is for.
- **A narrow screen is ONE column at a time** (`diffPageColumns`, at the app's own `md`
  breakpoint): the files, then the feed, with the header's own Back between them — the
  list-then-detail shape every other surface in this app takes below `md`. It OPENS on the files,
  because that is the question a diff asks first. Narrowing a window mid-read keeps the FEED,
  because taking away what somebody is reading is the one thing a resize must not do.
- **ONE header names each file, and it is pierre's.** Theirs is inside the scroller and STICKY,
  which in a feed is what says whose code is under the reader's eye — and it already shows both
  names of a renamed file. The first capture of this page had two headers three centimetres apart
  saying the same thing, so this app draws none of its own: what theirs cannot know goes into the
  `renderHeaderMetadata` slot they publish for it (the REACT prop — the `options` key of that name
  returns a DOM node), which is GitLab's own `generated_file`, why a file has no code under it,
  and WHICH file the item is (the element carries no path, and these slots are its own light-DOM
  children, so it is the only place that can say). `disableFileHeader: true` was tried the other
  way round and collapses their container to nothing.
- **The PANE states which file the reader is AT** (`data-path` on `gitlab-diff-pane`) — the one
  at the top of the feed, whose row the tree has lit. One place to read "where am I" from — the
  sentinel discipline the composer already follows for its conversation, and what every test and
  capture waits on. Each file's own header carries the same answer for itself
  (`gitlab-diff-file[data-path]`), which is what scopes a line number to one file.

**Every fact below was measured against the real instance** by
`examples/merge_request_diff_recon.rs` — READ-ONLY, over 508 files on the 25 newest open merge
requests, printing counts and shapes and never anybody's code:

    cargo run --example merge_request_diff_recon

- **GitLab's own `diff` opens at `@@`.** No `diff --git`, no `--- a/…`, no `+++ b/…` — on all
  338 rows that carried hunks. A patch renderer reads the FILE out of that header, so
  `gitlab_mr::unified_patch` writes one from the row's own `old_path` / `new_path` / modes /
  flags, and only the hunks are GitLab's text. Measured back: 356 of 356 patches that travel
  open with the header this app wrote. `unidiff=true` gives `--- / +++` and was rejected — it
  still writes no `rename from`, which is the one thing a pure rename has to say.
- **A pure RENAME carries no diff at all**, and GitLab sets `collapsed: true` on those rows
  anyway. Reading that as an elision reported every moved file as one GitLab refused to expand,
  so `renamed` wins over `collapsed` on BOTH sides — in `diff_file_from_json` and again in
  `diffFileState`, because a payload from an older backend must not draw it either. 18 of 508.
- **The COLLAPSE is a property of the merge request, never of the page.** The same 96 of 149
  files came back collapsed at every `per_page` from 10 to 100, and the expanded bytes were
  174 703 every time: GitLab expands a diff collection up to a byte budget and collapses the
  rest. **Paging is not the way out** — do not "fix" a collapsed file by asking for a smaller
  page. `access_raw_diffs=true` IS, and only on the older `/changes`: `/diffs` ignores the
  parameter (measured, byte for byte). That read is `DiffDepth::Raw`, it expanded 142 of those
  149 in one **523 KB** answer, and it is therefore the READER'S OWN ASK — `canExpandDiff`
  offers it once, `expandDiffHint` names the cost before the press, and it is never the
  default. The row shape of the two endpoints is IDENTICAL (`a_mode b_mode collapsed
  deleted_file diff generated_file new_file new_path old_path renamed_file too_large`, on all
  149 and all 508), which is what lets one parser serve both.
- **A BINARY file carries a one-line marker** (`Binary files a/… and /dev/null differ`) rather
  than hunks. It is STATED; running GitLab's prose through a code renderer would draw it as
  somebody's code. 4 of 508.

So four of the five states a file arrives in have NO patch, and each says something different
because the reader's next move differs. That is `diffFileState`, and it is why the section's
decisions are pure and testable without loading a megabyte of highlighter to make them.

Seven more rules hold the RENDERERS, and `web/e2e/gitlab.spec.ts` pins each:

- **The renderer is a LAZY chunk, and that is load-bearing.** `@pierre/diffs` carries Shiki,
  which resolves a TextMate grammar per language as a dynamic import — measured at a 728 KB
  chunk of its own plus one per language, and **+3.9 MiB gzipped on the release asset** (which
  the launcher embeds, so it is on every in-app update). It must never sit on the path of a
  chat: `gitlab-diff-view.tsx` is reached only through `lazy(() => import(…))`, exactly as the
  emoji picker is. The grammars are worth their room — a review surface that drew an unlisted
  language as plain text would fail silently on the file somebody needed.
- **Both packages render into a SHADOW ROOT**, so their internals cannot be styled from
  app.css and are not meant to be: each publishes a `--diffs-*` / `--trees-*` property per
  colour and app.css maps the surfaces onto this app's tokens. What stays THEIRS is the syntax
  palette (`pierre-light` / `pierre-dark`, from `@pierre/theme`, which ships with the renderer)
  and the git status tint per row — that is a colour vocabulary, not a surface.
- **The theme is passed EXPLICITLY, never sniffed.** Both resolve `light-dark()` from the used
  `color-scheme`, and their own `:host` leaves it at `light dark` — which follows the OS rather
  than this app's appearance setting, so a reader whose OS is dark and whose app is light got a
  black diff in a white page. `themeType` carries the app's resolved theme to the highlighter,
  and app.css pins `color-scheme` on both hosts (an outer-tree rule beats `:host`). It is the
  mistake the update button's orb already made once.
- **The GLYPHS are this app's own** (`web/src/lib/tree-icons.ts`). Pierre ships a coloured
  file-type icon pack and it is a second icon set — a different grid at a different weight,
  three centimetres from this app's own tab strip, which is what § Project shape bans. So
  hugeicons' data is serialized into the sprite pierre injects into its shadow root, under
  **this app's own symbol ids**: pierre PREPENDS its built-in sprite and a `<use href="#id">`
  takes the first match, so a sprite reusing their four ids loses to theirs every time (it did,
  and the capture showed it). `set: "none"` and `colored: false` are both needed too. The
  chevron is the DOWN one, because pierre rotates it `-90deg` on a collapsed row.
- **The tree model is created ONCE and mutated.** A new diff — the expanded read, another merge
  request — is `resetPaths` + `setGitStatus` on the one model, which is what keeps the reader's
  folds and their scroll position across it. It virtualizes its rows, so it measures its own box
  before drawing any: a box with only a `max-height` measures zero, which drew an empty column
  the width of a tree. On the page it takes `h-full` and the COLUMN bounds it.
- **A narrow screen is always UNIFIED** (`effectiveDiffLayout`, `SPLIT_MIN_WIDTH`). Split needs
  two columns of code and this app is read from a phone, where 390px is two columns of eight
  characters. The preference is kept and persisted per browser; it simply cannot apply there,
  and the toggle is not drawn at all — a control that changes nothing reads as a bug.
- **A diff that cannot be read costs the Changes PANEL and nothing else** on the merge request —
  the contract the comments already hold — and no press is offered into an empty page. On the diff
  page itself the failure IS the whole screen, because there is no other content to fall back on,
  and it offers the one thing left. The way out to GitLab's own `/diffs` stays whatever this app
  can draw: a file GitLab will not expand, a merge request past 100 files and a review comment on
  a line the page does not show are all reasons a reader still wants theirs.

The READ still happens with the merge request, as a fifth parallel read, even though the diff is
a page away: the summary needs it to say "7 files · +27 −10", and the press then opens a page that
paints at once rather than one that starts by waiting. It is cached for 120 s
(`GITLAB_DIFF_TTL`, the longest window on the page: a diff moves only when somebody pushes, and
it is the biggest read), under the merge request's own prefix so a write forgets it, and per
DEPTH so the expanded answer a reader paid for is never replaced by the plain one.

A `DiffNote` still keeps the file and line it hangs on (`note.position`), and the merge-request
page names that file — so a comment on a line the diff does not show is never one about nothing.

`web/mock/server.ts` reproduces every state with no GitLab and no token (`mockDiffFiles`,
which holds a patch, a pure rename, a binary file, a file GitLab collapsed and a generated one
over several languages, plus `refuse_diff` on the `{kind:"gitlab_mr"}` hook — a spec MUST clear
it). `cd web && bun run preview -- --out /tmp/diff --diff` captures the way in on the merge
request, the page in both themes, the split layout, the feed SCROLLED with the tree's lit row
following it, all three files with no patch, the expand control and what it hands over, and both
of its columns at a phone's width. **No diff has been rendered from the real instance yet**:
the reads are measured (above) and the surface is pinned against the mock, so what is untested
is the pairing — one open of a real merge request in the user's own app.

**The four page READS are verified against the real instance**, by
`examples/merge_request_page_recon.rs` — which is READ-ONLY, reads the host and token out of
the app's own store, and prints counts and field presence rather than anybody's words (the
fifth, the diff, has a recon of its own — see § The DIFF):

    cargo run --example merge_request_page_recon

Measured 2026-08-06 on `git.sia.partners`: 109 open merge requests (100 asked for, so the
truncation notice is a real state), 929 closed, 21 authors under `scope=all` against 12 under
`scope=mine`, a detail carrying its `sha` and `detailed_merge_status`, and a head pipeline of
15 jobs over 5 stages. Run it again when a parse changes; it re-measures the three facts
above rather than trusting this paragraph.

`web/mock/server.ts` reproduces the whole flow with no GitLab and no token — including a
pipeline that advances one step per read, which is what makes "the panel follows the run"
watchable — and the `{kind:"gitlab_mr"}` test hook arms a refusal, a machine with no token,
and the reset a spec MUST call afterwards. `cd web && bun run preview -- --out /tmp/mr
--gitlab` captures the tab strip in both of its states (pass `--dpr 4`: the tanuki is 17px),
the list, the page, its HEADER cropped in both themes — where the approval and the merge stand —
the merge armed and that header armed in both themes, the comments, the description folded in
both themes and opened, the description at a phone's width, a 150-character title at both widths,
the people rows in both of their shapes and a blocked merge in both themes;
`web/e2e/gitlab.spec.ts` pins every rule above. **No WRITE on this page has ever
run against a real GitLab project**: there is no sandbox project to aim one at, so doing that
is the user's own click, in their own app.

### The pipeline is a GRAPH, and it is the Pipelines page (`/mr/<id>/pipelines`)

A pipeline is drawn the way GitLab's own page draws it: columns of job cards with a curve from
each job to the ones that wait for it. The Overview holds a compact one — a LOOK at the run,
with the press that opens the page — and **the Pipelines page** (§ The four PAGES) holds the one
a reader works in, drawn in the pane under the header that names the merge request and the
sub-header that names its pages. So the page draws no header of its own: a third row saying
either would be this app stating one thing twice.
`web/src/lib/gitlab-pipeline-graph.ts` holds every pure decision (which card is in which
column, which cards a curve joins, what pointing at one answers),
`web/src/components/gitlab-pipeline-graph.tsx` draws it, `gitlab-pipeline-page.tsx` is the page,
and the panel's half is `PipelinePanel` in `gitlab-pane.tsx`.

It replaced a list of stages with the jobs under each. What that shape cannot say is the one
thing a reader of a red pipeline asks — WHICH job is holding the rest up — because a list has no
room for the dependencies between its rows.

**THE STAGE ORDER IS NOT THE ANSWER'S ORDER**, and reading it as one shipped a graph that drew
every real pipeline backwards. GitLab's jobs endpoint answers NEWEST FIRST — measured on this
instance: of 25 merge requests, 16 came back in reverse stage order and the other 9 had a single
stage — so `install` was drawn last, after the tests that wait for it. Three things follow, and
each is pinned by a test:

- **The order is READ, over the same GraphQL query as the `needs`** (`PipelineShape.stages`,
  travelling as `PipelineView.stages`). GraphQL named the stages on all 25.
- **Nothing else trusts the order the jobs arrive in.** `pipelineStages` groups by name and
  `pipelineGraph` sorts the jobs by id ONCE at the top, because the same reversal also laid every
  column out newest-first and resolved a retried job's name to the run it replaced. The fallback,
  for a GitLab whose GraphQL could not be read, is ascending id — a pipeline's jobs are created
  stage by stage, so creation order IS stage order, except across a retry, which is the one case
  `stages` answers correctly.
- **The MOCK answers newest first too.** It used to answer in stage order, which is the one way it
  could have hidden this: every test passed while the tenant drew backwards. A fixture that is
  tidier than the real answer is a fixture that lies.

**FOUR COLOURS, and they are a closed vocabulary** (`PipelineTone`, `jobTone`, `jobsTone` in
`web/src/lib/gitlab-mr.ts`): **green** when the work is done, **red** when it failed and somebody
has to fix it, **ORANGE** for a failure nobody has to fix (a job GitLab reports `failed` with
`allow_failure` set — and the stage, column or pipeline that carries one), and **neutral** for
everything not finished, which is most states GitLab has. `running` is a fifth NAME and not a
fifth colour: it takes the neutral ink and says it is moving with MOTION, because a fifth hue in
a wall of cards would cost the three that mean something their meaning. Two rules travel with
it: a group's tone is `jobsTone` — one rule for a stage, a column and a whole pipeline, so a
reader never learns two, and RUNNING still wins over everything in it because the group has not
finished having its say; and the badge over a run reads the JOBS beside the status, since GitLab
calls a pipeline `success` while a job allowed to fail sits red inside it and flat green over a
red job is the one thing it must not say.

**Colour is never the only signal.** Every card carries its own glyph and states its status or
its duration in words, every dot names its tone in its `title`, an allowed failure says so on
the card, and the page's legend spells out the tones that run really holds — only those, because
a legend naming four states when the run has two is a legend nobody reads. The glyph is chosen
from the STATUS rather than the tone, so only a job that is really `running` turns: `running` as
a tone means "worth polling" and covers a job that has not started, and a spinner on one of
those says something false. A `manual` job wears the play mark it is started with, and a
`skipped` one the mark of something that will never run.

**The dependencies are a fact about the pipeline, not about the grouping**, which is why there
are two controls and not one. `Group by Stage | Dependencies` decides the COLUMNS —
`stage` is GitLab's own order, `needs` is dependency DEPTH, where a job sits one column right of
the deepest job it waits for — and `Show dependencies` decides whether the curves are drawn. So
"grouped by stage, with the dependencies lit" is a reading a stage view cannot otherwise give.
The dependency grouping is what a pipeline that declares one OPENS on (`defaultGrouping`): that
is the shape its author wrote, and a stage view flattens it away — `🤖 opencode review` in the
`test` stage waiting for nothing starts with the lint rather than after it. The grouping is
deliberately NOT remembered across merge requests: a preference kept from another one would open
this pipeline on a mode it may not even have.

Eight rules hold the surface, and `web/e2e/gitlab.spec.ts` pins each:

- **A ROUTE, never a piece of state** — the rule all four pages hold. It survives a reload, it
  can be sent to whoever is asking why CI is red, and the browser's own Back leaves it. It is
  reached from the strip and from the Overview's own press, and both land on the one URL: a
  second address for one surface is a second thing to keep in step.
- **The GEOMETRY is measured, never computed** (`useEdgePaths`). A card's height depends on the
  font, the length of the job's own name and the width the reader gave the window, so the SVG
  sits inside the scrolling content, sized to it, and every path is re-derived off the cards'
  real boxes whenever anything moves (`ResizeObserver` on the scroller AND on the cards). A
  layout that predicted those boxes would be a second opinion about where a card is, and the
  wrong one on the first long job name.
- **It scrolls SIDEWAYS, and the page around it never scrolls.** Measured on this tenant: 4
  columns deep by dependency, 8 stages wide by stage. A graph that widened its container would
  take a phone's whole layout — the sub-header and the controls included — off the screen with
  it, which is what the 390px capture and the spec's own measurement exist to catch.
- **Pointing at a card answers "what is this waiting for, and what waits for it"**
  (`relatedNodes`), followed the whole way through rather than one step — "what is holding this
  up" is a chain — by drawing everything else faint. It is an ENHANCEMENT and never the only way
  to read the graph, because there is no hover on a phone. Two rules hold the drawing of it:
  - **The curves are NEUTRAL at rest, and the accent is what a pointer buys** (`edgeIsLit`,
    whose whole point is that nothing is lit with nothing pointed at). Every wire in the app's
    accent says every dependency matters, which is the same as saying none does.
  - **A card's surface stays OPAQUE in every state, and the curves run under it** (the graph's
    own `isolate` plus the edges' `-z-10`). What fades on a dimmed card is its CONTENT: an
    `opacity` on the whole card made it translucent, so the wires behind showed through its own
    name — and `isolate` is load-bearing, because a negative layer with no stacking context here
    falls behind the PAGE's background and draws no curves at all.
- **A control is drawn only where it changes something.** A pipeline whose jobs declare no
  dependency the graph can draw gets neither the grouping nor the toggle, and asking for the
  dependency layout on one answers a STAGE layout — a single column holding every job is not a
  graph, and the reader asked to see structure. `canGroupByNeeds` resolves the names for that
  reason: a `needs` naming a bridge is a dependency nothing can be drawn for.
- **A card OPENS THAT JOB'S LOG** (§ A job's LOG is a page), which is the one thing anybody wants
  after a red card. It stays an `<a>` with a real address, so the rule below holds and a modified
  click still opens a second window; GitLab's own job page is one press further, in the log's own
  header.
- **NOTHING here writes.** GitLab's own graph puts a RETRY on every card; this app reads
  trackers, and the writes it offers are elsewhere behind their own consent gates
  (§ The trackers). So a card is a LINK and holds no control at all — the spec counts the buttons
  inside the graph and expects none.
- **JOBS are a second view of one read, not a second surface.** The graph answers "what is the
  shape of this run"; the list answers "what took four minutes", down one column with no
  sideways scroll — which is the better one on a phone. The old stage list therefore still
  exists, on the page rather than deleted.
- **A read that FAILED says so** (`gitlabPipelineError`). The Overview's panel can fall back on
  the rest of the page, so it draws one line; the PAGE is that read and nothing else, so a
  failure it never stated would be "Reading the pipeline…" for ever — it names the reason and
  offers GitLab's own pipelines (through `gitlabPageUrl`, so there is one spelling of that
  address), which is the one thing left.

**`needs` is read over GraphQL, because GitLab's REST answer does not carry it**
(`src/gitlab_ci_graph.rs`, attached to the REST `PipelineView` in the `gitlab_mr_pipeline`
handler). It is a READ and it carries the read path's rails — the three `src/linear.rs` carries,
for the same reasons:

- **HOST PINNING.** The endpoint is `gitlab::origin` plus `GRAPHQL_PATH`, built from the
  configured host and nothing else. `api_base` is that same origin plus the REST prefix, so a
  configured host becomes an address in ONE place whichever API a request speaks.
- **QUERIES ONLY, and the BODY is what is guarded.** A GraphQL request is a POST whether it reads
  or writes, so the verb says nothing: every request goes through `run_query`, a test scans the
  module's own source for `mutation`, and a second scans the whole crate to keep `/api/graphql`
  out of every other file — those modules are scanned for every verb but GET, and a POST hiding
  in one is a write those scans cannot see.
- **BEST-EFFORT, and it can never cost the panel.** A GitLab too old for the field, a token
  GraphQL refuses, an instance with it switched off, a network failure: each costs the dependency
  MODE and nothing else (`attach_needs` writes one journal line and leaves the jobs as they were),
  and the graph is grouped by stage. So an empty `needs` means "nothing is known to be waited
  for" and never "this job starts immediately" — which is why the grouping is OFFERED rather than
  assumed.
- **A dependency is matched by job NAME**, both in the backend and again in the page. `needs:` is
  declared per name in `.gitlab-ci.yml`, so every retry of a job shares one set — and the REST
  read and the GraphQL one are two requests, so a push between them can show them two different
  head pipelines. A name means the same thing across both; an id would not, and matching on one
  would silently draw no edges at all. Where two cards carry one name (a retried job) the NEWEST
  is the end of the curve, and a name no card carries is dropped on both sides: an edge to a card
  that is not on screen is an edge to nothing, and the page COUNTS what it dropped
  (`graphSummary`) rather than looking complete.

**Every one of those facts is MEASURED** by `examples/pipeline_needs_recon.rs` — READ-ONLY, over
the 25 newest open merge requests, printing counts and field NAMES and never anybody's job:

    cargo run --example pipeline_needs_recon

Measured 2026-08-07 on `git.sia.partners`: a REST job row carries 25 fields and `needs` is not
among them; of 25 pipelines holding 143 jobs, **21 declare dependencies and 0 refused the
query**; 96 jobs carry a `needs`, 142 edges in all, of which **9 name a job the REST read did not
carry** (a bridge — the count the summary states); the longest dependency chain is **4** deep and
the stage counts run from 1 to 8. And the third fact, the one that cost a shipped bug: GraphQL
named the stages of all 25, and against the REST order **16 are REVERSED** while the other 9 have
a single stage — never anything else. Run it again rather than widening a parse on a hunch.

`web/mock/server.ts` reproduces the whole surface with no GitLab and no token: its live pipeline
declares `needs` (`MOCK_LIVE_PIPELINE_JOBS`, whose shape is deliberate — a job the rest waits
for, two that fan out from it, one that waits for NOTHING in a later stage, one allowed to fail
and a manual deploy), the failed fixture holds red, orange and skipped together, and `!63`
declares no dependencies at all, which is the pipeline that must offer no controls. `cd web &&
bun run preview -- --out /tmp/pipe --pipeline` captures the panel in both themes, the page under
both groupings, the curves off, one job pointed at, the jobs list, a phone's width and the failed
run in both themes. **The graph has never been drawn from the real instance**: the reads are
measured above and the surface is pinned against the mock, so what is untested is the pairing —
one open of a real merge request in the user's own app.

### A job's LOG is a page of its own (`/mr/<id>/jobs/<jobId>`)

Pressing a job card on the Pipelines page opens **that job's log**, full screen: the sections the
runner wrote, the colours it wrote them in, and what each part cost. A red card says a job failed,
and the only thing anybody wants next is why — which used to be a trip out to GitLab.
`src/gitlab_mr.rs` holds the read (`fetch_job_log`), `web/src/lib/gitlab-job-log.ts` every pure
decision, and `web/src/components/gitlab-job-log-page.tsx` draws it.

**It is a page for the diff's own reasons.** A log measured 4 238 lines and 510 KB here, with one
line 22 129 bytes wide: that has no room in a column which also carries a description, a pipeline,
the actions and a conversation — and reading a red job is somewhere a reader STAYS. So it is a
ROUTE, and the three things that come with one are not available to a piece of state: it survives a
reload, it can be sent to whoever is asking why CI is red, and the browser's own Back leaves it. It
hangs UNDER the Pipelines page rather than joining the strip of four — a job is a detail of a run,
so the sub-header keeps Pipelines current and Back leaves the log for the run.

**Every fact this rests on is MEASURED** by `examples/job_trace_recon.rs` — READ-ONLY, over 58 jobs
of the 12 newest open merge requests, printing counts, field names and byte sizes and never
anybody's log:

    cargo run --example job_trace_recon

Measured 2026-08-07 on `git.sia.partners`, and each number decides something:

- **The trace is `text/plain` with a length on every answer** (58/58), so it is the one read here
  that is not JSON and has a reader of its own (`read_text`).
- **A RANGE READ IS REFUSED**: no `accept-ranges` anywhere, and a `Range` request was answered
  `200` with the whole log 48 times out of 48. So a log too big to travel cannot be asked for in
  pieces — the only choice is WHICH end travels, and it is the **TAIL** (`tail_of`, cut on a line
  boundary because half a line is half an escape sequence). `MAX_TRACE_BYTES` is 1 MiB, twice the
  largest measured, and a cut log SAYS it is showing its end with GitLab's own page one press away.
- **It is small until it is not**: median 11 KB, p90 148 KB, largest 510 KB; median 192 lines,
  largest 4 238. That is why the rows are virtualized — over `@tanstack/react-virtual`, the one the
  chat history, the mail list and the merge-request sidebar already use, because a second
  virtualization library for the fifth list in this app is the icon-set mistake in another
  vocabulary.
- **A job with NO log answers 200 with an empty body** (10 of 58, all `manual` or `created`), never
  a 404 — so an empty log is a STATE, and the page says which one (`emptyJobLogReason`): a job that
  has not started will have a log later, an ERASED one never will, and one that ran and printed
  nothing is a third thing again. **A log this app could not READ is none of those**: the job and
  the trace are two requests and only the second can fail on its own (GitLab answers 404 for a
  trace file it has dropped), so the reason travels beside the job (`trace_error`,
  `jobLogUnreadable`) and is stated instead. "This job printed nothing" is a claim about the job,
  and this app must not make it on the strength of a read that failed.
- **`failure_reason` is present only on a job that failed** (2 of 58), and `runner`, `started_at`,
  `finished_at` and `queued_duration` only once a job has run (48 of 58). Every one is optional, and
  a `manual` job is drawn without them rather than with a zero.

Nine rules hold the surface, and `web/e2e/gitlab.spec.ts` pins each:

- **The window is decided by the ANSWER, not by the caller.** The same read is the liveliest on this
  page while a job runs and final the moment it stops, so `GitLabTtl::JobLog` reads `complete` off
  the payload: 5 s (the pipeline's own window) while the job is unfinished, 24 h once it is — a
  retry is a new job with a new id, so a settled log can never be stale. An answer that does not say
  is read as UNFINISHED, because an older build's payload must not be cached for a day on the
  strength of a field it never carried.
- **The page polls exactly while the job has not finished** (`jobLogIsLive`), and it FOLLOWS the
  newest line only while the reader is at the bottom — the rule the agent transcript already holds.
  Leaving the page stops the poll, so a log nobody is looking at asks GitLab nothing.
- **A MARKER IS READ BEFORE THE CARRIAGE RETURN THAT FOLLOWS IT.** The runner writes
  `section_start:<ts>:<name>`, then `\r`, then an erase, then the section's own heading — so a parse
  that resolved the rewrite first erases the marker with it and finds no sections at all. Order is
  the whole of that bug, and a test pins it.
- **Sections NEST, and a fold takes the whole subtree.** 48 of 58 logs carry 5 to 9 sections, and
  `step_script` holds sections a project's own `.gitlab-ci.yml` emitted — so the parse keeps a
  STACK, and `visibleLogLines` climbs to the OUTERMOST folded ancestor: a child left visible under a
  folded parent is a row with nothing above it to place it. A folded section keeps its opening line
  and states what it COST, from the two markers' own timestamps.
- **A bare carriage return means the runner rewrote the line in place** (48 of 48 logs), so a line
  shows its last segment and the progress bar before it is gone. Only two escape kinds exist here —
  35 856 SGR and 1 444 erase-line, and no cursor move at all — so nothing here models a screen.
- **The ANSI is `anser`'s** (MIT, no dependencies), asked for `use_classes`: WHAT a colour means
  belongs to `app.css`, so each theme keeps a palette a reader can read and a terminal's own
  `#000000` never lands on a white page. Only the 256-colour cube and truecolor resolve to a value
  in the component, because neither can be a class. It is parsed per VISIBLE row: sixty rows on
  screen against four thousand in the log.
- **It never WRAPS, and the line numbers never leave.** A 22 KB line wrapped is 200 rows of one
  line, which makes every row's height a measurement and the scrollbar a guess — so the page scrolls
  SIDEWAYS like a terminal and the gutter is sticky against it.
- **A search FILTERS.** "Which lines say `error`" is the question in 4 000 lines, and scrolling to a
  tinted word is not an answer to it. Every kept row carries the log's OWN line number, the count is
  stated (a filter that found nothing looks exactly like a log that arrived empty), and pressing a
  row's number clears the filter and takes the reader to that line in place.
- **Nothing here writes.** GitLab's own job page offers Retry, Cancel and Erase; this app reads
  trackers, and the writes it offers are elsewhere behind their own consent gates (§ The trackers).
  So the card that opens this page stays an `<a>` — the graph holds no button at all, and its spec
  counts them — and GitLab's own job page is one press further, in this page's header.

`web/mock/server.ts` reproduces the whole surface with no GitLab and no token: its trace is written
the way the runner writes one (nested sections, a progress line rewritten in place, 16-colour and
256-colour SGR), the RUNNING job's log grows by a line on every read — which is what makes
"following" reviewable with no CI anywhere — a `manual` job answers an empty one, and the
`{kind:"gitlab_mr"}` hook arms `truncate_job_log` and `refuse_job_log` (a spec MUST clear it, since
one mock process serves the whole run). `cd web && bun run preview -- --out /tmp/log --job-log`
captures the card, the page in both themes, every section folded, the filter in both themes, a
phone's width, a cut log, a job that has not run, a live one and a refused read. **No real log has
been drawn from the instance yet**: the reads are measured above and the surface is pinned against
the mock, so what is untested is the pairing — one press on a job card in the user's own app.

### A comment on a diff LINE (a press on a line number, or a drag over several)

The diff page comments on code the way GitLab's own does: press a line NUMBER and a box opens
under that line, or drag from one line number to another and the box is about the span. The
thread it makes hangs there from then on, beside the threads colleagues already left.
`web/src/lib/gitlab-diff-comment.ts` holds every pure decision, `gitlab-diff-comments.tsx` the
card and the box, `gitlab-diff-view.tsx` the seam onto the renderer, and the write itself is
`gitlab_mr_write::comment` with a `DiffAnchor`.

**It is not a fifth write.** It is the COMMENT above — the same `gitlab_mr_comment` method, the
same `OUTWARD_METHODS` gate, the same people told, the same deletion undoing it — in the third
shape GitLab files a comment in (`POST …/discussions` with a `position`, beside `…/notes` and a
reply's `…/discussions/{id}/notes`). Adding a gate of its own would be a second consent for one
act; what it does need is the rails below, because a position is a claim about WHICH code.

- **The gesture is the RENDERER's**, and that is why it is a gesture at all: `@pierre/diffs`
  starts a selection only from the line-number gutter and follows the pointer to another number,
  so a press is one line and a drag is a span. Nothing here reimplements it. What this app adds
  is the MEANING of the answer, which is the one thing a diff renderer cannot know (below).
- **Every gesture names its FILE**, because the diff is a feed of all of them: line 42 exists in
  most of these files, so a range with no file would light one line in each and file the comment
  against whichever the reader happened to be at. The item's id travels with the live selection
  (`DiffLineSelection`), with the end of the gesture, and with the gutter's own press — which is
  the shape the renderer's own `CodeViewLineSelection` takes, for that same reason — and the box
  keeps that file until it is sent or cancelled, however far the reader has scrolled meanwhile.
- **The box opens when the gesture ENDS, never during it.** A card drawn mid-drag inserts a row
  into the patch and moves the line numbers out from under the reader's own pointer — measured:
  it cut a drag from line 3 to line 6 short at line 4. So `onLineSelectionChange` only lights
  lines and `onLineSelectionEnd` is what opens the box. **`onLineSelected` is deliberately not
  the signal**: pierre calls it whenever the selection is SET, the app's own `selectedLines`
  prop included, and the React wrapper writes that prop back on every render — so a live
  highlight would come back as "the reader finished here" a frame later, which is that same
  mid-drag card.
- **A line means two numbers, and the patch is the only thing that knows both.** The renderer
  reports a number on a SIDE (42 in the additions gutter); GitLab addresses the same line by its
  place in BOTH files and states only the side the line is really on — an added line has no old
  line, a context line has both. `patchLines` walks the patch git's own way to reconcile them,
  and it is one walk on purpose: two — one for the display, one for the position — would
  disagree on the first patch with a removal in it. Two traps are pinned by tests: nothing
  before the first `@@` is a line (the header this app writes carries `--- a/…` and `+++ b/…`,
  which are neither a removal nor an addition), and a context line whose leading space somebody
  stripped is still counted, because skipping one puts every number below it out by one — a
  comment quietly filed against the wrong line.
- **The two ends are put in READING order.** Pierre reports `start` as the line the drag began
  on, so an upward drag arrives backwards — and GitLab hangs a thread on the LAST line of a
  range, so a pair left in pointer order would file the comment at the top of the block and name
  the span the wrong way round.
- **A range of one line is a LINE.** GitLab's own answers carry no `line_range` for one, so
  writing one would describe the comment as something it is not.
- **The three commits travel with it** (`diff_refs` — `base_sha`, `head_sha`, `start_sha`, all
  three or none). A line number means nothing on its own across a push: the diff moves and the
  number stays. GitLab resolves the position against the diff those three describe and REFUSES
  one it cannot place, which is the same rail the merge's own `sha` is — a comment written on a
  page that has gone stale is refused rather than hung on whichever line now holds that number.
  The refusal says so in words a reader can act on, and it is offered only where it would work:
  a file with no patch (a binary file, a pure rename, one GitLab did not expand) and a diff
  whose commits this page never read offer no control at all rather than one that collects a
  comment with nowhere to go.
- **Every failure is reported in the box the words are in**, and the box keeps them. This page
  holds several at once — a composer and a thread per line — so the sentence carries WHICH one
  it belongs to; a refusal drawn in every card would report a failed reply inside three threads
  that have nothing to do with it.
- **A thread is finished from its own card: the user's OWN words are rewritten or taken back,
  and the thread is RESOLVED.** Those undos are what make writing a comment from this page
  acceptable at all (§ The trackers), so they live where the comment is rather than a page away:
  - **The deletion asks twice and the edit asks once.** An edit can be edited back; a deletion
    cannot. Both are offered on the user's own comment only, and whose it is comes from GitLab
    before the write — a colleague's is refused by the backend and offered by nothing.
  - **An edit cannot EMPTY a comment.** That is a deletion with none of a deletion's rails, so
    it is refused by name and the box says which control to use instead.
  - **A rewritten comment says `edited`** (`noteWasEdited`, the two timestamps differing). The
    words on screen are then not the words the thread replied to, which is the honesty a Teams
    message's own mark carries. An absent timestamp is "not known to be edited", never "edited".
  - **A RESOLVED thread is drawn FOLDED**, which is what GitLab's own diff does: a settled
    objection has no claim on two centimetres of somebody's code. The fold is a default and not
    a rule — the reader's own press wins from then on — and it states how much is behind it,
    because "resolved" alone does not say whether anybody answered.
  - **Every one of them is offered on the merge-request page too**, on the same threads, through
    the same rules (`threadResolution` decides both). One thread must not be two answers to
    "can I settle this?".
- **The position is built from PRIMITIVES.** The page sends a file, two line numbers and a side;
  the backend spells GitLab's own `position` and the line codes inside it (`gitlab_diff_anchor`
  in src/bin/server.rs). So no client can hand GitLab a field this app does not know it is
  sending — the rule `gitlab_merge_request_params` already holds for a project path.

**Every field of that position is MEASURED, because there is no sandbox project to try a write
against.** `examples/merge_request_diff_note_recon.rs` is READ-ONLY — it walks the positions
GitLab itself stored on this instance's own comments and checks each rule against them:

    cargo run --example merge_request_diff_note_recon

Measured 2026-08-06 on `git.sia.partners`, over the 40 newest open merge requests: all 40 carry
three whole commits in `diff_refs`; 276 notes carry a position and every one is
`position_type: "text"`; the anchor names the NEW line alone on 255 (an added line) and both
lines on 21 (a context line); 17 carry a `line_range`, whose ends are
`{line_code, old_line, new_line, type}` with `type` in `new` (22), `old` (4) and `expanded`
(8) — GitLab's word for a context line inside a region somebody OPENED, which is a line this app
cannot select and therefore never writes. And **all 34 of those line codes match what this crate
computes** (`gitlab_mr::line_code`, the SHA-1 of the path with BOTH counters, which is why a
removed line still carries its place in the new file). That last one is the part nothing else
could have checked: a line code is a hash, so a wrong rule earns a refusal that names nothing.

The same run measures what the RESOLUTION reads back: 207 threads are resolvable, 89 of them are
resolved, and 573 conversations are not resolvable at all — which is why the control is drawn
only where GitLab would take one. **Not one of those 207 had its notes disagreeing**, so the
all-resolvable-notes rule is not load-bearing today; it is still the right rule, because GitLab's
API resolves a single note as well as a thread and the numbers say nothing about tomorrow.

`web/mock/server.ts` reproduces the whole flow with no GitLab and no token — it translates the
position the way the backend does, so what the page reads back is the shape the tenant would
answer with, it moves `updated_at` on an edit so the `edited` mark is real, it refuses a
resolution on a comment that is not a thread in the service's own words, and it seeds one thread
on a RANGE of a file the page really shows (a colleague's comment with the user's own reply under
it, so the edit and the deletion are on screen too). `cd web && bun run preview -- --out /tmp/dc
--diff-comment` captures the thread in both themes, the affordance in the gutter, the box on one
line, the drag's own span in both themes, the words written, the thread they became, a comment
being rewritten, the fold a resolved thread takes in both themes, and the box on a phone; `web/e2e/gitlab.spec.ts` pins every rule above by
driving the POINTER, because the drag is the feature. **It has never run against a real GitLab
project**: like every other write here, that is the user's own click, in their own app.

## A tracker REFERENCE in the words (`ENG-123`, `!42`)

The trackers the user works in turn up in everything written here — an agent's answer ("!42 is
ready, it closes STMN-3439"), a colleague's message, a merge request's own description. Written
out it is a word; read as a reference it is one press away from the thing it names, and where
that press goes is the whole feature:

- a **LINEAR issue** goes to Linear, wearing Linear's own mark, because this app holds no issue
  page — the card a link earns is as far as it goes;
- a **GitLab MERGE REQUEST** goes to THIS APP's own merge-request page (§ The GitLab page),
  wearing the tanuki, because that page is where the reader is going anyway: the diff, the
  pipeline, the conversation and the merge are all on it.

`web/src/lib/tracker-ref.ts` holds every pure decision, `tracker-ref-chip.tsx` draws the chip,
`tracker-refs-context.tsx` carries what a surface reads references WITH, and the one read the
feature needs is `linear_workspace` (`linear::fetch_workspace` in src/linear.rs).

**It is read from the WORDS, never from markup**, which is the choice `agent-tag.ts` makes for a
`@claude` prefix and `agent-message.ts` for a reply's signature. A reference carries no markup
anywhere: an agent writes `!42` because that is what a person writes, a colleague types
`STMN-3439` from their phone, and GitLab hands us the author's own text. So there is nothing to
restore, and every message ever written renders as one. Nothing is added to the wire either — the
posted body is the words the agent wrote, so a colleague's own client shows exactly them.

**It is drawn EVERYWHERE, from one place.** `RichNodes` is the seam every surface in this app
draws words through, so the transform lives there and covers a message body, a reply quote, an
app card, an agent's streamed answer, a merge request's description and a comment on a diff line
at once. What the words are read WITH comes from a CONTEXT rather than a prop, because the answer
belongs to the app — it is two settings — and threading it through eight callers would be eight
chances to forget one, on the surface where a reference then silently stayed a word.

**A bare identifier needs the WORKSPACE, and that is the one thing this app had to read.**
GitLab's host is configured, so `!42` is addressed from a setting the page already holds; Linear
is SaaS and the KEY names the workspace, so `linear_workspace` reads it — the url key that
addresses an issue, and every team key the workspace holds. It is an ordinary open READ (it
publishes nothing, and a gate would only stop a page from drawing a chip), cached for
`LINEAR_WORKSPACE_TTL` in the store so the page's ask on every connect costs no request and
survives a restart, and forgotten the moment the key that named it changes. A read that FAILED
falls back to whatever was stored, however old: a url key from this morning addresses every issue.

Seven rules hold the recognition, and each is pinned by a test in `web/src/lib/tracker-ref.test.ts`
or `web/e2e/tracker-refs.spec.ts`:

- **A reference nothing can address stays the text it is.** A `!42` in a body that names no
  project, an `ENG-123` on a machine whose workspace was never read, a GitLab URL on another
  host: each stays the word it was. That is the rule an @mention already follows — a name the
  thread does not hold is plain text — and it is what stops `UTF-8`, `SHA-1`, `RFC-2119`,
  `AES-256` and `ISO-8601` from becoming links to nothing. **The TEAM KEYS are what make that
  honest** rather than a guess about the shape of a word: this workspace holds three teams (read
  from Linear on 2026-08-07), so a reference to any other prefix is a word.
- **The words are never replaced by other words.** A chip shows the reference the author wrote,
  or the label they gave their own link. The one text this ever drops is a bare URL turned into
  that URL's own short reference, which is the case where the words ARE the address — and it is
  what keeps a quoted line readable, since a URL fills one on its own.
- **A reference inside code is code.** The scan skips a `code` / `pre` subtree, exactly as a
  mention does: an answer explaining what `!42` means must not link to somebody's branch while
  it does so.
- **A bare `!42` belongs to the CONTAINING project**, which is GitLab's own rule, and what
  "containing" means is decided per surface, nearest first:
  - the open **merge request**, on its page and on its diff (`TrackerProjectProvider`) — a
    reference written inside a project is about that project;
  - then the **message's own** links, quote included: a reply's subject is the thing it quotes,
    which is exactly the shape an agent's answer takes, since "Review this merge request: !42
    <url>" comes back quoted above it. The project is read with `projectNamedIn` rather than
    `extractLinks` because a quote carries its preview as PLAIN TEXT, so the URL in it is words
    by the time the bubble sees it;
  - then the **THREAD**, from the nearest project it named at or ABOVE that message
    (`threadProjects`, computed once by the message pane). That last one is not a nicety: read on
    this tenant, the link is pasted ONCE and everything after it — the reader's own words and
    every answer an agent writes — says `!298`. With a window of one message, the shape people
    really write recognised nothing. It never looks forward, and it moves with the thread, which
    is how a reader resolves "the merge request we are talking about" themselves.
- **Only a merge request is claimed on the GitLab side.** `#123` (an issue) and `&5` (an epic)
  are GitLab references too, and this app has a page for neither, so they are left alone rather
  than sent to a page that would say "not built yet".
- **A merge-request chip NAVIGATES; a Linear chip leaves.** Both are anchors, so the browser's
  own affordances still work — the status bar says where it goes, a middle click opens a second
  window, "copy link" copies something that resolves — and the merge-request one intercepts a
  plain left press so it stays inside the app. Every modified click is the browser's.
- **An enriched link is still a CARD.** `dropLinks` runs first, so a link that earned a preview
  card is gone from the body before the scan sees it: a chip beside its own card would state one
  thing twice.

The address a bare identifier is turned into is Linear's own — `linear::issue_url`, the workspace
path plus the identifier, with no slug — and that shape is **measured** rather than assumed:
read from this workspace on 2026-08-07, Linear's API answers exactly that URL as an issue's own
`url` when the title carries no slug, and the slug is decoration when it does.
`examples/linear_workspace_recon.rs` re-measures the whole chain through this crate's own
functions — the workspace, the URL written from an identifier, and whether Linear resolves it. It
is READ-ONLY and takes the key from the ENVIRONMENT, which is also why it has **not been run
yet**: nothing here may read the user's own key out of their store, so that run is theirs. What
is therefore untested against the tenant is the pairing — one `linear_workspace` answered by the
real API — while the parse itself is pinned by unit tests against the shape Linear answers with.

`web/mock/server.ts` reproduces the whole feature with no Linear and no GitLab: it answers
`linear_workspace` with one team key (`ENG`), the seeded thread carries a bare `!99` twice — once
in a REPLY, so the project comes from the quote and no second card is drawn, and once in a message
that names nothing at all, so the project comes from the thread — the mock agent's answer names
`acme/webapp!596` and `ENG-1` in the words a CLI would write, and every fixture puts `UTF-8`
beside them, because the word that must NOT become a chip is half the rule. `cd web && bun run
preview -- --out /tmp/ref --tracker-refs` captures the chat message, the chip in both themes, a
phone's width, the agent's own answer and a merge request's description.

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
  - **A page can ASK where it stands, and it asks before it acts.** `write_lock_status` is
    an OPEN method — the one question that must not be gated behind the token it is about
    — and it answers `held`, `foreign` or `read_only` plus whether this backend's token was
    pinned, never the token itself (`write_lock_state` in `src/bin/server.rs`). It exists
    because the pairing between a page and a backend breaks in two ways nothing on either
    side could see, and the retry above cannot heal either one: `teams` ATTACHES to a
    backend that is already listening (`ensureBackend`), and a backend another launcher
    spawned carries a PINNED token — which is in no file, on purpose — so the attached
    instance serves its page a token nothing accepts; and `TEAMS_LITE_WS_URL`, when it is
    already set, points the page's socket at one backend while its token comes from
    another. In both, every read answers and every outward and machine method is refused.
    It reached a real user as **Update failed — try again**, and the refusal text of the
    button they had pressed was the only place this app ever said so. Three things follow,
    and each is pinned by a test:
    - **The page says it, once, in the sidebar** (`write-lock-banner.tsx`, over the pure
      `web/src/lib/write-lock.ts`): "This window can read, but not send", the cause, and
      the one thing that mends it — which is never something the page can do, so the only
      action offered is **Check again**. It is drawn for `foreign` alone. `read_only` is
      silent because refusing is that backend's whole purpose, and an unanswered status is
      silent because a banner that appears by default is worse than the bug it guesses at.
      A REFUSED write that a fresh token could not heal re-asks the question
      (`setWriteRefusedHandler`), because that refusal is proof about the whole app rather
      than about one button.
    - **The launcher says it at startup**, in one line, for whoever ran the command and for
      a unit's journal (`launcher/src/write-lock.ts`). It asks with the token its own
      server hands the page — the chain the user's clicks travel down, not our idea of it.
    - **An ATTACHED launcher serves the token FILE and nothing else.** `serveWriteToken`
      REMOVES an inherited `TEAMS_LITE_WRITE_TOKEN` when we did not spawn the backend: this
      process inherits its parent's environment, and for an in-app update that parent is
      the launcher it replaced, whose token died with its backend. Left in place,
      `web/write-token.ts` reads the environment first and would serve a dead token in
      front of the file that holds the live one.
- **The hook (harness).** Blocks, before execution, any command that would write:
  ad-hoc browser drivers, scripts calling `send`/`edit`/`delete`/`react`/`mark_read` against
  `127.0.0.1:19420` or `19421` (and the 19440 / 19441 relays in front of them), a
  consumption-horizon PUT straight to Teams (which bypasses the backend's gate
  entirely), a presence publish straight to the presence service (same reason — see
  § The user's own status), a merge-request approval straight to GitLab or a Linear
  mutation (same reason again, and there is no sandbox project to aim one at — see
  § The trackers), dev servers with no declared backend, a production web server with no
  declared backend, a send-capable backend started by tooling — including `systemctl
  --user start` on the always-on service's units, and including the `teams` command
  itself, which is that backend plus the real app on 19440 in one word — and
  `teams-lite-service.sh update --now`, the switch that skips the wait for a live
  `@claude` run and so freezes a half-written reply in the thread — and `restart_backend`,
  which is that same failure from inside the app (see § Settings › This app). Asking whether a
  release is newer (`update_check`) stays allowed: it is a read, and the backend already makes
  that request every two minutes. It reads the
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
  `openCalendarView` / `openFirstEvent`. For the team → channel tree — and a channel post's own TITLE:
  the composer's field empty and filled, the titled post in both themes and that composer at a
  phone's width:
  `bun run preview -- --out /tmp/chan --channels`, or `openChannelsTab` /
  `toggleTeamSection` from the same file. For the merge-request page — its tab strip at rest
  and current, the list, the page, its header's own approval and merge in both themes, its own
  sub-header of four pages in both themes and at a
  phone's width, the page that holds nothing yet,
  the merge armed and that header armed in both themes, the comments — one of which carries a pasted PICTURE beside an image on
  another host — the description folded and opened, the picture the description ends with in
  both themes, the description at a phone's
  width, a 150-character title at both widths, the people rows in both of their shapes and a
  blocked merge:
  `bun run preview -- --out /tmp/mr --gitlab`, or `openGitLabTab` / `openMergeRequestAt` /
  `openMergeRequestPage` from the same file. For its DIFF PAGE — the way in, the FEED in both
  themes, the split layout, the feed scrolled with the tree's lit row following it, each of the
  three files with no patch, the expand control and what it hands over, and both of its columns at
  a phone's width:
  `bun run preview -- --out /tmp/diff --diff`, or `openChanges` / `pickDiffFile` /
  `scrollDiffFeed` / `diffFileItem` from the same file. For a COMMENT on a diff line — the
  affordance in the gutter, the box on one line, the span a drag covers, the thread it lands as, a
  comment being rewritten and the fold a resolved thread takes:
  `bun run preview -- --out /tmp/dc --diff-comment`, or `diffGutterLine` / `dragDiffLines` from
  the same file — each of which names the FILE it is about, because in a feed a line number does
  not (the drag is driven with the pointer, because the drag IS the feature).
  For one JOB's LOG — the card that opens it, the page in both themes, every section folded, the
  filter, a cut log, a job that has not run, a live one and a refused read:
  `bun run preview -- --out /tmp/log --job-log`, or `openJobLog` from the same file.
  For the chat list's sections and the "…"
  menu on a row: `bun run preview -- --out /tmp/chat --chat-menu`, or `openChatMenu` /
  `toggleChatSection` from the same file. For a message's actions as a PHONE draws them —
  opened by a real HOLD, at the touch floor, in both themes, and the bubble left with no "…"
  once the menu closes: `bun run preview -- --out /tmp/ma --message-actions`. For "Answer with <agent>" on a message:
  `bun run preview -- --out /tmp/ask --answer-with`. For SENDING LATER — the send pill, the
  menu of moments in both themes, a moment that has passed being refused, the banner a queued
  message earns, the custom-time dialog in both themes, the list of what is waiting in both
  themes and an armed deletion:
  `bun run preview -- --out /tmp/sched --schedule`. For the user's own CUSTOM AGENTS — the
  Settings section, the form, the name a persona may not take, the "@" list that offers them
  beside the providers, the chip and one answering under its own face:
  `bun run preview -- --out /tmp/ca --custom-agents`. For a game of CHESS — the header's
  control, the challenge popover, the board in both themes, a game in progress with its score
  sheet, the armed resignation, the board at a phone's width and the card a colleague's challenge
  leaves for the reader to answer: `bun run preview -- --out /tmp/chess --chess` (pass `--dpr 2`:
  the pawn in the header is 20px). For a tracker REFERENCE drawn as a
  chip — in a chat message, in an agent's own answer and in a merge request's
  description: `bun run preview -- --out /tmp/ref --tracker-refs`. For the typing hint above the
  composer, one typist then three: `bun run preview -- --out /tmp/typ --typing`
  (it honours `--dpr`, because the faces in it are 20px). For the settings pane:
  `bun run preview -- --out /tmp/set --settings`, or `openSettings` from the same
  file. For Settings › AI providers and its model picker, open and closed in both
  themes: `bun run preview -- --out /tmp/prov --ai-providers`. For Settings › This app — the
  update check's answer and the restart armed on a live agent run:
  `bun run preview -- --out /tmp/app --maintenance`. For the update button, the
  changelog it discloses on hover in both themes, its progress mid-download and the link the
  other install shape keeps: `bun run preview -- --out /tmp/upd --update`. For recording a
  call — the control and the sentence it carries, the live state, the card it leaves in the
  conversation and the Settings list: `bun run preview -- --out /tmp/rec --call-recording`
  (it writes a real webm out of the mock's canvases, with no camera and no microphone). For
  "Always available" and the HOURS it keeps — off, on all day, the hours running, the hours not
  yet come round, a window crossing midnight and the card at a phone's width:
  `bun run preview -- --out /tmp/av --available`, or `setAlwaysAvailable` /
  `setAvailableHours` from the same file (both assert the MOCK sentinel: against a real backend
  those fields decide when the user's own status is published). For the
  write-lock banner, in both of its
  causes: `bun run preview -- --out /tmp/wl --write-lock`. For SIGNING IN AGAIN — the offer,
  the sign-in that needed nobody, the broker's own window served into the app in both themes,
  the words typed into it, a phone's width, the cancel and the machine that cannot serve one:
  `bun run preview -- --out /tmp/si --signin`. For the notification offer —
  the row that asks once, in both themes and at a phone's width:
  `bun run preview -- --out /tmp/notif --notifications`. To review a detail too
  small to read in a
  1200px page — a 16px icon, a chip, a badge — crop to it and raise the pixel
  density: `bun run preview -- --out /tmp/chip --element
  '[data-testid="message-file"]' --dpr 4`.
  `web/scripts/scroll-probe.ts` is what a diagnostic built on top of it looks like
  (it measures history scroll smoothness frame by frame): a tracked script that
  drives the app *through* `withPreview`, never around it.
- **A capture switches the theme through the OS query, not by writing the attribute.**
  `setTheme` calls `page.emulateMedia({colorScheme})`, and the app — whose appearance is
  `system` by default — repaints `data-theme` and updates its own `resolvedTheme` with it.
  Writing the attribute from the outside left the palette dark while the app still believed
  it was light, so anything drawn FROM the app's theme (the update button's orb, the emoji
  picker) was captured in the wrong one and the capture said nothing about it. It must not
  become a reload either: a capture mid-flow (a download in progress, a live agent run)
  would not survive one.
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
- **THE FEATURE IS OFFERED, because a setting nobody finds is a feature that does not
  exist.** The whole chain above worked and NOBODY HAD IT ON: measured on this machine's
  own store, **zero rows in `push_subscriptions`** against a VAPID key that had been
  generated a fortnight earlier — the switch was in Settings › Notifications and the app
  never once said notifications were possible. So one row sits at the foot of the sidebar
  (`web/src/components/notification-offer.tsx`, over the pure `pushOffer`), where the
  update row already stands and for its reasons. It is not a second gate: the press calls
  the same `enablePush`, and Settings is still where a device is turned back off. Five
  rules, each pinned by `web/e2e/notification-settings.spec.ts` or `push.test.ts`:
  - **THE PRESS IS THE PERMISSION, and NOTHING asks any other way.** It used to be asked
    on connect, out of nowhere (`ensureNotificationPermission`, deleted): a prompt with no
    question in front of it is dismissed, and a browser dismissed a few times stops asking
    and answers `denied` — the one state neither this app nor its Settings pane can undo,
    and it takes the push path down with the popup. Asking from the reader's own press is
    also the only shape iOS accepts.
  - **It is SILENT on `denied`, `unsupported` and `backend`** — that is why `pushOffer` is
    a function rather than a `!endpoint` check. Each is undone somewhere this app cannot
    reach, and a row the reader cannot act on is a nag. `INITIAL_PUSH_STATE` is
    `unsupported` too, so nothing is offered before the backend has answered.
  - **iOS gets the one thing that would fix it**, in `pushBlockerMessage`'s own words:
    Share → Add to Home Screen. That row carries no button, because there is no press that
    could work in a Safari tab — and it is the only place the phone half of this feature is
    ever mentioned to somebody who has not gone looking.
  - **AN INSECURE ADDRESS IS BLAMED ON THE ADDRESS, never on the browser.** No browser
    publishes `serviceWorker` or `PushManager` outside a secure context, so a page opened
    over plain `http://` at a hostname or a LAN address — a tailnet name with the TLS front
    skipped, `http://192.168…` — answered "this browser cannot receive push notifications".
    That is false about the browser, blames the one thing the reader cannot change, and
    hides a one-step fix; it reached a real reader on Brave, which has had Web Push for
    years. `PushEnvironment.secure` is the browser's OWN `isSecureContext` (it already
    knows loopback counts, and a rule written over `location` here would re-derive that and
    get it wrong), and `insecure` is ordered ABOVE both `unsupported` and `needs-install` —
    every one of those arrives as the same symptom, the APIs simply missing, so the order
    is the whole of `pushBlocker`. HTTPS beats Apple's rule because an `http` page cannot
    be added to the Home Screen either. An ABSENT flag reads as secure: the capability
    check is what really decides, and this one only picks which sentence explains it.
    **The PROBLEM and the REMEDY are two sentences, and only Settings draws the second**
    (`pushBlockerMessage` / `pushBlockerRemedy`). The remedy is a paragraph — this app is
    reached three ways and they do not overlap: a real https front, loopback on the machine
    itself, and a PRIVATE address on a VPN or an overlay network (NetBird, Tailscale,
    `http://100.x.y.z:19440`), where no certificate is possible and Chromium's own
    per-origin allowance is the only thing that works. That belongs in a pane somebody
    opened to mend something, not in eleven-pixel text at the foot of a list of chats, and
    the row states the problem alone. Every other blocker names its fix inside its own one
    line, so the remedy answers null for all of them.
  - **A refusal is said AT the press**, in the browser's own words (a push service switched
    off, a worker that will not register). The composer's rule: an action that did not
    happen must never be left looking like it did.
  - **One dismissal is for good, per browser** (`localStorage`, like every other
    client-side preference here). The offer is worth making once; a dismissal on the laptop
    must not silence it on the phone.
  `cd web && bun run preview -- --out /tmp/notif --notifications` captures the row in both
  themes and at a phone's width. The iOS shape is deliberately not captured: it is a
  paragraph of text, and spoofing a user agent to photograph a sentence buys nothing.
- **A LIVE PAGE SHOWS ITS OWN POPUP TWO WAYS, and the second one is what reaches the
  phone.** The service worker deliberately shows nothing while a window is visible, so the
  page owes the reader that notification itself (`web/src/lib/notify.ts`) — and an
  installed web app on iOS HAS `window.Notification` (its `permission` and
  `requestPermission` both work) while REFUSING the constructor: WebKit only notifies
  through the service worker registration there. So the constructor is tried and its
  failure is a ROUTE rather than an outcome, and `registration.showNotification` is the
  fallback. A tap carries the same `data.url` a push does — the path
  `push_policy::notification_for` already writes — so `notificationclick` in
  `web/public/sw.js` needed no second case.
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
- **THE PAGE'S OWN SOUND RIDES THAT SAME POLICY**, and it is one function, in one
  spelling, on each side: `shouldNotify` (`web/src/lib/protocol.ts`) mirrors
  `push_policy::notification_for` rule for rule — never our own message, never a system
  line, never a deletion, never a frame older than `MAX_AGE_MS`, and a channel post only
  as loud as the user asked Teams to make it. The backend broadcasts EVERY live frame to
  every page (§ Running the released build beside the staged one says why), so a
  reaction, an edit and a deletion each arrive as the whole stored message again and a
  reconnect replays what it missed. The page used to answer "is this news?" with three of
  those seven rules, so the app chimed at things the user's own phone deliberately stayed
  quiet about — and they opened it to find nothing new. Measured over one week of this
  tenant's own store: **226 posts in `mentions_only` channels, mentioning them in none of
  them, plus 26 system lines** — some 36 sounds a day with nothing behind any of them.
  Three things hold it, and each is pinned by a test:
  - **The page adds ONE rule the backend cannot have**: a frame carrying a message this
    page already holds (`alreadyKnown`, read BEFORE the merge, since after it every frame
    looks known). It is the client's own better answer to what the delivery path decides
    with its insert — a reaction on a message already drawn is not news.
  - **`mentions_me` is resolved by the BACKEND and rides on the message**
    (`message_json`, over `push_policy::mentions_user`). The page never learns the user's
    MRI, and a mention's span carries a display name two colleagues may share, so this is
    the one fact about "is this for me?" it cannot work out. ABSENT — a backend older than
    the field — reads as a mention, because silence on a real summons is the worse of the
    two failures.
  - **Two policies for one question is the bug.** A rule added to either side belongs on
    both; if it cannot be (an identity, a claimed delivery), the other side is TOLD, as
    `mentions_me` is.

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

## A HOLD is how a phone reaches a menu (and the browser's own echo of it)

Three surfaces are opened by a still touch rather than by a hover: a message's actions
(`useMessageGestures`), a chat row's Teams settings and what an update brings
(`useLongPress`). The hold itself is 500 ms of not moving, and everything below is about the
half-second AFTER it — which is where this feature failed twice, on a real iPhone, while every
test passed. `web/src/lib/press-echo.ts` holds the shared half; `web/e2e/mobile.spec.ts` pins
each rule, and `cd web && bun run preview -- --out /tmp/ma --message-actions` is the capture
(a phone, with a finger — `withPreview`'s `phone` option, which is a coarse POINTER and not
only a narrow viewport).

**THE MENU OPENS WHILE THE FINGER IS STILL DOWN, so the browser's own echo of that touch
arrives afterwards — and every Radix layer reads it as somebody dismissing.** Two events, and
each cost a bug:

- **`pointerdown` with `pointerType: "mouse"`**, which WebKit sends at the point the finger
  was: outside the menu, so `usePointerDownOutside` dismissed it in the same frame the reader
  let go. **Chromium's compatibility sequence carries no pointerdown at all**, which is why
  nothing here could see it: the engine the app is READ on is the one engine this suite cannot
  drive, so the spec sends that event itself (`holdWithEcho`).
- **`mousedown`, whose DEFAULT moves focus** to the element under the finger — so the row
  behind the menu took it and Radix dismissed on focus-outside, half a second later, with no
  pointer event involved. Swallowing the event is not enough for that one; the default has to
  be prevented.

So while a hold owns the moment — the finger down, plus `PRESS_ECHO_GRACE_MS` after it lifts —
both are stopped at one document capture listener, for every hold in the app rather than at
each surface a hold can open. A REAL new touch is never swallowed: that is how a reader
dismisses what is open. Three more rules:

- **The window runs from the RELEASE, never from the hold.** A reader who holds for three
  seconds gets the echo when they lift, long after a window measured from the 500 ms mark had
  expired.
- **A CLICK is swallowed only where the bubble really holds it.** A React portal's events
  travel up the COMPONENT tree, so every tap inside the menu the hold had just opened passed
  through the bubble's own suppression and was eaten — the reader held a message, the reaction
  row appeared, and their tap on it did nothing. **That was the whole of the reported bug**, and
  a DOM containment test is the whole of the fix (`event.currentTarget.contains(event.target)`).
- **A menu a HOLD opened gives focus back to nothing.** Radix restores focus to its trigger on
  close, and the "…" is `focus-visible:grid` at every pointer — so a phone was left with a
  permanent ellipsis beside every message its reader had ever held, which is what the bug
  report's screenshot showed. `openedByHold` prevents that one restore; a keyboard close still
  gets its focus back.

**AND EVERY TARGET IN THOSE MENUS IS 44 px UNDER A THUMB**, which is the floor a dialog's
close, a slider's thumb and the schedule menu's rows already hold. Measured on a phone before
this: a menu row was 32 px tall — "Copy" and "Delete for everyone" 32 px apart in one column —
and the quick reactions were nine 28 px circles side by side. The row height rides the shared
`DropdownMenuItem`, for the reason the dialog close rides `DialogContent`: one rule, every menu
in the app. The reaction row is drawn at the floor on a coarse pointer and the menu widens to
hold six of them; the full picker becomes a labelled **More reactions** row there, because a
seventh circle would either shrink them all back under the floor or wrap onto a line of its
own — and a word is easier to hit than a 16 px glyph either way. **That swap is RENDERED by
pointer, not hidden by CSS** (`useCoarsePointer` in `web/src/lib/platform.ts`): a row taken out
with `display: none` is still in the menu's own collection, so a keyboard would walk onto a
stop nobody can see. It reads `false` until it has asked, because the extra row belongs to a
phone and a pointer's menu is the one that must not gain a dead stop.

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

## ONE MENU in a conversation's header (everything the thread offers, behind one trigger)

A conversation's header holds ONE control at its right, and it opens a menu with everything the
thread offers in it: the CALL — or the JOIN, where the thread was minted for a meeting — a game of
CHESS, whether the local agent answers here, and whether the chat is ENCRYPTED.
`web/src/components/conversation-menu.tsx` is the whole of it, and it replaced three separate
controls standing side by side.

**THE THING THE READER AIMS AT USED TO MOVE BETWEEN CONVERSATIONS.** Each of those three drew
itself only where it would work, which is the right rule for a control and the wrong shape for a
row of them: a 1:1 had a call, a meeting chat had a Join in that slot instead, Notes had neither so
the agent switch slid left into the space, and a channel had only the agent. So the second control
from the right was a different action in every thread — on a phone a mis-tap, on a desktop a
hesitation. One trigger, in one place, in every conversation, is steadier.

**The cost is honest and worth saying: a call is now two presses.** That is the trade — a target
that never moves, paid for with one extra press on the commonest action here. What is bought back is
that every OTHER action costs two presses as well rather than being hidden behind a glyph the reader
had to recognise first, and that a menu row has room for WORDS: a refusal used to live in a tooltip,
which on a coarse pointer is a sentence that does not exist.

Five rules hold it, and each is pinned by a test:

- **No gate moved with the controls.** Each row is drawn under exactly the condition its button was
  drawn under, carries the same `aria-label`, and states the same reason where it cannot act. The
  arguments each came with are KEPT in that file's own header, because `call-button.tsx` and
  `agent-menu.tsx` drew nothing once the menu existed and were removed rather than left as dead
  files with living comments in them. `chess-button.tsx` survives (the menu reads its pure
  helpers) and so does `meeting-join-button.tsx` (the calendar and the incoming-call banner still
  draw the real button).
- **The old testids are KEPT on the rows** (`call-button`, `meeting-join-here`, `chess-button`,
  `chess-challenge`, `agent-mode-toggle`, `agent-hint`, `agent-unrestricted-toggle`). A spec that
  drove a control now opens the menu and finds the same row, so what every existing assertion MEANS
  survived the move.
- **Two things stay OUTSIDE the closed menu, because a signal inside one says nothing.** The chess
  attention DOT, whose whole job is to say the game wants something from the reader while the board
  is a screen away, moves onto the trigger; and the agent's own "on" becomes the trigger's accent,
  because "a machine may post under my name in this thread" is the sharpest state this header ever
  stated and a consent that can only be read by opening a menu is one the reader stops checking. The
  two do not compete: the accent is a standing state and the dot is a thing waiting to be done.
- **A MEETING's Join still states its own address** (`data-join-url`, or `data-meeting-thread`), for
  the reason § Automation safety gives: an outward action a driver cannot prove is one it must not
  take. `web/scripts/join-live.ts --from-chat` therefore OPENS the menu and then re-reads that
  address from the row in the moment before the click — the proof is unchanged, and opening a menu
  reaches nobody. Only the OPENING is retried, so no attempt can carry a stale proof forward.
- **Every row clears the 44px touch floor**, which it gets from the shared `DropdownMenuItem` — the
  same rule and the same one place a message's own actions already hold (§ A HOLD is how a phone
  reaches a menu).

## Audio calls (a call RINGS a person — the sharpest outward action here)

The app takes and places one-to-one **audio** calls, by doing what the real Teams WEB
client does: `src/calling.rs` is the signaling plane, the browser carries the media
(`web/src/lib/call-media.ts`), and `NATIVE-CALLING.md` is the protocol map every line of
both was written from — read it before touching either. What the user SEES of a live call is
§ A call is a page; video is received and sent, which is § Video in a meeting and
NATIVE-CALLING.md § 10 for the protocol it rests on. A call can also be RECORDED, which is
§ Recording a call — teams-lite's own file, made in the page, and the one thing about a call
that Teams is never told.

**The backend signals; the page carries the audio.** That split is not an implementation
detail: the tokens must never reach a browser, and a microphone is only reachable from
one. So an SDP crosses the local WebSocket in each direction and nothing else about a
call does — this side never handles RTP, and the page never learns a Teams URL.

- **Calling is ON, with no switch anywhere** (`calling_available` in `src/bin/server.rs`).
  The app IS a Teams client, so it REGISTERS a calling endpoint at startup the way every
  other client the user is signed in on does, and their real incoming calls are offered
  here as well as on their phone. There used to be a Settings switch, off by default; it
  was the wrong shape for the one thing it gated — registering reaches nobody by itself,
  and the actions that reach a person are gated one by one below. Four things hold the
  new shape, and each is pinned by a test:
  - **A READ-ONLY backend says no, and nothing else does.** A screenshot backend must not
    become a device the user's calls ring on; every install they can open registers, and
    no environment value takes that back (`no_environment_value_silences_calling` scans
    for the one that used to). **Two installs on one machine both register, deliberately**
    — each holds a calling endpoint id of its own (`endpoint_id_path`, keyed by the port),
    so the service sees two DEVICES and rings both, exactly as it rings a phone beside a
    laptop. The released build beside the staged pair used to be silenced with
    `TEAMS_LITE_CALLING=0`, to spare that second ring; what it really cost was every call
    and Join control in that window, drawn disabled — and the front a phone had open was
    the silenced one, so the app read as one that cannot call at all. A second ring is
    cheap; a call the user cannot place is not. Never trade one for the other again.
  - **The registration is TAKEN BACK as the app goes away.** `stop_calling` runs on the
    idle shutdown, because a registration Teams still believes in keeps routing their
    calls to a process that is gone, and a call offered to a device that never rings is a
    call they miss. It would expire within the hour on its own; every call inside that
    hour is the reason not to wait for it.
  - **What a window cannot do, it says.** `enabled: false` is no longer something the user
    can fix, so the disabled call and Join controls say what that window IS — never "turn
    it on in Settings", which would name a switch that does not exist
    (`callUnavailableReason` / `meetingUnavailableReason`).
  - **The page never assumes it.** `UNKNOWN_CALL_STATUS` is still both flags false until
    the backend answers: a hopeful `true` would claim the user's calls ring here while
    nothing is registered.
- **Four methods reach a person, and they are `OUTWARD_METHODS` entries**: `call_place`
  starts a device buzzing in somebody's pocket, `call_accept` opens the user's own
  microphone to whoever is on the other end, `call_hangup` ends the call for both of them
  (or declines it, which the caller is shown), and `call_mute` publishes whether they can
  be heard. None can be taken back, and each one carries out one click the user just made
  — nothing in this feature ever acts on its own.
- **`call_prepare` is a `MACHINE_METHODS` entry**, with its own refusal words: it reserves
  the one call slot and hands the page the relay credentials this backend holds.
  `call_status` stays open: it returns no SDP, no links and no credentials, only what the
  UI has to draw. There is no method that turns calling on — the registration is the
  backend's own act at startup, so no client can ask for it and none can take it away.
- **One call at a time.** A second simultaneous call needs a second microphone and a UI
  that can hold two. An invite that arrives while a call is up is left for the user's
  other devices to ring, which is what Teams does with a client that does not answer.
- **A CHAT is called; a MEETING is joined, and the conversation decides which**
  (`conversationCallAction` in `web/src/lib/call.ts`, drawn by `conversation-menu.tsx`). One
  control per conversation, in its header:
  - a **1:1** rings the person, and a **GROUP CHAT** rings every member at once. That is
    the same POST — `calling::invitation_payload` takes a list, `participants.to` carries
    all of them, and `enableGroupCallEventMessages` was already on, so the call line lands
    in the thread everybody in it reads. The roster the service then reports is what
    answers "who is in it", which is machinery a meeting already had (`CallSession::others`,
    one `<audio>` per remote stream). `call_prepare` resolves the list ONCE and keeps it on
    the session (`ring`), because `call_place` is a second round trip and a list rebuilt
    there could disagree with the one the user was shown.
  - a **MEETING chat** — a thread Teams minted FOR a meeting — JOINS instead, addressed by
    that thread (see § Joining a meeting). It offers no ring: joining and ringing everybody
    invited answer the same question, and only one of them is what the thread is for.
  - **All three are ONE ROW of the conversation's own menu** (§ ONE MENU in the header). They
    answer one question — start talking to the people in this conversation, here — so they were
    one control in one box before the menu existed, for the reason that argument still gives:
    a header is a row of controls the user aims at, and a chat that changed their size or shape
    would move the target between two conversations. The menu takes that further rather than
    away: the TRIGGER is the one target now, in every conversation, and the row has room for
    WORDS where the icon had a tooltip — which on a coarse pointer is a sentence that does not
    exist. WHICH action it is is in the row's own label, in what a screen reader is handed, and
    in the row's "Meeting chat" subtitle. A glyph that tried to say "join" was measured and
    rejected on the way here: `MeetingRoomIcon` reads as a bare panel at 20px.
  - **`MAX_GROUP_CALL_PEOPLE` (20) is the ceiling**, and it is a product rule rather than a
    protocol one: every name in that list is a device buzzing in somebody's pocket, and a
    mis-click on a 60-person thread cannot be taken back. Above it the user still has real
    Teams. The mock mirrors the number, so the refusal is reviewable.
  - **The label says what the click reaches** — "Call everybody in Design crew" — because
    that is the fact the user needs before it and the one thing they cannot undo after. A
    group call is NOT asked for twice: it is one click, exactly like a 1:1, and the words
    carry the difference.
  - **A group call names the CONVERSATION where a 1:1 names the person** (`CallKind::Group`,
    empty `peer_mri`): five people have no one name, so the surface draws the group mark
    rather than a face seeded from nothing, and says who is there from the roster once
    somebody picks up. It has no lobby — that state is a meeting's, and reading one into a
    call would show a state that cannot end.
  - An INCOMING group call is still named after its CALLER: they are who the user decides
    about, and everybody else arrives on the roster.
  - **It is unverified against the tenant**, like the 1:1 call and for the same reason: a
    call has no pre-authorized target, so ringing a real group chat is the user's own click.
    What the mock proves is the whole surface; what the protocol rests on is that the body
    is the join's own shape with a longer `participants.to`.
- **The microphone is released on ONE path.** Every ending — our hangup, theirs, a
  dropped connection, this machine stopping taking calls — arrives as the backend's
  `call_state` frame,
  and the store's handler is the only place that stops the media. A path that released it
  somewhere else would eventually miss a case and leave the browser's recording indicator
  on for a call that does not exist.
- **A start the user STOPS is not a failure, and the call it half-made is taken back.** A
  start is three awaits long — reserve, open the microphone, post the offer — and the
  microphone alone takes up to `GATHER_TIMEOUT_MS`, so a call stopped a second after it was
  placed lands inside one of them. Both halves used to be wrong, and each is now pinned by a
  test:
  - **The page holds the user's own intention** (`callAttempt` in `web/src/lib/store.ts`,
    moved by every start and every hang-up). A start whose attempt no longer stands says
    nothing, sends no offer, and RELEASES the media it had just opened — `adoptCallMedia` is
    the only place `callMedia` is assigned, because a capture adopted after the hang-up is
    one nothing can find to stop. It is read off the counter and never off a `call_state`
    frame: a frame says the call is over whoever ended it, a real failure included, and a
    failure must still be said. Before this the start ran on to the end and the backend's
    refusal of an offer for a call it had already let go was floated at the user as a fault
    — `no such call — call_prepare first`, for a call they stopped themselves.
  - **The backend hangs up what the service accepted meanwhile** (`hang_up_orphan`, in
    `call_place`, `call_join` and `call_accept`). The hangup finds no link to post on while
    that POST is still on the wire, so it drops the call here — and a moment later the
    service has a device buzzing in somebody's pocket, or a caller talking into a machine
    that holds nothing. The answer's own links are that call's only address and this is the
    only moment they exist, so each handler re-reads the reservation after its answer and
    ends the call when it has gone. `a_call_answered_for_a_cancelled_start_is_hung_up` scans
    all three.
  - **The mock can hold ONE step of a start** (`{kind:"call_start", hold:"prepare"|"place"}`,
    over `holdCallStart`), which is what makes the window reachable from a spec at all: the
    mock's own media is instant, so the window a user cancels in did not exist there.
- **What a call has to SAY is a transient notice, and this app's only one**
  (`web/src/lib/notice.ts`, drawn by `app-toaster.tsx` over `sonner`). Why a call ended for a
  reason the user did not choose, why one never went out, why a capture was refused: by the
  time there is anything to say the call is gone, so there is no surface of its own left to
  say it in. It was a CARD before, and the card was wrong twice — it carried no timer at all,
  so `not connected` sat over the user's chat list until they placed another call, and it was
  drawn only while NO call was live, which is exactly when a refused camera has something to
  say. Five rules hold it, and `web/e2e/calling.spec.ts` pins each:
  - **It leaves on its own.** `NOTICE_MS` for a report of something that happened,
    `ERROR_NOTICE_MS` for a failure — longer, because that is the one the user may have to
    act on. Nothing here ever waits to be dismissed.
  - **It never lands on the controls it is about.** The ringing card measures its own stack
    into `--notice-inset-bottom` (the base inset is in `styles/app.css`), so a sentence stacks
    over that card instead of over Answer — and both clear the composer, for the reason the
    card already clears it. A live call needs no reservation: its controls are the page's own
    header, at the top (see § A call is a page), and the spec measures the notice against that
    header rather than trusting the inset.
  - **A new attempt takes the old reason back, and a `call_state` frame never does.** Those
    frames arrive all through a call — a roster, a renegotiation, a camera going on — so
    clearing there erased a refusal a beat after it appeared. The dismiss lives where an
    attempt STARTS, which is the only place that knows one is starting.
  - **The words are the user's, not the socket's** (`web/src/lib/call-failure.ts`, the twin
    of `send-failure.ts`): the RPC name the backend opens every refusal with is dropped, the
    socket's `not connected` becomes what it costs the call, and a failure that carried no
    words at all — the service answers `400` with an empty body — still says something.
  - **A call that rang NOTHING says whose devices were not there.** Measured against the
    tenant: calling somebody with no client signed in is accepted, answered with an SDP, and
    then ended two seconds later — and the only frame that names the CAUSE is
    `addParticipantFailure` (`code 480 subCode 10037`, "No callee endpoints were found."),
    which arrives a beat before the ending whose own phrase names the symptom ("no one else
    has joined the group call"). So `calling::invite_failed` reads it, the session remembers
    it (`unreachable`), and the ending is stated as `calling::END_REASON_UNREACHABLE` — a NAME
    rather than the service's prose, because `callEndLabel` turns names into sentences and a
    Rust test pins the two spellings together. Without it the user pressed call, watched it
    die two seconds later, and was told "The call ended." — five times in a row, which reads
    as this app dropping their calls.
  - **Only a CALL comes through here.** A failed send stays at the composer and an approval
    stays in the menu it was clicked in (§ Sending messages, § The trackers), and the write
    lock, a broken sign-in and a pending update keep their banners and their row: each of
    those is a STATE of the app, and a state that scrolls away is one nobody can check.
- **The registration mimics the WEB client, not the desktop one.** `SkypeSpacesWeb_2.6`,
  TTL 3600, path = the bare surl, on a connection of its own to `calling_trouterUrl`
  (`trouter::Endpoint::calling`). The desktop client's `NGCallManagerWin` /
  `DesktopNgc_2.3` pair is what an earlier capture branch sent, and it is wrong: Teams
  routes a call to the endpoints it believes are running, so claiming to be a Windows
  client sends the user's calls to a client that is not there. A test scans this crate
  for those spellings — do not bring them back.
- **The SDP is rewritten in ONE respect, and the service named it.**
  `application/sdp-ngc-1.0` is a LABEL on ordinary WebRTC SDP — the codecs, the
  fingerprint, the candidates and the ICE credentials all travel as Chrome wrote them, and
  the blob travels WHOLE with its candidates, because this protocol has no trickle channel
  (hence the bounded wait for ICE gathering in `call-media.ts`). The exception is the
  transport profile: a browser's `UDP/TLS/RTP/SAVPF` is answered `conversationEnd 410,
  UnrecognizedTransportProfile` and the meeting drops a second after it was joined, so
  every media line goes out as `RTP/SAVP` — the client's own `toMsSdp` does exactly that.
  The answer comes back in the same spelling and Chrome refuses it, so the return direction
  is undone too (`UDP/TLS/RTP/SAVPF` where the section carries a fingerprint, `RTP/SAVPF`
  where it does not). Both live in `web/src/lib/ms-sdp.ts`, next to the only code in this
  app that ever looks inside an SDP: the backend passes the blob through untouched, and a
  rewrite there would be a second place that has to know this.
- **Nothing else about the blob is guessed at.** The client's `toMsSdp` does more —
  `x-ssrc-range` instead of `a=ssrc`, a per-section fingerprint, `a=rtcp` on an offer,
  MS-encoded header-extension URIs — and none of it is here, because the service has not
  refused what it would replace. A rewrite earns its place when a refusal names it. That
  is how the profile was found, and it is the only reason it is in.
- **`web/mock/server.ts` reproduces the whole flow with no tenant, no registration and no
  microphone**, and the page pairs it with `simulatedCallMedia` because that backend
  announces itself as a mock. That is what makes this surface reviewable with nothing
  leaving the machine: `cd web && bun run preview -- --out /tmp/call --call` captures the
  button, the ring, the page, the window it folds into and the notice, and
  `web/e2e/calling.spec.ts` pins every rule above. That mock CALLS out of the box, like the
  backend it stands for, and its `{kind:"calling", enabled:false}` test hook is the only
  way to the window that does not — a spec MUST reset it (`call_invite {reset:true}`), since
  one mock process serves the whole run. A MID-CALL failure is reachable only through that
  mock's own `call_media` test hooks, because the page's simulated media never refuses anything
  and the service that does is a real tenant. There are FOUR of them, and each stands for one
  ending a capture really has: `{refuse:true}` refuses the NEXT offer outright (armed — a spec
  must reset with `call_invite {reset:true}`), `{drop:"screen"}` takes away a section the
  meeting had accepted, `{reject:"screen"}` answers the offer that added one by rejecting it —
  never accepted, which is what the tenant really did — and `{unreadable:true}` answers in a way
  no browser can read, which is the one that used to cost the whole call. The last three arm
  nothing: they happen on the live call at once.
- **A live call has ONE authorized target, and `cd web && bun run call-live` is the only way
  to ring it.** There is no sandbox for a call — the sandbox chat is a group thread, and
  ringing it would ring real people — so the target is not a place a mistake is harmless but
  a person who agreed to it: the one-to-one the user named out loud, a CONSTANT in
  `web/scripts/call-live.ts` (`AUTHORIZED_CALL_CONVERSATION`). It is the third live driver
  and it earns its place exactly as `sandbox-live.ts` and `join-live.ts` do — no argument can
  aim it elsewhere, the conversation is opened BY ITS ID rather than clicked for in the
  sidebar, the target is proved TWICE out of the app's own state immediately before the click
  (the composer's `data-conversation-id` and the call button's own), and it hangs up on every
  path out including a throw. Its microphone is a FAKE device capturing silence, so the offer
  is real and no real microphone opens. It exists because a call the service ENDS cannot be
  diagnosed anywhere else: the store keeps only "Call ended · 2s", the released build hides
  its backend's output, and the reason arrives on frames the page receives and renders
  nowhere — so it digests them (`endReasons`, `mediaLines`, shapes and never a key). Any
  wider live call is still the user's own click — see NATIVE-CALLING.md § 8 for what is
  unverified against the tenant.

## Video in a meeting — received, and sent

A meeting draws the pictures other people put into it — a colleague's shared SCREEN on the
stage, their CAMERA as a tile beside it — and it can put the user's own camera and screen
into the meeting (`web/src/components/call-video.tsx` draws one picture, `call-stage.tsx`
decides where each one goes and carries the two toggles, over `callVideo` /
`callLocalVideo`).

**Sending is the sharper half, and the split in the gates says so.** Receiving publishes
nothing about the user; sending puts their face — or whatever else is on their screen — in
front of everybody in the meeting. So `call_offer_media` is an `OUTWARD_METHODS` entry beside
`call_place`, every capture starts from one click, the browser asks its own permission under
it, and nothing in this app opens a camera on its own. Four more rules:

- **Both are OFF until asked, every call.** There is no remembered preference, because a
  camera that came on with the call is the worst thing this app could do.
- **The toggles are drawn only where they would work** — `can_send_media`, which the backend
  decides: the service refuses new media on a call that is not established (its own words),
  so a button before that reports a refusal the user can do nothing about.
- **The state is the BACKEND's** (`call.sending`), not the page's. Two open pages share one
  call, and a phone that reconnects mid-call has to be TOLD the camera is on rather than draw
  its button from its own memory.
- **The sender sees their own picture, and the screen is never mirrored.** A preview is not
  vanity: a screen share shows whatever else is on that screen, and the only way somebody can
  tell what the meeting is seeing is to see it too. A camera IS mirrored, because that is what
  a person expects of themselves.
- **The BROWSER can stop a share without asking us** — its own "Stop sharing" bar ends the
  track and nothing else. `onSendingEnded` catches that and takes the section down with the
  service, or the meeting keeps a section carrying no picture while the button still says on.
- **The track is stopped before anything that can fail.** A camera whose light stays on
  because a POST was refused is the worst possible outcome of turning it off.
- **The screen never carries system audio.** `getDisplayMedia` is asked with `audio: false`:
  the user is already on the call with their microphone, and they asked to show a picture.

Everything about it follows from one measured fact: **the service renegotiates on its own,
and its offer already carries the sections.** ~9 s into a join it POSTs a
`mediaRenegotiation`, and a second after somebody shares their screen that offer grows
`label:applicationsharing-video` at a fixed mid with its SSRC range declared. So there is
nothing to ask for — the whole receive path is *answer it, then subscribe*. It is not
unconditional: measured on five joins, the four that got one all had a second endpoint in the
meeting and the one that joined an empty meeting got none. Nothing here depends on the
difference — it answers what arrives and does nothing otherwise — but do not write a test that
joins alone and waits for an offer. Six rules hold it together, and
`web/e2e/calling.spec.ts` pins each:

- **An offer is not an answer, and this app used to read it as one.** `media_answer_from_frame`
  matched `mediaNegotiation` too, so the page was handed an offer where it expected an answer,
  checked its signaling state and dropped it — silently, every time.
  `calling::media_renegotiation_from_frame` runs FIRST and tells them apart by the frame's own
  `mediaAnswer` LINK, not by a url or a body name.
- **The MEDIA SOURCE ID comes from the roster and nowhere else.** A subscription names
  `sourceId`, which lives in `endpoints[<id>].call.mediaStreams[]` — the part of the roster
  the parser used to throw away. It is per meeting and it MOVES between joins, so it is never
  cached across calls. `call_state.publishing` carries it to the page, ours excluded: drawing
  the user's own camera as a colleague's tile is the one thing this surface must not do.
- **A LABEL is what tells a screen from a camera**, because both are `m=video` sections. It
  travels per section (`labels::SHARING` = `applicationsharing-video`), the service reads it,
  and `web/src/lib/ms-sdp.ts` echoes the OFFER'S OWN label back on the answer rather than
  deriving one from the m-line kind — a label chosen from the kind calls somebody's screen
  `main-video` and describes the wrong stream on the section it was handed.
- **The subscription is assembled from BOTH sides, which is why it lives in the store.** The
  source ids are the backend's (the roster); the mids and stream ids are the page's (what the
  browser reported on its `track` events, which exist only after the answer is applied).
  Neither half can do it alone. A screen takes a section before a camera does: it is the
  thing somebody deliberately put on screen to be read.
- **A section the far side DROPPED is read as absent** (`sectionIsStopped` in
  `web/src/lib/call-media.ts`). The service can reject a section this app offered, and the
  browser then STOPS that transceiver: it loses its mid, it carries nothing, and every setter
  on it throws. So a stopped one is never written to and never reused — switching the camera
  off wrote `direction` on it and handed the user the browser's own sentence, "The transceiver
  is stopped", as the report of a click that had worked. And the capture behind it is
  RELEASED, down the same path the browser's own "Stop sharing" takes: a camera whose light
  stays on under a button that says the meeting can see it, while nothing is sent, is the
  mirror of the failure that path already exists for. The two are told apart
  (`SendingEndedReason`), because a drop is SAID — one sentence, and the one action left
  (`captureDroppedMessage`) — while the browser's own bar is not: the user pressed that
  themselves. The mock takes a capture away by REJECTING its section (a zero port, which is
  how the service says one is gone — `rejectedLabels`, read by the stand-in that has no
  transceivers), so the whole reaction is pinned by `web/e2e/calling.spec.ts` with no tenant.
- **A failure here NEVER ends the call, and the ANSWER is where that rule was broken.** Audio
  is already up and untouched, so a renegotiation that cannot be answered or a subscription the
  service refuses costs one tile — and the service offers again. Ending a working call because
  a screen could not be drawn would be much the worse outcome. It happened, on 2026-08-06, the
  first time a screen was shared against the real tenant: the service answered our offer, the
  browser threw the answer out, and `onCallMedia` hung up — so the user got an error and then
  could not hear their coworker, twice in two minutes. `hangUpCall` releases the microphone and
  the remote `<audio>` elements before any round trip, so the call goes silent at once. Three
  rules follow, and `web/e2e/calling.spec.ts` pins each:
  - **WHICH answer it is decides everything** (`CallMedia.negotiated`, read off the connection's
    own `currentRemoteDescription` rather than counted). THE answer is what makes a call a call:
    with it refused nothing will ever be heard, so the call goes rather than sitting at
    "connecting" for good. A LATER one answers a renegotiation of ours, and losing it costs the
    picture. One reaction for both is the bug.
  - **An offer whose answer is unreadable is ROLLED BACK** (`abandonLocalOffer`), because a
    connection left in `have-local-offer` has every later renegotiation rolled back under it by
    the browser instead — and the captures it carried are released down the path a DROPPED one
    already takes, since nothing is being sent.
  - **The sentence says the call is still there** (`renegotiationRefusedMessage`). That half is
    load-bearing: the share stopping and an error arriving both say the opposite.
- **The sections a camera and a screen go out on are negotiated with the CALL, not when
  somebody presses share — on a ONE-TO-ONE.** That is the real client's own shape and it is
  why a screen share was refused without it: its `addModalities` forces both modalities
  `inactive` at the first negotiation of a one-to-one (`numVideoChannels` is 1 there), so
  every section exists in the FIRST offer and turning a share on ACTIVATES one the service
  already answered. This app offered one audio section and asked the service to accept a new
  `applicationsharing-video` mid-call; the service zeroed its port and nothing was ever
  shown. NATIVE-CALLING.md § 10.8 holds the client's code and the four things it settles.
  Four rules, and each is pinned by a test:
  - **A CONFERENCE is the opposite, and its behaviour is unchanged.** With `isMultiparty` the
    client creates no video entity until one is asked for, so a meeting adds the section
    mid-call exactly as this app always did. One reaction for both is what was wrong.
  - **The backend says WHICH** (`call_prepare`'s `one_to_one`), because the RING LIST is what
    says how many people a call reaches and only the backend fetches it. A conversation id
    does not answer it, and a backend too old to say reads as `false` — the older behaviour.
  - **An INCOMING offer is ADOPTED, never added to** (`LocalSenders.adopt`). The far side is a
    real client, so its offer already holds the layout: the sections are claimed from it BY
    LABEL (`reservedKindFor`), and a section labelled anything else is never claimed — putting
    the user's screen on a section the far side described otherwise is the one thing this must
    not do.
  - **A reserved section publishes NOTHING.** It is `inactive` and carries no track, so no
    camera and no screen is opened until the user asks: the consent gate is untouched.
- **A SCREEN is a SESSION before it is a track, and a meeting grants one at a time.** Measured
  2026-08-06 against the tenant: a meeting rejected an `applicationsharing-video` section
  outright — no mid, no label, a zeroed port — with the section negotiated correctly, labelled
  correctly and offering the codecs a client offers. What this app never did is ASK to present.
  The client asks first (`startContentSharingAsync` → the session's `start`), POSTing a
  `contentSharing` blob to the conversation's `addModality` link and setting `isPresenter` on
  the answer. So `call_start_sharing` and `call_stop_sharing` are `OUTWARD_METHODS` entries
  either side of the media offer, and the automation hook blocks a script that names either.
  Six rules, each pinned by a test:
  - **"One at a time" is a rule about the MEETING, never a reason to refuse the user.** The
    session CHANGES HANDS: measured 2026-08-06 against a colleague's real share, the service
    granted this endpoint the role — `role = "presenter"` in our own roster entry — and offered
    their `applicationsharing-video` section straight back at PORT 0, so their screen stopped.
    That is what every Teams client does when somebody presses Share while another person
    presents, and it is what this app does. `call_start_sharing` REFUSED it for a day, named,
    which took the one action the user came for away in the very state they wanted it in. It is
    ONE press either way — Teams asks nobody, and the colleague can take it straight back — so
    what the app owes them is the sentence BEFORE it: `shareTakeoverHint` names whose screen the
    press stops, on the control itself, the way `RECORD_HINT` carries what a recording costs.
    The backend reads the roster only to write one journal line, and posts at nobody else's
    session; the mock reproduces both halves the service publishes — their stream leaves the
    roster, and their section comes back zeroed — so the whole takeover is reviewable with no
    tenant.
  - **The session is asked for BEFORE the section is offered, and before the capture.** The
    order is the client's own, and it is the one rule of this feature no screen can show — a
    page that offered the media first looks exactly right and shares nothing. `web/mock/server.ts`
    records the order for that reason (`{kind:"call_sharing_order"}`), and a meeting that
    refuses to grant one never opens a screen picker.
  - **A CAMERA asks for nothing.** A meeting carries as many cameras as it has people; only the
    one screen is a session, so a camera stays the plain renegotiation it always was.
  - **The session's links are read APART from the call's** (`calling::ContentSharing`). The
    answer carries a `leave` of its own and `Links::collect` takes the deepest of a name, so
    merging it would overwrite the link this app hangs the CALL up on: giving a share back
    would have ended the call.
  - **It is given back on the ONE path every ending of a screen passes through** —
    `onLocalVideoChange`, which is the user's own press, the browser's "Stop sharing" bar, a
    section the meeting dropped, and an offer rolled back because its answer could not be read.
    It is the rule the microphone already follows: a release wired per ending misses one, and a
    meeting still believing this endpoint is its presenter REFUSES the next share. A spec
    catches that, because the mock refuses a second session while one is held.
  - **A share that cannot be given back is not one this app starts.** The answer's own `leave`
    is what `call_stop_sharing` posts to, and a session the service named no way out of is
    reported rather than remembered — the principle § The trackers states for an irreversible
    write.
- **A CONFERENCE is offered three video codecs, and a one-to-one is offered every one the
  browser has.** That split is the client's own — `allowedVideoCodecsMultiparty` is
  `[H264, AV1, rtx]` with `filterCodecsInSdpMultiparty: true`, while `allowedVideoCodecs` is
  empty and `filterCodecsInSdp` false — and this app offered Chrome's whole list everywhere:
  VP8 and VP9 first, into a service whose own video sections carry `H264/90000` alone.
  `conferenceVideoCodecs` is the pure half (H.264 FIRST, `rtx` kept because retransmission is
  not optional, and an empty answer means say nothing rather than offer no codec at all), and
  `LocalSenders.addVideoSection` is the ONE place a section is created, so the list cannot be
  forgotten on one of the two paths.
- **A colleague's video was never drawable, and TWO named refusals were in the way.** Both were
  found by driving a real meeting with a real second participant sharing
  (`bun run join-live -- --share`), and each one names itself — which is the whole reason to
  prefer a refusal over a hypothesis:
  - **Chrome threw the service's own offer out.** `InvalidAccessError … A BUNDLE group contains a
    codec collision for header extension id=3. The id must be the same across all bundled media
    descriptions` — the service gives one header-extension id two meanings across the sections of
    one bundle. `fromMsSdp` therefore makes the offer CONSISTENT before Chrome sees it: every URI
    keeps the first id it was given, and a URI whose id is taken moves to the lowest free one.
    Dropping the clashing line instead was tried and moved the problem — Chrome then numbered the
    extension differently per section in its ANSWER and the service refused that.
  - **The service threw our answer out.** `SdpParsingFailure`, with no line named. The cause was
    a section the browser had REJECTED: this app sent Chrome's whole description for it, and the
    client's own transform writes a stub — `m=<kind> 0 RTP/SAVP 34` with its mid and its label and
    nothing else (`Kn(e) = e.port === 0`). With the stub, the call survives the renegotiation.
- **A stream is filtered by the ENDPOINT that publishes it, never by the person.** One account
  joined from a laptop and a phone has two endpoints under one mri, so `call_state.publishing`
  excludes THIS endpoint's own streams (`RosterStream.endpoint_id`, the roster's own key for the
  device) rather than everything the user publishes. Excluding by mri hid a screen the user was
  really sharing from their other device: the section was negotiated and the tile drawn, and
  nothing was ever subscribed to, because the stream read as ours. Drawing this endpoint's own
  camera as a colleague's tile is still the thing that must never happen, and the endpoint is
  what says so.
- **Everything § 2.5 measured applies to an OFFER, and an ANSWER is left as the browser wrote
  it.** The capture IS an offer, and an answer carrying the same additions was refused three
  times over — `SdpParsingFailure`, each one ending the call a second after the answer went out.
  So an answer gets the transport profile, the labels and the SSRC range, and nothing else. The
  client draws the same kind of distinction in its own `rtcpTransform`, so direction-dependence
  is the shape of this transform rather than an exception to it — and `isAnswer` reads the
  ABSENCE of `a=setup:actpass`, because scanning for a role was fooled by one rejected section
  that carried its own.
- **Every section states its SSRCs as `a=x-ssrc-range`**, added beside the browser's own
  `a=ssrc:` lines rather than replacing them — which is what the captured client offer does
  (NATIVE-CALLING.md § 2.5) and what the service does on every section of its own. Audio is
  accepted without it, so it is not what makes a section work; a send section the service must
  allocate a channel for is where that would show.
- **A capture the meeting never ACCEPTED is not one it dropped, and the advice is the whole
  difference.** A section rejected in the answer to the very offer that added it never carried
  anything, so "Share it again" sends the user into the identical refusal — which is what
  happened, in the same second. `LocalSenders.noteAccepted` writes down what the far side
  agreed to at the one moment `currentDirection` still says so, `SendingEndedReason` carries
  `refused` beside `dropped`, and `captureRefusedMessage` names what is really left, which is
  real Teams. **Sending is still unverified against the tenant** (NATIVE-CALLING.md § 10.8):
  the only live attempt was refused, so a fix for the refusal itself waits for a refusal that
  names what it wants — the rule this whole plane was built under.
- **What the service GRANTED is in the journal** (`calling::media_sections`, on every answer,
  in the `call_offer_media` response and on the frame). The modalities were logged and they
  are a claim about what this machine asked for; only the answer says what came back, so the
  one live failure left nothing on this machine to read. It prints the SHAPE and never the
  content — kind, mid, label, accepted or REJECTED — which is the discipline
  `web/scripts/join-live.ts` already follows: no candidate, no fingerprint, no port.
- **`call_answer_media` is an `OUTWARD_METHODS` entry and `call_subscribe` is a
  `MACHINE_METHODS` one**, and the split is the point. Subscribing ASKS to receive and
  publishes nothing about the user. Answering carries an SDP — and an SDP is what would offer
  their camera — so it is gated as the widest thing it can do rather than as what it usually
  does. `param_modalities` refuses a name outside the four the service knows, because a
  modality is a claim about what this machine is sending.

`web/mock/server.ts` reproduces the whole flow with no tenant and no camera: it renegotiates
after the roster with the measured labels and mids, and `simulatedCallMedia` answers with
streams captured from a blank canvas — so `cd web && bun run preview -- --out /tmp/call --call`
shows the stage and the tiles with nothing leaving the machine.

## Recording a call — teams-lite's OWN file, and Teams is never told

A live call can be recorded from its own header: every picture in it and every voice in it,
into one video kept in this browser, drawn afterwards in the conversation the call was in —
for the one person who pressed record, and for nobody else
(`web/src/lib/call-recording.ts` decides what goes in the frame, `call-recorder.ts` writes
it, `recording-store.ts` keeps it, `web/src/components/call-recording-card.tsx` draws it).

**It is not Teams' recording, and it cannot become one.** Teams' own announces itself to the
meeting, uploads to OneDrive and drops a file in the chat for everybody; this one never
touches the calling service, posts no message and sends no byte anywhere — so there is
nothing to announce it with and nowhere to announce it. Two consequences follow, and both
are stated in the app rather than left to be assumed:

- **Nobody on the call is told.** The control says so in the words the user reads BEFORE
  they press it (`RECORD_HINT`, pinned by a test), because that is the one fact they decide
  with, and asking the people on the call is theirs to do. Never make the control quieter
  than that sentence.
- **It is ONE BROWSER's file.** It lives in this browser's IndexedDB, like the chat pins and
  the calendar preferences and for the same reason — there is no upstream to write it to. So
  a recording made on the phone is not on the laptop, the card and the Settings pane both say
  where it is kept, and Save is offered beside it, which is how a recording becomes a file
  the user really owns.

Ten rules hold it up, and `web/e2e/call-recording.spec.ts` pins each:

- **No RPC exists, and that is the design.** Nothing in this feature reaches the backend, so
  there is no `OUTWARD_METHODS` entry to add and none to want: a recording publishes nothing
  about the user and tells the tenant nothing. Sending the bytes to the backend instead was
  considered and rejected — it would mean a hundred megabytes of base64 over a socket built
  for JSON, and then serving it back to a `<video>` that has to seek. The narrowest place for
  a recording of somebody's voice is the machine that made it.
- **The PICTURE is composited; the app's window is never captured.** A `MediaRecorder` takes
  one stream and a call is many, so every picture is drawn onto one canvas by the stage's own
  rule — a shared screen is the subject, faces are a strip under it — and each tile carries
  the name the roster gave it, drawn INTO the file, because a recording of five faces is what
  nobody can name a week later. Capturing the window instead would record the sidebar, the
  reader's scrolling and whatever else is on their screen, and it would ask for a second
  screen-share permission for streams this app already holds.
- **Every voice is mixed, the user's own included.** `CallAudio` on `call-media.ts` is what
  exposes them — the remote streams play through elements that module owns and the microphone
  is a local variable, so this is the only place they exist. Reading them plays nothing: the
  mixer's output goes to the recorder and to no destination, or every voice would double and
  the microphone would feed back.
- **One call is one file, whatever changes inside it.** A camera that comes on, a screen share
  that ends, a colleague who unmutes five minutes in: the recorder is TOLD the current sources
  (`syncRecorder`, from every place the call's media changes) and re-points its own elements
  and nodes. It never restarts — a call recorded in five files is not a recording of the call.
- **The file is closed on the ONE path the microphone is released on.** `stopCallMedia` is
  where it happens, for the reason that function exists: every ending — the user's own press,
  the hangup, the far side leaving, a dropped transport, calling switched off — comes through
  it, and a recording lost because of WHICH side hung up would be a file that exists nowhere
  else. It is idempotent, so a press and a hangup in the same moment write one file.
- **The row in the history is not a message, and is drawn as one thing that is not.** No
  bubble, no side, no sender, no reactions, no "…" menu — nothing was sent, and a card that
  looked like a message would be this app claiming something reached the thread. It sits at
  the moment the recording ENDED, between what was said before the call and what was said
  after, because that is when it happened.
- **A recording asked twice is deleted for good.** There is nothing upstream to take a
  deletion back from, so this deletion is the whole deletion — the pattern Delete and Approve
  already use, for the sharper version of the same reason.
- **What became of the FILE never covers why the CALL ended.** The two arrive together —
  calling switched off, a dropped transport, both end the recording as well — so the recording
  speaks under an id of its own (`RECORDING_NOTICE`, beside `CALL_NOTICE` in
  `web/src/lib/notice.ts`) rather than replacing the sentence the user cannot work out for
  themselves. One subject, one id, is still the rule: a recording is a different subject.
- **A meeting joined from a calendar LINK names no conversation**, so its recording has no
  history to appear in — and Settings › Call recordings is where it, and every older one, is
  reachable. It is the renamed-people split exactly: the card belongs where the thing
  happened, the list belongs where a thing months old can still be found. That pane is also
  the only place that answers what they all COST, because these are the largest things this
  app keeps and the user is the only one who can decide one is no longer worth the room.
- **A browser that cannot keep one is not offered the control** (`recordingsCanBeKept`, false
  until the browser is asked, which is the same reading every unanswered capability takes in
  this app). A recording that had nowhere to go is a recording nobody asked for.

`web/mock/server.ts` needs no half of its own — the recording is the page's — and the whole
surface is still reviewable with nothing leaving the machine: `simulatedCallMedia` hands the
recorder canvases and one silent oscillator (`simulatedAudioStream`, the twin of the canvas
stand-in and there for the same reason: a real track makes the mixer path the one the mock
exercises), so a real `MediaRecorder` writes a real webm with no camera, no microphone and no
permission prompt. `cd web && bun run preview -- --out /tmp/rec --call-recording` captures the
control and its sentence, the live state, the stop the folded window keeps, the card in both
themes, its armed deletion, the composite a MEETING's recording holds, and the Settings list.

## A call is a PAGE, and it folds into a window

A live call takes the whole screen (`web/src/components/call-stage.tsx`, over the pure
`web/src/lib/call-stage.ts`): a header that names it and holds every control, one card with
the picture — or the person — in the middle of it, and a side panel for the people and for
the meeting's own chat. It used to be a card in the corner, which was the right shape for a
two-minute audio call and the wrong one for the thing this app grew into: a shared screen
does not fit in 26rem, and "who is in this meeting" does not fit in a line.

**A RINGING call is not the page.** It is an offer — nothing is connected and no microphone
is open — so it stays the card beside the conversation (`call-bar.tsx`, `callStageIsUp`):
taking the screen for something the user may decline would be the app deciding for them.
Everything after they answer is the page's, dialling included, because the microphone opens
there.

**The two shapes are ONE element, and that is the whole design.** Nothing is unmounted
between them, so the video keeps playing, the roster keeps arriving and the microphone is
never touched by a fold. Four rules hold the motion up, and `web/e2e/calling.spec.ts`
measures the geometry rather than trusting it:

- **The geometry is animated, not the layout.** `x` / `y` / `width` / `height` are motion
  values on one `position: fixed` box, and the content is ordinary flex that re-flows into
  whatever size the box has at that frame. So no part of it is ever a stretched picture of
  another size — at 40% of the way the stage genuinely IS 40% of the way, which is what makes
  it read as one object moving instead of as a window being resized. `STAGE_MORPH_SECONDS`
  (0.42) on a strong ease-out, because the movement crosses most of a screen.
- **The two contents crossfade over that movement**, quicker than it and led by it: a page's
  header and a small window's bar are different things and neither can be the other. They
  overlap on purpose — a `mode="wait"` swap would leave the box empty for the one moment the
  user is watching it.
- **The window is dragged with the same motion values**, so a window dropped in a corner
  expands FROM that corner and folds back TO it. Every drop is CLAMPED
  (`clampMiniPosition`) and so is every viewport change: a window left where it no longer
  fits would take the hang-up button off screen with it.
- **Its SIZE is a share of a narrow screen** (`miniSize`, pinned by `web/e2e/mobile.spec.ts`).
  This app is read from a phone, and 320px over a 412px viewport is not a call folded away —
  it is the app with a hole punched in it, which is the one thing folding exists to avoid. The
  height is 16:9 plus the control bar at every width, because a picture that is not 16:9 is a
  picture with black edges.
- **There is no close.** The stage is drawn for every live call, folded or not, because a
  call this app holds and shows nowhere is a microphone the user cannot find the off switch
  for. Escape closes the open panel, then folds — and never hangs up, since that is the one
  action here nothing takes back.

What the page itself decides:

- **A shared SCREEN takes the whole content, and faces give way to it.** A screen is text
  and it is the only thing in a call a tile is too small for; a face reads at any size. The
  user's own camera is a TILE among the others (it is what they look like to the meeting),
  and their own SCREEN is a corner preview that never becomes the content — a mirror of one's
  own screen inside itself is a hall of mirrors, but the only way to know what the meeting is
  seeing is to see it too. `callStageLayout` decides all of it in one place, and
  `call-video.tsx` draws one picture without knowing where it goes.
- **A call with no picture draws the PERSON**, centred, with what the call is doing under
  them. Most calls are that.
- **The header carries the time twice** — how long the call has been going, and the clock time
  it started at — because they answer different questions, and somebody who joined late is
  asking the second one.
- **The People panel counts the user themselves, first.** A meeting they are alone in still
  holds one person. What each person is sending is read from the ROSTER's own streams, never
  from the sections this page happens to have subscribed to: a camera is on for the meeting
  whether or not this machine asked to see it.
- **The CHAT panel is the app's own thread, in a column, and it is OPEN by default**
  (`initialCallStagePanel`). A call in a conversation is half a conversation — what is being
  said in the thread while people are talking is the other half — so the sidebar starts open
  rather than behind a click nobody would think to make. There is no second condition on
  that: every call with a thread behind it opens with it, on every screen. Three things
  follow:
  - **An open panel OPENS that conversation underneath**, so the history, the drafts, the live
    feed and the read state are the ones the conversation already has — there is no second
    history loader, and a message sent from the panel goes out through the same composer under
    the same consent. It runs from the panel being OPEN rather than from the click that opened
    it, so the default and the toggle take one path.
  - **It is drawn only where there IS a thread** (`callStageChatConversation`): a meeting
    joined from a calendar LINK names none — the service resolves one from the code and never
    tells us — and a conversation this app does not hold has nothing behind a tab. That is the
    one call that opens with no panel.
  - **So a call MARKS ITS OWN THREAD READ**, because opening a conversation does (see
    § Sending messages on `mark_read`). For every call the user starts that thread is already
    the open one and nothing changes; a call they ANSWER in a thread they were not looking at
    publishes that read when the page opens with its chat. That is the price of the default,
    it was asked for deliberately, and Ghost mode still decides whether Teams is told.
- **There is ONE composer in this app, and the panel TAKES it rather than adding a second**
  (`useCallOwnsComposer`). It carries the live sentinel `sandbox-live.ts` proves its target
  with (`data-conversation-id`), so two of them would give that question two answers — the
  spec asserts the count. Nothing is hidden by the handover: the panel only holds it while
  the stage is FULL, and a full stage covers the message pane completely.
- **A message is read here and acted on there.** No reactions, no edit, no delete, no "…"
  menu in the panel: a call's side column is for following what is being said and saying
  something back, and everything else is one fold away in the conversation itself, where it
  has the room its menus need. The transcript is bounded (`TRANSCRIPT_MESSAGES`) and not
  virtualized for the same reason — mounting a whole backlog beside a live video stage would
  cost the call frames.

`cd web && bun run preview -- --out /tmp/call --call` captures the page, both panels, the
folded window, the drag and the picture in both themes.

## Joining a meeting (the calendar stays read-only)

A calendar event with a Teams link offers **Join here** beside the way out to real
Teams (`web/src/components/meeting-join-button.tsx`) — and the MENU of the meeting's own
chat offers the same join, as one row of the one control every conversation's header carries
(see § ONE MENU in a conversation's header). A meeting is usually noticed in the chat list, which is
why both surfaces exist. It joins with a microphone and nothing else, so a meeting whose
point is a shared screen is still one to open in Teams.

**The event's footer holds TWO controls at every width: this app's join, and "Open in"**
(`OpenIn` in `web/src/components/calendar-event-details.tsx`). The panel is 320px beside its
event and a phone's screen in a dialog, and "Join here" + "Open in Teams" + "Open in
Outlook" is wider than either — on a phone the last of them fell off the panel's own clip,
so the event offered a join and no way to Outlook at all. Four rules hold it, and
`web/e2e/calendar.spec.ts` pins each:

- **A menu holds a CHOICE, so it is drawn only where there is one.** An ordinary event
  carries an Outlook link and no meeting, and it keeps the labelled link it always had: a
  menu whose single row is already named by its trigger asks for a click to say nothing.
- **The panel's width is its HOST's decision, never its content's.** What really clipped the
  footer was one unbreakable word — Graph's `bodyPreview` opens with the 80-character rule of
  underscores Outlook draws above a Teams block — widening a grid item whose `min-width` was
  `auto`. `min-w-0` on the panel and `break-words` on the tenant's own text is the fix, and
  the mock carries a real invitation body so the case cannot hide again.
- **Escape closes the MENU, and the panel takes the next one.** `@radix-ui/react-popover`
  ships its own copy of the dismissable-layer module, so on a wide screen the panel keeps a
  layer stack of its own and cannot know a menu opened above it — its Escape handler closed
  the whole panel from under the menu. The menu owns the key while it is open.
- **A click on an EVENT is not a dismissal** (`onInteractOutside` in
  `calendar-event-popover.tsx`), and the pane's background rule tests its own DOM subtree
  (`calendar-pane.tsx`). React events bubble out of a portal, so that rule used to see the
  clicks inside the panel and close it from a control the user had just pressed — and Radix's
  own dismissal then raced the click that re-opened it.

**Two ADDRESSES, because the user reaches a meeting from two places, and neither covers
the other** (`meeting_address` in `src/bin/server.rs`, `MeetingAddress` in
`web/src/lib/call.ts`; exactly one of `join_url` / `meeting_thread` ever travels).

- **A THREAD is a join address on its own** (`calling::MeetingJoin::from_thread_id`): Teams
  mints one conversation per meeting and puts it in the chat list, and that
  `19:meeting_…@thread.v2` id is what a long link carries in its own first segment. The
  `meetingInfo` beside it is what the service PREFERS, not what it requires — a long link
  with no context joins by its thread. So a meeting is joinable from the chat the user is
  already looking at, with no link to find: measured on this tenant, 399 of its
  conversations are meeting-backed and NOT ONE of them holds a join link anywhere in its
  history, because the invitations use the short shape and that code lives in the calendar
  event alone. Only a `19:meeting_` thread parses: a group chat has no meeting to join (it
  is called instead), and a channel meeting hangs off a message id a thread cannot name, so
  guessing `"0"` there would address the channel rather than the meeting inside it.
- **The title comes from the store for a thread, and from the caller for a link.** Each is
  read where it exists — a join link carries no subject, and a thread has a name of its own
  — so no title is ever minted twice.
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
- **A join is ONE POST, and the microphone travels in it.** It is the SAME body a call
  sends: `conversationRequest` + `groupChat` + `meetingInfo`, plus a `callInvitation`
  holding the offer — and minus `participants.to`, because a meeting rings nobody. The
  client's own builder makes both shapes from one function and posts once: `stream: {}` for
  the roster alone (a pre-join screen), `callInvitation` for a join with audio. The answer
  names ~37 links and the lobby state; **the media answer is not in it**, it arrives on the
  `mediaAnswer` callback link. See NATIVE-CALLING.md § 2.3a for the shape field for field:
  `messageId` is the string `"0"`, `meetingInfo.organizerId` is a bare oid, and there is no
  `conversationType`.
- **`addModality` is NOT the second half of a join**, and three things follow from the round
  that read it as one. The link grows a GROUP modality on a 1:1 call, so a join posted to it
  answers `400 subCode 5021 — no modality blob in the request`. The body must carry no
  `payload` envelope: every builder in the client's own bundle returns one, and its
  transport strips it (`JSON.stringify(s.payload)`) — a wrapped body is refused `400` with
  `{}` and names nothing, which is what this app sent for days. And a refusal measured while
  the request was ALREADY failing for another reason proves nothing: "media in the first POST
  is refused, measured twice" was recorded here in good faith and was the envelope all along.
  Check the baseline passes before believing a variant.
- **A join rings nobody**, which is the only thing it does differently from a call: the
  payload carries no `participants.to`. `call_join` is still an `OUTWARD_METHODS` entry,
  because everybody already in the meeting sees the user arrive and their microphone is
  opened to all of them.
- **The lobby is its own state.** A meeting may hold the user in its lobby
  (`ConnectedForRosterOnly`), and the UI says "Waiting to be let in…" rather than
  "Connecting…" — the one thing they have to know is that nobody has admitted them yet.
- **The roster is what "who" means in a meeting.** `rosterUpdate` frames replace the list
  wholesale, we are dropped from it (`CallSession::others`), and the header names one or two
  people and counts a crowd — the People panel is where every name is (see § A call is a
  page). A meeting's title stands where a call names a person.
- **Several voices, several audio elements.** Teams sends a meeting's voices as separate
  streams, so `call-media.ts` keeps one `<audio>` per remote stream and drops each when
  its stream ends. A single element would play one person and silently drop the rest.
- **The calendar is untouched.** Joining writes nothing, answers no invitation and
  follows no link on the user's behalf — the app still never opens `join_url` itself, and
  the read-only rules of § The calendar hold exactly as before.
- `cd web && bun run preview -- --out /tmp/call --call` captures the Join button, the
  lobby and the roster, and `web/e2e/calling.spec.ts` pins them.
- **A join is EXERCISED against the tenant by `cd web && bun run join-live`, and nothing
  else can.** It works — verified 2026-08-05 end to end, with the user hearing and being
  heard in a real meeting; the script itself proves the path as far as `getStats` can
  (`connected/connected via prflx/udp -> relay/udp`, 2093 RTP packets sent), and a fake
  microphone can never prove more than that —
  and it took five refusals to get there — every one of them named by the thing that
  refused it, and none visible without this script. That is the point of it: the mock has
  no tenant, and `examples/meeting_join_probe.rs` has no browser and fabricates the surl
  its callbacks sit on, so the acceptance, its answer and the acknowledgement the service
  waits 30 s for were all invisible. The script is the live twin of `sandbox-live.ts` and
  carries the same rails — the meeting is a CONSTANT, the caller gets no raw page, the
  button's own address is re-read immediately before the click, and it hangs up on
  every path out including a throw. Its microphone is a FAKE device, so the offer is real
  and no real microphone opens. Both live drivers are named in the automation guard's
  allowlist; a copy of either parked outside the repo is still blocked.
  **`--from-chat` drives the other surface**, the CHAT header's Join, and it earns its place
  the same way rather than by being a flag on a script that already exists: the thread is the
  same constant (`AUTHORIZED_MEETING_THREAD`), the conversation is opened BY THAT ID instead
  of clicked for in the sidebar, and two things out of the app's own state are checked before
  the click — the composer's `data-conversation-id` and the button's `data-meeting-thread`.
  No argument can aim either mode at another meeting. **The thread-addressed join is NOT yet
  verified against the tenant**: it needs the always-on service re-staged onto the commit
  that added it, and then one run of that command.
- **The button states which meeting it joins** — `data-join-url` for a link,
  `data-meeting-thread` for a thread, never both — for the same reason the composer states
  its conversation: an outward action a driver cannot prove is one it must not take.

## The user's own status (outward, and gated like one)

The app can hold the user's Teams status green — the **Always available** setting, off
by default (`src/teams_presence.rs`, `set_always_available` in `src/bin/server.rs`).
Reading other people's presence is the older half of that module and stays open; the
publish is gated, because a green dot is a claim about where the user is that every
colleague reads.

**AND IT KEEPS HOURS, because green at 03:00 is a claim nobody believes.** The setting
was a plain switch and published Available at three in the morning as eagerly as at
eleven — which defeats the one thing it is for: a status that reads as a person at their
desk. So it carries a WINDOW (`08:00-19:00`) and the ZONE that window is kept in
(`Europe/Paris`); the pane draws the window as a two-thumb SLIDER over one day with the
exact hours as fields beside it, and the zone as a picker under both
(`web/src/lib/presence-hours.ts` holds the pure half, `SETTING_AVAILABLE_HOURS`,
`SETTING_AVAILABLE_ZONE` and `presence_intent` the backend's). Nine rules, and each is
pinned by a test:

- **The switch is the CONSENT and the window only NARROWS it.**
  `teams_presence::should_publish` is the one spelling of "should this machine be green
  right now", read by the RPC, by the heartbeat and by the settings answer alike — two
  answers to that question is the bug that shows as a switch saying one thing while
  colleagues see another. Off is off whatever the hours say.
- **NO window is ALL DAY**, which is exactly what the setting did before it grew one — so
  an install that never sets hours behaves as it always did, and an older page that sends
  neither hour is not silently rescheduled.
- **The two hours are a PAIR: both or neither** (`available_hours_param`). A half window
  reads equally as "all day from 8" and as "8 until whenever", so the backend refuses one
  and the pane stores nothing until the reader has said which — the rule a diff's
  `diff_refs` and a picture's `width`/`height` already follow.
- **`from == to` is refused, and an end BEFORE its start crosses midnight.** `09:00-09:00`
  reads equally as never and as all day, and one character deciding between those is a
  setting nobody can check; `22:00-06:00` is a night shift, and refusing it would be an
  arbitrary limit on the same comparison inverted. The end is exclusive, which is what the
  two numbers read as.
- **The CLOCK is the backend's and the ZONE is the user's, which are two different things.**
  The process that has to decide at 03:00 with every window closed is the backend, so it holds
  the clock — but the zone cannot be that machine's, because the PERSON travels while the
  always-on service stays in one flat: 08:00 set in Paris is not 08:00 read from Tokyo. So
  `SETTING_AVAILABLE_ZONE` holds an IANA NAME and `teams_presence::minute_of_day` resolves the
  instant in it (the whole of the `chrono-tz` dependency). A name and never an offset, because
  an offset is an hour wrong for half the year — Paris is UTC+2 in August and UTC+1 in
  December, and an hour is exactly the size of the mistake this feature exists to avoid. No
  zone is the MACHINE's own, which is the older behaviour and what an install that never set
  one keeps; a name the database does not hold is REFUSED at the RPC, because a typo answered
  with this machine's zone publishes the user's status at hours nobody chose.
- **The zone the pane OFFERS comes from the browser, and the list costs the wire nothing.**
  `Intl` is where the reader is, which is the fact the setting exists for, so the picker's
  options are `Intl.supportedValuesOf("timeZone")` and a one-press "Use Europe/Paris" appears
  only while that is not the stored one — a control that changes nothing reads as a bug. The
  backend validates against its own copy of the same IANA database, so nothing here trusts the
  page's list.
- **The window is a SLIDER, and the fields are what a slider cannot do.** Two thumbs over one
  day at a 15-minute step is how somebody says "my day looks like this", and it is one control
  for one value — but the thumbs cannot pass each other, so a window that CROSSES MIDNIGHT can
  only be typed, and aiming at 08:30 is slower than typing it. So both are drawn over one
  state: `hoursSlider` / `hoursFromSlider` carry the window's MODE through a drag (without it
  one drag turns 22:00-06:00 into its opposite), a wrapped window is drawn green on the OUTSIDE
  of the two thumbs (the primitive's own range is one element, so the pane draws both
  segments), and a DRAG publishes nothing — `onValueCommit` is the write, because a publish per
  frame is dozens of outward calls for one gesture. The thumb carries 44px of touch target
  around 16px of ink (`web/src/components/ui/slider.tsx`, the ninth radix primitive here), and
  the keyboard moves it, which is what the spec drives it with.
- **The HEARTBEAT is what turns the hours into a status, and its two edges are not
  symmetric.** Nobody is clicking anything at 08:00 or 19:00, so the heartbeat acts:
  inside the hours it registers, and it keeps registering because a registration EXPIRES;
  at the end of them it withdraws ONCE. A DELETE every two minutes all night would be 700
  pointless requests a day and a journal full of them. With the switch OFF it says nothing
  at all — the RPC that turned it off already withdrew — which is why an install that never
  turned this on still makes no presence request.
- **`available_now` is stated by the backend, and the page is TOLD when it turns.** The
  clock and the zone that decide it are the backend's, and they are often not the reader's
  — the always-on service runs on a machine at home while the page is a phone somewhere
  else — so the page never works it out (the reading `mentions_me` already takes). The
  heartbeat emits `settings_changed` on the turn, so a Settings pane left open across 19:00
  stops claiming a green dot the backend has already withdrawn.

`web/mock/server.ts` mirrors the store and every refusal with no tenant — the window, the
zone, and `available_now` resolved in that zone over the runtime's own IANA database (it
publishes no presence at all, which is what makes driving the switch safe). `cd web && bun run
preview -- --out /tmp/av --available` captures the switch off, on all day, the hours running,
the hours not yet come round, a window crossing midnight and the card at a phone's width, and
`web/e2e/always-available.spec.ts` pins every rule the page owns. **The hours and the zone are
untested against the tenant**, and deliberately: the publish and its undo are the two calls
that were measured, and a window only decides WHEN this app makes them.

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
  refreshes it every 120 s while the setting is on and inside its hours, and the first
  tick restores the state after a restart. One endpoint id lives in the store, so the
  always-on service and the user's dev backend refresh ONE registration rather than two.
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
- **The local agent can mention the people of the thread it answers in, and nobody
  else.** An answer writes `@[Full Name]` or `@Name`, and `agent_markdown` turns it into
  the same pair a composer builds (see § The local agent). Four rails, all
  in code: the candidates come from that conversation's own roster
  (`thread_mentionable_people`, the very list the `members` RPC offers), a name that
  resolves to nobody or to two people stays plain text, the span shows the name the
  THREAD holds rather than the text the model typed, and a mention inside a code span is
  code. The edit path carries `properties.mentions` for this — an agent's body only
  exists after the edit, so a mention it writes can travel nowhere else — and
  `build_edit_body` refuses a mention with no span exactly as a send does.
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
- **A RENAME wins over both sources** (`rename_mentionables`, applied last). The store's own
  read already resolved it for whoever has WRITTEN in the thread, so the list gave two
  answers to "what is this person called": their nickname where they had written, and Teams'
  own name where the ROSTER was all this machine knew of them — inside one menu, and inside
  one prompt for the local agent. It is applied after the directory batch because that batch
  overwrites, so an override applied earlier is undone by the very lookup that names a silent
  member. The mock has always answered this way, which is the shape the app is reviewed
  against, and § Renaming a person names the @mention list among the surfaces a rename
  reaches. What it costs is stated where it is: the span a mention posts carries the name the
  list gave, so a colleague sees the nickname — which is what this app already posted for
  anybody who had written in the thread.
- **An inbound mention pasted back into the composer goes out as plain text.** Its span
  indexes the list of the message it came from, so it names nobody we can prove — see
  `serializeTeamsMessage` in `web/src/lib/rich-text.ts`, which is where the outbound
  pair is made.

## Custom emoji

The user can upload, name and use custom emoji and GIFs, the way Slack does. `:shipit:`
in the composer becomes the art in the message, and the art travels WITH the message —
so a reader needs no pack to SEE an emoji, only to USE one. That is what makes this
feature worth having: a local-only decoration would be a different, smaller feature.

- **The code IS the wire format.** `:shipit:` reaches the wire as plain text, and the
  BACKEND substitutes Teams' own inline-emoji markup for it (`custom_emoji::substitute_codes`,
  called from the send path and the edit path in `src/teams_send.rs`). Two reasons that
  shape follows, and both are load-bearing: the `edit` RPC sends plain text only, so an
  emoji that lived in composer markup would be destroyed by every edit; and Slack renders a
  hand-typed `:shipit:` too, so the autocomplete is a convenience rather than the mechanism.
  The nearest precedent in this codebase is the agent tag — a chip in the composer, bare
  text on the wire, read back by the backend.
- **A LONE ":" opens the list, and offers the PACK.** Somebody who has just added their
  first emoji does not know its name yet, so "type a letter and I will tell you what you
  have" is backwards — the colon is the ask. An empty query therefore returns the pack from
  `emojiSuggestions`, and **no Unicode shortcode**: every one of the ~1800 matches an empty
  prefix, so including them would bury the user's own art under whichever ten sort first.
  The index is in generated order, so those ten would be `:100:` and `:1234:`. A Unicode
  emoji is still reached by naming it, exactly as before, and one typed letter brings the
  band back. The two rules that keep prose out are untouched and each has its own test: the
  colon must open the line or follow whitespace (so `note:`, `18:30` and `https:` are
  words), and whitespace ENDS a query (so `: ` closes the list again). Three details of
  that list are load-bearing:
  - **The rows are sorted by name in `emojiSuggestions`, not trusted from the caller.** The
    store orders them (`store.rs`: `ORDER BY name ASC`) and a Map-backed mock did not, so a
    menu whose order depends on which backend answered is a menu no spec can pin. The mock
    sorts now too, and the unit test asserts the sort on a deliberately unsorted pack.
  - **Enter SENDS on a lone colon, and PICKS once a letter is typed** (`handleKeyDown` in
    `web/src/components/rich-editor.tsx`). French puts a space before a colon — "voici :" —
    so a message ending in one is an ordinary sentence, and stealing its Enter would post an
    emoji nobody asked for instead of the words. Tab picks in both cases: it means "complete
    this" and it sends nothing.
  - **A row is activated on `mousemove`, never on `mouseenter`** — in BOTH composer
    typeaheads, `web/src/components/emoji-suggestions.tsx` and `mention-suggestions.tsx`.
    Either list opens right over the field the reader just clicked, so a row appearing
    beneath a STATIONARY cursor fired `mouseenter` and took the active row away from the
    keyboard. That broke rule 5's own test before it was found. The mention list carried the
    same line and a bare "@" opens it the same way, so it was changed with the emoji one
    rather than left to be found later. `mousemove` is the honest "the reader moved the
    mouse here" signal.
  - The chip carries the name of the row that was PICKED, so an alias chip is
    `data-emoji-name="ship"` while the body it serializes to holds `:shipit:`. A spec that
    types `:ship` and then asserts on `shipit` art is asserting on the wire, not the chip.
  Pinned in `web/src/lib/custom-emoji.test.ts` and by rules 5 and 5b in
  `web/e2e/custom-emoji.spec.ts`.
- **This was measured, not assumed.** Two probes established the shape against the real
  tenant on 2026-08-05. `examples/custom_emoji_send_probe.rs` posted a message with two
  inline `<img itemtype="http://schema.skype.com/Emoji">` images mid-sentence, and read it
  back through this crate's own parser — and every attribute survived Teams' server-side
  sanitizer: `itemtype`, `src`, `width`, `height`, and the inline positioning between the
  words. Teams REWRITES the src host to `fr-prod.asyncgw.teams.microsoft.com`, so nothing
  may key on the upload host, but `teams_media::is_allowed_media_url` already covers that
  form. An AMS object can be re-referenced by a second message (200 OK), so the per-send
  upload is a choice rather than a necessity. Stock Teams draws them at text size, so
  parity is real. `examples/custom_emoji_reaction_probe.rs` PUT the emotion key this app
  really mints — `tlcustom-<the AMS object URL>`, 116 characters — on a message in the
  sandbox thread: 200 OK, read back in `properties.emotions` BYTE FOR BYTE, cleared with
  `value: 0`, and a 289-character key is accepted too. The probes are pinned to the sandbox
  channel const, and the run commands are verbatim:

      . bin/broker-env.sh && teams_lite_export_broker_bus && \
        cargo run --example custom_emoji_send_probe

  and the same shape for `custom_emoji_reaction_probe`. Both are reversible writes to the
  sandbox chat only, which § Sending messages pre-authorizes.
- **A colleague's emoji is drawn from THEIR message's bytes, never from the reader's pack**
  — and there is deliberately no client-side substitution of a code into art anywhere. Two
  people may each have a `:shipit:` and they may be different pictures, so redrawing their
  words with our art would be this app putting words in their mouth. It is the same rule
  that stops a local nickname from rewriting the record of a Teams frame.
- **An emoji somebody SENDS joins the reader's pack as the message arrives, under the name
  its sender gave it.** Seeing a colleague's emoji and being able to USE one were two
  different things: the art travelled, so it drew — but `:shipit:` posted nothing until the
  code had been picked out of that message's own "…" menu, one emoji at a time, which is a
  pack nobody fills. It fills itself now
  (`import_emoji_from_message` in src/bin/server.rs, over `custom_emoji::art_in_body` and
  `take_as`), and the whole thing rests on one fact that was already true: the markup this
  app writes carries the NAME in `itemid` beside the art in `src`, so a colleague's emoji
  arrives complete and nothing about it is guessed at or asked for. Seven rules hold it,
  each pinned by a test:
  - **It happens on INGEST, beside push and the agent trigger** (in the trouter loop), not on
    render. That is where every other "this message is new" reaction already lives, and it
    covers a channel nobody has scrolled to.
  - **A REACTION is a source, and on this tenant the commonest one** — so the import runs on
    `inserted || reactions_changed`, which is where it differs from push and the agent beside
    it. A reaction arrives as a frame on a message the store ALREADY holds, so `inserted` is
    false: gated on it, the art most colleagues send would never have been seen. A changed
    reaction set is as much "new emoji" as a new message is. The name comes from the key
    (§ A custom reaction's key), and a key too old to carry one is SKIPPED rather than given
    an invented name — see the manual row below, which is what is left for those.
  - **The work is CLAIMED per UPLOAD, not per message** (`emoji/<name>#<src>`), because this
    machine runs two send-capable backends against one store and both ingest every frame. Per
    MESSAGE was the first shape and it was wrong for exactly the reason above: the insert takes
    that claim, and every later reaction on the message is then dropped. An AMS object is one
    upload, so the key is precisely "these bytes, under this name". It stays an optimisation
    rather than a rail — a lost claim costs one repeat fetch that `take_as` skips on the bytes.
  - **A name the user already holds is NEVER overwritten.** Their `:shipit:` keeps posting
    their own art; the colleague's arrives as `shipit-2`, bounded, and an ALIAS blocks a name
    too. Both pictures exist, under two words — which is the only shape that does not put a
    colleague in charge of what the user's own message posts.
  - **Art the pack already holds is not taken twice, and the BYTES are what say so**
    (`Store::custom_emoji_named_by_bytes`, one `WHERE bytes = ?`). Not a nicety: every send
    re-uploads the art to a fresh AMS object (`teams_send::resolve_custom_emoji`), so the URL
    is new in every message and cannot answer it — without the byte check the second
    `:shipit:` message would mint `shipit-2`, the third `shipit-3`, and a busy thread would
    fill the pack with copies of one glyph.
  - **The art must come from a TEAMS host** (`teams_media::is_allowed_media_url`, the rail
    `custom_emoji_add` already holds), which is also what keeps Teams' OWN emoji out — theirs
    wears the same `itemtype` with a name-shaped `itemid`, and what differs is that the
    personal-expressions CDN is not on that list. And the bytes are MEASURED, never believed:
    the same caps an upload from the dialog passes.
  - **A quoted emoji is not taken**, because a quote is words said earlier and its art came
    with the message it quotes — `art_in_body` reuses `substitute_codes`' own walk, so the
    skipped regions are one list rather than two. The trap that cost a test: a skipped region
    arrives as ONE raw segment beginning just after its opening tag, so a quote whose first
    child is an emoji starts with `<img` and reads exactly like a lone tag.
  - **It is a SETTING, on by default** (Settings › Custom emoji, over
    `SETTING_EMOJI_AUTO_IMPORT` — the sender-icon switch's own shape and default). What it is
    for is the one thing the pack decides: what art `:shipit:` posts under the user's own name
    on the next send. A store this app cannot READ counts as off, because a failed read is not
    an answer; a read-only backend never writes at all.
  - **The manual row stays, takes itself away, and is the ONLY way in for art with no name.**
    `extractableCustomEmoji` refuses a code the pack holds and the import emits
    `custom_emoji_changed`, so "Add to my emoji" disappears on its own once the emoji is in,
    and remains where it is still the only way: an older message, the switch turned off, and —
    the case it now exists for — **a reaction whose key was written before the name travelled**.
    That art is in every reader's history already and nothing but the reader can name it, so
    the row offers it with an EMPTY code and the dialog opens on the art with the name field
    blank. It reads a reaction only as a FALLBACK, after the body, because the body is where a
    code the reader has actually seen written is.
  The mock carries the SWITCH and deliberately not the import: the import is a backend act on
  a frame, with no surface of its own, and a mock reimplementation of `take_as` would be a
  second spelling of the one policy that can drift from it. What is UNVERIFIED against the
  tenant is the pairing — one real colleague's emoji arriving on a live frame — since the
  reads and the markup are measured (above) and the policy is pinned in Rust.
- **Three regions are never substituted**: `<code>`, `<pre>`, and a reply quote. The first
  two because Slack does not render an emoji in code either; the third because a quote
  holds a colleague's own words and substituting our art into them would rewrite what they
  wrote — the same reason `agent_policy` strips quoted blocks before reading a trigger.
- **An emoji among words is TEXT-SIZED; a message that is nothing but emoji drops the bubble
  chrome and draws them LARGE.** Among words an emoji is punctuation in a sentence, and a
  glyph twice the height of the line it sits on is not readable — but a message whose whole
  body is emoji has no sentence to sit in, and there the content IS the surface. That is the
  argument the link-, image-, card- and recording-only messages already make in
  `web/src/components/message-bubble.tsx`, and `emojiOnly` joins that family and feeds the
  same `bare` flag: no fill, no padding, no rounded corners, just the art. **The two halves
  are ONE decision and must stay one** — a large emoji still inside a padded bubble reads as
  an uploaded picture in a frame, and a text-sized one inside a bare row reads as a mistake.
  Both were built on the way here and both were wrong, which is why the flag is computed
  once, in the bubble, and the size travels down from it (`jumbo`, threaded through
  `RichContent` to `CustomEmoji`) rather than being decided a second time from the same
  nodes. `jumbo` is carried through `childCtx` in `rich-content.tsx` for a reason worth
  keeping: Teams wraps a body in a `<p>`, so every emoji this flag exists for is a child
  rather than a top-level node, and a flag that did not descend would die at the paragraph.
  `bodyIsOnlyEmoji` (`web/src/lib/custom-emoji.ts`) is the walk that answers it — whitespace
  is skipped, because Teams indents what it wraps and a phone keyboard commits a trailing
  space as the send key is pressed. `web/src/lib/custom-emoji.test.ts` pins the walk and
  `web/e2e/custom-emoji.spec.ts` pins both halves in one test, on purpose: either assertion
  alone would pass over one of the two shipped mistakes.
- **An animated GIF animates for a teams-lite reader and not for a stock Teams one, and
  that is Teams' own limitation rather than ours.** Measured 2026-08-07, and worth writing
  down because it is a day's work to rediscover:
  - **AMS transcodes the rendition a message body references.** An uploaded GIF's
    `views/imgo` — the view the markup names — is answered as `image/jpeg`, a single still
    frame. `content/imgpsh` answers the original `GIF89a`: 61 300 bytes, 17 frames,
    `NETSCAPE2.0`. So this app fetches `content/imgpsh` (`originalArtUrl` /
    `original_art_url`), and that one change is the whole of the animation. The object's own
    metadata lists its contents as `imgo` (4 508 bytes), `imgpsh` (61 300), `img_small` and
    `imgpsh_thumbnail_sx`; `views/imgpsh`, `views/original` and `views/img_small` are all
    REFUSED, and `views/imgpsh_thumbnail_sx` answers a still PNG.
  - **Declaring the format does not help, and every way of declaring it was tried**: a
    `.gif` filename, a `contentType` field, an `originalContentType` field, an `image/gif`
    content-type on the upload PUT, and the object types `pish/gif`, `pish/animatedImage`
    and `pish/video` — each either refused or still transcoded.
  - **Teams' own client has the same limitation, and that is the fact that settles it.** A
    Tenor GIF that real Teams uploaded is served from `views/imgo` as `image/jpeg`, its
    markup declares `itemscope="png"`, it carries no animation attribute of any kind, and
    its `content/imgpsh` is already 404. Teams shows an animated GIF only when the body
    references a PUBLIC url — a `media1.giphy.com/….gif` — which is exactly why a giphy
    pick animates for everyone and an uploaded file does not.
  - So a teams-lite reader sees the animation because this app fetches the original, and a
    stock Teams reader sees the still frame, exactly as they would for any GIF Teams itself
    uploaded. Getting animation to every client would mean publishing the user's art to a
    public host, which this app does not do — so do not go looking for a rendition or a
    declaration that fixes it. The numbers above were measured by
    `examples/custom_emoji_gif_probe.rs`, which stays because it re-checks the one fact code
    rests on (`original_art_url`), and by a second example that walked every rendition and
    every declaration in a matrix. That one is deleted: its question is CLOSED — the answer
    is the paragraph above, no code path depends on any variant it tried, and re-running it
    could only re-measure a refusal this file already records.
- **The writes are gated, and why.** `custom_emoji_add` / `custom_emoji_remove` /
  `custom_emoji_import` are `MACHINE_METHODS` entries even though they write only to the
  local store, because the pack decides what art this machine will post under the user's
  name on the next send. The reads stay open. The automation hook blocks the three names
  against a live port.
- **The URL source is the one place this feature touches a stranger's server**, and it
  reuses `src/sender_icon.rs`'s existing rails rather than copying them — public-IP-only
  resolution (a hostile domain pointing at `169.254.169.254` would make this an SSRF into
  the cloud metadata endpoint), a raster sniff on the bytes rather than the claimed content
  type, a byte cap, no cookie or referrer of its own. A colleague's emoji lifted from a
  message takes the OTHER path, `teams_media::fetch_media`, which is authenticated and
  host-allowlisted. Say plainly that the two must never be confused: a Teams URL on the
  unauthenticated path simply fails, and a stranger's URL on the authenticated one would
  send the user's token off-tenant. That mistake was made once during the build and is
  worth recording as the reason the rule is written down.
- **Slack's limits, copied**: 128 KB, 512 px on a side, PNG/JPEG/GIF/WebP and never SVG.
- **A picture too big is SHRUNK where it is pasted, and the BACKEND still re-encodes
  nothing.** Slack takes a screenshot somebody pasted and reduces it; refusing one with
  "512 pixels or smaller on a side" sends the user out to an image editor for a glyph that
  will be drawn at 20 px. So the Add Emoji dialog redraws it — `emojiOversize`
  (`web/src/lib/custom-emoji.ts`) decides, `redrawSmaller` in `add-emoji-dialog.tsx` draws,
  and what is SENT is already inside both caps. Five rules hold it, and each is pinned by a
  test (`custom-emoji.test.ts` for the arithmetic, `web/e2e/custom-emoji.spec.ts` for the
  paste):
  - **The caps stay the STORE's invariant.** `custom_emoji::measure_art` is unchanged and
    still reads the type and the size out of the bytes, so the shrink is what stops a
    refusal from happening rather than a way around one — the discipline the dialog's own
    measurement already had (it is "a courtesy rather than the check").
  - **The box is 128 px, not the 512 px cap** (`EMOJI_SHRINK_DIMENSION`, Slack's own emoji
    size and the size the slackmojis in the pack already are). It is well inside BOTH caps,
    which is what makes one pass enough: 128x128 of raw RGBA is 64 KB, so a PNG of it cannot
    reach the 128 KB one. Redrawing at 512 px would fit the dimension and fail the weight.
  - **Nothing is ever drawn LARGER, and the shape is kept.** A small-but-heavy picture is
    re-encoded at its own size — upscaling it to 128 px would make it heavier — and a
    squashed emoji is worse than a refused one.
  - **A GIF is still REFUSED, for the reason nothing re-encodes one anywhere in this app**:
    its frames live nowhere a canvas can see, so a redraw keeps the first frame and throws
    the animation away. The refusal names that and says what to do instead.
  - **The dialog says it shrunk the picture** (`add-emoji-shrunk`, naming the size it
    arrived at). Reducing what somebody handed the app without saying so is the app quietly
    changing their art. The URL source is untouched: those bytes are fetched by the backend,
    which measures and refuses them as before.
- **A custom reaction's key carries the art's address AND its name**:
  `tlcustom-<objectUrl>#<name>`. A REACTION is how most custom emoji actually arrive —
  measured on this tenant by `examples/custom_emoji_inbound_recon.rs`: 11 messages hold one,
  addressing 14 distinct pictures against the 12 in the pack — so a key that named only the
  art left the commonest case drawn and unusable, which is the whole complaint the
  auto-import answers. Six things hold it, each pinned by a test:
  - **`#` is what makes carrying both possible**, and it is chosen rather than convenient. It
    is in NEITHER half — not in the name charset `[a-z0-9_+-]`, not in an AMS URL — so the
    key splits on the FIRST one, unambiguously. The old `<name>-<id>` shape could not: a name
    may hold digits and hyphens (`blob-2`, `parrot-1`) and an AMS id starts with one. Those
    keys are still in this tenant's history and `custom_reaction_art` reads them, minus the
    name it cannot recover.
  - **It is ADDITIVE on the wire, which is the second reason for that character.** `#` opens
    a URL FRAGMENT, and a browser never sends one to a server — so a teams-lite too old to
    know about the name reads the whole remainder as the address, asks for
    `…/views/imgo#shipit`, and is served the same object. A colleague on an older build loses
    nothing.
  - **The tenant accepts it, measured** (`examples/custom_emoji_reaction_probe.rs`, run
    2026-08-12 against the sandbox chat): the key was accepted `200`, read back out of
    `properties.emotions` **byte for byte** with the `#shipit` intact, split back into art +
    name through this crate's own reader, and cleared with `value: 0`. A 289-character key is
    accepted too, and an object URL plus a name is ~110.
  - **The PAGE never mints that key** — the object does not exist until the backend has
    uploaded the art, so `react` takes `emoji` (the pack name) and the backend mints from what
    the upload answered — and **a toggle-off hands the EXISTING key back verbatim**, with no
    upload and no re-mint.
  - **A name is held to the store's own rule before it is believed**, on both sides
    (`is_valid_name` / `isValidCustomEmojiName`): a key is written by whoever reacted and the
    name is about to become a row. A refused name costs the LABEL only — the art still draws,
    because the art was never the missing half.
  - **A LABEL is still resolved locally or stated neutrally, and ART never is.** Two people's
    `:shipit:` are two different pictures, so the chip draws the bytes the key names. What the
    name buys is that the reader can now TYPE the emoji — and that the chip can SAY which
    emoji it is (§ WHO reacted) — not that their own art is substituted into somebody else's
    reaction.
- **Custom art in a stock Teams REACTION row is impossible**, and this is the one place
  Slack parity ends: their client renders a reaction from its own asset catalogue and has
  no fetch path. Both halves of the reaction surface say so — the quick row's custom band
  and the picker's own footer. What a stock client draws INSTEAD has never been observed,
  on any run of the probe, so neither the UI nor the spec claims it: they say the art is
  drawn in teams-lite and stop there.
- One sentence worth including because it will save the next reader an hour: `alias_of` is
  a plain string whose EMPTY value means "not an alias", so `??` is the wrong operator
  against it. That mistake shipped a broken typeahead once in this build.

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
- **It is offered wherever an "@" is, because it works wherever it is written.** The
  backend reads an address anywhere in the message (`agent_policy::address_in`), so a tag
  mid-sentence summons the agent exactly as one at the front does. The rule that keeps a
  row honest was never the position: it is the next bullet — a row is drawn only for
  something it would really reach, because a chip that looks like it started a program
  while nothing ran is worse than plain text. It is the same rule that refuses a mention
  with no visible span.
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
  `agentTagInText` is a port of `agent_policy::split_prefix` plus its prompt rules — so an
  address mid-sentence is marked (it is a request now) while one in a quote stays plain
  words: the backend strips quoted blocks before it reads a trigger, so a prefix inside one
  started nothing. The offsets are taken over the whole body the way `teams_read` flattens
  it, one newline per block, so the chip sits where the BACKEND read the address and not
  wherever those letters happen to appear.
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
- **The user's own CUSTOM AGENTS are offered here too, after the providers** (see
  § CUSTOM AGENTS). A persona is that provider wearing a name, so its row draws its own face
  and label while the chip keeps the vendor's palette — and it is offered on exactly the terms
  its provider is, since `@bebou` would otherwise summon nothing. The providers come FIRST
  because they are a fixed short list a reader learns once, and the personas grow: a menu whose
  first row moved as agents were added would have to be read every time.
- `web/mock/server.ts` seeds the sandbox thread as a conversation of its own
  (`seedAgentSandbox`), so the tag is exercised in the state a fresh backend is really in:
  one thread opted in, every other off — plus the other machine's half, a colleague's own
  `@claude` and the answer their agent posted under their name, which is what makes that
  pair reviewable with no second tenant. `cd web && bun run preview -- --out /tmp/tag
  --agent-tag` captures the list, both chips, the sent bubble and theirs, and
  `web/e2e/agent-tag.spec.ts` pins every rule above.

## CUSTOM AGENTS (`@bebou` — a name of the user's own, in Settings › Custom agents)

`@claude` summons a CLI. `@bebou` summons the same CLI wearing a face, a name and a standing
instruction the user wrote — so a thread can hold a review bot, a French boomer aunt and an
ordinary assistant, each addressed by WHO it is rather than by which program runs it.
`src/agent_persona.rs` is the record and every rule about it, `web/src/lib/agent-persona.ts`
the page's half, and `web/src/components/custom-agents-settings.tsx` the pane that makes one.

**A PERSONA IS AN ADDRESS, NEVER A PROGRAM.** That is the whole safety story, and it is why
this feature needed no new gate of its own. `agent_policy::BACKENDS` is a static table for a
stated reason — the program a Teams message can start is not something a message, or a client
that found the socket, gets to choose — and a persona is a row that POINTS at one of its
entries. What it adds is a name to summon it by, a picture, a model already inside
`is_valid_model`, and text prepended to the prompt. So `@bebou` goes through the same
`command_for` as `@claude`: the `from_me` gate holds, the conversation still has to be opted
in, the provider switch still silences it, and a stale frame is still a replay. A stored row
naming a provider this build does not hold is DROPPED by the read rather than defaulted
(`Store::agent_personas`), because falling back would start a program the user never named.

- **The PREPROMPT leads the prompt, and appears in no message.** It is the point of the
  feature: `/bebou` turns every request into that character, and a paragraph of review
  instructions turns one into a review bot. It leads rather than trails and sits OUTSIDE the
  context blocks (`Persona::lead`, applied in `agent_request`) for three reasons — instructions
  before the material is the shape every prompt in this app takes, it is the one position where
  a SLASH COMMAND still reads as a command, and it works identically for both CLIs, since
  opencode has no `--append-system-prompt` and reads its instructions at the top of the message.
  The system prompt names the agent instead (`system_prompt` takes `Command::identity`, the
  persona's own label), so a model is told it is Natacha rather than claude.
- **The reply signs itself with its own name, and that ONE spelling is the whole feature's
  identity.** `agent_policy::Signature` writes `— bebou (claude), via teams-lite` where a
  provider run writes `— claude, via teams-lite` — byte for byte what it always wrote, so every
  reply already in a thread keeps rendering. Three readers depend on the two forms agreeing:
  the bodies write it, the LOOP GUARD reads it back (`is_agent_answer`, so a run cannot answer
  itself), and the page reads it back (`agentAuthorship`, which is how a reply answered from a
  phone draws under its agent's face). The guard recognises the persona form by its SHAPE —
  `<word> (<a provider we know>)` — and never by looking the persona up: a run whose persona
  the user deleted mid-answer still signed itself, and reading that answer as a request is
  exactly the loop it exists to prevent. A run a restart abandoned is closed from the two names
  its `agent_runs` row wrote down (`Signature::stored`), for the same reason.
- **A SESSION is per agent, not per provider.** `agent_session_key` gains a segment, because a
  review bot and a boomer aunt in one thread must not be handed each other's context — with the
  preprompt of one leading a conversation the other has been having. A provider run keeps
  EXACTLY the key it always had, so no thread loses the session it is in the middle of.
- **A persona may not take a provider's name.** `@claude` resolves to the provider before any
  persona (`split_address` prefers the earliest address and a provider breaks a tie), so a row
  called `claude` would be one the user can see, edit and never summon — with an instruction
  they believe leads every `@claude` run. `agent_persona::check_name` refuses it, and the
  dialog says so as the name is typed.
- **The name is the ADDRESS and the LABEL is what a reader sees.** The name is one lowercase
  word, because it becomes part of a `@…` the backend has to find in a sentence and see END —
  a `.` would collide with a sentence ending on an address, a space would make it two words.
  The label is free ("Natacha"), and a case-only difference is KEPT: an address must be
  lowercase and a name a reader sees should not be, so folding the case dropped exactly the
  labels the field exists for. The dialog repairs what it can as it is typed ("@Review Bot" →
  `review-bot`) rather than teaching the charset one keystroke at a time.
- **A persona with no face wears the mark of the provider it runs** (`AgentMark`). Never a
  blank square and never a letter in a circle: a persona is a program answering, not a person
  in the thread. That fallback is also what a message whose persona this machine no longer
  holds draws — and it is the honest answer, because that message really was answered by that
  CLI. The face rides its own read (`agent_persona_avatar`, base64, the shape
  `custom_emoji_image` already has) and is cached per name AND per `updated_ms`, so a replaced
  picture is a different key rather than one that draws the old face until a reload.
- **The face and the name arrive from the STORE, and a body renders without one.**
  `useOptionalAppState` is the seam: `RichContent` is pure given its props (which is what lets
  it be server-rendered and unit-tested with no DOM), so a chip in a message resolves what it
  can and falls back to the address and the provider's mark. That is the same answer a deleted
  persona gets, so it adds no state to reason about.
- **The tool allowlist stays MACHINE-WIDE, deliberately.** A persona cannot widen what an agent
  may DO — `agent_set_tools` is the one consent surface for that — because a name and a picture
  are not a consent gate: a "deploy bot" must not hold permissions its author granted by naming
  it. A persona's MODEL is per agent (it inherits the provider's when it names none, so a
  persona that is only a character does not go stale the day the user changes it in Settings).
- **NOTHING about a persona travels, and that is the user's own decision.** Teams holds no
  notion of one, so there is no upstream to publish to and nothing to reconcile — it is a local
  override like a nickname or a pinned chat. A colleague's own `@bebou` is therefore a WORD
  here, exactly as `@natacha` is on a machine that never made one: marking it from OUR list
  would draw their message under a face the user chose, for an agent they did not address. What
  their reply DOES carry is its own signature, which is where their agent's name really comes
  from.
- **`agent_persona_save` and `agent_persona_remove` are `MACHINE_METHODS` entries**, gated for
  the reason `agent_set_tools` is: a row decides what a later `@bebou` will do in a thread the
  user opted in. The automation hook blocks a script that names either against a live port.
  Reading the list stays open — it rides inside `agent_status`, so every surface that already
  offers an agent gets it with no second read, and both writes answer with the whole fresh
  status exactly as the other four agent setters do. The PREPROMPT travels to the page, unlike
  a token in `get_settings`: it is not a credential but the user's own instruction, and the
  pane that edits one has to show what is there.
- **The composer's "@" offers them; a message's "…" menu does NOT.** The providers come first
  (a fixed short list a reader learns once, so the first row does not move as agents are added),
  then the personas, each offered only where its own provider would answer. A row per agent in
  the message menu would turn a column of actions on one message into a directory of programs
  before the reader has said what they want — the rule the default provider already exists for.
- **The LIVE bubble draws the persona from the FIRST frame** (`persona` on `agent_stream`), and
  the phase line names it too. A bubble that wore the vendor's mark until the run ended and then
  swapped to the persona's face would show the reader a change for no reason, and "Claude is
  thinking" over a message sent to Bebou reads as the wrong agent having picked it up.
- **A dialog owns Escape, and the shell stands aside** (`aModalIsOpen` in
  `web/src/lib/platform.ts`). The app's own Escape leaves the open pane and is not part of the
  dialog's layer stack, so both fired: Escape in this form — and in Add emoji, which had the
  same defect — closed the form AND navigated out of Settings, taking the reader's place with
  it. It matches a dialog in EITHER state, because Radix dismisses on CAPTURE and the one it
  just closed already reads `closed` by the time a bubble-phase handler runs.
- **The composer's chip owns its own DOM** (`ignoreMutation` on the node view). A custom agent's
  face arrives one round trip after the chip is drawn, and ProseMirror re-parses the node a
  mutation it did not make landed in — so that swap was read as the reader editing the
  document.

`web/mock/server.ts` reproduces the whole feature with no CLI and no tenant: two agents, and
the PAIR is deliberate — `bebou` has a real PNG face and an instruction, `natacha` has neither
and therefore wears Claude's own mark, so both halves of the fallback rule are on screen at
once. Its trigger resolves a persona exactly as the backend does (`mockAgentAddress`), and the
`{kind:"agent_personas"}` test hook resets the set — a spec that adds, edits or removes one
MUST call it, since one mock process serves the whole run. `cd web && bun run preview -- --out
/tmp/ca --custom-agents` captures the Settings section in both themes, the form, the name a
persona may not take, the "@" list, the chip and a persona answering; `web/e2e/custom-agents.spec.ts`
pins every rule above, including that the instruction reaches no message. **What is unverified
against the tenant is the pairing**: the signature, the trigger and the prompt are pinned in
Rust and against the mock, so what is untested is one real `@bebou` run in the user's own app.

## Chess in a conversation (a game IS the thread, and it has a PAGE)

The user can play chess against anybody in a conversation who also runs teams-lite, from a row of
that conversation's own MENU (§ ONE MENU in a conversation's header) — several games at once if
they like. Every game is carried by ordinary Teams messages; the board is a row in the history,
and one game in FULL is a page of its own. `web/src/lib/chess-wire.ts` is the line a chess message
signs itself with, `chess-thread.ts` derives every game from the thread's own messages,
`chess-clock.ts` does the clocks, `chess-act.ts` decides what a press publishes, `chess-menu.ts`
what the header offers, `chess-sound.ts` what a move sounds like,
`web/src/components/chess-board.tsx` draws the board (and is the only place `react-chessboard` is
touched), `use-chess-game.ts` is every behaviour a board has, `chess-game-card.tsx` the row in the
history, `chess-page.tsx` the full-screen page, `chess-score-sheet.tsx` its right column and
`chess-games-strip.tsx` the strip under the header.

**Teams has no private data channel, and that constraint is the whole design.** A move has to
reach another machine and a message in the conversation is the only carrier — so a game is played
in the thread, under the user's name, visible to everybody in it. What that buys is that **nothing
about a game is stored**: the position replays out of the thread's own history, so a reload, a
phone and a game played while this app was closed all draw the same board, and there is nothing to
reconcile when a frame is lost. It is the property the agent's overlay has ("the row in the history
IS the Teams message") with no overlay left at all — no RPC, no schema, no new gate.

### A MOVE EDITS ONE MESSAGE (the ledger), it does not post another

A sixty-move game used to be sixty messages. It is now TWO: **one message per player per game,
edited in place** — that player's whole record, rewritten on every move — and the game is the
MERGE of the two ledgers by ply.

**One per PLAYER rather than one per game, because a shared message is impossible.** This app
refuses to edit a message that is not the user's own and so does the backend before the network
(§ Sending messages), so each player keeps their own record. That also keeps authorship exactly as
strong as it was when every move was its own message: a ply is signed by whoever authored the
message that holds it, and nobody can write a move into somebody else's ledger.

The line is versioned and read from the WORDS, never from markup — the choice `agent-message.ts`,
`agent-tag.ts` and `tracker-ref.ts` all make:

    — chess 7f3a1c v2 w open tc.600+0 at.1756060012345 1.e4.59830 3.Nf3.59200, via teams-lite

Eleven rules hold it, and each is pinned by a test:

- **NO COLON EVER APPEARS IN A LEDGER LINE**, and that is not a matter of taste. The backend
  substitutes custom emoji into every outbound body on a send AND on an edit, and
  `custom_emoji::code_spans_in_text` matches `:name:` ANYWHERE in the text — no whitespace needed
  in front of it — for any lowercase name in the user's own pack. A move written `1:e4:59830`
  therefore carries the code span `:e4:`, and a pack holding an emoji of that name (packs grow on
  their own — § Custom emoji imports a colleague's) would replace it with an `<img …>`. That breaks
  `SIGNATURE`'s own `[^<]*` and the game is unreadable for BOTH players for good, with nothing left
  to repair it with, because the app can no longer see a game to edit. Every separator is a full
  stop, which is chess's own notation, and `serializeLedger` is asserted to write no colon at all.
- **A ledger is a STATE, not a stream.** The whole line is written again on every act, so a token
  that is no longer true is simply not written and there is no history inside the message to
  disagree with itself. It is what makes `drawOfferedAt` and a resignation ply-anchored rather than
  ordered.
- **`at.<epoch ms>` is the moment that author last MOVED**, and never "the newest thing I did". A
  draw offer, a resignation and a flag claim all leave it alone. One token doing both jobs made a
  flag claim move the very instant it was checked against — the claim said "your clock ran out" and
  by carrying its own time forward also said the opponent's clock had only just started, so the
  claim disproved itself.
- **THE ACCEPT IS TIMED BY ITS OWN MESSAGE.** An edited message keeps the `compose_time` it was
  first posted at, and for the accepting player that IS the moment they accepted — stamped by the
  service rather than claimed by a client. Reading it off `at.` made the moment the clock starts
  from move forward every time that player moved again.
- **The order of play is read off the PLY, never off message order.** A ledger keeps the `seq` of
  the message it was first posted as, so the challenger's ledger has the LOWEST seq in the game and
  holds their fortieth move. `chessGamesInThread` is therefore COLLECT-THEN-RESOLVE rather than the
  incremental walk it was.
- **A ply belongs to one colour and to one player.** A ledger claiming the other side's parity is
  refused whole (white's second ply is 3, never 2), a ply two messages claim goes to the earlier
  message, and a move from somebody who is not in the game is refused — the derivation rather than
  a rule the UI applies, which is what keeps a third person in a group chat out of it.
- **A GAP stops the game.** Plies are taken from 1 while they are contiguous: the history pages
  older, so a board drawn past a missing ply is a position nobody played.
- **The acts that END a game are anchored at a PLY**, so a move claimed after a resignation is
  absorbed and ignored exactly as it was when message order could say so.
- **THE v1 SHAPE STILL REPLAYS.** One derivation reads both: every game played before this is one
  message per act, and its acts are ordered by their own `seq` (`plyAtSeq`). A v1 game has no clock
  and needs none — its moves are timed by their own messages.
- **A LEDGER THIS BUILD CANNOT READ leaves an ordinary message**, which is the rule an unknown v1
  kind already followed. So a `v3` line from a newer build draws its words and no board, and an
  UNKNOWN token inside a v2 line is IGNORED rather than fatal — a build that gains a token does not
  make its games unreadable to this one.
- **The words above the line state the STATE**, because they are rewritten with it: "my moves: 1.
  e4 2. Nf3", bounded to the last six, plus the clock on a challenge and a sentence for each
  terminal act. A message whose words said one move while its line held forty would lie to every
  client but this one.

**THE `edit` RPC GAINED ONE OPTIONAL `content_html`**, exactly as `send` has one, because it
escaped its text and a ledger line cannot survive that. It is the same trust boundary the send
already draws — a client supplies the body of its own message either way — and the same
`OUTWARD_METHODS` entry it was: no new gate, no mentions (the list still travels on a send and an
agent's own edit still builds its own), no way to retitle a post (the subject is still read from
the store) and no way past the seal (which still runs last). `web/mock/server.ts` mirrors it.

**What an edit COSTS, stated because it is real and it is a trade the user asked for:**

- **A MOVE NO LONGER NOTIFIES.** An edit does not bump a conversation's preview and does not push,
  so a colleague whose app is CLOSED is buzzed by the challenge and the accept and by nothing after
  them. With a clock running that is the honest exchange — a game against somebody who is not
  looking is lost on time either way — and an OPEN page still redraws the board on every edit,
  because the backend broadcasts the whole stored message.
- **THE LEDGER IS THE GAME'S RECORD.** One corrupted body ends the game for both players with
  nothing to repair it with, where the old shape lost one move per bad message. That is why the
  colon rule above is a rule rather than a preference.
- **A COLLEAGUE ON STOCK TEAMS sees one message rewritten sixty times**, wearing Teams' own edited
  mark, rather than a conversation. The words state a growing score sheet, which is the most useful
  thing that message can say.

**A PUSH ABOUT A CHESS MESSAGE CARRIES NO WIRE** (`push_policy::without_chess_line`). The page
strips the marker out of a sidebar preview itself and a push has no page — and it matters more than
it did: a move used to be its own short message, and a whole game's record now lives in one line of
several hundred characters, so an unstripped push would be a screenful of wire with the sentence it
is about pushed off the end of it. Nothing else is ever cut: an agent's own `— claude, via
teams-lite`, a colleague's prose and a bare em dash are all left alone, which is what the six-hex
game id and the exact trailing shape are checked for.

### SEVERAL GAMES AT ONCE

"One game in flight per conversation" was the rule and it is gone. A group chat holds a game per
pair of people, and two colleagues wanting a second board while the first is still going was the
commonest ask this feature had. `activeChessGames` answers every live game MOST URGENT FIRST — one
waiting for the reader before one waiting for somebody else, the newest before the older — and that
order is the derivation's rather than a component's, because what wants the reader's attention is
what they should meet first. Nothing is refused for being the second game; the conversation's menu
names every live game and still offers a challenge ("Start another game").

**A STRIP OF THE RUNNING GAMES FLOATS UNDER THE HEADER** (`chess-games-strip.tsx`), because a board
is one row in a history that may be a hundred messages long. One chip per game: whose game, whose
move, BOTH clocks, a dot when it wants the reader, and a press that opens that game's page. Four
rules, each pinned:

- **it FLOATS rather than taking room** — an overlay at the top of the history, so nothing in the
  conversation moves when a game starts or ends (the failure the scheduled banner avoids by sitting
  above the composer rather than inside it). The container passes pointer events through; only the
  chips take them.
- **the CLOCK ticks in the chip and nowhere else** (`useChessClock`, in a module with no `chess.js`
  in it), so a running game redraws a 60px pill four times a second instead of re-rendering a
  virtualized history that already re-renders on every scroll that mounts a row.
- **it is bounded and says what it left out**: three chips, then a count. A row of eight pills is a
  second sidebar, and on a phone it would cover the first message of the conversation.
- **every chip clears the 44px touch floor**, which every target this app draws for a thumb does.

### THE PAGE (`/c/<conversation>/chess/<game>`)

One game, the whole screen: the board in the middle, the score sheet down the right, and the
conversation's own chat under it. It is chess.com's shape and it is what the feature was missing —
the card in the history is a board in a column a phone's width wide, between things people said,
which is the right place to play A MOVE and the wrong place to play a GAME.

- **A ROUTE, never a piece of state** — the rule the merge request's diff, its pipeline graph and a
  job's log all hold. Three things come with the URL and none is available to a `useState`: it
  survives a reload, it can be sent to whoever you are playing, and the browser's own Back leaves
  it. It is a CHILD of the conversation's route, so the shell opens the thread exactly as it always
  did and the page never loads a history of its own.
- **The shell draws it INSTEAD of the sidebar and the pane**, rather than over them: there is no
  overlay to dismiss, and the app's ONE composer is this page's while it is up — the pane that
  usually holds it is not mounted, so the sentinel a sanctioned driver proves its target with still
  has exactly one answer. A live call's chat panel is the one thing that can also hold it, so the
  page asks (`useCallOwnsComposer`) rather than drawing a second.
- **Each column scrolls itself and the page never scrolls.** Below `md` it is one column — board,
  the score sheet as a single line, then the chat — because a table of pairs and a chat cannot both
  have room at 390px, and the chat is what a game in a conversation is for. That narrow column DOES
  scroll: the seats, the board, the four controls and the sentence do not fit in one screen there.
- **THE BOARD COLUMN CARRIES NO SCROLLBAR ON A WIDE SCREEN, and the board is what gives way.** A
  board somebody has to scroll to see is not a board, and a scrollbar beside one moves the squares
  under the pointer. It is the shorter of the room it has — and the room is MEASURED
  (`useBoardFit`), which is the whole of the fix. The page used to cap the board at
  `calc(100vh - 15rem)`: 240px for the header, the padding, two seats, the controls and the
  sentence, which really measure 252 — so every full-screen game overflowed by twelve pixels and
  carried a scrollbar. A constant cannot be right anyway, because the chrome GROWS: a premove hint,
  a refusal, the two buttons a challenge is answered with, and a sentence that wraps at a narrow
  width each add a line nobody can put in a `calc`. Flexbox already measures what is left (`flex-1`
  over `min-h-0`); the hook reads that number and hands it back as the stack's WIDTH, so the two
  seats and the controls line up with the board's own edges rather than with the column's. Three
  details are load-bearing: the width comes from the COLUMN and never from the stack (whose width
  is the answer, so measuring it would be reading it back), a phone measures nothing (`side` stays
  null and the CSS estimate stands), and the pure-CSS shortcut is measured to be WRONG —
  `aspect-square` with `max-h-full` gives 700x296 rather than a square, because a min/max clamp on
  one axis does not travel back through the ratio.
- **ESCAPE LEAVES THE BOARD FOR THE CONVERSATION**, never the conversation for the chat list: the
  reader is two surfaces deep, and one Escape does one thing. It is decided in the shell, where
  every other Escape already is.
- **A game the URL names and the thread does not hold SAYS so** — the history pages older, so a
  game may simply not be loaded yet.
- **The chat beside the board is the app's own thread** (`ConversationChatPanel`, shared with the
  call stage): the same history, drafts, live feed and read state, and the same composer under the
  same consent. A message is READ there and acted on in the conversation itself.

### WHAT A BOARD DOES (`use-chess-game.ts`, shared by the card and the page)

- **A move is drawn before it lands and TAKEN BACK if it does not leave**, with the sentence at the
  board — the composer's own rule, because a move that did not go out is otherwise invisible.
- **The reader can WALK BACK through the game**: four 44px controls, a press on any ply of the score
  sheet, and ArrowLeft/ArrowRight/Home/End on the page — ignored the moment the reader is typing,
  because this page holds the composer. A move arriving while they are in the past LEAVES them
  there; the board snaps to the live position only on the TRANSITION to their own turn, because
  their clock is running and leaving them reviewing would cost them the game. Reading that as a
  STATE rather than a transition was a real bug: with `atLive === false` in the condition, pressing
  Back on one's own turn took the reader straight back, so the game could not be walked through at
  all on the one turn a player most wants to.
- **A press while reviewing the past comes BACK to live and plays nothing.** A board that swallows a
  press says nothing about why, and the reader presses again.
- **A PREMOVE is a private intention.** It is queued while the opponent thinks (their move drawn in
  its own tint — never the yellow a real move wears), it is stored per conversation and game so it
  survives the walk from the card to the page, it publishes NOTHING until it is legal, and the
  moment their move lands it plays itself. A premove the arriving position makes illegal is dropped
  rather than posted. It is taken back by a right press, and by a left press on anything that is
  not the reader's own piece.
- **A PREMOVE COSTS 0.1 s** (`PREMOVE_SPEND_MS`), whatever the wall clock says: it is a move that
  was already decided, so charging the minutes the opponent spent thinking would punish the reader
  for the opponent's time, and charging nothing would make a premoved game free.
- **The sounds follow the POSITION, not the press**, so a move arriving from the other machine
  sounds exactly like one played here.
- **Nothing is playable except at the live position, on the reader's own turn, with nothing of
  theirs already in flight** — a second press before the first move's message came back would claim
  a ply the thread has not reached.

### THE CLOCKS (default ten minutes, on both sides of the board)

The wire carries the time control once (`tc.<base>+<inc>`, whole seconds, from whoever opened the
game), the moment of each player's last move (`at.`), and per ply what the mover had LEFT after
playing it (centiseconds, so a sixty-move line stays short). Everything else is arithmetic
(`chess-clock.ts`), which is what makes a reload, a phone picked up later and an app that was
closed for an hour all reach the same two numbers.

- **EACH PLAYER IS AUTHORITATIVE FOR THEIR OWN CLOCK, and nothing pretends otherwise.** There is no
  server here — a move is a message — so the mover states their own remaining time. What CAN be
  proved is the ceiling, and it is: `chessClockCeilingMs` clamps a stated clock to
  `base + increment × their own plies`, using only what both machines hold, so both clamp the same
  way. A player who states a little less than the ceiling is not caught, and that limit is written
  where the trust is rather than papered over — the same trust a friendly game already extends to a
  colleague who could also take a move back by hand.
- **NOTHING ENDS A GAME ON A TIMER.** A clock at zero makes a win CLAIMABLE by whoever is not on the
  clock (`flag.<colour>.<at>`), and the other machine re-checks the arithmetic at the claimed moment
  (`chessFlagIsFair`) before it believes it: a claim against the player who is not on the clock, a
  claim on one's own clock, one that names no moment and one the numbers disagree with are all
  refused. So a laptop that went to sleep never loses a game by itself, and a flag nobody claims
  leaves the game where it was — which is what lichess does with no server in the middle.
- **The side to move counts down from the moment their OPPONENT acted**, and the first move of a
  game from the ACCEPT — which is what makes white's first move cost them something. A game nobody
  has joined holds two still clocks: nobody is on the clock in a game that is not a game yet.
- **A game with no clock draws none**, which is every game played before this and what "No clock"
  in the picker means. A dash nobody can act on would be worse.
- **The clocks are drawn on BOTH sides of the board**, on the seat they belong to, with the running
  one carrying the ink; under thirty seconds it turns, and below twenty it counts tenths, because
  whole seconds tell nobody whether they can still make a move. A clock is redrawn four times a
  second, ten times below twenty seconds, and NOT AT ALL while nothing is running or the tab is
  hidden.
- **The picker is nine presses in the challenge form**, opening on ten minutes, and it is kept
  across an open and close of the menu exactly as the colour is: it is a preference, not a step.

### THE LOOK, AND THE SOUNDS

- **THE BOARD IS CHESS.COM'S BOARD** — `#ebecd0` and `#779556` — and it is the one surface in this
  app that does NOT follow the appearance setting: the two greens are stated identically in both
  themes, so a reader never has to re-learn their own squares. The cost is stated where the rule
  is: a light board sits in a dark page, which is exactly what chess.com's own dark interface does.
  Everything drawn ON the board follows it — one yellow for the selected square and the last move,
  a distinct tint for a premove (a decision is not a move that happened), a grey dot for a legal
  square and a ring round a piece that can be taken, and a RADIAL red glow for the king in check,
  because flat it would be a third highlight on a board that already has two.
- **ARROWS ARE DRAWN BY A RIGHT-DRAG, ON THE PAGE ONLY.** They were refused before on the argument
  that a right-click takes the browser's own menu away; the user asked for them, so the argument is
  theirs — and the split is where it costs nothing: a page a reader is thinking on gets them, a
  conversation does not. The gesture is the renderer's own (nothing here reimplements one), a left
  click clears them and so does a new position, and the ink is amber rather than the board's yellow,
  because an arrow is the one thing on the board nobody else can see.
- **A PROMOTION IS ASKED WITH PIECES, over the square the pawn is landing on** — a column of four,
  strongest at the top, drawn with the renderer's own art so the queen in the picker is the queen
  that lands. It was four words in a row under the board, which is the one shape a chess player
  never meets. It is dismissed by a press anywhere else and by Escape (on CAPTURE, so the shell's
  own Escape does not also leave the conversation), and the four `chess-promote-*` ids are kept so
  what every existing assertion means survived the change of shape.
- **THE SOUNDS ARE SYNTHESIZED AND ONLY THE PAGE MAKES THEM** (`chess-sound.ts`). Twelve of them,
  each with its own SHAPE rather than the same click at another volume — a knock for a move, two for
  a capture, an alert over the knock for check, a rising arpeggio for a promotion, three notes for a
  result — because a reader should hear which it was without looking. Nothing is downloaded: they
  are oscillators and one noise burst, the way `cuelume` builds the app's own cues, and a dozen
  small files would be a dozen requests on a page whose promise is that displaying it makes none.
  The AudioContext is created on the first sound a PRESS asks for and resumed on every play (iOS
  suspends it whenever the app goes away), a HIDDEN document plays nothing, and the whole palette
  answers to the app's own `soundsEnabled` — a reader who turned the app's cues off did not ask for
  a board to be the exception. The CARD in the history makes no sound at all: a conversation that
  clicked at every move of every game in it is one nobody can read in an open-plan office.

### THE CARD IN THE HISTORY, AND THE SCROLL IT USED TO EAT

The card is a board the reader can play a move on and read a clock off, with a press that opens the
page. It deliberately has no sounds, no arrows and no touch dragging — and that last one is a BUG
FIX rather than a preference:

**`react-chessboard` writes `touch-action: none` inline on every one of the 32 pieces** (its own
`Piece`, with no option to change it), which is right for a board that owns the screen and wrong for
one sitting in a scrolling history: a finger landing on an occupied square could not scroll the
conversation, and on a phone the board is most of the width of it. On the reader's own turn a second
cause stacked on it — dnd-kit's TouchSensor calls `preventDefault()` on a non-passive `touchmove`,
which kills the scroll over the WHOLE board. So the card sets `scrollable`: an author `!important`
rule frees the pieces to `touch-action: manipulation` (both directions and pinch-zoom back, the
double-tap zoom a tap-tap board would otherwise trigger still suppressed) and touch dragging is off
with it. Moves are played by TAP-TAP on a phone and by dragging with a mouse, and the history
scrolls either way. A spec reads the computed style and wheels over the board, because "it scrolls"
is the whole fix. One more thing the renderer's DOM costs: every piece is a dnd-kit draggable, which
spreads `role="button" tabIndex={0}` onto its wrapper — 32 tab stops per board — so they are taken
out of the tab order, because a board is played by pressing squares and a piece is not a control.

### THE MOCK, AND WHAT IS NOT VERIFIED

`web/mock/server.ts` plays the OPPONENT, because a game needs two machines and the suite has one:
it keeps a LEDGER of its own and EDITS it, which is what the other machine really does — a mock that
answered with a message per move would let a broken merge pass every test. It accepts a challenge,
opens as white when the challenger took black, answers each move with a legal reply replayed out of
the thread's own messages, and charges its own clock what it really waited. Three hooks and each
exists because a moment cannot be reached otherwise: `challenge` makes the mock the CHALLENGER (its
absence once hid the fact that the app had no Accept button while eleven tests passed), `seed` puts a
game mid-flight with the clocks a spec chose (the alternative is a spec that waits ten minutes for a
number to move), and `play` makes the opponent move on its own, which is the only way to reach the
instant a premove fires — a premove posts nothing until it is legal. **A spec MUST reset**: one mock
process serves the whole run, and a conversation holds several games at once now, so a game left
unfinished is a chip in the next test's strip, a row in its menu and a board in its history.

`cd web && bun run preview -- --out /tmp/chess --chess` captures the control, the challenge form
with its clock, the board in both themes, a game in progress with its score sheet, the armed
resignation, the board at a phone's width, the card a colleague's challenge leaves, the STRIP of
running games, the full-screen PAGE in both themes and at a phone's width, the promotion picker, a
premove and a clock down to its last seconds. `web/e2e/chess.spec.ts` pins every rule the page owns,
and `chess-wire.test.ts`, `chess-thread.test.ts`, `chess-clock.test.ts`, `chess-act.test.ts`,
`chess-menu.test.ts` and `chess-sound.test.ts` the pure ones — the last of which pins the palette
without an AudioContext anywhere: which sound a move earns, that every sound has its own shape
rather than being one click at another volume, and that each is short and quiet enough to happen
every few seconds.

**What is unverified against the tenant is the pairing, and one new thing.** The wire rides `send`
and `edit`, both measured, and everything else is pinned in unit tests and against the mock — so
what is untested is one real challenge accepted by a colleague who also runs teams-lite, which is
the user's own click in the sandbox chat. NEW and unmeasured: **no probe has posted a ledger line
and read it back byte for byte.** The sealed-message probe measured base64url surviving at 10 923
characters and the v1 line has always survived, so a line of letters, digits, spaces, `+` and `.`
is expected to — but expected is not measured, and a `.`-separated ledger is the one part of this
feature that a tenant has never seen.

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
  sidebar's preview attribution, the typing line, the "seen by" row, the @mention
  list, their merge requests and the name the local AGENT calls them by
  (§ The local agent) at once. That placement is the whole design: `insert_message` freezes a
  message's `sender` at first insert and no sync refreshes it, so a rename applied at
  render time would have to be applied at a dozen render sites — and the one that got
  forgotten is the bug. Never move it out to a caller.
- **ONE read hands both names over, and it is the exception that proves the rule.**
  `Store::thread_people` keeps the nickname and Teams' own name APART where every other read
  collapses them, because its one caller — the prompt the local agent answers with — needs
  both: the nickname is what to answer in, and Teams' name is who a quote, a file and a
  merge request call the same person. A surface draws one name; a prompt has to reconcile
  two.
- **What the store never produced, the server resolves explicitly.** Four names do not
  come through a store read: the activity feed's actor (`feed_json`), the sender of a
  live push (`push_live_message`, which gets the frame that just arrived), a 1:1's
  title in `conversation_context` — which is why that one takes `self_mri`, so a
  nickname the user gave THEMSELVES can never retitle their own chat — and a person on the
  GitLab page, whose name arrives from GITLAB and is matched to a colleague by it
  (`with_teams_people`, see § A tracker user who is also a colleague). Each of the four ends
  in the same `display_name_for_mri`, so there is one answer about a name in this app. The
  phone is the sharpest case: it is the one surface the user cannot correct by looking again.
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
- **The row is the composer's own list, narrowed to the DEFAULT provider**
  (`defaultAgentCandidatesFor`), so a thread nobody opted in offers none and a machine
  holding two CLIs still offers one row — see the default provider under § The local agent.
  The consent gate stays in the thread's own menu; this reflects it and never widens it. A
  request also carries the conversation it was asked in, so walking to another chat drops it
  rather than leaving a tag in a draft nobody asked for.
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

### "Review !42 with <agent>" — the same row, for a merge request

A message that names a MERGE REQUEST gets one more row per agent
(`web/src/lib/merge-request.ts`). It is the row above with a different sentence, and that
is the whole design: one pick, one tag at the front of the draft, one Enter that is the
user's. What changes is only what is asked.

- **The request names the merge request in FULL** — the reference and the URL
  (`reviewRequest`). A reference alone means nothing outside its project, and the URL is
  what the agent needs to go and read it. A half-written draft still wins, under the same
  rule as "Answer with": `answerRequest` takes the row's own seed and applies it to an
  EMPTY composer only, so whose words go out never depends on which row was picked.
- **The row is read from the LINK, not from the card.** `mergeRequestFromUrl` is a port of
  the merge-request half of `gitlab::parse_url` and keeps both of its rails: the host must
  be the configured one, and only `/-/merge_requests/<iid>` counts. So a merge request
  whose preview card never arrived — a missing token, a private project — can still be
  handed to an agent, while an issue, a project or a commit offers nothing.
- **One merge request, the first one.** A message naming three would turn one menu into a
  directory, and the one being discussed is the one named first.
- The approval row sits below it, in its own group, because it is a different kind of thing
  altogether: a review starts a program on this machine, an approval writes to GitLab (see
  § The trackers). `cd web && bun run preview -- --out /tmp/mr --merge-request` captures
  both, and `web/e2e/merge-request.spec.ts` pins them.

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
  and, only when the user asks for it and only during the hours they set in the zone they
  named, publishing their own (`src/teams_presence.rs`,
  see § The user's own status), the READ-ONLY conversation roster an @mention list is
  built from (`src/teams_members.rs`, see § @mentions), the per-chat ENCRYPTION that seals a
  message's words before they reach Teams (`src/seal.rs`, read back by `Store::seal_keyring` and
  applied at the last moment of a send by `teams_send::seal_body` — see § A SEALED chat), the
  one-to-one AUDIO CALLING
  plane (`src/calling.rs` plus the calling half of `src/trouter.rs` — see § Audio calls
  and NATIVE-CALLING.md), the READ-ONLY rich link
  previews for the trackers the user works in (`src/link_preview.rs` dispatching to
  `src/gitlab.rs` and `src/linear.rs`, whose `fetch_workspace` also answers what a bare
  `ENG-123` written anywhere is addressed with — see § A tracker REFERENCE in the words), the
  merge-request PAGE — its seven reads (the DIFF among them, whose unified patch this app writes
  over GitLab's bare hunks, and one JOB's LOG, whose cache window the answer itself decides —
  see § A job's LOG is a page) in
  `src/gitlab_mr.rs` over a durable response cache, what each CI job WAITS FOR in
  `src/gitlab_ci_graph.rs` (the one GraphQL read in this app, and query-only by construction —
  see § The pipeline is a GRAPH) and its six writes in `src/gitlab_mr_write.rs`, plus who a
  person on EITHER tracker is in the user's own Teams
  (`src/tracker_people.rs`, see § A tracker user who is also a colleague) — plus the approval
  those trackers got first, and its undo (`src/gitlab_approval.rs`, see § The trackers),
  the local agent that answers an `@claude`
  message (`src/agent.rs`, `src/agent_policy.rs`, `src/agent_markdown.rs` — see
  § The local agent) and the user's own CUSTOM AGENTS that answer to a name they chose
  (`src/agent_persona.rs`, see § CUSTOM AGENTS) and the app's own update — the check, the download and the swap
  (`src/update.rs`, see § Updating the app from inside it) — plus the restart the user can
  ask for without a new build at all (`src/restart.rs`, see § Settings › This app), and
  SIGNING IN AGAIN when the identity broker asks a human — the automatic interactive
  acquisition that usually needs nobody (in `src/auth.rs`), the session that serves the
  broker's own window (`src/signin.rs`), the one window it reads and drives over X11
  (`src/xwindow.rs`) and the frames it sends (`src/png.rs`, a PNG encoder over the `flate2`
  this crate already carries) — see § Signing in again and SIGN-IN.md.
  A message the service is HOLDING for later carries the moment it is due
  (`store::Message::scheduled_time`, schema v17) so the history can leave it out until then,
  and `scheduled_messages` lists what is waiting — see § Sending a message LATER.
  A CHANNEL post also carries a TITLE, in the send that posts it and in the edit that
  rewrites it (`teams_send::SUBJECT`, over the `Message::thread_subject` the read path has
  always decoded) — see § A channel post has a TITLE.
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
    rather than installing one. A vendored component that ships its OWN pack is held to
    the same rule through its own seam rather than exempted: `@pierre/trees` draws the
    merge-request diff's file tree with hugeicons, serialized into the sprite it injects
    (`web/src/lib/tree-icons.ts`, see § The DIFF). The one thing in this app NOT drawn from it
    is a chess PIECE: the board is `react-chessboard` and the pieces are its own art, because
    that hugeicons set cannot tell two armies apart at board size — the reasoning, and the two
    hand-rolled boards tried first, are in § Chess in a conversation. No second icon package is
    installed, so the test above still holds.
  - The game of CHESS is entirely the page's: `chess-wire.ts` reads the line a chess message
    signs itself with, `chess-thread.ts` derives every game from the thread's own messages, and
    `chess.js` plus `react-chessboard` are reached only through the board's lazy chunk (see
    § Chess in a conversation). There is no backend half at all — a move rides the `send` that
    is already gated.
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
  **It takes options only, and REFUSES an argv it does not know** (`parseArgs`, exit 2 with
  the usage). It used to ignore what it could not parse, so a script written against a
  DIFFERENT `teams` — `teams chats -n 40 --json`, from this machine's telegram bridge —
  started the whole app instead: a second web server on the default port, ATTACHED to the
  backend another launcher had spawned, so it handed its pages the write-token FILE of a
  backend that no longer existed. Every send and every update was refused on the door a
  phone reaches through (§ Automation safety names that state `foreign`), and the caller got
  no JSON at all, so it blocked on the output for a day.

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
backend WATCHES whether `latest` names a different commit and, when it does, the sidebar
offers the update as a blue button above the status line
(`web/src/components/update-button.tsx`, over the pure `web/src/lib/update.ts`).

**The watch is a POLL, every two minutes, and one request per MACHINE**
(`spawn_release_poll` / `Ctx::poll_release`, over `RELEASE_CHECK_INTERVAL`). It used to be a
single check at startup, and that was wrong for the app this is: it runs for weeks on a
phone, so nothing published after it booted was ever offered — the reliable way to be shown
an update was to restart the app the button exists to restart. Four rules hold it, and each
is pinned by a test:

- **The budget is MEASURED, and it sets the floor on the interval.** GitHub allows an
  unauthenticated caller **60 requests an hour per IP** (`update::GITHUB_HOURLY_REQUESTS`),
  and a conditional request buys nothing — an `If-None-Match` answering `304` was measured
  still spending one, so an ETag is not the way out. Two minutes is 30 an hour, half the
  budget, and the other half belongs to the compare API behind the changelog and to the
  re-read before every download.
- **One request per machine, not per backend.** The answer is the same for every process
  here, so the FETCH is claimed (`Store::claim_release_check`, a moving timestamp rather than
  a `push_deliveries` key, because the thing being claimed comes round again) and the answer
  is shared through the store (`update::SETTING_RELEASE`). A backend that loses the claim
  reads that answer on the same pass, so it learns about a release just as quickly without
  asking. This machine runs three send-capable backends: a poll per backend would spend the
  whole budget and then be refused `403`, whose only symptom is an update button that stops
  appearing. The split that makes it possible is `update::fetch_release` (the network half,
  machine-wide) beside `update::compare` (pure, per build — two installs here run two
  different commits).
- **A read-only backend never takes the claim.** It cannot install anything, and holding the
  machine's slot would delay by up to one interval the discovery by the app that can. It
  still reads the stored answer, so its UI says what the app's does.
- **Silence unless something moved.** `update_available` goes out when the release CHANGES
  and never on a pass that found the same one, so a page open for a week is not sent an event
  every two minutes and the journal keeps one line per release rather than 720 a day. A pass
  also stands aside whenever the phase is not `Idle`: the user has pressed something, and the
  asset a progress bar is drawn against is the download's own (`refresh_release`).

**Every build publishes TWO releases, and each answers what the other cannot**
(`.github/workflows/build.yml`). `build-<shortsha>` is immutable, one per commit, and kept
FOR EVER: it is the record of what shipped, and its body is that build's changelog. `latest`
is the rolling tag, recreated every time — and it can never move to another name, because
`update::check` asks `/releases/tags/latest` and install.sh downloads
`/releases/download/latest/…`, so every copy already installed depends on that spelling.
The asset is therefore uploaded twice on purpose. **The BINARY is kept on the newest
`ASSET_WINDOW` (10) builds only**: it is 134 MB and this project pushes about 19 times a
day, so keeping every one would cost some 78 GB a month — older releases keep their notes,
which is the part worth for ever and a few KB. `update::tests::the_release_workflow_…` pins
the tag, the notes' machine-readable line, the history the changelog needs and the fact that
pruning selects `build-` releases and never `latest`.

**The changelog is written ONCE, in Rust** (`src/changelog.rs`), and read by two surfaces:
CI renders its markdown into every release body through `examples/changelog.rs`, and the
backend publishes the same structure to the app. A grouper in the workflow beside one in the
crate would be two spellings of one list, drifting apart at the first commit type nobody
thought of. It reads conventional commits — the type becomes the heading, the scope is kept
apart from the summary, a `!` is lifted to a **Breaking** group above everything — and a
subject written outside the convention keeps its own words rather than being dropped.

**THE SUBJECT IS THE TITLE OF A CHANGE, NEVER THE CHANGE.** A commit here carries a subject
of some 75 characters and then the paragraphs saying what was wrong before, what the change
costs and why it is shaped that way — measured over 20 commits of master, **1 501 bytes of
subject against 22 171 bytes of body**. This read `--pretty=format:%s` and nothing else, so a
release page held one sentence for a fortnight of work and 94% of what the authors wrote
reached nobody. The body travels as `Change::body` now, and four rules carry it. Each is
pinned by a test — three in `changelog::tests`, and the workflow's own in `update::tests`,
because that file is on the other side of a process boundary and a change there is invisible
to everything else:

- **The two readers get different amounts of it, and that is not a compromise.** The RELEASE
  PAGE renders the detail: whoever opens it is asking what a build changed and has a page for
  the answer. The APP is handed the summaries alone (`#[serde(skip)]`), because its list is a
  hover panel over a sidebar showing the newest few — a paragraph an entry there is a wall of
  text in a 20rem card, and 200 changes of prose is a 400 KB message on a socket built for
  JSON. It is still ONE list, grouped once; what differs is how much of each entry a surface
  has the room to draw.
- **`git log -z --no-merges --pretty=format:%s%n%b` is the whole of the CI side**, and `-z` is
  load-bearing: a commit MESSAGE is several lines, so a newline cannot separate one commit
  from the next. `from_commits` takes whole messages for that reason, and the compare API's
  `commit.message` goes in untouched as well — one split, in one place, so neither caller
  decides what a reader is shown.
- **The page's prose is BUDGETED, and an entry carries all of its detail or none**
  (`MAX_BODY_BYTES`, 40 000 — well inside GitHub's own 125 000-character limit on a release
  body, which would REFUSE the release rather than shorten it). The first entry that does not
  fit ends the details for the rest of the page, so a reader gets whole entries and then
  summaries instead of paragraphs appearing and vanishing by the accident of their length.
  108 commits render to 47 KB. Half a paragraph reads as a fault, and a budget bounds the
  prose and never the LIST — dropping an entry is what `omitted` says out loud.
- **The work is FOLDED under what the reader can see.** `Reworked`, `Documented`, `Tests` and
  `Housekeeping` go behind one `<details>` disclosure, because a refactor alters no behaviour
  and a test proves what already shipped — they must not stand between the reader and the
  features. Two exceptions, and each is a rule: they stand OPEN when they are all there is
  (housekeeping is why a release exists on a day nobody shipped a feature, and a page whose
  whole content is folded reads as an empty page), and `Other` is never folded, because a
  subject this module could not classify may say anything and hiding it on the strength of a
  missing prefix would bury a real change. A `revert` sits with `fix`: something the reader
  HAD is gone.

**The base is PROVED to be behind this build, and two releases are asked.** `latest` is the
honest answer to "where is the reader coming from" — it is what every installed copy asks
about — but it is a rolling tag recreated at the END of the job, so two pushes a minute apart
race on it: the second job read `latest` before the first recreated it, and `build-218bd7b`'s
page re-listed `build-c40f8d8`'s own change. The newest immutable `build-*` tag is published
BEFORE the tag is recreated, so it names the newer commit exactly when the race loses it.
Both are candidates; the workflow keeps the one that is an ANCESTOR of this build and closest
to it, and falls back to the parent. A non-ancestor is refused rather than used, because a
force-pushed history would otherwise put commits this build does not hold in its own notes.

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
  phase for it — the disclosure below included, which counts changes and names no commit.
- **What the update BRINGS is a disclosure on the control itself.** Resting the pointer on
  the button opens the commits between this build and the release, beside it
  (`UpdateChangesPanel`, a hover card — the person card's own primitive and delays, so one
  hover means one thing across the app). The backend reads them from GitHub's compare API in
  one request (`update::changes`), which is why the list is right even for a build a hundred
  releases back, and caches them against the release so a retried download costs no request.
  Five rules hold it, each pinned by `web/e2e/update.spec.ts`:
  - **It is a floating panel, never a section in the row.** The row is the button (below), so
    a list that unfolded under it would move the control the user is aiming at. The spec
    measures the button's own box across the hover.
  - **A phone gets it from a LONG PRESS**, because there is no hover there and this app is
    used from one — the chat row's "…" makes the same split, and a TAP stays the update
    itself (`web/e2e/mobile.spec.ts` pins both halves).
  - **It is bounded and scrolls itself**, and what it leaves out it COUNTS: GitHub's compare
    stops at 250 commits and `changelog::MAX_CHANGES` caps the payload, so the heading says
    "43 changes since your build — the newest 6 below". A list that stops without saying so
    reads as a complete one.
  - **A comparison that could not be read costs the DISCLOSURE, never the button.** Offline,
    rate-limited, a force-pushed history: `changes` arrives null and the update is still
    offered. That an update EXISTS is what the row is for; what it brings is the nicety.
  - **It goes once the decision is made.** `restarting` and `installed` carry no list: it is
    what somebody decides WITH, and from there the release notes hold it.
- **The progress takes the place of the label, and the button does not move.** The percent
  is drawn where the pressed words were, over the fill. `web/e2e/update.spec.ts` measures
  the button's own position across the click.
- **The ROW IS THE BUTTON.** What a click costs or does is the button's own title
  (`UpdateView.hint`) and never a line under it: this row sits at the foot of a sidebar
  whose job is chat rows, and a sentence that comes and goes moves the control the user is
  aiming at. A line of its own (`UpdateView.detail`) is kept for what HAPPENED — a
  failure's reason, and the one thing left to do when nothing restarted the app — because a
  report nobody can hover is a report a phone does not have.
- **The work is drawn as an ORB, not as a turning glyph.** `thinking-orbs` (MIT, no
  dependencies, a plain 2D canvas — no WebGL, no filters, still under
  `prefers-reduced-motion`, paused off-screen and on a hidden tab) in its `solving` state at
  its own 20 px inline preset. It is a loading indicator and not an icon set, so § Hugeicons
  is untouched: every GLYPH still comes from one library. Its ink is monochrome, so the
  theme is passed INVERTED — the orb sits on `bg-primary`, whose foreground runs the
  opposite way from the page (white on the light theme, near-black on the dark one), and the
  package's own `auto` reads the page's `data-theme` and would be wrong in both.

- **Both RPCs are `MACHINE_METHODS`** — the write token, refused read-only, and the
  automation hook blocks a script that names either against a live port. `update_apply`
  replaces the binary the user's whole Teams account runs through and then restarts it,
  which would also cut a live `@claude` reply in half: the same failure
  `teams-lite-service.sh update --now` is blocked for.
- **The swap is a RENAME, never a write into the running file.** Every running process
  keeps the inode it started from — overwriting the bytes of a running executable is how a
  process gets a `SIGBUS` — and the next start gets the new build
  (`update::install_binary`, pinned by an inode assertion).
- **A NEW BINARY IS A NEW BACKEND AND A NEW WEB BUNDLE, and neither is told apart by its
  SIZE.** The release asset is one file that CARRIES both: the launcher unpacks the Rust
  backend to `~/.cache/teams-lite/server` and the web app to `.../web`, keeps what is
  already there when it is the asset this binary holds, and used to decide that on the byte
  COUNT. A Rust release binary's size is decided by section alignment, so three consecutive
  builds weighed exactly 17 432 216 bytes — the update installed the new launcher, the
  launcher kept the backend it had extracted two commits earlier, and the BACKEND is the
  process that compares its own build with the release. So the app offered the same update
  for ever: download, apply, restart, `Update available`, again — with a new UI in front of
  an old backend, where a new RPC answers `unknown method`. An asset is identified by its
  CONTENT now (`assetId` in `launcher/src/embedded-cache.ts`, stamped beside the extracted
  copy), every failure to read that stamp extracts again, and the backend is moved into
  place by a RENAME for the same reason `update::install_binary` is — the released unit and
  a `teams` the user typed share one cache path, so this machine may be running the file
  being replaced. `launcher/src/embedded-cache.test.ts` pins each half, and scans both
  extractors so a size comparison — which reads as a sensible optimisation — cannot come
  back.
- **What is downloaded is checked before it can be installed**: the byte count must match
  the size the release published, and the first four bytes must be an ELF header. Neither
  alone is enough — a captive portal's login page is the wrong shape, and a cut-off
  transfer of the real asset is the right one — and a file that fails is deleted rather
  than kept, because the next click would install it.
- **`latest` IS A ROLLING TAG, so a size is only true at the moment it was read.** CI
  republishes that tag on every push, and this app stays up for weeks: the asset the startup
  check measured is replaced without anything here noticing. A transfer verified against that
  remembered number then failed *forever* — and the only thing the button offered was to try
  the same stale number again, which left the user with no way forward at all. It happened,
  on a difference of one 4 096-byte page. Three things follow, and each is pinned by a test:
  - **Every download re-reads the release first** (`Ctx::refresh_release`, over
    `Ctx::fetch_release_asset`), and fetches what THAT answer names — never what the
    greeting carried. `Ctx::publish_release` is the one spelling of the availability
    payload, so a size the button draws its bar against is corrected in the same breath.
  - **It attempts twice, and no more.** The asset can also be replaced *during* a transfer,
    and the second attempt — which reads the release again — is what heals that. Bounded at
    `DOWNLOAD_ATTEMPTS`, because a download that retried forever would hide a broken
    release. A re-read that finds this build CURRENT is not a failure: the row empties
    itself (`Ctx::forget_release`).
  - **A mismatch says which mismatch it is, meaning first.** Fewer bytes than published is a
    transfer that stopped; MORE is a different build, and calling that "cut short" sent its
    reader hunting a network fault that was never there. The response's own `Content-Length`
    is checked before the bytes, so a replaced asset costs a page rather than 130 MB — but it
    is never taken as the expected size, since a captive portal states a length too.
- **A failed SWAP says why, on this machine and to every page.** The swap is the one step that
  touches something outside this process, so it is the step that fails for reasons nobody in
  the app can guess at — and it used to fail silently: the page that had clicked drew a
  failure out of its rejected RPC, the journal held nothing, a second page kept drawing
  `Restarting…`, and the sentence the user got named the install path with the CAUSE stripped
  off it (`e.to_string()` on an `anyhow::Error` is the outermost context alone). All three
  halves are pinned by a test: the slot goes `Failed` with the whole chain so every page
  agrees, one journal line keeps the record after that page is closed, and **an RPC refusal
  reaches its client as `{e:#}`** — which is every surface that states a refusal, the composer
  and the approval menu included. The retry is a fresh download, which is what heals the
  commonest cause.
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
- **The user can also ask NOW, from Settings › This app** (`update_check`), which is the poll's
  own pass on their own ask — and the only surface that answers "there is nothing new". See
  § Settings › This app, which also holds the restart that has no new binary in it.

`web/mock/server.ts` reproduces the whole flow with no GitHub and no binary (armed with
the `{kind: "update"}` test hook, which a spec MUST clear afterwards — one mock process
serves the whole run, and a left-behind update moves every later sidebar). `fail_once` on
that hook arms the replaced-asset failure, because the half a PAGE owns is that a failure it
shows is one the button really recovers from; `changes: false` arms the comparison the
backend could not read, and `changes_omitted` the build so far behind that the list is
capped. `cd web && bun run preview -- --out /tmp/upd
--update` captures the button, the changelog it discloses in both themes, the capped list,
the download mid-transfer, the restart it offers next, the failure and its reason, and the
link the other install shape keeps.

## Settings › This app (a manual check, and a restart)

Settings' last section holds the two things the user can do to the APP rather than to their
Teams account: **Check for updates**, and **Restart the backend**
(`web/src/components/maintenance-settings.tsx`, over the pure `web/src/lib/maintenance.ts`).
Both exist for the same reason, and it is the reason most of this app exists: it is read from
a PHONE, over a tailnet, and the machine it runs on is somewhere else — everything either row
does used to need a terminal on that machine.

**Both report their outcome where the click was made**, which is the rule § Sending messages
states for the composer and § The trackers for the approval menu. These two need it more than
either: a check that finds nothing new changes nothing anywhere else in the app, and a restart
nobody carried out looks exactly like one that worked. The words for every state live in
`maintenance.ts` so they are unit-tested; the component holds the one thing a pure function
cannot know — whether the socket really went down and came back.

**`update_check` is the POLL's own pass, on the user's ask** (`Ctx::check_release_now`, over
the shared `Ctx::release_pass` — one spelling of "is there a newer build", with `ReleaseAsk`
carrying the single difference between the clock and the button). Four rules, each pinned by a
test:

- **It is an OPEN read, unlike everything else in this area.** It changes nothing on this
  machine, publishes nothing about the user, and makes the request the backend already makes
  every two minutes — a gate would only stop a page from answering "am I up to date?".
- **The user's ask TAKES the machine's slot**, whatever its timestamp says
  (`Ctx::claim_release_read`): they pressed the button to learn where they stand now, and an
  answer up to two minutes old is not that. It still MOVES the timestamp, so the clock's next
  tick stands down — one request for the press, not one for the press and one behind it.
- **A request the USER asked for and could not make is a failure, never a verdict.** The poll
  falls back to the stored answer with one journal line; a manual check reports the reason
  instead, because "you are up to date" on the strength of a read that failed is the one
  answer it must not give.
- **The row says an update exists and points at the SIDEBAR.** The update control there is
  the one place a build is downloaded and restarted onto (§ Updating the app from inside it);
  a second one here would be a second spelling of six states. Nothing in either surface ever
  names a commit.

**`restart_backend` is `update_apply` minus the new binary, and the same two shapes carry it
out** (`src/restart.rs` decides which). It is the one repair for a backend that answers reads
and has stopped doing something else — and it is deliberately NOT the fix for a broken
sign-in, which has its own button on its own banner because that one restarts the Intune
container instead. Five rules hold it, and each is pinned by a test:

- **A backend cannot restart itself, so something has to bring it back — and each watcher
  SAYS so.** The staged service is the backend under systemd, so it exits and `Restart=always`
  starts it again; the `teams` command and `teams-lite-app.service` run the LAUNCHER, which
  owns the backend as a child and re-spawns it on the `backend_restart` event
  (`launcher/src/backend-restart.ts`), with its web server never going down — so the page
  stays served and only its socket blinks. Neither is detected: `INVOCATION_ID` proves only
  that systemd started something in this tree (a launcher unit's child inherits it) and
  `Restart=` is invisible from inside a process, so the launcher sets `TEAMS_LITE_LAUNCHER` on
  every backend it spawns and the backend unit declares `TEAMS_LITE_RESTART_ON_EXIT`. **A
  backend nobody watches is REFUSED** and told so — a button that stopped the app for good is
  the one outcome this must not have.
- **The re-spawned child keeps the PINNED write token.** A fresh one would leave every send
  refused until somebody reloaded, which is the exact failure the pinned token exists to
  prevent (§ Automation safety).
- **The user asks twice while a local agent is writing a reply.** A run dies with the process
  and nothing can resume it, so the first press is answered with the count it would cut off
  (`restarted: false, blocked: "agent"`) and `force` is the second press — Delete's own
  pattern, decided in the BACKEND because the count is a fact only it holds: a page knows
  about the runs it happened to watch, and the common case is a reply asked for from a phone.
  The sentence never says the answer is lost, because it is not: whichever backend comes up
  rewrites that message as interrupted (`repair_abandoned_agent_runs`).
- **The answer goes out before the process does** (`RESTART_ANSWER_GRACE`), because the reply
  travels on the socket the restart drops — and the calling registration is handed back on the
  way out, exactly as the idle shutdown does it and for its reason.
- **The SOCKET is the proof.** It drops when the backend goes and returns when it is back, so
  a restart this page watched happen is one it can report. Nothing dropping inside
  `RESTART_STALLED_MS` is the launcher not being there at all — the backend accepted, asked,
  and nobody acted — and the row says so rather than spinning for ever. A connection that went
  and has not returned stays `Restarting…` on purpose: the app already says the backend is
  down, and this row must not call a restart on its way a failure.

It is gated as a `MACHINE_METHODS` entry — the write token, refused read-only — and the
automation hook blocks a script that names it against a live port, for the reason it blocks
`update_apply`: tooling must not restart the app somebody is reading.

`web/mock/server.ts` reproduces both rows with no GitHub and nothing to restart (the
`{kind:"maintenance"}` test hook arms a check's outcome, the agent runs a restart would cut
off, and the machine that would refuse — a spec MUST reset it, since one mock process serves
the whole run). `cd web && bun run preview -- --out /tmp/app --maintenance` captures the
section, the check's answer and the armed restart in both themes, and
`web/e2e/maintenance.spec.ts` pins every rule above.

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
- **And it waits BEFORE it stages, because staging alone breaks the running app.** The web
  bundle is a DIRECTORY of hashed chunks and the SSR handler imports them off disk as the
  routes are asked for, so a `dist/` replaced under the live web server leaves it holding a
  module graph whose files are gone: the process stays up and every page dies. It reached
  the user on 2026-08-06 — an `update` staged, then held its restart for a 40-minute
  `@claude` run, and their phone was served Bun's own "fetch(req) did not return a Response
  object" page for all of it. So the order is build (which touches nothing live), wait,
  stage, restart, and `update::tests::the_installer_waits_before_it_replaces_a_live_artifact`
  pins it. The other half is in the app: `renderWithSsr` in `web/server.ts` never hands Bun
  an object it refuses to serve — it tells a REPLACED bundle from an SSR fault by the build
  stamp on disk (`bundleWasReplaced`) and answers 503 or 500 accordingly, because the
  reader's next move differs and "we are updating" about a real fault sends them reloading
  for ever. Neither half replaces the other: `install` stages without restarting anything.
  Note what Bun's own refusal cost — srvx's `NodeResponse` passes `instanceof Response` and
  is still refused, so the test is the CONSTRUCTOR, and the cause is read out of the refused
  body rather than dumped as a wall of getters.
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
- **A backend can also freeze the WRONG bus at BOOT, and that one is permanent.** The
  address is resolved once and frozen at exec, so a backend that started before the
  container was ready holds the HOST session bus — which carries no broker at all — for
  as long as it lives. It never exits over it either: a broken sign-in is deliberately
  not fatal (see § A broken sign-in costs the LIVE feed), so the process stays
  `active (running)`, answers every read out of the store, and signs in to nothing.
  It happened to `teams-lite-app.service` on this host: four start attempts lost the
  race, the survivor froze `/run/user/1000/bus`, and the app on 19442 could not reach
  Teams while the staged pair on 19420 worked perfectly. Nothing noticed, because every
  existing self-heal watches the CONTAINER and the container was healthy — the `.path`
  unit fires on a WRITE to `rootless.json` and on a boot that write lands before
  anything is watching, `PartOf=` never fires because the container unit is a
  `Type=oneshot` that stays "active (exited)", and the keyring check answers about the
  keyring. Two halves fix it, and neither replaces the other:
  - **The wrappers WAIT, so the first start is the right one.**
    `teams_lite_wait_for_broker_bus` (`bin/broker-env.sh`) polls the existing detection
    for `TEAMS_LITE_BROKER_WAIT_SECONDS` (30), and the wrapper install.sh writes carries
    its own copy of that loop because it is self-contained by design. It waits only while
    a container is KNOWN — `rootless.json` exists, a stale one from the last boot
    included — so a classic-Intune host and a machine with no Intune launch at once
    rather than hanging. For the staged backend this also replaces a start that exited 69
    and handed the retry to `Restart=always`, whose backoff walks to 300 s: losing the
    first race cost minutes of silence for a container that was up two seconds later.
  - **The health timer compares the two answers, and restarts what disagrees.**
    `bin/teams-lite-broker-bus-check.sh` reads where the broker IS
    (`teams_lite_broker_bus`) against where each running backend is still dialling
    (`teams_lite_frozen_bus_of_pid`, over `/proc/<pid>/environ`) and asks
    `teams-lite-backend-restart.service` for the repair — the same unit the `.path` uses,
    so a restart is spelled once. It tests the CAUSE rather than a symptom, exactly as
    the keyring check does, because a failed token call is equally what a locked keyring,
    a stopping container and a slow reply look like and each has a different repair. It
    never touches the container: the container is healthy in this failure. And it
    **never repairs on ignorance** — no resolvable container bus, an unreadable
    `/proc` entry or a stopped unit all answer "cannot tell" (exit 2) and restart
    nothing, since a restart with the container down would only fail the backend's own
    start and take the history offline while it walked up the backoff.
  Both halves are pinned by
  `update::tests::a_backend_that_froze_the_wrong_broker_bus_is_found_and_restarted`,
  which scans the units and both wrappers — every one of those files is on the other side
  of a process boundary, so a change there is invisible to every other test. **The bare
  check is yours; `--repair` is not**: it restarts two send-capable backends, so the
  automation hook blocks that flag for the reason it blocks every other backend start.
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
  That timer runs the BUS check beside this one (see the bullet above), ordered after it:
  the keyring is the older and commoner fault, and its own "cannot tell" then skips the
  second — the right direction, since a host where the keyring cannot be read is one
  where the bus answer would be no better.
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
registration. One thing is deliberately NOT shared: the tailnet mapping (give the released
one its own port if the phone should reach it — this machine serves 8443 → 19440 and
8444 → 19442).

**A setting a NEWER build understands is not one an OLDER build honours**, and the presence
HOURS and their ZONE (§ The user's own status) are the first to show it: both backends refresh the one
registration, so an install from before that commit keeps the user green at 03:00 whatever
window the other one was given. Nothing here can prevent that — the older process reads a
row it has never heard of — and it heals with the next update, which is what the released
build is there to exercise. Worth knowing before diagnosing a window that seems not to hold.

**They also share the DOWNLOAD CACHE, and that one bit them.** `~/.cache/teams-lite/updates`
is per MACHINE while an update's phase is per PROCESS, so the staged service's own cleanup
reached the released build's 130 MB: the staged pair IS the newest release within minutes of
every push, its two-minute poll therefore found itself current, and it cleared that directory
wholesale — including the build the released one had just downloaded and was one click from
installing. The second click failed, and the reader was shown the install path with no reason
under it. So a cleanup **prunes by rev and spares whatever `latest` names**
(`update::prune_downloads`, and there is deliberately no way to spell "remove everything"):
every install fetches exactly what `latest` names, which is what makes one process's cleanup
safe for another's transfer. The kept build is a bounded 130 MB that the next release clears.
A phase check cannot stand in for it — this backend's phase says nothing about the other's.

**CALLING runs in BOTH, and that is the one rule here that was reversed on purpose.** The
app unit used to carry `TEAMS_LITE_CALLING=0` so only the staged pair rang; the cost was
that every call and Join control on 19442 was drawn disabled, and a phone whose bookmark
pointed there found an app that could not call. Both register now — a calling endpoint id
is keyed by the PORT, so they are two devices to the service and a call rings both, exactly
as it rings a phone beside a laptop. That second ring is the deliberate price of every
window being able to place a call.

**The REAL-TIME endpoint id is the sharpest thing they must not share, and it was the one
bug this arrangement really cost.** The live feed follows the endpoint id, and a second
registration of the same id REPLACES the first: the service then pushes every message,
typing signal and read receipt to whichever backend registered last. The id was derived
from the store's path, so one store meant one id — the released build took the feed, and
the user's own app went live-silent. Nothing looked wrong: reads answer from the store,
the other backend kept writing to it, so a sent message appeared only when the page was
RELOADED. Two rules follow, and each is pinned by a test in `src/bin/server.rs`:

- **One id per backend and per worker** (`endpoint_id_path`, keyed by the port, which is
  what tells this machine's backends apart). That covers the read-only backend too: a
  screenshot backend must not take the phone's live feed either.
- **A live frame is broadcast by the backend that RECEIVED it**, whether or not that
  process was the one that wrote the row. Both hold a feed and both ingest the same frame,
  so gating the broadcast on `insert_message` returning true left the loser of that race
  telling its own pages nothing. The store's row is shared; what a page has SEEN is not. A
  re-delivered frame costs nothing, because a client merges by id. Push and the agent
  answer stay behind the insert: those are per-machine actions, already claimed.

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
- **What a restart cannot fix says so IN FLOW, never behind a hover.** Only
  `Disconnected` is repairable here (`BrokerFailure::is_repairable`); `Refused` is now
  answered by the app itself — the banner offers a sign-in in the browser instead (see
  § Signing in again) — and `NoAccount` still needs the user to sign in to Intune again,
  which is the one remedy on this banner that is theirs to carry out. The button stays
  visible and inert — a missing one
  would read as "nothing can be done" without saying so — and the sentence beside it sits
  in the same slot the repairable branch puts its own footnote in
  (`broker-repair-hint`), because it was a Radix TOOLTIP once and this app is read from a
  PHONE: no hover there, so the state whose whole answer is "go and sign in" showed a dead
  button and no words at all. In flow it also lands inside the banner's `aria-live` region
  rather than waiting for a focus. `web/e2e/broker-banner.spec.ts` pins that the words are
  visible with no pointer anywhere near them.

## Signing in again, from the app (the broker's own window, in the browser)

A sign-in breaks in two ways and only one of them is a locked keyring. The other is Entra
answering `interaction_required` for a resource whose refresh token has died — and until this
change the app's whole answer was a dead button and the sentence "it needs you to sign in to
Intune again", which in practice meant SSH to the machine, an `Xvfb`, `x11vnc`, `websockify`,
noVNC, `openbox` (without a window manager a click focuses nothing, so the password could not
be typed at all) and `xdotool`. Measured once, by hand: about forty minutes, and it did not
finish. **SIGN-IN.md is the measured map** — read it before touching any of this.
`src/auth.rs` holds the automatic half, `src/signin.rs` the session, `src/xwindow.rs` the X
half, `src/png.rs` the frames, `web/src/lib/signin.ts` every pure decision and
`web/src/components/signin-panel.tsx` the surface.

**MOST OUTAGES NOW END WITH NOBODY BEING TOLD THERE WAS ONE, and that is one method name.**
Measured on this tenant on 2026-08-18, on a live outage that had been failing every 30 s for
hours: `acquireTokenSilently` refused the skype scope with `interaction_required` /
`token_expired`, and `acquireTokenInteractively` — **the same request, byte for byte** — minted
the token in under a second with **no window and nobody typing**. The silent path only
refreshes the resource's own refresh token, which is the thing that had died; the interactive
one redeems the machine's Primary Refresh Token for that resource. The silent path then worked
again for both scopes, and the backend reconnected to Teams on its own. So `auth::acquire_token`
retries interactively on exactly the refusal codes that mean "a human may be needed"
(`auth::rescue`), and three bounds hold it: a read-only backend never tries, one attempt runs
at a time, and at most one every `RESCUE_MIN_INTERVAL`. A window that goes up with nobody
watching is taken back before returning, so the broker's display never collects abandoned
sign-ins.

**WHEN A HUMAN REALLY IS NEEDED, THE WINDOW COMES TO THE BROWSER.** There is no way around
the window and it is not for want of looking: the broker refuses a device-code flow on Linux
(its own binary carries "AcquireTokenWithDeviceCodeFlow is not implemented on Linux platform"),
it renders the sign-in itself in an embedded WebKitGTK view, an ordinary browser is refused by
this tenant's Conditional Access, and the Company Portal answers `4rfhk` on an enrolled device.
So the app serves that one window: a PNG a second, and the reader's keys and taps back.
Nine rules hold it, and each is pinned by a test:

- **THERE IS NO PASSWORD FIELD, and that is the design.** The reader types into Microsoft's own
  page and every keystroke travels as one key press (`signin_input`, one character at a time —
  `parse_key` refuses more). Nothing in this app or its backend assembles, stores or logs a
  password. A field here would have been the easy shape and the wrong one.
- **Nothing is served unless THIS backend started a sign-in and it is still running**
  (`Ctx::with_live_signin`). That is the whole authorization: with no live session there is no
  frame and no keystroke, so the app can never be asked for a picture of the machine's screen.
- **A frame is ONE WINDOW, found by the broker's own `WM_CLASS`** — and by its MAP STATE, which
  only the real thing showed: after a flow ends the broker leaves an **unmapped 10x10 window
  behind carrying the same class**, and `GetImage` on it is a `BadMatch`. Matched on the class
  alone, this app reported an X error code where the honest answer was "no sign-in window is
  open". Never the root window: the display it lives on held six other windows when this was
  measured, and forty on the container's own.
- **The display is READ from the broker, never chosen** (`/proc/<pid>/environ`, measured
  `DISPLAY=:77`). The broker is D-Bus activated and its environment is frozen at activation, so
  a display chosen here would either be ignored or, worse, strand it — `intune-container` ships
  a whole script for that bug. A display the broker names and nothing serves is a stated state
  with a remedy, not a mystery. **This process's own `DISPLAY` is not a fallback either**: on a
  desktop session it answers `:0`, whose socket exists, so the app offered a sign-in and then
  watched a display the broker never draws on — ten minutes at `starting`, with the real window
  left standing somewhere else.
- **A flow is ended by CLOSING ITS WINDOW, never by `cancelInteractiveFlow`.** Measured: that
  D-Bus call with an empty body took the broker OFF THE BUS — which is `BrokerFailure::Disconnected`,
  the one signature whose automatic remedy is restarting the user's whole Intune container. A
  closed window ends the pending call as a named cancellation (`status: 7`) and the broker stays
  up. **Cancel also STOPS THE RUN**, because during `starting` there is no window yet: closing
  alone made Cancel a silent no-op in the phase most sign-ins live in, and left the session live,
  so no new sign-in could be started for ten minutes.
- **The window is looked for only while THIS session's own call is out** (`auth::InteractiveTurn`,
  taken as a value rather than hidden inside the call). Promoted on any viewable broker window, a
  session drew the one the automatic rescue had put up and was about to close — the reader typing
  their password into the flow whose token nobody reads, which is the very thing the
  single-flight turn exists to prevent.
- **Reading the phase is a READ**: no X, no promotion. `signin_status` is open, so a client that
  merely found the socket could otherwise flip the recorded phase and set the backend to work on
  the broker's display, once per call, with no token.
- **The scope a sign-in acquires is the one that FAILED** (`auth::BrokerState::scope`). A refusal
  is per resource — measured, Graph minted while the skype scope refused — so signing in for a
  different one would mint a token, clear the broker's state and report "sign-in works again"
  over a feature still dark.
- **A keystroke queue, because a password is a sequence.** The page sends one character per
  request and CHAINS them: a phone's keyboard (or a password manager) inserts a whole word at
  once, and fanned out un-awaited against a backend that serves requests concurrently, `Hunter2!`
  can arrive as `Hnu2te!r` — refused by Microsoft, with nothing in the app able to say why.
- **The four write methods are `MACHINE_METHODS`; asking how it is GOING is open.**
  `signin_start` authenticates as the user, `signin_frame` answers with a picture of a sign-in
  page and `signin_input` presses keys into it — so `signin_frame` is gated as hard as the
  rest, because a read whose answer is somebody's password field is not a read. `signin_status`
  publishes no pixels and no keys, so it stays open like `write_lock_status`. The automation
  hook blocks all four against a live port.
- **The banner offers exactly ONE remedy** (`brokerRemedy`, pure and unit-tested): the container
  restart where a restart is the cause, the sign-in where a human is, and where a sign-in is
  what is needed and the machine cannot serve one, the button stays visible and inert with the
  backend's own sentence under it — IN FLOW, because on a phone a hover is a sentence that does
  not exist. Two buttons would ask the reader to know which failure they have, which is the
  thing they opened the app to be told.
- **`NoAccount` is deliberately NOT offered a sign-in**, though it reads like the case that
  needs one most: with no account the interactive request has nobody to name, and what is gone
  is the device's enrolment — `intune-container`'s business rather than a token's.
- **The state is the APP's, not the panel's**, and it rides the greeting. A sign-in is exactly
  when a reader changes device — press it on the laptop, pick the phone up for the
  Authenticator — so a page that connects mid-flow draws the panel it never started. The FRAMES
  are the panel's alone: a PNG a second has no business in the whole app's state.

The scope a sign-in acquires is the backend's choice and never the caller's
(`Ctx::signin_scope`): a client naming one would be choosing what this machine authenticates
for. The panel is bounded and scrolls, because the content is a picture 675 px tall and the
Cancel button was off the screen below it — the spec caught that by not being able to click it.

`web/mock/server.ts` reproduces the whole flow with no broker, no X display and no tenant: it
DRAWS its own sign-in page as a real PNG (`mockSigninFrame`, over the same `pngChunk` writer the
inline-picture fixtures use), with a number to match and one dot per character typed — which is
what makes this surface reviewable at all, since the one thing a reader must be able to do is
read a number off somebody else's window. Its `{kind:"signin"}` hook arms what the next sign-in
does (`window`, `immediate`, `refuse`, `fail`) and **a spec MUST reset it**: one mock process
serves the whole run, and a sign-in left running puts a dialog over every later spec.
`cd web && bun run preview -- --out /tmp/si --signin` captures the offer in both themes, the
sign-in that needed nobody, the window in both themes, the words typed into it, a phone's width,
the cancel and the machine that cannot serve one; `web/e2e/signin.spec.ts` pins every rule
above, and `examples/signin_window_recon.rs` re-measures the window against the real broker,
read-only.

**What is UNVERIFIED against the tenant is the pairing.** The automatic half is measured end to
end on a real outage (above). Of the served half, every piece is measured through this crate's
own code — the display, the window's identity, a 34 KB frame of the real branded page, typing
six characters into it (three shifted) and seeing six dots, and the close that cancels cleanly
— but **nobody has typed a real password into a teams-lite frame and come out with a token**,
because that needs a PRT this side cannot expire on purpose. Number matching through the served
window is unmeasured for the same reason. Do not write a number into SIGN-IN.md that nothing
measured; run `examples/signin_window_recon.rs` instead.

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
- **A branch lands on `master` as ONE commit — always SQUASH.** `git merge --squash
  <branch>` locally, `gh pr merge --squash` for a pull request; never a merge commit,
  and never a plain fast-forward that replays the branch's own history. A worktree's
  work-in-progress is a fix, a rename and an "actually no"; `master` is the record of
  what shipped — and it is also what the release notes are built from, since
  `src/changelog.rs` groups conventional commits into every release body (see
  § Updating the app from inside it). So each intermediate commit that reaches `master`
  becomes a line somebody reads in the app's own changelog. The squashed subject is
  the one the whole branch deserves, conventional-commit style, with the branch's own
  subjects dropped rather than piled into the body.
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
- **`/ship` is that whole sequence in one command** (`.claude/commands/ship.md`):
  commit the open work, run the checks above as the gate, fast-forward `master` onto
  the rebased branch, push, then clean up. It refuses to run from the main checkout,
  and it never squashes, never force-pushes `master` and never touches a third branch.
  Two things about it are worth knowing before it is used:
  - **The gate is the only thing between a commit and three people's Teams client.**
    A push to `master` republishes the rolling `latest` release, so the update button
    offers that commit to every install and the always-on service re-stages itself from
    the checkout (see § Updating the app from inside it and § The always-on service).
    `master` is not a staging area here — a red check is where the command stops.
  - **A worktree under `~/.t3/worktrees/` is KEPT, and its build artifacts are pruned
    instead.** T3 Code owns that directory and re-spawns the agent with the same working
    directory on every turn, so removing it kills the thread on the next message. The
    merge and the push are the point; the cleanup is not. What the kept worktree does
    give up is its build cache (`.claude/scripts/prune-worktree-artifacts.sh`) — twenty
    of them once filled a 98 GB disk with 53 GB of `target/` alone — so the next build
    in it is a cold one.

## Working style (MANDATORY)

- **Act autonomously.** For every prompt, drive the task to completion without
  waiting for hand-holding. Investigate, decide, implement, and verify on your own.
- **Always write clean code.** Favor clear naming, small focused units, and proper
  separation of concerns over quick hacks.
- **Choose the professional solution.** When you spot a problem, fix it properly.
  Never take a shortcut just because it is easier or faster.
- **Address root causes, not symptoms.** If a proper fix requires more work, do the
  work rather than patching around the issue.
