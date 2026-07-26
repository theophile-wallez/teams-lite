// App link-unfurl cards — the payload behind an `InputExtension` span.
//
// When a message contains a link an installed Teams app can describe (a GitHub repo,
// a Figma file, a Jira issue), Teams keeps the rendered card OUT of the body. The
// body only carries an empty placeholder:
//
//   <p><a href="https://github.com/owner/repo" itemtype="…/HyperLink" …>…</a></p>
//   <span itemid="app-preview-card-ps<hex>" itemscope=""
//         itemtype="http://schema.skype.com/InputExtension">
//     <span itemprop="cardId"></span>
//   </span>
//
// `cardId` is EMPTY — there is nothing in the HTML to render, which is why these
// messages showed the link and nothing else. The card lives in the message's
// `properties.cards` (proven by recon against the tenant, 2026-07-25):
//
//   properties.cards = [{
//     "appId":        "ca9e26b7-dce5-44a0-b2b7-a70a3d65ce25",
//     "cardClientId": "app-preview-card-ps<hex>",   // == the placeholder span's itemid
//     "appName":      "GitHub Notifications",
//     "appIcon":      "https://…/urlp/v1/url/content?url=…_largeimage.png",
//     "content":      { "type": "AdaptiveCard", "body": [ … ] }
//   }]
//
// `content` is an ordinary Adaptive Card, so this module does NOT re-implement card
// flattening: it hands the payload to [`crate::teams_cards::adaptive_card_attachment`]
// and gets back the same `kind:"card"` attachment an adaptive/connector card
// produces. The app's identity (`appName`/`appIcon`) is the one thing an unfurl adds
// over a normal card, so it rides along inside `card` as `app_name` / `app_icon`.

use serde_json::Value;

/// How many unfurl cards one message may contribute. Real messages carry one per
/// link; the cap keeps a pathological frame from bloating a stored row.
const MAX_CARDS: usize = 4;

/// The link-unfurl cards a message carries, as `kind:"card"` attachment entries
/// ready to append to the message's `attachments` array. Empty for the overwhelming
/// majority of messages, which have no `properties.cards`.
///
/// Best-effort by design (like every other `properties` reader here): a missing,
/// double-encoded, or malformed payload yields no cards rather than an error, so a
/// surprising unfurl shape can never break message ingestion.
pub fn parse_link_unfurl_cards(m: &Value) -> Vec<Value> {
    let props = decode_nested(m.get("properties"));
    let cards = decode_nested(props.get("cards"));
    let fallback_title = link_preview_title(&props);
    cards
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|card| unfurl_attachment(card, fallback_title.clone()))
        .take(MAX_CARDS)
        .collect()
}

/// One `properties.cards` entry as a card attachment, or `None` when it carries no
/// card payload (nothing to render, so nothing to store).
///
/// Title chain: whatever the card itself names, then the message's own link preview
/// title (`properties.links[].preview.title`, e.g. "owner/repo" — what Teams shows as
/// the card heading), then the app's name. The last two are why an unfurl is never
/// left titleless, which would render as an anonymous block of facts.
fn unfurl_attachment(card: &Value, link_title: Option<String>) -> Option<Value> {
    let content = card.get("content").filter(|c| c.is_object())?;
    let app_name = string_field(card, "appName");
    let app_icon = string_field(card, "appIcon");
    let fallback = link_title.or_else(|| app_name.clone());
    let mut attachment = crate::teams_cards::adaptive_card_attachment(content, fallback);
    if let Some(card_object) = attachment.get_mut("card").and_then(Value::as_object_mut) {
        if let Some(name) = app_name {
            card_object.insert("app_name".to_string(), Value::String(name));
        }
        if let Some(icon) = app_icon {
            card_object.insert("app_icon".to_string(), Value::String(icon));
        }
    }
    Some(attachment)
}

/// The title of the message's link preview, when the message unfurls exactly ONE
/// link. With several links there is no way to tell which preview belongs to which
/// card (`cardClientId` and a link's `itemid` are unrelated ids), and a wrong title
/// is worse than the app's name.
fn link_preview_title(props: &Value) -> Option<String> {
    let links = decode_nested(props.get("links"));
    let list = links.as_array()?;
    let [only] = list.as_slice() else { return None };
    only.pointer("/preview/title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
}

/// A non-empty string field, trimmed.
fn string_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Read a value Teams delivers EITHER nested or as a JSON-encoded string — the same
/// double encoding as `properties.files`/`emotions`/`mentions`. `Null` when absent or
/// unparseable.
fn decode_nested(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(other) => other.clone(),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The tenant's real shape (trimmed): the card payload nested under a
    /// JSON-ENCODED `properties`, next to the link whose preview names it.
    fn unfurl_message(properties: Value) -> Value {
        json!({
            "id": "1784279270015",
            "messagetype": "RichText/Html",
            "content": "<p><a href=\"https://github.com/owner/repo\">https://github.com/owner/repo</a></p>\
                        <span itemid=\"app-preview-card-psd62d\" itemscope=\"\" \
                        itemtype=\"http://schema.skype.com/InputExtension\">\
                        <span itemprop=\"cardId\"></span></span>",
            "properties": properties.to_string(),
        })
    }

    fn github_cards() -> Value {
        json!([{
            "appId": "ca9e26b7-dce5-44a0-b2b7-a70a3d65ce25",
            "cardClientId": "app-preview-card-psd62d",
            "appName": "GitHub Notifications",
            "appIcon": "https://x/icon.png",
            "content": {
                "type": "AdaptiveCard",
                "body": [
                    { "type": "TextBlock", "text": "Repository | **owner/repo**", "size": "small" },
                    { "type": "TextBlock", "text": "Rust", "size": "small" }
                ]
            }
        }])
    }

    #[test]
    fn an_unfurl_card_becomes_a_card_attachment() {
        let m = unfurl_message(json!({
            "cards": github_cards(),
            "links": [{
                "@type": "http://schema.skype.com/HyperLink",
                "itemid": "0",
                "url": "https://github.com/owner/repo",
                "preview": { "title": "owner/repo" }
            }],
        }));
        let cards = parse_link_unfurl_cards(&m);
        assert_eq!(cards.len(), 1);
        let card = &cards[0];
        assert_eq!(card["kind"], "card", "reuses the existing card attachment shape");
        assert_eq!(card["content_type"], "application/vnd.microsoft.card.adaptive");
        assert_eq!(card["url"], "");
        // The single link's preview names the card; the app rides along beside it.
        assert_eq!(card["card"]["title"], "owner/repo");
        assert_eq!(card["name"], "owner/repo");
        assert_eq!(card["card"]["app_name"], "GitHub Notifications");
        assert_eq!(card["card"]["app_icon"], "https://x/icon.png");
        let text = card["card"]["text"].as_str().unwrap();
        assert!(text.contains("owner/repo"), "card body text is kept: {text}");
        assert!(text.contains("Rust"), "card body text is kept: {text}");
    }

    #[test]
    fn the_app_name_titles_a_card_no_link_preview_can_name() {
        // Two links: no way to tell which preview belongs to the card, so the app
        // name titles it rather than a possibly-wrong link title.
        let m = unfurl_message(json!({
            "cards": github_cards(),
            "links": [
                { "url": "https://github.com/owner/repo", "preview": { "title": "owner/repo" } },
                { "url": "https://example.com", "preview": { "title": "Example" } },
            ],
        }));
        assert_eq!(parse_link_unfurl_cards(&m)[0]["card"]["title"], "GitHub Notifications");

        // No links at all: same fallback.
        let m = unfurl_message(json!({ "cards": github_cards() }));
        assert_eq!(parse_link_unfurl_cards(&m)[0]["card"]["title"], "GitHub Notifications");
    }

    #[test]
    fn cards_are_read_whether_nested_or_json_encoded() {
        // `properties` nested, `cards` a JSON string — every combination Teams uses.
        let m = json!({
            "id": "1",
            "properties": { "cards": github_cards().to_string() }
        });
        assert_eq!(parse_link_unfurl_cards(&m).len(), 1);
        let m = json!({ "id": "1", "properties": { "cards": github_cards() } });
        assert_eq!(parse_link_unfurl_cards(&m).len(), 1);
    }

    #[test]
    fn a_message_without_a_usable_card_yields_nothing() {
        for properties in [
            json!({}),
            json!({ "cards": [] }),
            json!({ "cards": "not json" }),
            // An entry with no card payload at all (nothing to render).
            json!({ "cards": [{ "appName": "GitHub", "cardClientId": "x" }] }),
            // ...or a payload that is not an object.
            json!({ "cards": [{ "content": "just a string" }] }),
        ] {
            let m = unfurl_message(properties.clone());
            assert!(
                parse_link_unfurl_cards(&m).is_empty(),
                "must yield no card for {properties}"
            );
        }
        // A message with no properties at all (the overwhelming majority).
        assert!(parse_link_unfurl_cards(&json!({ "id": "1" })).is_empty());
    }

    #[test]
    fn the_number_of_cards_per_message_is_bounded() {
        let many: Vec<Value> = std::iter::repeat_n(github_cards()[0].clone(), MAX_CARDS + 3).collect();
        let m = unfurl_message(json!({ "cards": many }));
        assert_eq!(parse_link_unfurl_cards(&m).len(), MAX_CARDS);
    }
}
