import { testRender } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import { MessageBubble, MessageComposer } from "./app";
import type { ChatMessage } from "./client";
import { copyableMessageText, inlineReplyMarker, MessageActions, replyToPayload } from "./message-actions";

const incoming: ChatMessage = {
  id: "incoming",
  conversation_id: "c1",
  seq: 1,
  compose_time: 1,
  sender: "Alice",
  content: "<p>Hello &amp; welcome</p>",
  is_self: false,
};

const mine: ChatMessage = {
  ...incoming,
  id: "mine",
  sender: "Me",
  content: "<p>My message</p>",
  is_self: true,
};

const strip = (frame: string) => frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const settle = async (renderOnce: () => Promise<void>) => {
  await renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await renderOnce();
};

let ok = true;
function check(label: string, pass: boolean) {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
}

for (const message of [incoming, mine]) {
  let copied: string | undefined;
  let repliedTo: ChatMessage | undefined;
  let closed = false;
  const [open, setOpen] = createSignal(false);
  const { renderOnce, captureCharFrame, mockInput, mockMouse } = await testRender(
    () => (
      <box style={{ width: 60, height: 20, flexDirection: "column" }}>
        <MessageBubble message={message} showSenderName={false} onClick={() => setOpen(true)} />
        <Show when={open()}>
          <MessageActions
            message={message}
            onReply={(target) => (repliedTo = target)}
            onCopy={(text) => (copied = text)}
            onClose={() => {
              closed = true;
              setOpen(false);
            }}
          />
        </Show>
      </box>
    ),
    { width: 60, height: 20 },
  );

  await settle(renderOnce);
  const initial = strip(captureCharFrame());
  const row = initial.split("\n").findIndex((line) => line.includes(message.is_self ? "My message" : "Hello & welcome"));
  const column = initial.split("\n")[row]?.indexOf(message.is_self ? "My message" : "Hello & welcome") ?? -1;
  await mockMouse.click(column, row);
  await settle(renderOnce);

  const menu = strip(captureCharFrame());
  check(`${message.is_self ? "own" : "incoming"} message opens actions`, menu.includes("Message Actions"));
  check(`${message.is_self ? "own" : "incoming"} message shows Reply`, menu.includes("Reply"));
  check(`${message.is_self ? "own" : "incoming"} message shows Copy`, menu.includes("Copy"));

  mockInput.pressEnter();
  await settle(renderOnce);
  check(`${message.is_self ? "own" : "incoming"} message can be replied to`, repliedTo?.id === message.id);
  check(`${message.is_self ? "own" : "incoming"} reply closes actions`, closed && !strip(captureCharFrame()).includes("Message Actions"));

  closed = false;
  await mockMouse.click(column, row);
  await settle(renderOnce);
  const copyMenu = strip(captureCharFrame());
  const copyRow = copyMenu.split("\n").findIndex((line) => line.includes("Copy"));
  const copyColumn = copyMenu.split("\n")[copyRow]?.indexOf("Copy") ?? -1;
  await mockMouse.click(copyColumn, copyRow);
  await settle(renderOnce);
  check(`${message.is_self ? "own" : "incoming"} message copies visible text`, copied === copyableMessageText(message));
  check(`${message.is_self ? "own" : "incoming"} copy closes actions`, closed && !strip(captureCharFrame()).includes("Message Actions"));
}

const reply: ChatMessage = {
  ...incoming,
  compose_time: 1_784_279_090_040,
  sender_mri: "8:orgid:bob",
  content:
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply">` +
    `<strong itemprop="mri">Bob</strong><p itemprop="preview">Old message</p>` +
    `</blockquote><p>New reply</p>`,
};
check("reply copies its body without the quoted message", copyableMessageText(reply) === "New reply");
check(
  "reply payload cites the selected message body",
  JSON.stringify(replyToPayload(reply, "Before", "After")) ===
    JSON.stringify({
      compose_time: 1_784_279_090_040,
      sender: "Alice",
      sender_mri: "8:orgid:bob",
      preview: "New reply",
      before: "Before",
      after: "After",
    }),
);
check(
  "reply marker starts exactly at a line cursor",
  inlineReplyMarker(incoming, "First line\nSecond line", 11) === "> Alice: Hello & welcome\n",
);
check(
  "reply marker splits text at an inline cursor",
  inlineReplyMarker(incoming, "BeforeAfter", 6) === "\n> Alice: Hello & welcome\n",
);

const [composerValue, setComposerValue] = createSignal("");
const [composerReply, setComposerReply] = createSignal<{ message: ChatMessage; marker: string | null } | null>(null);
const composer = await testRender(
  () => (
    <MessageComposer
      value={composerValue()}
      focused
      replyingTo={composerReply()}
      onReplyMarkerInserted={(marker) =>
        setComposerReply((reply) => (reply ? { ...reply, marker } : null))
      }
      onContentChange={setComposerValue}
      onSubmit={() => {}}
    />
  ),
  { width: 60, height: 8 },
);
await composer.renderOnce();
await composer.mockInput.typeText("BeforeAfter");
for (let i = 0; i < 5; i++) composer.mockInput.pressArrow("left");
setComposerReply({ message: incoming, marker: null });
await settle(composer.renderOnce);
check(
  "reply is inserted at the live textarea cursor",
  composerValue() === "Before\n> Alice: Hello & welcome\nAfter",
);

process.exit(ok ? 0 : 1);
