import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { MessageComposer } from "./app";

test("submits the textarea contents on Enter and clears the composer", async () => {
  let submitted = "";
  const [value, setValue] = createSignal("");
  const { renderOnce, captureCharFrame, mockInput } = await testRender(
    () => (
      <MessageComposer
        value={value()}
        focused
        onContentChange={setValue}
        onSubmit={(text) => {
          submitted = text;
          setValue("");
        }}
      />
    ),
    { width: 60, height: 6 },
  );

  await renderOnce();
  await mockInput.typeText("hello world");
  mockInput.pressEnter();
  await renderOnce();

  expect(submitted).toBe("hello world");
  expect(captureCharFrame()).not.toContain("hello world");
});
