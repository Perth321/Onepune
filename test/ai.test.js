import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenRouterClient,
  detectTranslationDirection,
  isAssistantInvocation,
  removeAssistantInvocation,
} from "../src/ai.js";

test("detects Thai and English translation directions", () => {
  assert.equal(detectTranslationDirection("สวัสดี วันนี้เป็นอย่างไร"), "th-to-en");
  assert.equal(detectTranslationDirection("Hello, how are you?"), "en-to-th");
  assert.equal(detectTranslationDirection("123 🎉"), null);
});

test("recognizes flexible assistant invocations", () => {
  assert.equal(isAssistantInvocation("วันเพื่อน ช่วยคิดหน่อย", "123"), true);
  assert.equal(isAssistantInvocation("วัน เพื่อน ตอบที", "123"), true);
  assert.equal(isAssistantInvocation("สวัสดี <@123>", "123"), true);
  assert.equal(isAssistantInvocation("คุยกันเฉย ๆ", "123"), false);
});

test("removes the invocation before sending a chat prompt", () => {
  assert.equal(removeAssistantInvocation("<@!123> วันเพื่อน วันนี้กินอะไรดี", "123"), "วันนี้กินอะไรดี");
});

test("sends translation requests without exposing the key in the body", async () => {
  let captured;
  const client = createOpenRouterClient({
    apiKey: "test-secret",
    model: "test/model",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(await client.translate("สวัสดี", "th-to-en"), "Hello");
  assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret");
  assert.equal(captured.options.body.includes("test-secret"), false);
});
