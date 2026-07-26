// Adaptive / connector cards — the payload hiding behind Teams' "Card - access it
// on https://go.skype.com/cards.unsupported" fallback sentence.
//
// A card message body is a `SWIFT.1` URIObject:
//
//   <URIObject type="SWIFT.1" url_thumbnail="…">Card - access it on
//     <a href="https://go.skype.com/cards.unsupported">…</a>.
//     <Title>Card</Title>
//     <Swift b64="eyJzdW1tYXJ5Ijoi…"/>
//   </URIObject>
//
// The visible text is Skype's "this client cannot render me" apology; the REAL
// payload is the base64 in `<Swift b64="…">` — a Bot Framework activity whose
// `attachments` carry the card itself. Two content types show up in the tenant:
//
//   - `application/vnd.microsoft.card.adaptive` — an Adaptive Card (polls, GitHub
//     / Figma sign-in prompts): a nested tree of `TextBlock` / `Container` /
//     `ColumnSet` / `FactSet` / `Input.*` elements plus `actions`.
//   - `application/vnd.microsoft.teams.card.o365connector` — a legacy connector
//     card (monitoring alerts relayed by a webhook): `title` / `text` (HTML) /
//     `sections[].facts` / `potentialAction`.
//
// This module flattens either into ONE small, presentation-free payload the UI can
// render without knowing anything about Adaptive Cards:
//
//   { "title": "…", "text": "…", "facts": [{"title","value"}], "actions": [{"title","url"}] }
//
// `text` is PLAIN text (tags stripped, `\n` between blocks) so a front-end can
// print it verbatim; nothing here is ever HTML. Images, styling, input widgets and
// submit payloads are deliberately dropped — a chat bubble is not a card host.
// Everything is bounded (see the MAX_* constants) so a pathological card cannot
// bloat a stored row.

use base64::Engine;
use serde_json::{json, Value};

use crate::teams_read::{xml_attr, xml_first_value};

/// Bounds on what one card contributes to a stored row. Real cards are far below
/// these; the caps exist so a hostile or generated card cannot grow a message row
/// without limit.
const MAX_TEXT_CHARS: usize = 4000;
const MAX_TEXT_BLOCKS: usize = 64;
const MAX_FACTS: usize = 32;
const MAX_ACTIONS: usize = 8;

/// The Skype placeholder title on a card body ("Card"), which carries no
/// information and must never become the card's title.
const PLACEHOLDER_TITLE: &str = "Card";

/// The default content type reported for a card whose attachment does not name one.
const ADAPTIVE_CONTENT_TYPE: &str = "application/vnd.microsoft.card.adaptive";

/// Outcome of inspecting a message body for a `SWIFT.1` card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwiftCard {
    /// The card payload, as the attachment entry the UI renders (see
    /// [`card_attachment`] for the exact shape).
    Card(Value),
    /// The body IS a card, but its payload could not be recovered. Carries a short,
    /// loggable reason so a dropped payload is diagnosable instead of silently
    /// becoming an empty bubble — the caller keeps the fallback body in that case.
    Undecodable(&'static str),
}

/// Recognise a `SWIFT.1` card body and decode its payload, or `None` when the body
/// is not a card (so the caller handles it as a normal message).
///
/// Detection is by body SHAPE (a `<URIObject type="SWIFT.1">`), not `messagetype`,
/// matching how [`crate::teams_read::parse_call_recording`] recognises a recording:
/// the same check then works on live frames, history rows and legacy-row cleanups.
pub fn parse_swift_card(content: &str) -> Option<SwiftCard> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("<URIObject") {
        return None;
    }
    let open_tag = &trimmed[..trimmed.find('>').map(|g| g + 1).unwrap_or(trimmed.len())];
    if !xml_attr(open_tag, "type").is_some_and(|t| t.eq_ignore_ascii_case("SWIFT.1")) {
        return None;
    }
    let Some(b64) = swift_b64(trimmed) else {
        return Some(SwiftCard::Undecodable("no <Swift b64> element"));
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) else {
        return Some(SwiftCard::Undecodable("<Swift b64> is not valid base64"));
    };
    let Ok(activity) = serde_json::from_slice::<Value>(&bytes) else {
        return Some(SwiftCard::Undecodable("<Swift b64> payload is not JSON"));
    };
    Some(SwiftCard::Card(card_attachment(&activity, uri_object_title(trimmed))))
}

/// Flatten a BARE card payload — an Adaptive Card object that did not arrive inside
/// a Bot Framework activity — into the same `kind:"card"` attachment
/// [`parse_swift_card`] produces.
///
/// The link-unfurl path needs this: an app's unfurl card sits in
/// `properties.cards[].content` as a plain `{"type":"AdaptiveCard","body":[…]}` with
/// no activity envelope around it (see [`crate::teams_unfurl`]). Wrapping it in a
/// synthetic one-attachment activity keeps ONE card flattener for both shapes rather
/// than a second, drifting implementation.
pub fn adaptive_card_attachment(content: &Value, fallback_title: Option<String>) -> Value {
    let activity = json!({
        "attachments": [{ "contentType": ADAPTIVE_CONTENT_TYPE, "content": content }]
    });
    card_attachment(&activity, fallback_title)
}

/// The base64 payload of the `<Swift b64="…">` element, bounded to that element's
/// own opening tag so no other attribute in the body can be mistaken for it.
fn swift_b64(content: &str) -> Option<String> {
    let lower = content.to_ascii_lowercase();
    let at = lower.find("<swift")?;
    let tag = &content[at..];
    let end = tag.find('>').map(|g| g + 1).unwrap_or(tag.len());
    xml_attr(&tag[..end], "b64").filter(|b| !b.trim().is_empty())
}

/// The URIObject's own `<Title>`, used as a last-resort card title. Skype's
/// information-free placeholder ("Card") is treated as no title at all.
fn uri_object_title(content: &str) -> Option<String> {
    xml_first_value(content, "Title")
        .map(|t| html_to_text(&t))
        .filter(|t| !t.is_empty() && t != PLACEHOLDER_TITLE)
}

/// Build the attachment entry a decoded card rides on:
///
/// ```json
/// {
///   "name": "n-Alerts",                                     // card title, or "Card"
///   "content_type": "application/vnd.microsoft.card.adaptive",
///   "url": "",
///   "kind": "card",
///   "card": { "title": "…", "text": "…", "facts": […], "actions": […] }
/// }
/// ```
///
/// The four outer keys mirror a file attachment ([`crate::teams_read::file_to_attachment`])
/// so a generic attachment renderer — and the sidebar preview — always find a label,
/// while `kind: "card"` tells a card-aware UI to read `card` instead. `url` is empty
/// because a card is not a downloadable object; `content_type` keeps the Bot
/// Framework content type for provenance (adaptive vs o365 connector).
fn card_attachment(activity: &Value, fallback_title: Option<String>) -> Value {
    let attachment = activity
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|a| a.get("content").is_some());
    let content = attachment.and_then(|a| a.get("content")).unwrap_or(&Value::Null);
    let content_type = attachment
        .and_then(|a| a.get("contentType"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .unwrap_or(ADAPTIVE_CONTENT_TYPE)
        .to_string();

    let mut card = Card::default();
    card.collect(content);
    // The activity's `summary` is the bot's own one-line description of the card
    // ("Elena LOUMAGNE sent a poll"); it beats the URIObject's `<Title>`, which is
    // usually the Skype placeholder.
    let title = card
        .title
        .clone()
        .filter(|t| !t.is_empty())
        .or_else(|| {
            activity
                .get("summary")
                .and_then(Value::as_str)
                .map(html_to_text)
                .filter(|t| !t.is_empty())
        })
        .or(fallback_title)
        .unwrap_or_default();

    json!({
        "name": if title.is_empty() { PLACEHOLDER_TITLE.to_string() } else { title.clone() },
        "content_type": content_type,
        "url": "",
        "kind": "card",
        "card": {
            "title": title,
            "text": card.text(),
            "facts": card.facts,
            "actions": card.actions,
        },
    })
}

/// Accumulator for the flattened card: a title, text lines in document order,
/// label/value facts, and actions. Kept separate from the JSON shape so the walk
/// stays readable and the bounds are enforced in one place.
#[derive(Default)]
struct Card {
    title: Option<String>,
    lines: Vec<String>,
    facts: Vec<Value>,
    actions: Vec<Value>,
}

impl Card {
    /// The collected text: one line per visible block, capped in both directions.
    fn text(&self) -> String {
        let mut text = self.lines.join("\n");
        if text.chars().count() > MAX_TEXT_CHARS {
            text = text.chars().take(MAX_TEXT_CHARS).collect();
        }
        text
    }

    fn push_line(&mut self, line: &str) {
        let line = html_to_text(line);
        if !line.is_empty() && self.lines.len() < MAX_TEXT_BLOCKS {
            self.lines.push(line);
        }
    }

    fn push_fact(&mut self, title: &str, value: &str) {
        let (title, value) = (html_to_text(title), html_to_text(value));
        if (!title.is_empty() || !value.is_empty()) && self.facts.len() < MAX_FACTS {
            self.facts.push(json!({ "title": title, "value": value }));
        }
    }

    fn push_action(&mut self, title: &str, url: &str) {
        let title = html_to_text(title);
        if !title.is_empty() && self.actions.len() < MAX_ACTIONS {
            self.actions.push(json!({ "title": title, "url": url }));
        }
    }

    /// Flatten a card `content` object, whichever content type it belongs to. Both
    /// families are recognised by the keys they carry rather than by the attachment's
    /// declared type, so a mislabelled attachment still yields its text.
    fn collect(&mut self, content: &Value) {
        self.title = content
            .get("title")
            .or_else(|| content.get("summary"))
            .and_then(Value::as_str)
            .map(html_to_text)
            .filter(|t| !t.is_empty());
        // Connector card: a flat `text` (HTML) plus sections and potential actions.
        if let Some(text) = content.get("text").and_then(Value::as_str) {
            self.push_line(text);
        }
        for section in array(content.get("sections")) {
            self.collect_section(section);
        }
        for action in array(content.get("potentialAction")) {
            self.collect_potential_action(action);
        }
        // Adaptive card: a nested element tree plus card-level actions.
        self.collect_elements(content.get("body"));
        self.collect_actions(content.get("actions"));
    }

    /// A connector card section: its own titles, text and `{name, value}` facts.
    fn collect_section(&mut self, section: &Value) {
        for key in ["title", "activityTitle", "activitySubtitle", "text"] {
            if let Some(v) = section.get(key).and_then(Value::as_str) {
                self.push_line(v);
            }
        }
        for fact in array(section.get("facts")) {
            let name = fact
                .get("name")
                .or_else(|| fact.get("title"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = fact.get("value").and_then(Value::as_str).unwrap_or_default();
            self.push_fact(name, value);
        }
    }

    /// A connector card `potentialAction` — an `OpenUri` carries its link in
    /// `targets[].uri`; anything else contributes its name with no link.
    fn collect_potential_action(&mut self, action: &Value) {
        let title = action
            .get("name")
            .or_else(|| action.get("title"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let url = array(action.get("targets"))
            .iter()
            .find_map(|t| t.get("uri").and_then(Value::as_str))
            .unwrap_or_default();
        self.push_action(title, url);
    }

    /// Walk an Adaptive Card element list, recursing through the containers Teams
    /// actually nests (`Container`, `ColumnSet`/`Column`, `ActionSet`). Only text is
    /// kept: `TextBlock`s, `FactSet` facts, and an `Input.*` widget's label plus its
    /// choices (the question and options of a poll, which are its whole content).
    /// Images, separators and styling are dropped by design.
    fn collect_elements(&mut self, elements: Option<&Value>) {
        for element in array(elements) {
            // An explicitly hidden element is Teams' own bookkeeping, never content.
            if element.get("isVisible").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            match element.get("type").and_then(Value::as_str).unwrap_or_default() {
                "TextBlock" | "RichTextBlock" => {
                    if let Some(text) = element.get("text").and_then(Value::as_str) {
                        self.push_line(text);
                    }
                }
                "FactSet" => {
                    for fact in array(element.get("facts")) {
                        let title = fact.get("title").and_then(Value::as_str).unwrap_or_default();
                        let value = fact.get("value").and_then(Value::as_str).unwrap_or_default();
                        self.push_fact(title, value);
                    }
                }
                _ => {
                    if let Some(label) = element.get("label").and_then(Value::as_str) {
                        self.push_line(label);
                    }
                    for choice in array(element.get("choices")) {
                        if let Some(title) = choice.get("title").and_then(Value::as_str) {
                            self.push_line(title);
                        }
                    }
                }
            }
            // Containers nest their children under one of these keys.
            for key in ["items", "columns", "rows", "cells"] {
                self.collect_elements(element.get(key));
            }
            self.collect_actions(element.get("actions"));
        }
    }

    /// Adaptive Card actions: `Action.OpenUrl` carries a real link, `Action.Submit`
    /// (a poll vote, a bot command) carries only a title — kept with an empty url so
    /// the UI can render it as a non-actionable label rather than lose it.
    fn collect_actions(&mut self, actions: Option<&Value>) {
        for action in array(actions) {
            let title = action.get("title").and_then(Value::as_str).unwrap_or_default();
            let url = action
                .get("url")
                .and_then(Value::as_str)
                .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
                .unwrap_or_default();
            self.push_action(title, url);
        }
    }
}

/// A JSON array as a slice, or empty for any other shape — so the walk above never
/// needs to care whether a key is absent, null, or the wrong type.
fn array(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Flatten a card string to plain, single-spaced text: block boundaries become
/// spaces, tags are stripped, the entities Teams emits are decoded, and whitespace
/// is collapsed. Connector cards ship HTML in `text`, and even an Adaptive Card's
/// `TextBlock` can carry a mention `<span>`, so nothing from a card is trusted to be
/// plain. Not a sanitizer: it removes markup, it does not neutralise it — which is
/// why the stored `card` payload never contains HTML in the first place.
fn html_to_text(s: &str) -> String {
    let mut text = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' => in_tag = false,
            _ if in_tag => {}
            _ => text.push(c),
        }
    }
    let text = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wrap a Bot Framework activity in the `SWIFT.1` URIObject body Teams sends,
    /// exactly as the tenant delivers it (fallback sentence, `<Title>`, `<Swift b64>`).
    fn swift_body(activity: Value, title: &str) -> String {
        let b64 = base64::engine::general_purpose::STANDARD.encode(activity.to_string());
        format!(
            "<URIObject type=\"SWIFT.1\" url_thumbnail=\"https://urlp.asm.skype.com/x.png\">\
             Card - access it on <a href=\"https://go.skype.com/cards.unsupported\">\
             https://go.skype.com/cards.unsupported</a>. <Title>{title}</Title>\
             <Swift b64=\"{b64}\"/></URIObject>"
        )
    }

    fn card_of(body: &str) -> Value {
        match parse_swift_card(body) {
            Some(SwiftCard::Card(a)) => a,
            other => panic!("expected a card, got {other:?}"),
        }
    }

    #[test]
    fn a_non_card_body_is_not_a_card() {
        // Plain chat, an inline image, and a recording notice are all left alone.
        for body in [
            "<p>hello</p>",
            "<URIObject type=\"Picture.1\" uri=\"https://x/y\"><Title>Image</Title></URIObject>",
            "<URIObject type=\"Video.2/CallRecording.1\" status=\"Success\"><Title>Rec</Title></URIObject>",
            "",
        ] {
            assert!(parse_swift_card(body).is_none(), "{body} must not parse as a card");
        }
    }

    #[test]
    fn an_o365_connector_card_yields_its_text_facts_and_link() {
        // The shape the tenant's monitoring webhook posts: HTML text with a link.
        let body = swift_body(
            json!({
                "type": "message",
                "textFormat": "markdown",
                "attachments": [{
                    "contentType": "application/vnd.microsoft.teams.card.o365connector",
                    "content": {
                        "title": "n-Alerts",
                        "text": "<p>Filebeat error(s):\n<a href=\"https://kibana/app\">https://kibana/app</a></p>",
                        "sections": [{
                            "activityTitle": "production",
                            "facts": [{ "name": "level", "value": "error" }]
                        }],
                        "potentialAction": [{
                            "@type": "OpenUri",
                            "name": "Open Kibana",
                            "targets": [{ "os": "default", "uri": "https://kibana/app" }]
                        }]
                    }
                }]
            }),
            "Card",
        );
        let attachment = card_of(&body);
        assert_eq!(attachment["kind"], "card");
        assert_eq!(attachment["url"], "");
        assert_eq!(
            attachment["content_type"],
            "application/vnd.microsoft.teams.card.o365connector"
        );
        assert_eq!(attachment["name"], "n-Alerts");
        let card = &attachment["card"];
        assert_eq!(card["title"], "n-Alerts");
        assert_eq!(
            card["text"], "Filebeat error(s): https://kibana/app\nproduction",
            "HTML is flattened to plain text, one line per block"
        );
        assert_eq!(card["facts"], json!([{ "title": "level", "value": "error" }]));
        assert_eq!(
            card["actions"],
            json!([{ "title": "Open Kibana", "url": "https://kibana/app" }])
        );
    }

    #[test]
    fn an_adaptive_card_yields_its_nested_text_and_actions() {
        // A poll: the question is an Input.ChoiceSet label, the options its choices,
        // and the hidden bookkeeping TextBlock must not leak into the text.
        let body = swift_body(
            json!({
                "summary": "Elena sent a poll",
                "attachments": [{
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": {
                        "type": "AdaptiveCard",
                        "body": [
                            { "type": "ColumnSet", "columns": [{ "type": "Column", "items": [
                                { "type": "TextBlock", "text": "Poll" },
                                { "type": "TextBlock", "text": "Choice", "isVisible": false }
                            ]}]},
                            { "type": "Container", "items": [{
                                "type": "Input.ChoiceSet",
                                "label": "Laser game?",
                                "choices": [
                                    { "title": "Tuesday", "value": "0" },
                                    { "title": "Wednesday", "value": "1" }
                                ]
                            }]},
                            { "type": "Image", "url": "https://x/bar.png" },
                            { "type": "FactSet", "facts": [{ "title": "Votes", "value": "26" }] }
                        ],
                        "actions": [
                            { "type": "Action.Submit", "title": "Send the vote" },
                            { "type": "Action.OpenUrl", "title": "Open", "url": "https://forms/x" }
                        ]
                    }
                }]
            }),
            "Card",
        );
        let card = card_of(&body)["card"].clone();
        // No card-level `title`: the activity summary titles it.
        assert_eq!(card["title"], "Elena sent a poll");
        assert_eq!(card["text"], "Poll\nLaser game?\nTuesday\nWednesday");
        assert_eq!(card["facts"], json!([{ "title": "Votes", "value": "26" }]));
        assert_eq!(
            card["actions"],
            json!([
                { "title": "Send the vote", "url": "" },
                { "title": "Open", "url": "https://forms/x" }
            ]),
            "a submit action keeps its label with no link",
        );
    }

    #[test]
    fn a_mention_span_in_a_text_block_is_flattened() {
        let body = swift_body(
            json!({
                "attachments": [{
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": { "type": "AdaptiveCard", "body": [{
                        "type": "TextBlock",
                        "text": "Hi <span itemtype=\"http://schema.skype.com/Mention\" itemid=\"0\">Cl&#39;ment</span> \u{1f44b}"
                    }]}
                }]
            }),
            "Card",
        );
        assert_eq!(card_of(&body)["card"]["text"], "Hi Cl'ment 👋");
    }

    #[test]
    fn the_uri_object_title_is_the_last_resort_and_the_placeholder_is_not_a_title() {
        // No card title and no activity summary: fall back to the `<Title>` element…
        let payload = json!({ "attachments": [{ "content": { "type": "AdaptiveCard", "body": [] } }] });
        let titled = card_of(&swift_body(payload.clone(), "GitHub"));
        assert_eq!(titled["card"]["title"], "GitHub");
        assert_eq!(titled["name"], "GitHub");
        // …but Skype's information-free "Card" placeholder is NOT a title. The
        // attachment still carries a label so a generic renderer has something.
        let untitled = card_of(&swift_body(payload, "Card"));
        assert_eq!(untitled["card"]["title"], "");
        assert_eq!(untitled["name"], "Card");
        assert_eq!(
            untitled["content_type"], ADAPTIVE_CONTENT_TYPE,
            "an attachment with no contentType is reported as an adaptive card",
        );
    }

    #[test]
    fn an_undecodable_payload_is_reported_with_a_reason() {
        let cases = [
            (
                "<URIObject type=\"SWIFT.1\"><Title>Card</Title></URIObject>",
                "no <Swift b64> element",
            ),
            (
                "<URIObject type=\"SWIFT.1\"><Swift b64=\"!!!not base64!!!\"/></URIObject>",
                "<Swift b64> is not valid base64",
            ),
            (
                "<URIObject type=\"SWIFT.1\"><Swift b64=\"bm90IGpzb24=\"/></URIObject>",
                "<Swift b64> payload is not JSON",
            ),
        ];
        for (body, reason) in cases {
            assert_eq!(
                parse_swift_card(body),
                Some(SwiftCard::Undecodable(reason)),
                "{body}",
            );
        }
    }

    #[test]
    fn a_card_payload_is_bounded() {
        // A generated card cannot grow a stored row without limit.
        let blocks: Vec<Value> = (0..MAX_TEXT_BLOCKS * 2)
            .map(|i| json!({ "type": "TextBlock", "text": "x".repeat(200) + &i.to_string() }))
            .collect();
        let facts: Vec<Value> = (0..MAX_FACTS * 2)
            .map(|i| json!({ "title": format!("f{i}"), "value": "v" }))
            .collect();
        let actions: Vec<Value> = (0..MAX_ACTIONS * 2)
            .map(|i| json!({ "type": "Action.Submit", "title": format!("a{i}") }))
            .collect();
        let body = swift_body(
            json!({ "attachments": [{ "content": {
                "type": "AdaptiveCard",
                "body": [{ "type": "Container", "items": blocks },
                         { "type": "FactSet", "facts": facts }],
                "actions": actions
            }}]}),
            "Card",
        );
        let card = card_of(&body)["card"].clone();
        assert_eq!(card["text"].as_str().unwrap().chars().count(), MAX_TEXT_CHARS);
        assert_eq!(card["facts"].as_array().unwrap().len(), MAX_FACTS);
        assert_eq!(card["actions"].as_array().unwrap().len(), MAX_ACTIONS);
    }

    #[test]
    fn a_surprising_payload_degrades_to_an_empty_card_instead_of_failing() {
        // Neither an adaptive body nor connector text: the card is empty but valid,
        // and the message still renders as a card rather than as raw XML.
        let body = swift_body(json!({ "type": "message", "attachments": [] }), "Weekly report");
        let card = card_of(&body)["card"].clone();
        assert_eq!(card["title"], "Weekly report");
        assert_eq!(card["text"], "");
        assert_eq!(card["facts"], json!([]));
        assert_eq!(card["actions"], json!([]));
    }
}
