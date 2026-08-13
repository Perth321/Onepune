import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceTranscriber } from "../src/stt.js";

test("uses the fallback transcriber when Deepgram is not configured", async () => {
  const wav = Buffer.from("wav-data");
  let received;
  const transcribe = createVoiceTranscriber({
    apiKey: "",
    fallback: async (buffer) => {
      received = buffer;
      return "วันเพื่อน";
    },
  });

  assert.equal(await transcribe(wav), "วันเพื่อน");
  assert.equal(received, wav);
});

test("sends WAV audio to Deepgram when its key is configured", async () => {
  let captured;
  const wav = Buffer.from("wav-data");
  const transcribe = createVoiceTranscriber({
    apiKey: "deepgram-test-secret",
    model: "nova-3",
    language: "th",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(
        JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "วันเพื่อน ค้นข่าว" }] }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(await transcribe(wav), "วันเพื่อน ค้นข่าว");
  assert.match(captured.url, /model=nova-3&language=th/u);
  assert.equal(captured.options.headers.Authorization, "Token deepgram-test-secret");
  assert.equal(captured.options.body, wav);
});
