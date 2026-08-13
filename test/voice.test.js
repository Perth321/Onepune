import assert from "node:assert/strict";
import test from "node:test";

import { pcmToWav } from "../src/voice.js";

test("wraps Discord PCM audio in a valid stereo 48 kHz WAV header", () => {
  const pcm = Buffer.alloc(1_920, 7);
  const wav = pcmToWav(pcm);

  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});
