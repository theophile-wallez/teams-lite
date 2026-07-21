import type { ChatMessage, ReplyTo } from "./client";
import { DialogSelect } from "./dialog-select";
import { parseMessageContent } from "./message-content";

export function copyableMessageText(message: ChatMessage): string {
  const parsed = parseMessageContent(message.content);
  return parsed.body || parsed.quote?.text || "";
}

export function replyToPayload(message: ChatMessage, before: string, after: string): ReplyTo {
  return {
    compose_time: message.compose_time,
    sender: message.sender,
    sender_mri: message.sender_mri ?? "",
    preview: copyableMessageText(message),
    before,
    after,
  };
}

export function inlineReplyMarker(message: ChatMessage, text: string, cursorOffset: number): string {
  const offset = Math.max(0, Math.min(cursorOffset, text.length));
  const prefix = offset > 0 && text[offset - 1] !== "\n" ? "\n" : "";
  const suffix = offset < text.length && text[offset] !== "\n" ? "\n" : "";
  const preview = copyableMessageText(message).replace(/\s+/g, " ").slice(0, 80);
  return `${prefix}> ${message.sender}: ${preview}${suffix}`;
}

export function MessageActions(props: {
  message: ChatMessage;
  onReply: (message: ChatMessage) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <DialogSelect
      title="Message Actions"
      options={[
        { title: "Reply", value: "reply" },
        { title: "Copy", value: "copy" },
      ]}
      onSelect={(option) => {
        if (option.value === "reply") props.onReply(props.message);
        else props.onCopy(copyableMessageText(props.message));
        props.onClose();
      }}
      onClose={props.onClose}
    />
  );
}
