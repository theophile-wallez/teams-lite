// Behavior tests for the pure protocol helpers (message content parsing, history
// merge semantics, and sidebar/notification display logic).
import { describe, it, expect } from "vitest";
import {
  brokerNeedsAttention,
  calendarColor,
  eventRepeats,
  eventTitle,
  mergeCalendarWindow,
  mergeEvents,
  personLabel,
  type CalendarEvent,
  parseMessageContent,
  extractImages,
  mediaNeedsProxy,
  urlHost,
  mergeMessages,
  appendLiveMessage,
  mergeOlderHistoryPage,
  mergeRefreshedHistoryPage,
  trimHistoryPage,
  previewLine,
  convLabel,
  isGroupChat,
  isMeetingChat,
  channelLabel,
  channelPreviewLine,
  groupChannelsByTeam,
  channelIsMuted,
  channelIsPinned,
  channelIsShown,
  organizeChannels,
  chatIsHidden,
  chatIsMuted,
  chatIsPinned,
  chatRows,
  chatSectionCollapsedHint,
  organizeChats,
  NO_CHAT_PREFS,
  type ChatPrefs,
  shouldNotify,
  replyToPayload,
  copyableMessageText,
  mentionsByItemId,
  parseRichMessage,
  typingLabel,
  formatCallEvent,
  formatCallDuration,
  mailFolderLabel,
  mailAddressLabel,
  mailSenderLabel,
  mailSubjectLabel,
  mailReceivedMs,
  mailRecipientsLabel,
  mailFileAttachments,
  formatAttachmentSize,
  mailUnreadBadge,
  mergeMail,
  mergeRefreshedMailPage,
  mergeOlderMailPage,
  type MailHeader,
  formatThreadActivity,
  formatMeetingEvent,
  formatMeetingSchedule,
  bodyFormat,
  isCallEvent,
  isThreadActivityEvent,
  isMeetingEvent,
  incomingCallTitle,
  computeReadReceiptAnchors,
} from "./protocol";
import type {
  ChatMessage,
  ThreadActivityEvent,
  MeetingSystemEvent,
  Conversation,
  IncomingCall,
  MessagePage,
  Channel,
  ReadReceipt,
} from "./protocol";

function message(
  seq: number,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `m${seq}`,
    conversation_id: "c1",
    seq,
    compose_time: seq,
    sender: "Alice",
    content: `message ${seq}`,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    name: "General",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "",
    draft: "",
    ...overrides,
  };
}

// A real Teams reply captured from the tenant: quote first, reply body after.
const REPLY_AFTER_ONLY =
  `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
  `<strong itemprop="mri" itemid="8:orgid:abc">Clement BOSLE</strong>` +
  `<span itemprop="time" itemid="1"></span>` +
  `<p itemprop="preview">the original line</p>` +
  `</blockquote>` +
  `<p>my actual reply</p>`;

// A reply with body text on BOTH sides of the quoted block.
const REPLY_BEFORE_AND_AFTER =
  `<p>before the quote</p>` +
  `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="2">` +
  `<strong itemprop="mri">Bob</strong>` +
  `<p itemprop="preview">original</p>` +
  `</blockquote>` +
  `<p>after the quote</p>`;

// A real forwarded message captured from the tenant (message 1784304655568): the
// forwarder's own line, then the forwarded content in a Forward blockquote. Teams
// sends no author, no MRI and no time for a forward — the blockquote carries the
// content and nothing else.
const FORWARD_WITH_INTRO =
  `<p>ouh lala&nbsp;</p>\n` +
  `<blockquote itemtype="http://schema.skype.com/Forward">\n` +
  `<p>For clarification our current issue is they're being logged out.&nbsp;</p>\n` +
  `</blockquote>`;

// A real reply captured from the tenant (message 1774023047032) using the OLDER
// author markup: `<p><b><span itemprop="mri">` instead of `<strong itemprop="mri">`.
const REPLY_LEGACY_AUTHOR =
  `<div>\n` +
  `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1774023003842">\n` +
  `<p><b><span itemprop="mri" itemid="8:orgid:788646fd" style="font-size:small">` +
  `Nathan CAPIAUX&nbsp;</span>` +
  `<span itemprop="time" itemid="1774023003842"></span></b></p>\n` +
  `<p itemprop="preview">&#128247; Image Douchin qui commence</p>\n` +
  `</blockquote>\n` +
  `imagine s’il voyait notre board</div>`;

// A forward with no accompanying text of its own (message 1784217579552).
const FORWARD_ONLY =
  `<blockquote itemtype="http://schema.skype.com/Forward">` +
  `<p>it has to be sia.partners&nbsp;</p>` +
  `</blockquote>`;

describe("parseMessageContent", () => {
  it("returns a bare body with HTML stripped and entities decoded when there is no quote", () => {
    const html = `<p>&quot;A&quot; &amp; &#39;B&#39; &lt;c&gt;&nbsp;end</p>`;
    const parsed = parseMessageContent(html);

    expect(parsed.quote).toBeUndefined();
    expect(parsed.beforeQuote).toBeUndefined();
    expect(parsed.afterQuote).toBeUndefined();
    expect(parsed.body).toBe(`"A" & 'B' <c> end`);
  });

  it("splits a Teams reply into quote (author + preview) and the body after it", () => {
    const parsed = parseMessageContent(REPLY_AFTER_ONLY);

    expect(parsed.quote).toBeDefined();
    expect(parsed.quote?.sender).toBe("Clement BOSLE");
    expect(parsed.quote?.text).toBe("the original line");
    expect(parsed.beforeQuote).toBe("");
    expect(parsed.afterQuote).toBe("my actual reply");
    expect(parsed.body).toBe("my actual reply");
    // The body must never leak the quoted preview text.
    expect(parsed.body).not.toContain("the original line");
  });

  it("keeps body text before AND after the quote, joined by a newline", () => {
    const parsed = parseMessageContent(REPLY_BEFORE_AND_AFTER);

    expect(parsed.quote?.sender).toBe("Bob");
    expect(parsed.quote?.text).toBe("original");
    expect(parsed.beforeQuote).toBe("before the quote");
    expect(parsed.afterQuote).toBe("after the quote");
    expect(parsed.body).toBe("before the quote\nafter the quote");
  });

  it("tags a reply quote as a reply, with the quoted message's compose time", () => {
    const parsed = parseMessageContent(REPLY_AFTER_ONLY);

    expect(parsed.quote?.kind).toBe("reply");
    expect(parsed.quote?.senderMri).toBe("8:orgid:abc");
    expect(parsed.quote?.time).toBe(1);
  });

  it("splits a forwarded message into an unattributed forward quote and the intro", () => {
    const parsed = parseMessageContent(FORWARD_WITH_INTRO);

    expect(parsed.quote?.kind).toBe("forward");
    expect(parsed.quote?.text).toBe("For clarification our current issue is they're being logged out.");
    // Teams attributes nothing on a forward, so there is no author and no time.
    expect(parsed.quote?.sender).toBe("");
    expect(parsed.quote?.senderMri).toBe("");
    expect(parsed.quote?.time).toBeUndefined();
    expect(parsed.body).toBe("ouh lala");
    expect(parsed.body).not.toContain("logged out");
  });

  it("exposes an empty image list for a plain text message", () => {
    expect(parseMessageContent("<p>no images here</p>").images).toEqual([]);
  });

  it("extracts an inline image and still yields its surrounding text", () => {
    const html =
      `<div>look at this</div>` +
      `<img itemtype="http://schema.skype.com/AMSImage" ` +
      `src="https://eu-api.asm.skype.com/v1/objects/abc/views/imgo" alt="a graph"/>`;
    const parsed = parseMessageContent(html);

    expect(parsed.body).toBe("look at this");
    expect(parsed.images).toEqual([
      { src: "https://eu-api.asm.skype.com/v1/objects/abc/views/imgo", alt: "a graph" },
    ]);
  });

  it("does not treat an image inside the quoted preview as a body image", () => {
    const html =
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
      `<strong itemprop="mri">Bob</strong>` +
      `<p itemprop="preview">see chart</p>` +
      `</blockquote>` +
      `<img src="https://eu-api.asm.skype.com/v1/objects/reply-img/views/imgo"/>`;
    const parsed = parseMessageContent(html);

    expect(parsed.images.map((i) => i.src)).toEqual([
      "https://eu-api.asm.skype.com/v1/objects/reply-img/views/imgo",
    ]);
  });
});

describe("extractImages", () => {
  it("decodes entity-escaped ampersands in the src", () => {
    const html = `<img src="https://eu-api.asm.skype.com/o/x?a=1&amp;b=2"/>`;
    expect(extractImages(html)).toEqual([
      { src: "https://eu-api.asm.skype.com/o/x?a=1&b=2", alt: "" },
    ]);
  });

  it("collects multiple images in document order", () => {
    const html = `<img src="https://x.skype.com/a"/><p>and</p><img src="https://x.skype.com/b"/>`;
    expect(extractImages(html).map((i) => i.src)).toEqual([
      "https://x.skype.com/a",
      "https://x.skype.com/b",
    ]);
  });

  it("ignores non-http(s) sources (data URIs, empty, relative)", () => {
    const html =
      `<img src="data:image/png;base64,AAAA"/>` +
      `<img src=""/>` +
      `<img src="/local/path.png"/>`;
    expect(extractImages(html)).toEqual([]);
  });
});

describe("mediaNeedsProxy", () => {
  it("proxies authenticated Microsoft hosted-content hosts", () => {
    expect(mediaNeedsProxy("https://eu-api.asm.skype.com/v1/objects/x/views/imgo")).toBe(true);
    expect(mediaNeedsProxy("https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/x")).toBe(true);
    expect(mediaNeedsProxy("https://teams.microsoft.com/o/x")).toBe(true);
  });

  it("proxies OneDrive/SharePoint chat files (fetched via Graph on the backend)", () => {
    expect(
      mediaNeedsProxy("https://contoso-my.sharepoint.com/personal/user/Documents/x.json"),
    ).toBe(true);
    expect(mediaNeedsProxy("https://contoso.sharepoint.com/sites/team/x.pdf")).toBe(true);
  });

  it("loads public CDN images directly (no proxy)", () => {
    expect(mediaNeedsProxy("https://media1.giphy.com/media/abc/giphy.gif")).toBe(false);
    expect(mediaNeedsProxy("https://statics.teams.cdn.office.net/emoji/x.png")).toBe(false);
    expect(mediaNeedsProxy("https://skype.com.evil.example/x")).toBe(false);
    expect(mediaNeedsProxy("https://sharepoint.com.evil.example/x")).toBe(false);
    expect(mediaNeedsProxy("not a url")).toBe(false);
  });
});

describe("urlHost", () => {
  it("extracts the lowercased host of an http(s) URL", () => {
    expect(urlHost("https://gitlab.com/group/project/-/merge_requests/1")).toBe("gitlab.com");
    expect(urlHost("https://GitLab.EXAMPLE.com/a/b")).toBe("gitlab.example.com");
    expect(urlHost("http://example.org/path")).toBe("example.org");
  });

  it("strips credentials and port", () => {
    expect(urlHost("https://user:pass@gitlab.com:8443/x")).toBe("gitlab.com");
  });

  it("returns null for non-http(s) or malformed input", () => {
    expect(urlHost("mailto:a@b.com")).toBeNull();
    expect(urlHost("not a url")).toBeNull();
    expect(urlHost("ftp://host/x")).toBeNull();
  });
});

describe("parseRichMessage", () => {
  it("returns the raw HTML as bodyHtml when there is no quote", () => {
    const html = `<p>hello <b>world</b></p>`;
    const parsed = parseRichMessage(html);
    expect(parsed.quote).toBeUndefined();
    expect(parsed.beforeHtml).toBeUndefined();
    expect(parsed.bodyHtml).toBe(html);
  });

  it("splits a reply into a quote (with HTML) and the reply body HTML", () => {
    const parsed = parseRichMessage(REPLY_AFTER_ONLY);
    expect(parsed.quote?.sender).toBe("Clement BOSLE");
    expect(parsed.quote?.html).toContain("the original line");
    expect(parsed.bodyHtml).toContain("my actual reply");
    expect(parsed.bodyHtml).not.toContain("the original line");
  });

  it("keeps HTML both before and after the quote", () => {
    const parsed = parseRichMessage(REPLY_BEFORE_AND_AFTER);
    expect(parsed.beforeHtml).toContain("before the quote");
    expect(parsed.bodyHtml).toContain("after the quote");
    expect(parsed.quote?.sender).toBe("Bob");
  });

  it("carries the quoted author's MRI, so their name can offer their card", () => {
    expect(parseRichMessage(REPLY_AFTER_ONLY).quote?.senderMri).toBe("8:orgid:abc");
  });

  it("leaves the quoted MRI empty when the quote carries none", () => {
    const noMri =
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
      `<strong itemprop="mri">Someone</strong>` +
      `<p itemprop="preview">quoted</p></blockquote><p>reply</p>`;
    const parsed = parseRichMessage(noMri);
    expect(parsed.quote?.sender).toBe("Someone");
    expect(parsed.quote?.senderMri).toBe("");
  });

  it("tags a reply quote as a reply and carries the quoted message's compose time", () => {
    const parsed = parseRichMessage(REPLY_AFTER_ONLY);
    expect(parsed.quote?.kind).toBe("reply");
    expect(parsed.quote?.time).toBe(1);
  });

  it("falls back to the blockquote's own itemid for the quoted compose time", () => {
    const noTimeSpan =
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1784623715932">` +
      `<strong itemprop="mri" itemid="8:orgid:abc">Clement BOSLE</strong>` +
      `<p itemprop="preview">quoted</p></blockquote><p>reply</p>`;
    expect(parseRichMessage(noTimeSpan).quote?.time).toBe(1784623715932);
  });

  it("splits a forward into a forward-tagged quote, keeping the forwarded HTML", () => {
    const parsed = parseRichMessage(FORWARD_WITH_INTRO);

    expect(parsed.quote?.kind).toBe("forward");
    expect(parsed.quote?.html).toContain("logged out");
    // Nothing to attribute it to: the UI labels it "Forwarded" from `kind` alone.
    expect(parsed.quote?.sender).toBe("");
    expect(parsed.quote?.senderMri).toBe("");
    expect(parsed.quote?.time).toBeUndefined();
    expect(parsed.beforeHtml).toContain("ouh lala");
    expect(parsed.bodyHtml).not.toContain("logged out");
  });

  it("keeps an unaccompanied forward as a quote instead of an unlabelled body", () => {
    const parsed = parseRichMessage(FORWARD_ONLY);

    expect(parsed.quote?.kind).toBe("forward");
    expect(parsed.quote?.html).toContain("sia.partners");
    expect(parsed.beforeHtml).toBe("");
    expect(parsed.bodyHtml).toBe("");
  });

  it("keeps an image-only forward, whose quoted content has no text at all", () => {
    const imageOnly =
      `<blockquote itemtype="http://schema.skype.com/Forward">` +
      `<p><img itemtype="http://schema.skype.com/AMSImage" ` +
      `src="https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/abc/views/imgo" alt=""></p>` +
      `</blockquote>`;
    const parsed = parseRichMessage(imageOnly);

    expect(parsed.quote?.kind).toBe("forward");
    expect(parsed.quote?.html).toContain("views/imgo");
  });

  it("drops an empty quote blockquote rather than rendering a blank block", () => {
    const empty =
      `<p>look</p><blockquote itemtype="http://schema.skype.com/Forward">&nbsp;</blockquote>`;
    const parsed = parseRichMessage(empty);

    expect(parsed.quote).toBeUndefined();
    expect(parsed.bodyHtml).toBe("<p>look</p>");
  });

  // 8 of the 696 replies in the tenant snapshot use the older author markup below.
  describe("legacy Reply author markup", () => {
    it("attributes a quote whose author is a <span itemprop=mri> inside <p><b>", () => {
      const parsed = parseRichMessage(REPLY_LEGACY_AUTHOR);

      expect(parsed.quote?.kind).toBe("reply");
      expect(parsed.quote?.sender).toBe("Nathan CAPIAUX");
      expect(parsed.quote?.senderMri).toBe("8:orgid:788646fd");
      expect(parsed.quote?.time).toBe(1774023003842);
      expect(parsed.quote?.html).toContain("qui commence");
      // The author line is the attribution, never part of the quoted text.
      expect(parsed.quote?.html).not.toContain("Nathan CAPIAUX");
      expect(parsed.bodyHtml).toContain("imagine s");
    });

    it("removes the legacy author line from a quote that carries no preview wrapper", () => {
      const noPreview =
        `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="7">` +
        `<p><b><span itemprop="mri" itemid="8:orgid:abc">Dana</span></b></p>` +
        `<p>the quoted line</p>` +
        `</blockquote><p>my reply</p>`;
      const parsed = parseRichMessage(noPreview);

      expect(parsed.quote?.sender).toBe("Dana");
      expect(parsed.quote?.html).toContain("the quoted line");
      expect(parsed.quote?.html).not.toContain("Dana");
    });

    it("leaves the modern <strong> shape parsed exactly as before", () => {
      // Byte-identical output for the shape 688 of the 696 replies use.
      expect(parseRichMessage(REPLY_AFTER_ONLY)).toEqual({
        quote: {
          kind: "reply",
          sender: "Clement BOSLE",
          senderMri: "8:orgid:abc",
          time: 1,
          html: "the original line",
        },
        beforeHtml: "",
        bodyHtml: "<p>my actual reply</p>",
      });
    });
  });
});

describe("bodyFormat", () => {
  it("reads a Text body as plain text", () => {
    expect(bodyFormat("Text")).toBe("text");
  });

  it("ignores the casing of the Teams type", () => {
    expect(bodyFormat("text")).toBe("text");
    expect(bodyFormat(" TEXT ")).toBe("text");
  });

  it("reads every other known type as HTML", () => {
    expect(bodyFormat("RichText/Html")).toBe("html");
    expect(bodyFormat("RichText/Media_Card")).toBe("html");
    expect(bodyFormat("Event/Call")).toBe("html");
  });

  it("treats an unknown/legacy type as HTML, keeping the historical behaviour", () => {
    expect(bodyFormat("")).toBe("html");
    expect(bodyFormat(undefined)).toBe("html");
  });
});

describe("formatThreadActivity", () => {
  const activity = (over: Partial<ThreadActivityEvent> = {}): ThreadActivityEvent => ({
    kind: "thread_activity",
    event: "member_added",
    time_ms: 1781160917613,
    actor_mri: "8:orgid:actor",
    members: [],
    member_mris: [],
    ...over,
  });

  it("names a single added member", () => {
    const event = activity({ members: ["Nathan CAPIAUX"], member_mris: ["8:orgid:n"] });
    expect(formatThreadActivity(event)).toBe("Nathan CAPIAUX was added to the chat");
  });

  it("joins two and three names, then counts the rest", () => {
    expect(formatThreadActivity(activity({ members: ["Ada", "Bo"] }))).toBe(
      "Ada and Bo were added to the chat",
    );
    expect(formatThreadActivity(activity({ members: ["Ada", "Bo", "Cy"] }))).toBe(
      "Ada, Bo and Cy were added to the chat",
    );
    expect(formatThreadActivity(activity({ members: ["Ada", "Bo", "Cy", "Di", "Ed"] }))).toBe(
      "Ada, Bo, Cy and 2 others were added to the chat",
    );
  });

  it("counts the members Teams did not name instead of dropping them", () => {
    // The common real shape: `friendlyname` empty, only MRIs.
    const event = activity({ members: ["", ""], member_mris: ["8:orgid:a", "8:orgid:b"] });
    expect(formatThreadActivity(event)).toBe("2 people were added to the chat");
    expect(formatThreadActivity(activity({ members: [""], member_mris: ["8:orgid:a"] }))).toBe(
      "Someone was added to the chat",
    );
  });

  it("prefers the names resolved from the MRIs over the empty ones Teams sent", () => {
    const event = activity({ members: ["", ""], member_mris: ["8:orgid:a", "8:orgid:b"] });
    expect(formatThreadActivity(event, ["Ada", ""])).toBe(
      "Ada and 1 other were added to the chat",
    );
    expect(formatThreadActivity(event, ["Ada", "Bo"])).toBe("Ada and Bo were added to the chat");
  });

  it("labels a pin and an unpin", () => {
    expect(formatThreadActivity(activity({ event: "pinned" }))).toBe("A message was pinned");
    expect(formatThreadActivity(activity({ event: "unpinned" }))).toBe("A message was unpinned");
  });

  it("returns null for an activity it has no words for, so nothing is rendered", () => {
    expect(formatThreadActivity(activity({ event: "topic_updated" }))).toBeNull();
  });
});

describe("isCallEvent / isThreadActivityEvent / isMeetingEvent", () => {
  it("recognises each known kind", () => {
    expect(isCallEvent({ kind: "call", event: "ended" })).toBe(true);
    expect(isThreadActivityEvent({ kind: "thread_activity", event: "pinned" })).toBe(true);
    expect(isMeetingEvent({ kind: "meeting", event: "scheduled" })).toBe(true);
  });

  it("claims nothing for a kind this client predates", () => {
    const unknown = { kind: "thread_renamed" };
    expect(isCallEvent(unknown)).toBe(false);
    expect(isThreadActivityEvent(unknown)).toBe(false);
    expect(isMeetingEvent(unknown)).toBe(false);
  });
});

describe("formatMeetingEvent", () => {
  const meeting = (over: Partial<MeetingSystemEvent> = {}): MeetingSystemEvent => ({
    kind: "meeting",
    event: "scheduled",
    ...over,
  });

  it("names the meeting when Teams sent a title", () => {
    expect(formatMeetingEvent(meeting({ title: "Weekly sync" }))).toBe(
      "Meeting scheduled · Weekly sync",
    );
  });

  it("stands alone when there is no title, rather than trailing a separator", () => {
    expect(formatMeetingEvent(meeting({ title: "   " }))).toBe("Meeting scheduled");
    expect(formatMeetingEvent(meeting())).toBe("Meeting scheduled");
  });

  it("labels a cancellation and an update", () => {
    expect(formatMeetingEvent(meeting({ event: "cancelled", title: "Retro" }))).toBe(
      "Meeting cancelled · Retro",
    );
    expect(formatMeetingEvent(meeting({ event: "updated" }))).toBe("Meeting updated");
  });

  it("returns null for an activity it has no words for, so nothing is rendered", () => {
    expect(formatMeetingEvent(meeting({ event: "reminded" }))).toBeNull();
  });
});

describe("formatMeetingSchedule", () => {
  // Fixed instants, formatted in the runner's own locale/zone — the assertions ask
  // about STRUCTURE (one date, both times, or two dates) rather than about wording,
  // so they hold wherever the suite runs.
  const start = new Date("2026-05-04T12:30:00Z");
  const end = new Date("2026-05-04T13:30:00Z");
  const schedule = (over: Partial<MeetingSystemEvent>): string =>
    formatMeetingSchedule({ kind: "meeting", event: "scheduled", ...over });

  const timeOf = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayOf = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  it("spells out a same-day meeting as one date and a time range", () => {
    const out = schedule({ start_ms: start.getTime(), end_ms: end.getTime() });
    expect(out).toBe(`${dayOf(start)}, ${timeOf(start)} – ${timeOf(end)}`);
  });

  it("repeats the date when the meeting ends on another day", () => {
    const overnight = new Date("2026-05-05T01:00:00Z");
    const out = schedule({ start_ms: start.getTime(), end_ms: overnight.getTime() });
    expect(out).toBe(`${dayOf(start)}, ${timeOf(start)} – ${dayOf(overnight)}, ${timeOf(overnight)}`);
  });

  it("shows the start alone when no end was reported", () => {
    expect(schedule({ start_ms: start.getTime() })).toBe(`${dayOf(start)}, ${timeOf(start)}`);
    expect(schedule({ start_ms: start.getTime(), end_ms: 0 })).toBe(
      `${dayOf(start)}, ${timeOf(start)}`,
    );
  });

  it("is empty when Teams reported no start at all", () => {
    expect(schedule({})).toBe("");
    expect(schedule({ start_ms: 0, end_ms: end.getTime() })).toBe("");
  });
});

describe("mentionsByItemId", () => {
  it("indexes mentions by the itemid their span carries", () => {
    const map = mentionsByItemId(
      message(1, {
        mentions: [
          { itemid: 0, mri: "8:orgid:leonor", kind: "person", display_name: "Leonor" },
          { itemid: 2, mri: "8:orgid:ada", kind: "person", display_name: "Ada" },
        ],
      }),
    );
    expect(map.get(0)?.mri).toBe("8:orgid:leonor");
    expect(map.get(2)?.display_name).toBe("Ada");
    expect(map.get(1)).toBeUndefined();
  });

  it("indexes a channel or team mention too, with its kind", () => {
    // Such a mention points at a thread rather than at somebody, so the renderer
    // keeps it inert — but it is still what the span names, and two adjacent spans
    // naming one thread are one mention (see mergeAdjacentMentions).
    const map = mentionsByItemId(
      message(1, {
        mentions: [
          { itemid: 0, mri: "19:abc@thread.tacv2", kind: "channel", display_name: "[Run]" },
          { itemid: 1, mri: "19:team@thread.tacv2", kind: "team", display_name: "Platform" },
        ],
      }),
    );
    expect(map.get(0)?.kind).toBe("channel");
    expect(map.get(1)?.kind).toBe("team");
  });

  it("keeps out an entry that names nothing", () => {
    const map = mentionsByItemId(
      message(1, {
        mentions: [{ itemid: 2, mri: "", kind: "person", display_name: "Nobody" }],
      }),
    );
    expect(map.size).toBe(0);
  });

  it("is empty for a message that mentions nobody", () => {
    expect(mentionsByItemId(message(1)).size).toBe(0);
    expect(mentionsByItemId(message(1, { mentions: [] })).size).toBe(0);
  });
});

describe("mergeMessages", () => {
  it("dedups by id with the incoming copy winning", () => {
    const current = [message(2, { content: "old" })];
    const incoming = [message(2, { content: "new" })];

    const merged = mergeMessages(current, incoming);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("new");
  });

  it("sorts by seq, then compose_time, then id — from out-of-order input", () => {
    const current = [message(2, { id: "m2", compose_time: 20 }), message(1, { id: "m1" })];
    const incoming = [message(2, { id: "m3", compose_time: 15 })];

    const merged = mergeMessages(current, incoming);

    // seq 1 first; within seq 2, the earlier compose_time (m3=15) precedes m2=20.
    expect(merged.map((m) => m.id)).toEqual(["m1", "m3", "m2"]);
  });

  it("breaks a full seq/compose_time tie deterministically by id", () => {
    const current = [
      message(3, { id: "beta", compose_time: 3 }),
      message(3, { id: "alpha", compose_time: 3 }),
    ];

    expect(mergeMessages(current, []).map((m) => m.id)).toEqual(["alpha", "beta"]);
  });
});

describe("appendLiveMessage", () => {
  it("initializes history with has_more=true when there is no current page", () => {
    const page = appendLiveMessage(undefined, message(41));

    expect(page.messages.map((m) => m.seq)).toEqual([41]);
    expect(page.has_more).toBe(true);
  });

  it("appends and preserves the current has_more flag", () => {
    const current: MessagePage = { messages: [message(1)], has_more: false };

    const page = appendLiveMessage(current, message(2));

    expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(page.has_more).toBe(false);
  });

  it("replaces a message with the same id instead of duplicating it", () => {
    const current: MessagePage = {
      messages: [message(1, { content: "old" })],
      has_more: true,
    };

    const page = appendLiveMessage(current, message(1, { content: "edited" }));

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.content).toBe("edited");
  });
});

describe("mergeOlderHistoryPage", () => {
  it("prepends the older page and adopts its has_more", () => {
    const current: MessagePage = { messages: [message(41), message(42)], has_more: true };
    const older: MessagePage = { messages: [message(39), message(40)], has_more: false };

    const merged = mergeOlderHistoryPage(current, older);

    expect(merged.messages.map((m) => m.seq)).toEqual([39, 40, 41, 42]);
    expect(merged.has_more).toBe(false);
  });

  it("marks history complete when an empty older page arrives", () => {
    const current: MessagePage = { messages: [message(1), message(2)], has_more: true };

    const merged = mergeOlderHistoryPage(current, { messages: [], has_more: false });

    expect(merged.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(merged.has_more).toBe(false);
  });

  it("seeds from the incoming page when there is no current page", () => {
    const merged = mergeOlderHistoryPage(undefined, { messages: [message(1)], has_more: true });

    expect(merged.messages.map((m) => m.seq)).toEqual([1]);
    expect(merged.has_more).toBe(true);
  });
});

describe("mergeRefreshedHistoryPage", () => {
  it("preserves a deeper cache and its completed state on a newest-page refresh", () => {
    // The key semantic: the cache reaches further back (seq 1) than the refresh
    // (seq 41), so the refresh must NOT resurrect has_more.
    const current: MessagePage = {
      messages: Array.from({ length: 80 }, (_, i) => message(i + 1)),
      has_more: false,
    };
    const refresh: MessagePage = {
      messages: Array.from({ length: 40 }, (_, i) => message(i + 41)),
      has_more: true,
    };

    const merged = mergeRefreshedHistoryPage(current, refresh);

    expect(merged.messages).toHaveLength(80);
    expect(merged.has_more).toBe(false);
  });

  it("adopts the incoming has_more when oldest seqs are equal (not deeper)", () => {
    const current: MessagePage = {
      messages: Array.from({ length: 20 }, (_, i) => message(i + 41)),
      has_more: true,
    };
    const refresh: MessagePage = {
      messages: Array.from({ length: 40 }, (_, i) => message(i + 41)),
      has_more: false,
    };

    const merged = mergeRefreshedHistoryPage(current, refresh);

    expect(merged.messages).toHaveLength(40);
    expect(merged.has_more).toBe(false);
  });

  it("adopts the incoming has_more when the incoming page extends further back", () => {
    const current: MessagePage = { messages: [message(50), message(51)], has_more: false };
    const refresh: MessagePage = { messages: [message(40), message(50), message(51)], has_more: true };

    const merged = mergeRefreshedHistoryPage(current, refresh);

    expect(merged.messages.map((m) => m.seq)).toEqual([40, 50, 51]);
    expect(merged.has_more).toBe(true);
  });

  it("lets a refresh complete history that a live message initialized", () => {
    const live = appendLiveMessage(undefined, message(41));

    const opened = mergeRefreshedHistoryPage(live, {
      messages: [message(39), message(40)],
      has_more: false,
    });

    expect(opened.messages.map((m) => m.seq)).toEqual([39, 40, 41]);
    expect(opened.has_more).toBe(false);
  });

  it("seeds from the incoming page when there is no current page", () => {
    const merged = mergeRefreshedHistoryPage(undefined, { messages: [message(9)], has_more: true });

    expect(merged.messages.map((m) => m.seq)).toEqual([9]);
    expect(merged.has_more).toBe(true);
  });
});

describe("trimHistoryPage", () => {
  it("keeps the newest messages and reports that older ones exist", () => {
    const page = { messages: [message(1), message(2), message(3), message(4)], has_more: false };

    const trimmed = trimHistoryPage(page, 2);

    expect(trimmed.messages.map((m) => m.seq)).toEqual([3, 4]);
    expect(trimmed.has_more).toBe(true);
  });

  it("returns the same page untouched when it is within the budget", () => {
    const page = { messages: [message(1), message(2)], has_more: false };

    expect(trimHistoryPage(page, 2)).toBe(page);
    expect(trimHistoryPage(page, 5)).toBe(page);
  });

  it("preserves an already-true has_more", () => {
    const page = { messages: [message(1), message(2), message(3)], has_more: true };

    expect(trimHistoryPage(page, 1).has_more).toBe(true);
  });
});

describe("previewLine", () => {
  it("prefixes 'You:' when the last message was from me", () => {
    const c = conversation({ last_message_preview: "on my way", last_message_from_me: true });
    expect(previewLine(c)).toBe("You: on my way");
  });

  it("prefixes only the sender's first name in a group", () => {
    const c = conversation({
      kind: "group",
      last_message_preview: "hi team",
      last_message_sender: "Alice Wonderland",
    });
    expect(previewLine(c)).toBe("Alice: hi team");
  });

  it("treats an unknown-kind conversation as a group for the sender prefix", () => {
    const c = conversation({
      kind: "unknown",
      last_message_preview: "ping",
      last_message_sender: "Bob Builder",
    });
    expect(previewLine(c)).toBe("Bob: ping");
  });

  it("shows the bare body in a one-on-one where the sender is implicit", () => {
    const c = conversation({
      kind: "one_on_one",
      last_message_preview: "see you soon",
      last_message_sender: "Carol",
    });
    expect(previewLine(c)).toBe("see you soon");
  });

  it("returns an empty string when there is no preview", () => {
    expect(previewLine(conversation({ last_message_preview: "" }))).toBe("");
  });
});

describe("convLabel", () => {
  it("uses the name when present", () => {
    expect(convLabel(conversation({ name: "Design" }))).toBe("Design");
  });

  it("falls back to 'Notes' for a nameless notes conversation", () => {
    expect(convLabel(conversation({ name: "", kind: "notes" }))).toBe("Notes");
  });

  it("falls back to '(untitled)' otherwise", () => {
    expect(convLabel(conversation({ name: "", kind: "group" }))).toBe("(untitled)");
  });
});

describe("isGroupChat / isMeetingChat", () => {
  // The two signals a tenant sends, each measured against the real account: the id
  // Teams mints, and CSA's own `threadType`.
  const MEETING_ID = "19:meeting_YWI2Y2E5MDItNmNhZi00OTM2LTgzZDQ@thread.v2";
  const CHAT_ID = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

  it("counts every multi-party thread as a group chat", () => {
    expect(isGroupChat(conversation({ kind: "group" }))).toBe(true);
    expect(isGroupChat(conversation({ kind: "unknown" }))).toBe(true);
    expect(isGroupChat(conversation({ kind: "one_on_one" }))).toBe(false);
    expect(isGroupChat(conversation({ kind: "notes" }))).toBe(false);
  });

  it("reads a meeting origin from either signal alone", () => {
    expect(isMeetingChat(conversation({ id: CHAT_ID, thread_type: "meeting" }))).toBe(true);
    expect(isMeetingChat(conversation({ id: MEETING_ID, thread_type: "" }))).toBe(true);
    expect(isMeetingChat(conversation({ id: MEETING_ID, thread_type: "meeting" }))).toBe(true);
  });

  it("leaves a chat a person started as a chat", () => {
    expect(isMeetingChat(conversation({ id: CHAT_ID, thread_type: "chat" }))).toBe(false);
    // A row synced before the column existed carries no thread type at all.
    expect(isMeetingChat(conversation({ id: CHAT_ID, thread_type: "" }))).toBe(false);
  });

  it("never calls a 1:1 or Notes a meeting", () => {
    // A meeting thread is always multi-party, so a 1:1 that somehow carried the
    // signal is bad data — not a meeting.
    expect(isMeetingChat(conversation({ kind: "one_on_one", thread_type: "meeting" }))).toBe(
      false,
    );
    expect(isMeetingChat(conversation({ kind: "notes", id: "48:notes" }))).toBe(false);
  });
});

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "19:c@thread.tacv2",
    team_id: "19:t@thread.tacv2",
    team_name: "Engineering",
    name: "General",
    is_general: true,
    last_message_time: 0,
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    draft: "",
    ...overrides,
  };
}

describe("channelLabel", () => {
  it("uses the channel name", () => {
    expect(channelLabel(channel({ name: "Releases" }))).toBe("Releases");
  });

  it("falls back for an unnamed channel", () => {
    expect(channelLabel(channel({ name: "" }))).toBe("(unnamed channel)");
  });
});

describe("channelPreviewLine", () => {
  it("prefixes 'You:' when we posted the last message", () => {
    const c = channel({ last_message_preview: "deploying now", last_message_from_me: true });
    expect(channelPreviewLine(c)).toBe("You: deploying now");
  });

  it("prefixes the sender's first name otherwise (channels are multi-party)", () => {
    const c = channel({ last_message_preview: "ship it", last_message_sender: "Alice Wonderland" });
    expect(channelPreviewLine(c)).toBe("Alice: ship it");
  });

  it("is empty when there is no preview", () => {
    expect(channelPreviewLine(channel({ last_message_preview: "" }))).toBe("");
  });
});

describe("groupChannelsByTeam", () => {
  it("groups channels under their team, preserving incoming order", () => {
    const channels = [
      channel({ id: "a-general", team_id: "A", team_name: "Alpha", name: "General" }),
      channel({ id: "a-random", team_id: "A", team_name: "Alpha", name: "Random" }),
      channel({ id: "b-general", team_id: "B", team_name: "Beta", name: "General" }),
    ];
    const groups = groupChannelsByTeam(channels);
    expect(groups.map((g) => g.team_name)).toEqual(["Alpha", "Beta"]);
    expect(groups[0]!.channels.map((c) => c.id)).toEqual(["a-general", "a-random"]);
    expect(groups[1]!.channels.map((c) => c.id)).toEqual(["b-general"]);
  });

  it("keeps a team together even if its channels are not contiguous", () => {
    const channels = [
      channel({ id: "a1", team_id: "A", team_name: "Alpha" }),
      channel({ id: "b1", team_id: "B", team_name: "Beta" }),
      channel({ id: "a2", team_id: "A", team_name: "Alpha" }),
    ];
    const groups = groupChannelsByTeam(channels);
    expect(groups.map((g) => g.team_id)).toEqual(["A", "B"]);
    expect(groups[0]!.channels.map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("returns an empty list for no channels", () => {
    expect(groupChannelsByTeam([])).toEqual([]);
  });

  it("carries the team's group id, backfilling from a later channel if the first lacks it", () => {
    const channels = [
      // The first channel of team A has no group id...
      channel({ id: "a1", team_id: "A", team_name: "Alpha", team_group_id: "" }),
      // ...but a later one does — the team should adopt it.
      channel({ id: "a2", team_id: "A", team_name: "Alpha", team_group_id: "group-a" }),
      channel({ id: "b1", team_id: "B", team_name: "Beta", team_group_id: "group-b" }),
    ];
    const groups = groupChannelsByTeam(channels);
    expect(groups.find((g) => g.team_id === "A")!.group_id).toBe("group-a");
    expect(groups.find((g) => g.team_id === "B")!.group_id).toBe("group-b");
  });

  it("leaves the group id empty when no channel of the team reports one", () => {
    const groups = groupChannelsByTeam([channel({ team_id: "A", team_group_id: undefined })]);
    expect(groups[0]!.group_id).toBe("");
  });

  it("lifts the team's own fold state out of its channels", () => {
    // The backend denormalizes the team's `isCollapsed` onto every channel of it, so
    // the group takes it from whichever channel is read first.
    const groups = groupChannelsByTeam([
      channel({ id: "a1", team_id: "A", team_name: "Alpha", team_collapsed: true }),
      channel({ id: "a2", team_id: "A", team_name: "Alpha", team_collapsed: true }),
      channel({ id: "b1", team_id: "B", team_name: "Beta", team_collapsed: false }),
    ]);
    expect(groups.map((g) => [g.team_id, g.collapsed])).toEqual([
      ["A", true],
      ["B", false],
    ]);
  });

  it("believes the channel that says folded, never the one that says nothing", () => {
    // A row from a backend older than the field carries no answer at all. It must not
    // unfold a team the user folded in Teams.
    const groups = groupChannelsByTeam([
      channel({ id: "a1", team_id: "A", team_name: "Alpha", team_collapsed: undefined }),
      channel({ id: "a2", team_id: "A", team_name: "Alpha", team_collapsed: true }),
    ]);
    expect(groups[0]!.collapsed).toBe(true);
  });

  it("opens a team when nothing reports a fold state", () => {
    const groups = groupChannelsByTeam([
      channel({ id: "a1", team_id: "A", team_name: "Alpha", team_collapsed: undefined }),
    ]);
    expect(groups[0]!.collapsed).toBe(false);
  });
});

describe("channelIsPinned", () => {
  it("falls back to the Teams-sourced value when there is no override", () => {
    expect(channelIsPinned(channel({ id: "x", is_pinned: true }), {})).toBe(true);
    expect(channelIsPinned(channel({ id: "x", is_pinned: false }), {})).toBe(false);
  });

  it("treats an absent flag as unpinned, never as pinned", () => {
    // A backend older than the field reports none; assuming "pinned" would lift a
    // channel out of its team on a placement the user never chose.
    expect(channelIsPinned(channel({ id: "x", is_pinned: undefined }), {})).toBe(false);
  });

  it("lets a local override win over the Teams value", () => {
    expect(channelIsPinned(channel({ id: "x", is_pinned: false }), { x: true })).toBe(true);
    expect(channelIsPinned(channel({ id: "x", is_pinned: true }), { x: false })).toBe(false);
  });

  it("treats only its own id's override, ignoring others", () => {
    expect(channelIsPinned(channel({ id: "x", is_pinned: false }), { y: true })).toBe(false);
  });
});

describe("channelIsShown", () => {
  it("reads Teams' own Show/Hide switch", () => {
    expect(channelIsShown(channel({ is_shown: true }))).toBe(true);
    expect(channelIsShown(channel({ is_shown: false }))).toBe(false);
  });

  it("treats an absent flag as shown, never as hidden", () => {
    // A backend older than the field reports none. Hiding on that would bury a
    // channel the user can reach in Teams — and every channel, since none says so.
    expect(channelIsShown(channel({ is_shown: undefined }))).toBe(true);
  });
});

describe("channelIsMuted", () => {
  it("reads the Teams-sourced notification setting", () => {
    expect(channelIsMuted(channel({ alerts: "muted" }))).toBe(true);
    expect(channelIsMuted(channel({ alerts: "mentions_only" }))).toBe(false);
    expect(channelIsMuted(channel({ alerts: "all_new_posts" }))).toBe(false);
    expect(channelIsMuted(channel({ alerts: "all_new_posts_and_replies" }))).toBe(false);
  });

  it("treats an absent setting as unmuted, never as silence", () => {
    // A backend older than the field reports none; assuming "muted" would hide a
    // channel's unread marker for a setting the user never chose.
    expect(channelIsMuted(channel({ alerts: undefined }))).toBe(false);
  });
});

describe("organizeChannels", () => {
  it("lifts pinned channels into a flat top list, preserving incoming order", () => {
    const channels = [
      channel({ id: "a-general", team_id: "A", team_name: "Alpha", name: "General" }),
      channel({ id: "a-random", team_id: "A", team_name: "Alpha", name: "Random", is_pinned: true }),
      channel({ id: "b-general", team_id: "B", team_name: "Beta", name: "General", is_pinned: true }),
    ];
    const { pinned, teams } = organizeChannels(channels, {});
    // Pins keep their incoming (Teams) order and are removed from their teams.
    expect(pinned.map((c) => c.id)).toEqual(["a-random", "b-general"]);
    expect(teams.map((g) => g.team_id)).toEqual(["A"]);
    expect(teams[0]!.channels.map((c) => c.id)).toEqual(["a-general"]);
  });

  it("honours local overrides when deciding what is pinned", () => {
    const channels = [
      channel({ id: "a", team_id: "A", team_name: "Alpha", is_pinned: true }),
      channel({ id: "b", team_id: "A", team_name: "Alpha", is_pinned: false }),
    ];
    // The override unpins the Teams-pinned channel and pins the other.
    const { pinned, teams } = organizeChannels(channels, { a: false, b: true });
    expect(pinned.map((c) => c.id)).toEqual(["b"]);
    expect(teams[0]!.channels.map((c) => c.id)).toEqual(["a"]);
  });

  it("has no pinned section when nothing is pinned", () => {
    const channels = [channel({ id: "a", team_id: "A", team_name: "Alpha" })];
    const { pinned, teams } = organizeChannels(channels, {});
    expect(pinned).toEqual([]);
    expect(teams.map((g) => g.team_id)).toEqual(["A"]);
  });

  it("keeps a shown channel in its team and drops a hidden one into `hidden`", () => {
    // The whole point of the CSA flag: `isFavorite` is Show/Hide, so a channel it
    // marks false belongs under its team's Hidden entry, NOT in a top group — and a
    // channel it marks true is an ordinary member of its team, not a favorite.
    const channels = [
      channel({ id: "a-general", team_id: "A", team_name: "Alpha", is_shown: true }),
      channel({ id: "a-old", team_id: "A", team_name: "Alpha", is_shown: false }),
    ];
    const { pinned, teams } = organizeChannels(channels, {});
    expect(pinned).toEqual([]);
    expect(teams).toHaveLength(1);
    expect(teams[0]!.channels.map((c) => c.id)).toEqual(["a-general"]);
    expect(teams[0]!.hidden.map((c) => c.id)).toEqual(["a-old"]);
  });

  it("pins a hidden channel the user pinned anyway, an explicit choice winning", () => {
    const channels = [
      channel({ id: "a-general", team_id: "A", team_name: "Alpha", is_shown: true }),
      channel({ id: "a-old", team_id: "A", team_name: "Alpha", is_shown: false }),
    ];
    const { pinned, teams } = organizeChannels(channels, { "a-old": true });
    expect(pinned.map((c) => c.id)).toEqual(["a-old"]);
    expect(teams[0]!.hidden).toEqual([]);
  });
});

describe("chat placement: what is local and what is the account's", () => {
  const prefs = (over: Partial<ChatPrefs> = {}): ChatPrefs => ({
    ...NO_CHAT_PREFS,
    ...over,
  });

  it("reads the Teams-sourced pin when there is no override", () => {
    expect(chatIsPinned(conversation({ id: "x", is_pinned: true }), prefs())).toBe(true);
    expect(chatIsPinned(conversation({ id: "x" }), prefs())).toBe(false);
  });

  it("lets a local pin override win over the Teams value", () => {
    const pinned = conversation({ id: "x", is_pinned: true });
    expect(chatIsPinned(pinned, prefs({ pins: { x: false } }))).toBe(false);
    expect(chatIsPinned(conversation({ id: "x" }), prefs({ pins: { x: true } }))).toBe(true);
  });

  it("reads only its own id's override", () => {
    expect(chatIsPinned(conversation({ id: "x" }), prefs({ pins: { y: true } }))).toBe(false);
  });

  it("takes the mute from the conversation, which is the account's answer", () => {
    // The mute is published to Teams and read back from it (`set_chat_muted`), so
    // there is nothing local to override — one answer, on every device.
    expect(chatIsMuted(conversation({ id: "x", is_muted: true }))).toBe(true);
    expect(chatIsMuted(conversation({ id: "x", is_muted: false }))).toBe(false);
  });

  it("never reads Teams' own `hidden` flag as a hide", () => {
    // Measured against the tenant: `hidden` is true on all 95 one-to-one chats,
    // the colleagues the user messages daily included. Reading it as "the user put
    // this away" emptied Recent of every direct message.
    expect(chatIsHidden(conversation({ id: "x", is_hidden: true }), prefs())).toBe(false);
    expect(chatIsHidden(conversation({ id: "x", is_hidden: false }), prefs())).toBe(false);
  });

  it("keeps a locally hidden chat away until a NEW message arrives", () => {
    const hides = { x: 1_000 };
    // The message it was hidden on, and an older one, stay away.
    expect(chatIsHidden(conversation({ id: "x", last_message_time: 1_000 }), prefs({ hides }))).toBe(true);
    expect(chatIsHidden(conversation({ id: "x", last_message_time: 900 }), prefs({ hides }))).toBe(true);
    // A newer one brings the chat back on its own, exactly as Teams' Hide does.
    expect(chatIsHidden(conversation({ id: "x", last_message_time: 1_001 }), prefs({ hides }))).toBe(false);
  });

  it("shows a chat again once the user asks for it, whatever Teams says", () => {
    // `0` is the explicit "show it here", and it holds even for a chat with no
    // message at all, whose time is 0 too.
    const c = conversation({ id: "x", is_hidden: true, last_message_time: 5_000 });
    expect(chatIsHidden(c, prefs({ hides: { x: 0 } }))).toBe(false);
    const empty = conversation({ id: "x", is_hidden: true, last_message_time: 0 });
    expect(chatIsHidden(empty, prefs({ hides: { x: 0 } }))).toBe(false);
  });
});

describe("organizeChats", () => {
  const chat = (id: string, time: number, over: Partial<Conversation> = {}) =>
    conversation({ id, last_message_time: time, ...over });

  it("is one plain section when nothing is pinned and nothing is hidden", () => {
    const sections = organizeChats([chat("a", 2), chat("b", 1)], NO_CHAT_PREFS);
    expect(sections.map((s) => s.id)).toEqual(["recent"]);
    expect(sections[0]!.chats.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("lifts the pinned chats out and sorts every section newest-first", () => {
    const chats = [
      chat("old-pin", 10, { is_pinned: true }),
      chat("newest", 40),
      chat("new-pin", 30, { is_pinned: true }),
      chat("older", 20),
    ];
    const sections = organizeChats(chats, NO_CHAT_PREFS);
    expect(sections.map((s) => s.id)).toEqual(["pinned", "recent"]);
    expect(sections[0]!.chats.map((c) => c.id)).toEqual(["new-pin", "old-pin"]);
    // Recent is re-sorted rather than left in the incoming order: the backend puts
    // pinned chats first, so an unpinned-here chat would otherwise head the list
    // with a two-week-old message.
    expect(sections[1]!.chats.map((c) => c.id)).toEqual(["newest", "older"]);
  });

  it("counts the hidden chats in the section's own label", () => {
    const chats = [chat("a", 2), chat("b", 1), chat("c", 3)];
    const sections = organizeChats(chats, { pins: {}, hides: { b: 1, c: 3 } });
    expect(sections.map((s) => s.id)).toEqual(["recent", "hidden"]);
    expect(sections[1]!.label).toBe("Hidden chats (2)");
    expect(sections[1]!.chats.map((c) => c.id)).toEqual(["c", "b"]);
  });

  it("hides a pinned chat rather than pinning a hidden one", () => {
    // Putting a chat away is the stronger statement: the user asked not to see it.
    const chats = [chat("a", 1, { is_pinned: true })];
    const sections = organizeChats(chats, { pins: {}, hides: { a: 1 } });
    expect(sections.map((s) => s.id)).toEqual(["hidden"]);
  });

  it("honours the local overrides when deciding the sections", () => {
    const chats = [chat("a", 3, { is_pinned: true }), chat("b", 2), chat("c", 1)];
    const sections = organizeChats(chats, { pins: { a: false, b: true }, hides: { c: 1 } });
    expect(sections.map((s) => s.id)).toEqual(["pinned", "recent", "hidden"]);
    expect(sections[0]!.chats.map((c) => c.id)).toEqual(["b"]);
    expect(sections[1]!.chats.map((c) => c.id)).toEqual(["a"]);
    expect(sections[2]!.chats.map((c) => c.id)).toEqual(["c"]);
  });
});

describe("chatRows", () => {
  const open = { pinned: false, recent: false, hidden: false };

  it("writes no header for a single section — a lone group needs no name", () => {
    const sections = organizeChats([conversation({ id: "a" })], NO_CHAT_PREFS);
    const rows = chatRows(sections, open);
    expect(rows.map((r) => r.kind)).toEqual(["chat"]);
  });

  it("numbers the chats in render order, across the section headers", () => {
    const chats = [
      conversation({ id: "p", last_message_time: 1, is_pinned: true }),
      conversation({ id: "a", last_message_time: 3 }),
      conversation({ id: "b", last_message_time: 2 }),
    ];
    const rows = chatRows(organizeChats(chats, NO_CHAT_PREFS), open);
    expect(rows.map((r) => (r.kind === "header" ? `#${r.section.id}` : `${r.chat.id}:${r.index}`))).toEqual([
      "#pinned",
      "p:0",
      "#recent",
      "a:1",
      "b:2",
    ]);
  });

  it("gives a folded section its header and none of its chats", () => {
    const chats = [
      conversation({ id: "p", is_pinned: true }),
      conversation({ id: "a", last_message_time: 2 }),
    ];
    const rows = chatRows(organizeChats(chats, NO_CHAT_PREFS), { ...open, pinned: true });
    // The folded chat is out of the keyboard's reach as well as out of sight, so the
    // remaining chat is index 0.
    expect(rows.map((r) => (r.kind === "header" ? `#${r.section.id}` : `${r.chat.id}:${r.index}`))).toEqual([
      "#pinned",
      "#recent",
      "a:0",
    ]);
  });
});

describe("chatSectionCollapsedHint", () => {
  it("reports an unread chat a folded section holds, and the open one", () => {
    const chats = [
      conversation({ id: "a", is_read: false, is_pinned: true }),
      conversation({ id: "b", is_pinned: true }),
    ];
    const [pinned] = organizeChats(chats, NO_CHAT_PREFS);
    expect(chatSectionCollapsedHint(pinned!, "b")).toEqual({
      hidesUnread: true,
      hidesOpen: true,
    });
  });

  it("says nothing about an unread chat the user muted", () => {
    // A muted chat raises no unread marker of its own, so a section holding one must
    // not shout on its behalf.
    const chats = [conversation({ id: "a", is_read: false, is_muted: true, is_pinned: true })];
    const [pinned] = organizeChats(chats, NO_CHAT_PREFS);
    expect(chatSectionCollapsedHint(pinned!, null)).toEqual({
      hidesUnread: false,
      hidesOpen: false,
    });
  });
});

describe("shouldNotify", () => {
  it("never notifies for our own messages", () => {
    expect(shouldNotify({ conversation_id: "c1", is_self: true }, null)).toBe(false);
  });

  it("stays quiet for a muted thread", () => {
    // A mute that dimmed the row and still chimed would not be a mute.
    expect(shouldNotify({ conversation_id: "c1", is_self: false }, null, true)).toBe(false);
    expect(shouldNotify({ conversation_id: "c1", is_self: false }, null, false)).toBe(true);
  });

  it("does not notify for the conversation that is currently open", () => {
    expect(shouldNotify({ conversation_id: "c1", is_self: false }, "c1")).toBe(false);
  });

  it("notifies for another conversation or when nothing is open", () => {
    expect(shouldNotify({ conversation_id: "c2", is_self: false }, "c1")).toBe(true);
    expect(shouldNotify({ conversation_id: "c1", is_self: false }, null)).toBe(true);
  });
});

describe("copyableMessageText / replyToPayload", () => {
  it("uses the parsed body as the copyable text", () => {
    expect(copyableMessageText(message(1, { content: "<p>hello there</p>" }))).toBe("hello there");
  });

  it("falls back to the quote text when the reply has no body", () => {
    const quoteOnly =
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="9">` +
      `<strong itemprop="mri">Dana</strong>` +
      `<p itemprop="preview">quoted only</p>` +
      `</blockquote>`;
    expect(copyableMessageText(message(1, { content: quoteOnly }))).toBe("quoted only");
  });

  it("copies a plain-text body verbatim, angle brackets and all", () => {
    // Stripping tags out of a body that is not HTML would eat the author's own
    // text — and then Copy, Reply and Edit would all lose it.
    const plain = message(2, { message_type: "Text", content: "pour moi c'est <yyyy>-<id>" });
    expect(copyableMessageText(plain)).toBe("pour moi c'est <yyyy>-<id>");
  });

  it("builds a reply payload with body-derived preview and passthrough before/after", () => {
    const msg = message(7, {
      content: "<p>reply body</p>",
      sender: "Eve",
      sender_mri: "8:orgid:eve",
      compose_time: 1234,
    });

    const payload = replyToPayload(msg, "quoted before", "quoted after");

    expect(payload).toEqual({
      compose_time: 1234,
      sender: "Eve",
      sender_mri: "8:orgid:eve",
      preview: "reply body",
      before: "quoted before",
      after: "quoted after",
    });
  });

  it("defaults sender_mri to an empty string when the message has none", () => {
    const msg = message(8, { content: "<p>x</p>", sender_mri: undefined });
    expect(replyToPayload(msg, "", "").sender_mri).toBe("");
  });
});

describe("typingLabel", () => {
  it("returns an empty string when nobody is typing", () => {
    expect(typingLabel([])).toBe("");
  });

  it("renders a single typist by first name", () => {
    expect(typingLabel(["Clément BOSLE"])).toBe("Clément is typing");
  });

  it("joins two typists with 'and'", () => {
    expect(typingLabel(["Clément BOSLE", "Théophile WALLEZ"])).toBe(
      "Clément and Théophile are typing",
    );
  });

  it("summarizes three or more typists", () => {
    expect(typingLabel(["Clément BOSLE", "Théophile WALLEZ", "Henri SERANO", "Ghiles CHERFAOUI"])).toBe(
      "Clément, Théophile and 2 more are typing",
    );
  });

  it("de-duplicates repeated names and falls back to 'Someone' for blanks", () => {
    expect(typingLabel(["Clément", "Clément"])).toBe("Clément is typing");
    expect(typingLabel([""])).toBe("Someone is typing");
  });
});

describe("formatCallDuration", () => {
  it("shows seconds under a minute", () => {
    expect(formatCallDuration(45)).toBe("45s");
    expect(formatCallDuration(0)).toBe("0s");
  });

  it("rounds to whole minutes under an hour", () => {
    expect(formatCallDuration(600)).toBe("10 min");
    expect(formatCallDuration(1400)).toBe("23 min"); // 23.33 -> 23
    expect(formatCallDuration(90)).toBe("2 min"); // 1.5 -> 2
  });

  it("shows hours and minutes past an hour", () => {
    expect(formatCallDuration(3600)).toBe("1 h");
    expect(formatCallDuration(3900)).toBe("1 h 05 min");
    expect(formatCallDuration(7500)).toBe("2 h 05 min");
  });
});

describe("formatCallEvent", () => {
  it("labels a call that ended with its duration (participants render as avatars, not text)", () => {
    expect(
      formatCallEvent({ kind: "call", event: "ended", duration_seconds: 600, participant_count: 5 }),
    ).toBe("Call ended · 10 min");
  });

  it("labels a 1:1 call that ended with its duration", () => {
    expect(
      formatCallEvent({ kind: "call", event: "ended", duration_seconds: 1400, participant_count: 2 }),
    ).toBe("Call ended · 23 min");
  });

  it("shows a missed call with no duration", () => {
    expect(formatCallEvent({ kind: "call", event: "missed", participant_count: 2 })).toBe(
      "Missed call",
    );
  });

  it("shows a started call and never a duration for it", () => {
    expect(
      formatCallEvent({ kind: "call", event: "started", duration_seconds: 999, participant_count: 5 }),
    ).toBe("Call started");
  });

  it("degrades gracefully when duration is missing or zero", () => {
    expect(formatCallEvent({ kind: "call", event: "ended" })).toBe("Call ended");
    expect(formatCallEvent({ kind: "call", event: "ended", duration_seconds: 0 })).toBe("Call ended");
  });
});

describe("incomingCallTitle", () => {
  const call = (overrides: Partial<IncomingCall> = {}): IncomingCall => ({
    conversationId: "c1",
    caller: "Riley Carter",
    callerMri: "8:orgid:riley",
    participants: [],
    participantMris: [],
    participantCount: 0,
    ...overrides,
  });

  it("uses the caller's first name for a 1:1 (no conversation name)", () => {
    expect(incomingCallTitle(call())).toBe("Incoming call · Riley");
  });

  it("prefers the conversation name for a group or channel call", () => {
    expect(incomingCallTitle(call(), "Design crew")).toBe("Incoming call · Design crew");
  });

  it("falls back to the caller when the conversation name is blank", () => {
    expect(incomingCallTitle(call(), "   ")).toBe("Incoming call · Riley");
  });

  it("falls back to Someone when neither a name nor a caller is known", () => {
    expect(incomingCallTitle(call({ caller: "" }))).toBe("Incoming call · Someone");
  });
});

describe("computeReadReceiptAnchors", () => {
  // Teams message ids are arrival timestamps (ms), so a conversation is a run of
  // ascending numeric-string ids. Build one so the numeric id comparison is
  // exercised the way it runs in production.
  function numberedMessages(ids: number[]): Pick<ChatMessage, "id">[] {
    return ids.map((id) => ({ id: String(id) }));
  }
  function receipt(mri: string, lastRead: number, readAt: number): ReadReceipt {
    return {
      member_mri: mri,
      member: mri,
      last_read_message_id: String(lastRead),
      read_time_ms: readAt,
    };
  }

  it("anchors a member to the newest message at or before their read position", () => {
    const messages = numberedMessages([100, 200, 300]);
    // Read up to 250 → anchors to 200 (the newest they've reached), not 300.
    const anchors = computeReadReceiptAnchors(messages, [receipt("a", 250, 1)]);

    expect([...anchors.keys()]).toEqual(["200"]);
    expect(anchors.get("200")!.map((r) => r.member_mri)).toEqual(["a"]);
    expect(anchors.get("300")).toBeUndefined();
  });

  it("anchors to the exact message when the read id matches one on screen", () => {
    const messages = numberedMessages([100, 200, 300]);
    const anchors = computeReadReceiptAnchors(messages, [receipt("a", 300, 1)]);

    expect([...anchors.keys()]).toEqual(["300"]);
  });

  it("omits a member whose read position is older than the loaded window", () => {
    const messages = numberedMessages([200, 300]);
    // Read only up to 100 — before anything on screen — so no avatar floats above
    // the history; it appears once they read into the loaded range.
    const anchors = computeReadReceiptAnchors(messages, [receipt("a", 100, 1)]);

    expect(anchors.size).toBe(0);
  });

  it("groups everyone reading up to the same message and orders them most-recent-first", () => {
    const messages = numberedMessages([100, 200, 300]);
    const anchors = computeReadReceiptAnchors(messages, [
      receipt("early", 300, 10),
      receipt("late", 300, 30),
      receipt("mid", 300, 20),
    ]);

    expect(anchors.get("300")!.map((r) => r.member_mri)).toEqual(["late", "mid", "early"]);
  });

  it("places members at their own distinct anchors", () => {
    const messages = numberedMessages([100, 200, 300]);
    const anchors = computeReadReceiptAnchors(messages, [
      receipt("behind", 150, 1),
      receipt("caught-up", 300, 2),
    ]);

    expect(anchors.get("100")!.map((r) => r.member_mri)).toEqual(["behind"]);
    expect(anchors.get("300")!.map((r) => r.member_mri)).toEqual(["caught-up"]);
  });

  it("returns nothing for an empty conversation or no receipts", () => {
    expect(computeReadReceiptAnchors([], [receipt("a", 100, 1)]).size).toBe(0);
    expect(computeReadReceiptAnchors(numberedMessages([100]), []).size).toBe(0);
  });
});

// ---- mail (read-only Outlook surface) --------------------------------------

describe("mail display helpers", () => {
  const address = (name: string, addr: string) => ({ name, address: addr });

  it("labels a folder by its stable name, falling back to the mailbox's own", () => {
    // A well-known folder reads the same in any tenant language…
    expect(
      mailFolderLabel({
        id: "f",
        display_name: "Boîte de réception",
        well_known: "Inbox",
        total_count: 0,
        unread_count: 0,
        position: 0,
      }),
    ).toBe("Inbox");
    // …while a user folder has only the (localized) name Outlook shows.
    expect(
      mailFolderLabel({
        id: "f",
        display_name: "Projets",
        well_known: "",
        total_count: 0,
        unread_count: 0,
        position: 9,
      }),
    ).toBe("Projets");
  });

  it("names one address by display name, then by the address itself", () => {
    // What a recipient chip is labelled with. Empty means nobody is named, so the
    // chip is not drawn at all — never a chip with a blank name.
    expect(mailAddressLabel(address("Ada Lovelace", "ada@example.com"))).toBe("Ada Lovelace");
    expect(mailAddressLabel(address("", "ops@example.com"))).toBe("ops@example.com");
    expect(mailAddressLabel(address("", ""))).toBe("");
  });

  it("names a sender by display name, then address, then a placeholder", () => {
    expect(mailSenderLabel({ from: address("Lucas Silva", "lucas@example.com") })).toBe("Lucas Silva");
    expect(mailSenderLabel({ from: address("", "noreply@example.com") })).toBe("noreply@example.com");
    expect(mailSenderLabel({ from: address("", "") })).toBe("(unknown sender)");
  });

  it("shows the conventional placeholder for an empty subject", () => {
    expect(mailSubjectLabel({ subject: "Quarterly review" })).toBe("Quarterly review");
    expect(mailSubjectLabel({ subject: "" })).toBe("(no subject)");
  });

  it("parses the received timestamp, and refuses to invent one", () => {
    expect(mailReceivedMs({ received: "2026-06-30T14:20:16Z" })).toBe(
      Date.UTC(2026, 5, 30, 14, 20, 16),
    );
    // An unparseable value yields 0, which the formatters render as no date at all
    // rather than "Invalid Date".
    expect(mailReceivedMs({ received: "" })).toBe(0);
    expect(mailReceivedMs({ received: "not a date" })).toBe(0);
  });

  it("summarizes recipients and overflows into a count", () => {
    expect(mailRecipientsLabel([])).toBe("");
    expect(mailRecipientsLabel([address("Ada", "ada@example.com")])).toBe("Ada");
    // An address with no display name still identifies the person.
    expect(mailRecipientsLabel([address("", "ops@example.com")])).toBe("ops@example.com");
    expect(
      mailRecipientsLabel([address("Ada", "a@x"), address("Bob", "b@x"), address("Cy", "c@x")]),
    ).toBe("Ada, Bob and 1 other");
    expect(
      mailRecipientsLabel([
        address("Ada", "a@x"),
        address("Bob", "b@x"),
        address("Cy", "c@x"),
        address("Dee", "d@x"),
      ]),
    ).toBe("Ada, Bob and 2 others");
  });

  it("lists only file attachments, since inline ones are already in the body", () => {
    const attachments = [
      { id: "1", name: "deck.pdf", content_type: "application/pdf", size: 100, is_inline: false },
      { id: "2", name: "logo.png", content_type: "image/png", size: 10, is_inline: true },
    ];
    expect(mailFileAttachments(attachments).map((a) => a.id)).toEqual(["1"]);
  });

  it("formats attachment sizes", () => {
    expect(formatAttachmentSize(0)).toBe("");
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(1942)).toBe("1.9 KB");
    expect(formatAttachmentSize(20 * 1024)).toBe("20 KB");
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe("3 MB");
  });

  it("badges the inbox's unread count, not the whole mailbox's", () => {
    const folder = (well_known: string, unread: number, position: number) => ({
      id: `f-${well_known}`,
      display_name: well_known,
      well_known,
      total_count: 0,
      unread_count: unread,
      position,
    });
    // Deleted items carry thousands of unread messages nobody acts on; badging them
    // would make the count meaningless.
    expect(mailUnreadBadge([folder("Inbox", 12, 0), folder("Deleted", 1558, 6)])).toBe(12);
    // With no inbox at all, the first folder stands in.
    expect(mailUnreadBadge([folder("Archive", 3, 1)])).toBe(3);
    expect(mailUnreadBadge([])).toBe(0);
  });
});

describe("mail page merging", () => {
  const mail = (id: string, received: string, is_read = true): MailHeader => ({
    id,
    folder_id: "f",
    conversation_id: "c",
    subject: `Subject ${id}`,
    from: { name: "Lucas Silva", address: "lucas@example.com" },
    to: [],
    cc: [],
    received,
    is_read,
    has_attachments: false,
    importance: "normal",
    preview: "preview",
  });

  it("sorts merged mail newest first, deduplicating by id", () => {
    const merged = mergeMail(
      [mail("a", "2026-07-01T09:00:00Z"), mail("b", "2026-07-03T09:00:00Z")],
      [mail("c", "2026-07-02T09:00:00Z"), mail("a", "2026-07-01T09:00:00Z")],
    );
    expect(merged.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("lets a refreshed header replace the stale copy", () => {
    const merged = mergeMail(
      [mail("a", "2026-07-01T09:00:00Z", false)],
      [mail("a", "2026-07-01T09:00:00Z", true)],
    );
    expect(merged).toHaveLength(1);
    // Read in real Outlook, so the row must stop showing as unread here.
    expect(merged[0]!.is_read).toBe(true);
  });

  it("orders mail received in the same second deterministically", () => {
    const same = "2026-07-01T09:00:00Z";
    const first = mergeMail([], [mail("b", same), mail("a", same)]);
    const second = mergeMail([mail("a", same)], [mail("b", same)]);
    expect(first.map((m) => m.id)).toEqual(second.map((m) => m.id));
  });

  it("keeps mail older than a refreshed window instead of truncating the list", () => {
    // The backend only re-reads the newest window, so a merge must not throw away
    // the pages the user scrolled back through.
    const held = {
      messages: [
        mail("new", "2026-07-05T09:00:00Z"),
        mail("mid", "2026-07-03T09:00:00Z"),
        mail("old", "2026-06-01T09:00:00Z"),
      ],
      has_more: true,
    };
    const merged = mergeRefreshedMailPage(held, {
      messages: [mail("newest", "2026-07-06T09:00:00Z"), mail("new", "2026-07-05T09:00:00Z")],
      has_more: true,
    });
    expect(merged.messages.map((m) => m.id)).toEqual(["newest", "new", "mid", "old"]);
    expect(merged.has_more).toBe(true);
  });

  it("drops mail the server no longer lists inside the refreshed window", () => {
    // This is how a mail deleted or moved in real Outlook disappears here.
    const held = {
      messages: [
        mail("gone", "2026-07-05T09:00:00Z"),
        mail("kept", "2026-07-04T09:00:00Z"),
        mail("older", "2026-06-01T09:00:00Z"),
      ],
      has_more: true,
    };
    const merged = mergeRefreshedMailPage(held, {
      messages: [mail("kept", "2026-07-04T09:00:00Z")],
      has_more: true,
    });
    expect(merged.messages.map((m) => m.id)).toEqual(["kept", "older"]);
  });

  it("keeps what we hold when a refresh comes back empty", () => {
    // An empty window must never be read as "the folder is empty now".
    const held = { messages: [mail("a", "2026-07-01T09:00:00Z")], has_more: true };
    const merged = mergeRefreshedMailPage(held, { messages: [], has_more: false });
    expect(merged.messages.map((m) => m.id)).toEqual(["a"]);
    expect(merged.has_more).toBe(true);
  });

  it("takes the server's has_more when it holds nothing older", () => {
    const merged = mergeRefreshedMailPage(undefined, {
      messages: [mail("a", "2026-07-01T09:00:00Z")],
      has_more: true,
    });
    expect(merged.messages.map((m) => m.id)).toEqual(["a"]);
    expect(merged.has_more).toBe(true);
  });

  it("appends an older page and adopts its has_more", () => {
    const merged = mergeOlderMailPage(
      { messages: [mail("new", "2026-07-05T09:00:00Z")], has_more: true },
      { messages: [mail("old", "2026-06-01T09:00:00Z")], has_more: false },
    );
    expect(merged.messages.map((m) => m.id)).toEqual(["new", "old"]);
    expect(merged.has_more).toBe(false);
  });
});

// ---- calendar (read-only surface) -------------------------------------------

describe("calendar protocol helpers", () => {
  function ev(id: string, start: string, end: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
      id,
      calendar_id: "cal",
      subject: id,
      preview: "",
      start,
      end,
      is_all_day: false,
      is_cancelled: false,
      is_organizer: false,
      organizer: { name: "", address: "", response: "", kind: "" },
      location: "",
      join_url: "",
      web_link: "",
      show_as: "busy",
      response: "none",
      series: "singleInstance",
      recurrence: "",
      importance: "normal",
      sensitivity: "normal",
      categories: [],
      attendees: [],
      attendee_count: 0,
      has_attachments: false,
      reminder_minutes: -1,
      ...over,
    };
  }

  it("prefers Outlook's own colour and falls back to a stable palette", () => {
    expect(calendarColor({ hex_color: "#16a765", position: 3 })).toBe("#16a765");
    // "auto" / empty / malformed all fall through to the palette.
    const byPosition = calendarColor({ hex_color: "", position: 1 });
    expect(byPosition).toMatch(/^#[0-9a-f]{6}$/i);
    expect(calendarColor({ hex_color: "auto", position: 1 })).toBe(byPosition);
    expect(calendarColor({ hex_color: "#xyzxyz", position: 1 })).toBe(byPosition);
    // Same position, same colour, every time — a calendar must not change colour
    // between renders.
    expect(calendarColor({ hex_color: "", position: 1 })).toBe(byPosition);
    // The palette wraps rather than yielding undefined for a large position.
    expect(calendarColor({ hex_color: "", position: 99 })).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("labels an event and its people with honest fallbacks", () => {
    expect(eventTitle({ subject: "Guild" })).toBe("Guild");
    expect(eventTitle({ subject: "" })).toBe("(no title)");
    expect(personLabel({ name: "Ada", address: "ada@x.com" })).toBe("Ada");
    expect(personLabel({ name: "", address: "ada@x.com" })).toBe("ada@x.com");
    expect(personLabel({ name: "", address: "" })).toBe("(unknown)");
  });

  it("knows which events belong to a series", () => {
    expect(eventRepeats({ series: "singleInstance" })).toBe(false);
    expect(eventRepeats({ series: "" })).toBe(false);
    expect(eventRepeats({ series: "occurrence" })).toBe(true);
    expect(eventRepeats({ series: "exception" })).toBe(true);
  });

  it("merges events by id, keeping the fresher copy and earliest-first order", () => {
    const held = [
      ev("b", "2026-07-13T10:00:00Z", "2026-07-13T11:00:00Z"),
      ev("a", "2026-07-13T09:00:00Z", "2026-07-13T09:30:00Z"),
    ];
    const merged = mergeEvents(held, [
      // The same occurrence, moved half an hour later and now accepted.
      ev("a", "2026-07-13T09:30:00Z", "2026-07-13T10:00:00Z", { response: "accepted" }),
    ]);
    expect(merged.map((e) => e.id)).toEqual(["a", "b"]);
    expect(merged[0]!.response).toBe("accepted");
    expect(merged[0]!.start).toBe("2026-07-13T09:30:00Z");
  });

  it("lets a refreshed window drop an event deleted in Outlook", () => {
    const held = [
      ev("kept", "2026-07-13T09:00:00Z", "2026-07-13T10:00:00Z"),
      ev("gone", "2026-07-14T09:00:00Z", "2026-07-14T10:00:00Z"),
    ];
    const merged = mergeCalendarWindow(held, {
      start: "2026-07-01T00:00:00Z",
      end: "2026-08-01T00:00:00Z",
      events: [held[0]!],
    });
    expect(merged.map((e) => e.id)).toEqual(["kept"]);
  });

  it("keeps events outside the refreshed window", () => {
    // A background refresh of July must not drop a cached August: stepping back to
    // it would otherwise show an empty month until the network answered again.
    const held = [
      ev("july", "2026-07-13T09:00:00Z", "2026-07-13T10:00:00Z"),
      ev("august", "2026-08-03T09:00:00Z", "2026-08-03T10:00:00Z"),
    ];
    const merged = mergeCalendarWindow(held, {
      start: "2026-07-01T00:00:00Z",
      end: "2026-08-01T00:00:00Z",
      events: [],
    });
    expect(merged.map((e) => e.id)).toEqual(["august"]);
  });

  it("keeps a multi-day event that started before the refreshed window", () => {
    // Its start is in June, so a "starts within the window" test would treat it as
    // outside and never reconcile it — while the server DID list it.
    const leave = ev("leave", "2026-06-29T00:00:00Z", "2026-07-06T00:00:00Z", { is_all_day: true });
    const merged = mergeCalendarWindow([leave], {
      start: "2026-07-01T00:00:00Z",
      end: "2026-08-01T00:00:00Z",
      events: [],
    });
    // Dropped, because the window is authoritative and no longer lists it.
    expect(merged).toEqual([]);
  });
});

describe("brokerNeedsAttention", () => {
  const failing = {
    ok: false,
    signature: "disconnected",
    message: "The identity broker stopped answering.",
    detail: "",
    consecutive_failures: 3,
    can_repair: true,
    repairing: false,
  };

  it("raises the banner only for a backend that says sign-in is broken", () => {
    expect(brokerNeedsAttention(failing)).toBe(true);
    expect(brokerNeedsAttention({ ...failing, ok: true })).toBe(false);
  });

  it("stays silent when the backend never said anything", () => {
    // The mock and any backend older than this feature emit no broker_status at all,
    // and a banner that appeared by default would be worse than the bug it explains.
    expect(brokerNeedsAttention(null)).toBe(false);
    expect(brokerNeedsAttention(undefined)).toBe(false);
  });
});
