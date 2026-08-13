import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceTranscriber } from "../src/stt.js";

const wav = Buffer.from("wav-data");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("stays silent when neither transcription provider is configured", async () => {
  let requested = false;
  const transcribe = createVoiceTranscriber({
    apiKey: "",
    geminiApiKey: "",
    fetchImpl: async () => {
      requested = true;
      throw new Error("should not be called");
    },
  });

  assert.equal(await transcribe(wav), "");
  assert.equal(transcribe.available, false);
  assert.equal(transcribe.engine, "none");
  assert.deepEqual(transcribe.engines, []);
  assert.equal(requested, false);
});

test("uses Deepgram first and returns without calling Gemini on success", async () => {
  const requests = [];
  const transcribe = createVoiceTranscriber({
    apiKey: "deepgram-test-secret",
    model: "nova-3",
    language: "th",
    geminiApiKey: "gemini-test-secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        results: { channels: [{ alternatives: [{ transcript: "วันเพื่อน ค้นข่าว" }] }] },
      });
    },
  });

  assert.equal(await transcribe(wav), "วันเพื่อน ค้นข่าว");
  assert.equal(transcribe.available, true);
  assert.equal(transcribe.engine, "deepgram");
  assert.deepEqual(transcribe.engines, ["deepgram", "gemini"]);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /model=nova-3&language=th/u);
  assert.equal(requests[0].options.headers.Authorization, "Token deepgram-test-secret");
  assert.equal(requests[0].options.body, wav);
});

test("falls back to Gemini when Deepgram returns 402", async () => {
  const requests = [];
  const transcribe = createVoiceTranscriber({
    apiKey: "deepgram-test-secret",
    geminiApiKey: "gemini-test-secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.startsWith("https://api.deepgram.com/")) {
        return jsonResponse({ error: "insufficient credits" }, 402);
      }
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "วันเพื่อน " }, { text: "เปิดไมค์" }] } }],
      });
    },
  });

  assert.equal(await transcribe(wav), "วันเพื่อน เปิดไมค์");
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /gemini-2\.5-flash:generateContent$/u);
  assert.equal(requests[1].options.headers["x-goog-api-key"], "gemini-test-secret");
});

test("supports Gemini as the only configured transcription provider", async () => {
  let captured;
  const transcribe = createVoiceTranscriber({
    apiKey: "",
    geminiApiKey: "gemini-test-secret",
    geminiModel: "gemini-2.5-flash",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "วันเพื่อน ปิดไมค์" }] } }],
      });
    },
  });

  assert.equal(await transcribe(wav), "วันเพื่อน ปิดไมค์");
  assert.equal(transcribe.available, true);
  assert.equal(transcribe.engine, "gemini");
  assert.deepEqual(transcribe.engines, ["gemini"]);
  assert.match(captured.url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/u);
  const payload = JSON.parse(captured.options.body);
  assert.match(payload.contents[0].parts[0].text, /Return only the transcript/u);
  assert.deepEqual(payload.contents[0].parts[1], {
    inlineData: {
      mimeType: "audio/wav",
      data: wav.toString("base64"),
    },
  });
  assert.equal(captured.options.headers["x-goog-api-key"], "gemini-test-secret");
});

test("reports failure after both Deepgram and Gemini fail", async () => {
  const requests = [];
  const transcribe = createVoiceTranscriber({
    apiKey: "deepgram-test-secret",
    geminiApiKey: "gemini-test-secret",
    fetchImpl: async (url) => {
      requests.push(url);
      return url.startsWith("https://api.deepgram.com/")
        ? jsonResponse({ error: "insufficient credits" }, 402)
        : jsonResponse({ error: "service unavailable" }, 503);
    },
  });

  await assert.rejects(transcribe(wav), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.message, "All voice transcription providers failed");
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].status, 402);
    assert.equal(error.errors[1].status, 503);
    assert.equal(error.status, 503);
    assert.equal(error.provider, "Gemini");
    return true;
  });
  assert.equal(requests.length, 2);
});
