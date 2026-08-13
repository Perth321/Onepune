import assert from "node:assert/strict";
import test from "node:test";

import { extractVoiceCommand, pcmToWav } from "../src/voice.js";

test("wraps resampled PCM audio in a valid mono 16 kHz WAV header", () => {
  const pcm = Buffer.alloc(1_920, 7);
  const wav = pcmToWav(pcm);

  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("extracts tolerant onepune wake words and supports wake-only speech", () => {
  assert.equal(extractVoiceCommand("วันเพื่อน ปิดไมค์สมชาย"), "ปิดไมค์สมชาย");
  assert.equal(extractVoiceCommand("เอ่อ วัน เพื่อน"), "");
  assert.equal(extractVoiceCommand("วันนี้เพื่อนผมมา"), null);
  assert.equal(extractVoiceCommand("wan puean search Roblox news"), "search Roblox news");
});
