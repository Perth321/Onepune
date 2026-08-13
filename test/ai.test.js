import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanAssistantReply,
  createOpenRouterClient,
  detectTranslationDirection,
  isAssistantInvocation,
  openRouterWebSearchTool,
  removeAssistantInvocation,
} from "../src/ai.js";

test("cleans filler and leaked style instructions from chat replies", () => {
  assert.equal(
    cleanAssistantReply("อืม... ลีลี่ไปทำอะไรมาอีกล่ะ 555 antiated: แค่ humorous? ชัดเจน!"),
    "ลีลี่ไปทำอะไรมาอีกล่ะ 555",
  );
  assert.equal(cleanAssistantReply("<reply>เอ้า เล่ามาก่อนดิ 555</reply>"), "เอ้า เล่ามาก่อนดิ 555");
});

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
        JSON.stringify({ choices: [{ message: { content: '{"translation":"Hello"}' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(await client.translate("สวัสดี", "th-to-en"), "Hello");
  assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret");
  assert.equal(captured.options.body.includes("test-secret"), false);
  const requestBody = JSON.parse(captured.options.body);
  assert.equal(requestBody.response_format.type, "json_schema");
  assert.equal(requestBody.provider.require_parameters, true);
  assert.match(requestBody.messages[0].content, /never a question for you to answer/u);
});

test("falls back to tagged translation when structured output has no provider", async () => {
  let calls = 0;
  const client = createOpenRouterClient({
    apiKey: "test-secret",
    model: "openrouter/free",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "<translation>เล่น Roblox แมพอะไรดี</translation>" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(await client.translate("Which Roblox map should we play?", "en-to-th"), "เล่น Roblox แมพอะไรดี");
  assert.equal(calls, 2);
});

test("sends explicit free-model fallbacks when using the free router", async () => {
  let captured;
  const client = createOpenRouterClient({
    apiKey: "test-secret",
    model: "openrouter/free",
    fallbackModels: ["free/model-a", "free/model-b"],
    fetchImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "<reply>โอเค</reply>" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(await client.chat([], "ว่าไง"), "โอเค");
  assert.deepEqual(captured.models, ["free/model-a", "free/model-b"]);
});

test("runs a server tool and returns the final agent response", async () => {
  const requests = [];
  let calls = 0;
  const client = createOpenRouterClient({
    apiKey: "test-secret",
    model: "test/model",
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      calls += 1;
      const message = calls === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_server_overview", arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: "เซิร์ฟนี้มี 42 คน จัดว่าแน่นเหมือนรถตู้ตอนเลิกงาน 😆" };
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  let executed;
  const response = await client.chat([], "เซิร์ฟนี้มีกี่คน", {
    tools: [{ type: "function", function: { name: "get_server_overview", parameters: { type: "object" } } }],
    executeTool: async (name, args) => {
      executed = { name, args };
      return { ok: true, members: 42 };
    },
  });

  assert.equal(executed.name, "get_server_overview");
  assert.deepEqual(executed.args, {});
  assert.match(response, /42/u);
  assert.equal(requests[0].parallel_tool_calls, false);
  assert.equal(requests[1].messages.at(-1).role, "tool");
});

test("passes OpenRouter web search server tool and appends URL citations", async () => {
  let requestBody;
  const client = createOpenRouterClient({
    apiKey: "test-secret",
    model: "test/model",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: "เจอข้อมูลล่าสุดแล้ว",
              annotations: [{
                type: "url_citation",
                url_citation: { url: "https://example.com/news", title: "Example News" },
              }],
            },
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const response = await client.chat([], "ค้นข่าวล่าสุด", { tools: [openRouterWebSearchTool] });
  assert.equal(requestBody.tools[0].type, "openrouter:web_search");
  assert.match(response, /\[Example News\]\(https:\/\/example\.com\/news\)/u);
});
