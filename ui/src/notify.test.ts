// Unit: notification gating + body cleanup. Pure logic, no backend, no spawn.

import { test, expect } from "bun:test";
import { plainText, shouldNotify } from "./notify";

test("shouldNotify: notifies an incoming message for a background conversation", () => {
  expect(shouldNotify({ conversation_id: "19:abc", is_self: false }, "19:other")).toBe(true);
  expect(shouldNotify({ conversation_id: "19:abc" }, null)).toBe(true);
});

test("shouldNotify: never notifies our own messages", () => {
  expect(shouldNotify({ conversation_id: "19:abc", is_self: true }, "19:other")).toBe(false);
  expect(shouldNotify({ conversation_id: "19:abc", is_self: true }, null)).toBe(false);
});

test("shouldNotify: skips the conversation currently open on screen", () => {
  expect(shouldNotify({ conversation_id: "19:abc", is_self: false }, "19:abc")).toBe(false);
});

test("plainText: strips HTML tags and decodes entities", () => {
  expect(plainText("<p>hello</p>")).toBe("hello");
  expect(plainText("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe('a & b <c> "d"');
  expect(plainText("  <div>spaced</div>  ")).toBe("spaced");
});
