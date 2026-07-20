import { testRender } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import { MessageBubble } from "./app";
import type { ChatMessage } from "./client";
import { copyableMessageText, MessageActions } from "./message-actions";

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
  let closed = false;
  const [open, setOpen] = createSignal(false);
  const { renderOnce, captureCharFrame, mockInput, mockMouse } = await testRender(
    () => (
      <box style={{ width: 60, height: 20, flexDirection: "column" }}>
        <MessageBubble message={message} showSenderName={false} onClick={() => setOpen(true)} />
        <Show when={open()}>
          <MessageActions
            message={message}
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
  check(`${message.is_self ? "own" : "incoming"} message shows Copy`, menu.includes("Copy"));

  if (message.is_self) {
    mockInput.pressEnter();
  } else {
    const frame = strip(captureCharFrame());
    const row = frame.split("\n").findIndex((line) => line.includes("Copy"));
    const column = frame.split("\n")[row]?.indexOf("Copy") ?? -1;
    await mockMouse.click(column, row);
  }
  await settle(renderOnce);
  check(`${message.is_self ? "own" : "incoming"} message copies visible text`, copied === copyableMessageText(message));
  check(`${message.is_self ? "own" : "incoming"} message closes actions`, closed && !strip(captureCharFrame()).includes("Message Actions"));
}

const reply: ChatMessage = {
  ...incoming,
  content:
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply">` +
    `<strong itemprop="mri">Bob</strong><p itemprop="preview">Old message</p>` +
    `</blockquote><p>New reply</p>`,
};
check("reply copies its body without the quoted message", copyableMessageText(reply) === "New reply");

process.exit(ok ? 0 : 1);
