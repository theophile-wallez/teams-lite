import type { ChatMessage } from "./client";
import { DialogSelect } from "./dialog-select";
import { parseMessageContent } from "./message-content";

export function copyableMessageText(message: ChatMessage): string {
  const parsed = parseMessageContent(message.content);
  return parsed.body || parsed.quote?.text || "";
}

export function MessageActions(props: {
  message: ChatMessage;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <DialogSelect
      title="Message Actions"
      options={[{ title: "Copy", value: "copy" }]}
      onSelect={() => {
        props.onCopy(copyableMessageText(props.message));
        props.onClose();
      }}
      onClose={props.onClose}
    />
  );
}
