/**
 * An agent's Markdown answer, as the HTML subset a Teams message renders.
 *
 * A port of `src/agent_markdown.rs`, kept faithful on purpose — and the tests in
 * agent-markdown.test.ts are that module's own tests, case for case, so the two cannot
 * drift silently.
 *
 * Why the port exists at all: the backend converts the answer to HTML and posts it, but
 * it only does so about once a second (each conversion is a Teams edit everybody in the
 * thread pays for). The `agent_stream` event carries the raw Markdown instead, many
 * times a second, and this is what turns it into something {@link RichContent} can
 * render — so the live bubble and the posted message show the same body, formatted the
 * same way, without the live one waiting for a network round-trip.
 *
 * Deliberately a SUBSET, matching the Rust module exactly:
 *
 * - Paragraphs, fenced code blocks, bullet and numbered lists, block quotes.
 * - Inline: `` `code` `` and `**bold**`, and nothing else. `_underscore_` emphasis is
 *   left alone, because `some_function_name` is code far more often than it is
 *   emphasis.
 * - Every piece of text is escaped BEFORE any markup is added, so an answer can never
 *   inject markup into the body.
 *
 * ONE deliberate divergence: the Rust module also turns `@Name` into a Teams @mention
 * for the people of the thread, and this port does not. A mention is a PAIR — a span
 * carrying an index, and a list saying who that index names — and the second half exists
 * only on the posted message, which the overlay does not have. So `@Ada` reads as the
 * text it is while the answer streams and becomes a chip the moment the message takes its
 * body back. Drawing a chip here would mean drawing one this page cannot resolve, which
 * is the mistake `mergeAdjacentMentions` refuses to make for inbound messages too.
 */

/** Escape the five characters that matter in HTML text. */
function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render an answer as the HTML body of a Teams message. */
export function agentMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? "").replace(/\s+$/, "");
    i += 1;

    // A fenced code block runs to its closing fence, or to the end of the text while
    // the answer is still streaming — an unterminated fence is the normal state
    // halfway through a reply, not an error.
    const fence = openingFence(line);
    if (fence) {
      const code: string[] = [];
      while (i < lines.length) {
        const next = (lines[i] ?? "").replace(/\s+$/, "");
        if (closesFence(next, fence)) {
          i += 1;
          break;
        }
        code.push(escape(lines[i] ?? ""));
        i += 1;
      }
      html += `<pre><code>${code.join("\n").replace(/\n+$/, "")}</code></pre>`;
      continue;
    }
    if (line.trim() === "") continue;

    // A list: consume every following line that keeps the same kind.
    const kind = listKind(line);
    if (kind) {
      const [open, close] = kind === "bullet" ? ["<ul>", "</ul>"] : ["<ol>", "</ol>"];
      html += open;
      html += `<li>${inline(listItemText(line))}</li>`;
      while (i < lines.length) {
        const next = (lines[i] ?? "").replace(/\s+$/, "");
        if (listKind(next) !== kind) break;
        html += `<li>${inline(listItemText(next))}</li>`;
        i += 1;
      }
      html += close;
      continue;
    }

    if (line.trimStart().startsWith("> ")) {
      html += `<blockquote><p>${inline(line.trimStart().slice(2))}</p></blockquote>`;
      continue;
    }

    // A heading has no place in a chat message (the system prompt says so), so it
    // becomes a bold paragraph rather than an <h1> nobody wants in a thread.
    const heading = line.replace(/^#+/, "");
    if (heading.length < line.length && heading.trim() !== "") {
      html += `<p><strong>${inline(heading.trim())}</strong></p>`;
      continue;
    }

    // A paragraph: consecutive non-blank lines, joined by <br>.
    let paragraph = inline(line.trim());
    while (i < lines.length) {
      const next = (lines[i] ?? "").replace(/\s+$/, "");
      if (
        next.trim() === "" ||
        listKind(next) !== null ||
        openingFence(next) !== null ||
        next.trimStart().startsWith("> ")
      ) {
        break;
      }
      paragraph += `<br>${inline(next.trim())}`;
      i += 1;
    }
    html += `<p>${paragraph}</p>`;
  }
  return html;
}

/** The fence that opens a code block (``` or ~~~), if this line is one. */
function openingFence(line: string): string | null {
  const trimmed = line.trimStart();
  for (const fence of ["`", "~"]) {
    if (trimmed.startsWith(fence.repeat(3))) return fence;
  }
  return null;
}

function closesFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(fence.repeat(3)) && [...trimmed].every((c) => c === fence);
}

type ListKind = "bullet" | "numbered";

function listKind(line: string): ListKind | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("+ ")) {
    return "bullet";
  }
  const digits = /^\d+/.exec(trimmed)?.[0] ?? "";
  if (digits && trimmed.slice(digits.length).startsWith(". ")) return "numbered";
  return null;
}

function listItemText(line: string): string {
  const trimmed = line.trimStart();
  switch (listKind(trimmed)) {
    case "bullet":
      return trimmed.slice(2).trim();
    case "numbered": {
      const digits = (/^\d+/.exec(trimmed)?.[0] ?? "").length;
      return trimmed.slice(digits + 2).trim();
    }
    default:
      return trimmed;
  }
}

/**
 * Escape one line and turn `` `code` `` and `**bold**` into markup.
 *
 * One pass, with the code state tracked, so `**` inside a code span stays two asterisks
 * — which is what it is. A span the answer opened and never closed is closed here,
 * which is the normal state while streaming.
 */
function inline(text: string): string {
  const chars = [...escape(text)];
  let out = "";
  let inCode = false;
  let inBold = false;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "`") {
      out += inCode ? "</code>" : "<code>";
      inCode = !inCode;
      i += 1;
    } else if (c === "*" && !inCode && chars[i + 1] === "*") {
      out += inBold ? "</strong>" : "<strong>";
      inBold = !inBold;
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  if (inCode) out += "</code>";
  if (inBold) out += "</strong>";
  return out;
}
