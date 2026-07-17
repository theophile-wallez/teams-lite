// Message content parsing for the terminal UI.
//
// Teams sends a reply as an HTML <blockquote itemtype="http://schema.skype.com/Reply">
// that carries the quoted message's author + a preview of its text, immediately
// followed by the reply body. We split that structure out here so the renderer can
// show the quote as a nested block instead of flattening the whole thing into one
// line. All HTML -> plain-text stripping lives in this module.

export type MessageQuote = {
  // Display name of the quoted message's author.
  sender: string;
  // The quoted message, as plain text (Teams' own preview of it).
  text: string;
};

export type ParsedMessage = {
  // Present only when the message is a reply to another message.
  quote?: MessageQuote;
  // The reply body, or the whole message when there is no quote. Plain text.
  body: string;
};

// Strip HTML tags and decode the handful of entities Teams emits, for terminal
// display.
export function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

// A Teams reply blockquote. Matched case-insensitively; captures the inner HTML.
const REPLY_BLOCKQUOTE =
  /<blockquote\b[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[^>]*>([\s\S]*?)<\/blockquote>/i;
const QUOTED_AUTHOR = /<strong\b[^>]*itemprop="mri"[^>]*>([\s\S]*?)<\/strong>/i;
const QUOTED_PREVIEW = /<p\b[^>]*itemprop="preview"[^>]*>([\s\S]*?)<\/p>/i;

// Split a raw Teams message HTML into an optional quote plus the body text.
export function parseMessageContent(html: string): ParsedMessage {
  const inner = html.match(REPLY_BLOCKQUOTE)?.[1];
  if (inner === undefined) return { body: plain(html) };

  const sender = plain(inner.match(QUOTED_AUTHOR)?.[1] ?? "");
  // Prefer Teams' own preview <p>; otherwise fall back to the blockquote text
  // minus the author line.
  const previewHtml = inner.match(QUOTED_PREVIEW)?.[1];
  const text = plain(previewHtml ?? inner.replace(QUOTED_AUTHOR, ""));

  // The body is everything outside the reply blockquote(s). We strip every reply
  // blockquote so a (rare) multi-quote message doesn't leak quoted text into the body.
  const body = plain(html.replace(new RegExp(REPLY_BLOCKQUOTE, "gi"), ""));

  if (!sender && !text) return { body };
  return { quote: { sender, text }, body };
}
