// Tests for turn content from the session transcript (transcript.js): which
// reply belongs to the turn, and what the user got through the message tool.

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractContent } from "./transcript.js";

const user = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const said = (text) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const call = (id, name, args) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const result = (id, text, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, toolName: "message", content: [{ type: "text", text }], isError },
});

const PREVIOUS = [user("show me the board"), said("📋 Board: 3 in progress")];

test("a reply from the previous turn is never this turn's", () => {
  const c = extractContent([...PREVIOUS, user("make the deck longer"), call("t1", "exec", { command: "ls" })]);
  assert.equal(c.input, "make the deck longer");
  assert.equal(c.output, undefined);
  assert.equal(c.sessionInput, "show me the board");
});

test("the plain reply of the turn", () => {
  const c = extractContent([...PREVIOUS, user("hi"), said("Hey!")]);
  assert.deepEqual([c.input, c.output], ["hi", "Hey!"]);
});

test("a message-tool send is the reply; a silent final adds nothing", () => {
  const c = extractContent([
    ...PREVIOUS,
    user("make the deck longer"),
    call("m1", "message", { action: "send", message: "Here is the 17-slide deck." }),
    result("m1", '{"ok": true, "messageId": "6555"}'),
    said("NO_REPLY"),
  ]);
  assert.equal(c.output, "Here is the 17-slide deck.");
});

test("a final text after the send is delivered too, so it is kept", () => {
  const c = extractContent([
    ...PREVIOUS,
    user("make the deck longer"),
    call("m1", "message", JSON.stringify({ action: "send", message: "Here is the deck." })),
    result("m1", '{"ok": true}'),
    said("This is just context, not a new request. No reply needed."),
  ]);
  assert.equal(c.output, "Here is the deck.\n\nThis is just context, not a new request. No reply needed.");
});

test("a final that repeats the sent text is not counted twice", () => {
  const c = extractContent([
    user("status?"),
    call("m1", "message", { action: "thread-reply", text: "All green." }),
    result("m1", '{"ok": true}'),
    said("All green."),
  ]);
  assert.equal(c.output, "All green.");
});

test("a failed send is not something the user got", () => {
  const c = extractContent([
    user("write to the other bot"),
    call("m1", "message", { action: "send", message: "hi bot" }),
    result("m1", '{"status": "error", "error": "USER_BOT_TO_BOT_DISABLED"}', true),
    said("I could not reach the other bot."),
  ]);
  assert.equal(c.output, "I could not reach the other bot.");
});

test("message actions that post nothing are not sends", () => {
  const c = extractContent([
    user("read the thread"),
    call("m1", "message", { action: "read", message: "ignored" }),
    result("m1", "[]"),
    said("Nothing new in the thread."),
  ]);
  assert.equal(c.output, "Nothing new in the thread.");
});

test("legacy entries keep the runId scope", () => {
  const events = [
    { type: "model.completed", runId: "r1", data: { finalPromptText: "first", assistantTexts: ["one"] } },
    { type: "model.completed", runId: "r2", data: { finalPromptText: "second", assistantTexts: ["two"] } },
  ];
  assert.deepEqual(extractContent(events, "r1"), { input: "first", output: "one", sessionInput: "first" });
});
