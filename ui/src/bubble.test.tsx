// Headless render test for MessageBubble: proves left/right alignment by is_self
// and that the sender name shows only for incoming bubbles in group chats.

import { testRender } from "@opentui/solid";
import { For } from "solid-js";
import { MessageBubble } from "./app";
import type { ChatMessage } from "./client";

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    conversation_id: "c1",
    seq: 0,
    compose_time: 0,
    sender: "Someone",
    content: "hi",
    ...over,
  };
}

// column index of the first non-space char on the row containing `needle`
function indent(frame: string, needle: string): number {
  const line = frame.split("\n").find((l) => l.includes(needle));
  if (!line) return -1;
  return line.length - line.trimStart().length;
}

const WIDTH = 60;

// --- group chat: incoming bubble shows the sender name, mine is right-aligned ---
{
  const group: ChatMessage[] = [
    msg({ sender: "Alice", content: "GROUPHELLO", is_self: false }),
    msg({ sender: "Me", content: "GROUPMINE", is_self: true }),
  ];
  const { renderOnce, captureCharFrame } = await testRender(
    () => (
      <box style={{ width: WIDTH, flexDirection: "column" }}>
        <For each={group}>{(m) => <MessageBubble message={m} showSenderName={true} />}</For>
      </box>
    ),
    { width: WIDTH, height: 20 },
  );
  await renderOnce();
  const frame = captureCharFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

  const otherCol = indent(frame, "GROUPHELLO");
  const mineCol = indent(frame, "GROUPMINE");

  const checks: [string, boolean][] = [
    ["group: sender name shown for incoming", frame.includes("Alice")],
    ["group: incoming bubble is left (low indent)", otherCol >= 0 && otherCol <= 2],
    ["group: my bubble is right (high indent)", mineCol > otherCol + 5],
  ];
  report("group chat", checks, frame);
}

// --- 1:1 chat: no sender name on incoming, still left/right by is_self ---
{
  const dm: ChatMessage[] = [
    msg({ sender: "Bob", content: "DMHELLO", is_self: false }),
    msg({ sender: "Me", content: "DMMINE", is_self: true }),
  ];
  const { renderOnce, captureCharFrame } = await testRender(
    () => (
      <box style={{ width: WIDTH, flexDirection: "column" }}>
        <For each={dm}>{(m) => <MessageBubble message={m} showSenderName={false} />}</For>
      </box>
    ),
    { width: WIDTH, height: 20 },
  );
  await renderOnce();
  const frame = captureCharFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

  const otherCol = indent(frame, "DMHELLO");
  const mineCol = indent(frame, "DMMINE");

  const checks: [string, boolean][] = [
    ["1:1: no sender name shown", !frame.includes("Bob")],
    ["1:1: incoming bubble is left (low indent)", otherCol >= 0 && otherCol <= 2],
    ["1:1: my bubble is right (high indent)", mineCol > otherCol + 5],
  ];
  report("1:1 chat", checks, frame);
}

// --- reply: the quoted message renders as a nested block above the reply body ---
{
  const reply = msg({
    sender: "Alice",
    is_self: false,
    content:
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
      `<strong itemprop="mri" itemid="8:orgid:x">Bob</strong>` +
      `<span itemprop="time" itemid="1"></span>` +
      `<p itemprop="preview">QUOTEDTEXT</p></blockquote><p>REPLYBODY</p>`,
  });
  const { renderOnce, captureCharFrame } = await testRender(
    () => (
      <box style={{ width: WIDTH, flexDirection: "column" }}>
        <MessageBubble message={reply} showSenderName={true} />
      </box>
    ),
    { width: WIDTH, height: 20 },
  );
  await renderOnce();
  const frame = captureCharFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const rowOf = (needle: string) => frame.split("\n").findIndex((l) => l.includes(needle));

  const checks: [string, boolean][] = [
    ["reply: quoted author shown", frame.includes("Bob")],
    ["reply: quoted text shown", frame.includes("QUOTEDTEXT")],
    ["reply: reply body shown", frame.includes("REPLYBODY")],
    ["reply: half-block top spacer present", frame.includes("▀")],
    ["reply: half-block bottom spacer present", frame.includes("▄")],
    [
      "reply: quote appears above the body",
      rowOf("QUOTEDTEXT") >= 0 && rowOf("QUOTEDTEXT") < rowOf("REPLYBODY"),
    ],
  ];
  report("reply quote", checks, frame);
}

// --- reply without a sender name: the quote must not stack a second top gap ---
// When no name sits above the quote (1:1, or my own message), the bubble's own ▀
// top already provides the gap, so the quote starts on the very next row instead of
// after a second ▀ inset row.
{
  const content =
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
    `<strong itemprop="mri" itemid="8:orgid:x">Bob</strong>` +
    `<span itemprop="time" itemid="1"></span>` +
    `<p itemprop="preview">NONAMEQUOTE</p></blockquote><p>NONAMEBODY</p>`;
  const { renderOnce, captureCharFrame } = await testRender(
    () => (
      <box style={{ width: WIDTH, flexDirection: "column" }}>
        <MessageBubble message={msg({ content, is_self: false })} showSenderName={false} />
      </box>
    ),
    { width: WIDTH, height: 20 },
  );
  await renderOnce();
  const frame = captureCharFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const rows = frame.split("\n");
  const quoteRow = rows.findIndex((l) => l.includes("NONAMEQUOTE"));
  // Rows strictly above the quote content that are a half-block gap. Exactly one
  // (the bubble's ▀ top) is expected; two would be the regression we are fixing.
  const gapRowsAbove = rows.slice(0, quoteRow).filter((l) => /▀/.test(l)).length;

  const checks: [string, boolean][] = [
    ["no-name reply: quoted text shown", frame.includes("NONAMEQUOTE")],
    ["no-name reply: single top gap above the quote", gapRowsAbove === 1],
  ];
  report("reply quote (no name)", checks, frame);
}

console.log("\nOK MessageBubble alignment + sender-name rules hold (headless).");
process.exit(0);

function report(scope: string, checks: [string, boolean][], frame: string) {
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
    if (!pass) ok = false;
  }
  if (!ok) {
    console.log(`\n--- ${scope} frame ---\n` + frame);
    process.exit(1);
  }
}
