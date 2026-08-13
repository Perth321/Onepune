import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import prism from "prism-media";
import { parseDirectVoiceAction } from "../src/server-tools.js";
import { createVoiceWakeTracker, extractVoiceCommand, pcmToWav } from "../src/voice.js";

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

test("runs the same two-step wake-command flow as Guard", () => {
  let clock = 1000;
  const tracker = createVoiceWakeTracker({ now: () => clock, timeoutMs: 15_000 });

  assert.deepEqual(tracker.consume("user-1", "เอ่อ วัน เพื่อน"), {
    matched: true,
    followUp: false,
    awaitingCommand: true,
    command: "",
  });
  clock += 2500;
  assert.deepEqual(tracker.consume("user-1", "ค้นข่าว Roblox ล่าสุด"), {
    matched: true,
    followUp: true,
    awaitingCommand: false,
    command: "ค้นข่าว Roblox ล่าสุด",
  });
});

test("expires a wake-only command after 15 seconds", () => {
  let clock = 1000;
  const tracker = createVoiceWakeTracker({ now: () => clock, timeoutMs: 15_000 });
  tracker.consume("user-1", "วันเพื่อน");
  clock += 15_001;
  assert.equal(tracker.consume("user-1", "ปิดไมค์สมชาย").matched, false);
});

test("passes a two-step spoken command into the direct Discord action parser", () => {
  let clock = 1000;
  const tracker = createVoiceWakeTracker({ now: () => clock });
  tracker.consume("admin-1", "วันเพื่อน");
  clock += 2000;
  const wake = tracker.consume("admin-1", "ปิดไมค์ให้ Alex");

  assert.equal(wake.followUp, true);
  assert.deepEqual(parseDirectVoiceAction(wake.command), {
    name: "set_server_mute",
    enabled: true,
    targetText: "Alex",
    verb: "ปิด",
    device: "ไมค์",
  });
});

test("round-trips Discord PCM through the same Opus encoder and decoder used in production", async () => {
  const frameBytes = 960 * 2 * 2;
  const pcm = Buffer.alloc(frameBytes * 5);
  for (let offset = 0; offset < pcm.length; offset += 4) {
    pcm.writeInt16LE(1000, offset);
    pcm.writeInt16LE(1000, offset + 2);
  }
  const encoder = new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 });
  const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
  const decoded = [];
  decoder.on("data", (chunk) => decoded.push(chunk));

  await new Promise((resolve, reject) => {
    decoder.once("end", resolve);
    decoder.once("error", reject);
    Readable.from([pcm]).pipe(encoder).pipe(decoder);
  });

  assert.equal(Buffer.concat(decoded).length, pcm.length);
});
