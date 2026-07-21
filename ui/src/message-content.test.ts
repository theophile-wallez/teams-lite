// Unit test for parseMessageContent: proves a Teams reply is split into its quoted
// part (author + preview text) and the reply body, using real captured Teams HTML.
// Run: bun src/message-content.test.ts

import { parseMessageContent } from "./message-content";

// Verbatim from the real tenant (a reply Clément sent, quoting an earlier message).
const REPLY =
  `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1784279090040">` +
  `<strong itemprop="mri" itemid="8:orgid:5f5e928f-4aa0-4efa-a680-e3c9abb77439">Clément BOSLE</strong>` +
  `<span itemprop="time" itemid="1784279090040"></span>` +
  `<p itemprop="preview">après y a mon coloc qui est arrivé du coup on a discuté vite fait</p>` +
  `</blockquote>` +
  `<p>Aaaaah okay mb je pensais jusqu'à 19h30 tu attendais ma réponse</p>`;

const PLAIN = `<p>just a normal message</p>`;
const INLINE_REPLY =
  `<p>before quote</p>` +
  `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
  `<strong itemprop="mri">Bob</strong><p itemprop="preview">quoted</p>` +
  `</blockquote><p>after quote</p>`;
const ENTITIES = `<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>`;

let ok = true;
function check(label: string, pass: boolean) {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
}

{
  const p = parseMessageContent(REPLY);
  check("reply: quote detected", p.quote !== undefined);
  check("reply: quoted author extracted", p.quote?.sender === "Clément BOSLE");
  check(
    "reply: quoted text extracted",
    p.quote?.text === "après y a mon coloc qui est arrivé du coup on a discuté vite fait",
  );
  check(
    "reply: body is the reply only",
    p.body === "Aaaaah okay mb je pensais jusqu'à 19h30 tu attendais ma réponse",
  );
  check("reply: body excludes the quoted preview", !p.body.includes("mon coloc"));
}

{
  const p = parseMessageContent(PLAIN);
  check("plain: no quote", p.quote === undefined);
  check("plain: body is the whole message", p.body === "just a normal message");
}

{
  const p = parseMessageContent(INLINE_REPLY);
  check("inline reply: body before quote preserved", p.beforeQuote === "before quote");
  check("inline reply: body after quote preserved", p.afterQuote === "after quote");
  check("inline reply: copy body preserves order", p.body === "before quote\nafter quote");
}

{
  const p = parseMessageContent(ENTITIES);
  check("entities: decoded in body", p.body === 'a & b <c> "d"');
}

console.log(ok ? "\nOK parseMessageContent splits Teams replies (unit)." : "");
process.exit(ok ? 0 : 1);
