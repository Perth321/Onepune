import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import prism from "prism-media";

const INPUT_SAMPLE_RATE = 48_000;
const INPUT_CHANNELS = 2;
const INPUT_BYTES_PER_SECOND = INPUT_SAMPLE_RATE * INPUT_CHANNELS * 2;
const OUTPUT_SAMPLE_RATE = 16_000;
const MIN_UTTERANCE_SECONDS = 0.35;
const MAX_UTTERANCE_SECONDS = 5;
const IDLE_FLUSH_MS = 1500;
const WAKE_PENDING_MS = 15_000;
const WATCHDOG_MS = 60_000;
const WATCHDOG_COOLDOWN_MS = 3 * 60_000;
const MAX_QUEUE = 32;
const MAX_CONCURRENT_TRANSCRIPTIONS = 4;
const GUARD_GREETING_PATH = fileURLToPath(new URL("../assets/greeting.mp3", import.meta.url));

const WAKE_TOKEN_RE =
  /(?:วันเพื่อนๆ|วัน\s*เพื่อน|วันเพิ่อน|วันเพื้อน|วันเพือน|one\s*friend|wan\s*puean|wan\s*phuean)/iu;
const WAKE_PREFIX_RE = /^(?:[\s,.;:!?\-]+|อืม|เอ่อ|เออ|อะ|นี่|เฮ้|hey)\s*/iu;

function normalizeThaiSpacing(text) {
  let current = String(text || "").trim();
  let previous;
  do {
    previous = current;
    current = current.replace(/([\u0E00-\u0E7F])\s+(?=[\u0E00-\u0E7F])/gu, "$1");
  } while (current !== previous);
  return current;
}

export function extractVoiceCommand(text) {
  let cleaned = normalizeThaiSpacing(text)
    .replace(/^\[[^\]]{1,60}\]\s*/u, "")
    .replace(/^\([^)]{1,60}\)\s*/u, "")
    .trim();
  for (let index = 0; index < 2; index += 1) cleaned = cleaned.replace(WAKE_PREFIX_RE, "");
  const match = cleaned.match(WAKE_TOKEN_RE);
  if (!match || match.index !== 0) return null;
  return cleaned
    .slice(match[0].length)
    .replace(WAKE_PREFIX_RE, "")
    .replace(/^[\s,.;:!?\-]+/u, "")
    .trim();
}

export function createVoiceWakeTracker({ now = () => Date.now(), timeoutMs = WAKE_PENDING_MS } = {}) {
  const pending = new Map();
  return {
    consume(userId, transcript) {
      const pendingAt = pending.get(userId);
      if (pendingAt && now() - pendingAt < timeoutMs) {
        pending.delete(userId);
        return {
          matched: true,
          followUp: true,
          awaitingCommand: false,
          command: extractVoiceCommand(transcript) ?? normalizeThaiSpacing(transcript),
        };
      }
      pending.delete(userId);
      const command = extractVoiceCommand(transcript);
      if (command === null) {
        return { matched: false, followUp: false, awaitingCommand: false, command: null };
      }
      if (!command) pending.set(userId, now());
      return {
        matched: true,
        followUp: false,
        awaitingCommand: !command,
        command,
      };
    },
  };
}

function downmixAndResample(pcm) {
  const inputFrames = Math.floor(pcm.length / 4);
  const ratio = INPUT_SAMPLE_RATE / OUTPUT_SAMPLE_RATE;
  const outputSamples = Math.floor(inputFrames / ratio);
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourceFrame = Math.floor(index * ratio);
    const offset = sourceFrame * 4;
    const left = pcm.readInt16LE(offset);
    const right = pcm.readInt16LE(offset + 2);
    const mono = Math.max(-32768, Math.min(32767, Math.round((left + right) / 2)));
    output.writeInt16LE(mono, index * 2);
  }
  return output;
}

export function pcmToWav(pcm, sampleRate = OUTPUT_SAMPLE_RATE, channels = 1) {
  const bytesPerSample = 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function generateTone(segments, gain = 0.5) {
  const totalSamples = segments.reduce(
    (sum, segment) => sum + Math.floor((INPUT_SAMPLE_RATE * segment.ms) / 1000),
    0,
  );
  const output = Buffer.alloc(totalSamples * INPUT_CHANNELS * 2);
  let offset = 0;
  for (const segment of segments) {
    const samples = Math.floor((INPUT_SAMPLE_RATE * segment.ms) / 1000);
    const omega = (2 * Math.PI * segment.frequency) / INPUT_SAMPLE_RATE;
    const fade = Math.min(960, Math.floor(samples / 5));
    let phase = 0;
    for (let index = 0; index < samples; index += 1) {
      const envelope = segment.frequency
        ? Math.min(1, index / Math.max(1, fade), (samples - index) / Math.max(1, fade))
        : 0;
      const sample = Math.round(Math.sin(phase) * gain * envelope * 32767);
      output.writeInt16LE(sample, offset);
      output.writeInt16LE(sample, offset + 2);
      offset += 4;
      phase += omega;
    }
  }
  return output;
}

const JOIN_BEEP = generateTone([
  { frequency: 0, ms: 200 },
  { frequency: 880, ms: 280 },
  { frequency: 0, ms: 120 },
  { frequency: 660, ms: 320 },
  { frequency: 0, ms: 100 },
  { frequency: 1100, ms: 380 },
  { frequency: 0, ms: 400 },
]);
const WAKE_BEEP = generateTone([
  { frequency: 1400, ms: 110 },
  { frequency: 0, ms: 70 },
  { frequency: 1700, ms: 130 },
]);
const DONE_BEEP = generateTone([
  { frequency: 880, ms: 200 },
  { frequency: 660, ms: 250 },
]);

function humanMembers(channel) {
  return [...channel.members.values()].filter((member) => !member.user.bot);
}

function bestVoiceChannel(guild) {
  return [...guild.channels.cache.values()]
    .filter(
      (channel) =>
        [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type) &&
        humanMembers(channel).length,
    )
    .sort((a, b) => humanMembers(b).length - humanMembers(a).length)[0];
}

function responseChannel(guild, voiceChannel) {
  const me = guild.members.me;
  const canWrite = (channel) =>
    channel?.isTextBased() &&
    channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  if (canWrite(guild.systemChannel)) return guild.systemChannel;
  const nearby = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildText && channel.parentId === voiceChannel.parentId)
    .find(canWrite);
  if (nearby) return nearby;
  return [...guild.channels.cache.values()].find(
    (channel) => channel.type === ChannelType.GuildText && canWrite(channel),
  );
}

export function createVoiceController({ client, transcribe, onTranscript, enabled = true }) {
  const subscriptions = new Map();
  const audioBuffers = new Map();
  const wakeTracker = createVoiceWakeTracker();
  const busyGuilds = new Set();
  const syncingGuilds = new Set();
  const errorNoticeAt = new Map();
  const transcriptionPausedUntil = new Map();
  const lastPacketAt = new Map();
  const lastWatchdogRejoin = new Map();
  const announcedConnections = new WeakSet();
  const attachedReceivers = new WeakSet();
  const queue = [];
  let activeTranscriptions = 0;

  async function playBeep(connection, pcm, label) {
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw });
    const subscription = connection.subscribe(player);
    if (!subscription) return;
    player.play(resource);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      timer.unref();
      player.once(AudioPlayerStatus.Idle, () => {
        clearTimeout(timer);
        resolve();
      });
      player.once("error", (error) => {
        console.error(`Voice ${label} failed:`, error.message);
        clearTimeout(timer);
        resolve();
      });
    });
    subscription.unsubscribe();
  }

  async function playGuardGreeting(connection) {
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return false;
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const resource = createAudioResource(GUARD_GREETING_PATH, {
      inputType: StreamType.Arbitrary,
      silencePaddingFrames: 5,
    });
    const subscription = connection.subscribe(player);
    if (!subscription) return false;
    player.play(resource);
    const played = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      timer.unref();
      player.once(AudioPlayerStatus.Idle, () => {
        clearTimeout(timer);
        resolve(resource.playbackDuration >= 100);
      });
      player.once("error", (error) => {
        console.error("Guard greeting failed:", error.message);
        clearTimeout(timer);
        resolve(false);
      });
    });
    subscription.unsubscribe();
    return played;
  }

  async function notifyTranscriptionError(guild, voiceChannel, error) {
    const previous = errorNoticeAt.get(guild.id) || 0;
    if (![401, 402, 403, 429].includes(error.status) || Date.now() - previous < 5 * 60_000) return;
    errorNoticeAt.set(guild.id, Date.now());
    const channel = responseChannel(guild, voiceChannel);
    await channel?.send({
      content:
        error.status === 402
          ? "🎙️ เครดิตสำหรับถอดเสียงไม่พอ จึงพักรับคำสั่งเสียงชั่วคราว"
          : "🎙️ ระบบถอดเสียงใช้งานไม่ได้ชั่วคราว กรุณาตรวจคีย์หรือโควตา",
      allowedMentions: { parse: [] },
    }).catch(() => null);
  }

  async function handleTranscript({ guild, voiceChannel, userId, pcm }) {
    if ((transcriptionPausedUntil.get(guild.id) || 0) > Date.now()) return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) return;
    let text;
    try {
      text = normalizeThaiSpacing(await transcribe(pcmToWav(downmixAndResample(pcm))));
    } catch (error) {
      console.error("Voice transcription failed:", error.message);
      if ([401, 402, 403].includes(error.status)) {
        transcriptionPausedUntil.set(guild.id, Date.now() + 5 * 60_000);
      }
      await notifyTranscriptionError(guild, voiceChannel, error);
      return;
    }
    if (!text) return;

    const wake = wakeTracker.consume(userId, text);
    if (!wake.matched) return;

    const connection = getVoiceConnection(guild.id);
    if (!wake.followUp) await playBeep(connection, WAKE_BEEP, "wake beep");
    if (wake.awaitingCommand) return;
    if (busyGuilds.has(guild.id)) return;

    const textChannel = responseChannel(guild, voiceChannel);
    if (!textChannel) return;
    busyGuilds.add(guild.id);
    try {
      await onTranscript({
        guild,
        member,
        text: "วันเพื่อน " + wake.command,
        rawTranscript: text,
        textChannel,
        voiceChannel,
      });
    } finally {
      await playBeep(getVoiceConnection(guild.id), DONE_BEEP, "done beep");
      busyGuilds.delete(guild.id);
    }
  }

  function pumpQueue() {
    while (activeTranscriptions < MAX_CONCURRENT_TRANSCRIPTIONS && queue.length) {
      const job = queue.shift();
      activeTranscriptions += 1;
      handleTranscript(job)
        .catch((error) => console.error("Voice command failed:", error.message))
        .finally(() => {
          activeTranscriptions -= 1;
          setImmediate(pumpQueue);
        });
    }
  }

  function enqueue(job) {
    if (queue.length >= MAX_QUEUE) {
      console.warn("Voice transcription queue full; dropping utterance from", job.userId);
      return;
    }
    queue.push(job);
    pumpQueue();
  }

  function flushUserAudio(guild, voiceChannel, userId, reason) {
    const key = guild.id + ":" + userId;
    const buffer = audioBuffers.get(key);
    if (!buffer?.chunks.length) return;
    const pcm = Buffer.concat(buffer.chunks, buffer.totalBytes);
    buffer.chunks = [];
    buffer.totalBytes = 0;
    const durationSeconds = pcm.length / INPUT_BYTES_PER_SECOND;
    if (durationSeconds < MIN_UTTERANCE_SECONDS) return;
    enqueue({ guild, voiceChannel, userId, pcm, reason });
  }

  function appendPcm(guild, voiceChannel, userId, chunk) {
    const key = guild.id + ":" + userId;
    const buffer = audioBuffers.get(key) || { chunks: [], totalBytes: 0, lastAppendAt: 0 };
    buffer.chunks.push(chunk);
    buffer.totalBytes += chunk.length;
    buffer.lastAppendAt = Date.now();
    buffer.guild = guild;
    buffer.voiceChannel = voiceChannel;
    buffer.userId = userId;
    audioBuffers.set(key, buffer);
    lastPacketAt.set(guild.id, Date.now());
    if (buffer.totalBytes >= INPUT_BYTES_PER_SECOND * MAX_UTTERANCE_SECONDS) {
      flushUserAudio(guild, voiceChannel, userId, "max-length");
    }
  }

  function subscribeUser(connection, guild, voiceChannel, userId) {
    const key = guild.id + ":" + userId;
    if (subscriptions.has(key) || guild.members.cache.get(userId)?.user.bot) return;
    try {
      const stream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      });
      const decoder = new prism.opus.Decoder({
        rate: INPUT_SAMPLE_RATE,
        channels: INPUT_CHANNELS,
        frameSize: 960,
      });
      stream.pipe(decoder);
      subscriptions.set(key, { stream, decoder });
      decoder.on("data", (chunk) => appendPcm(guild, voiceChannel, userId, chunk));
      const cleanup = () => {
        subscriptions.delete(key);
        audioBuffers.delete(key);
      };
      stream.once("error", cleanup);
      stream.once("close", cleanup);
      decoder.once("error", (error) => {
        console.error("Voice decoder failed:", error.message);
        cleanup();
      });
    } catch (error) {
      console.error("Voice subscription failed:", error.message);
    }
  }

  function clearGuildAudio(guildId) {
    for (const [key, subscription] of subscriptions) {
      if (!key.startsWith(guildId + ":")) continue;
      subscription.stream.destroy();
      subscription.decoder.destroy();
      subscriptions.delete(key);
    }
    for (const key of audioBuffers.keys()) {
      if (key.startsWith(guildId + ":")) audioBuffers.delete(key);
    }
  }

  function attachReceiver(connection, guild, voiceChannel) {
    if (attachedReceivers.has(connection.receiver)) return;
    attachedReceivers.add(connection.receiver);
    connection.receiver.speaking.on("start", (userId) =>
      subscribeUser(connection, guild, voiceChannel, userId),
    );
    connection.receiver.speaking.on("end", (userId) =>
      flushUserAudio(guild, voiceChannel, userId, "speaking-end"),
    );
    for (const member of humanMembers(voiceChannel)) {
      subscribeUser(connection, guild, voiceChannel, member.id);
    }
  }

  async function connect(guild, voiceChannel) {
    clearGuildAudio(guild.id);
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on("error", (error) => console.error("Voice connection failed:", error.message));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        connection.destroy();
        clearGuildAudio(guild.id);
      }
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
      attachReceiver(connection, guild, voiceChannel);
      lastPacketAt.set(guild.id, Date.now());
      if (!announcedConnections.has(connection)) {
        announcedConnections.add(connection);
        const greeted = await playGuardGreeting(connection).catch(() => false);
        if (!greeted) await playBeep(connection, JOIN_BEEP, "join beep");
        await responseChannel(guild, voiceChannel)?.send({
          content:
            `🎙️ เข้าห้อง **${voiceChannel.name}** แล้ว พูด **วันเพื่อน** แล้วตามด้วยคำสั่ง ` +
            "หรือพูด “วันเพื่อน” ก่อน แล้วพูดคำสั่งภายใน 15 วินาทีได้ " +
            "(ช่วงเสียงจะถูกส่งไป OpenRouter เพื่อถอดเสียง)",
          allowedMentions: { parse: [] },
        }).catch(() => null);
      }
    } catch (error) {
      console.error("Could not join voice in " + guild.name + ":", error.message);
      connection.destroy();
    }
  }

  async function syncGuild(guild) {
    if (!enabled || !guild?.available || syncingGuilds.has(guild.id)) return;
    syncingGuilds.add(guild.id);
    try {
      const target = bestVoiceChannel(guild);
      const existing = getVoiceConnection(guild.id);
      if (!target) {
        if (existing) existing.destroy();
        clearGuildAudio(guild.id);
        return;
      }

      const currentChannelId = existing?.joinConfig.channelId;
      if (!existing || currentChannelId !== target.id) {
        if (existing) existing.destroy();
        await connect(guild, target);
        return;
      }
      attachReceiver(existing, guild, target);
      const lastAudio = lastPacketAt.get(guild.id) || Date.now();
      const lastRejoin = lastWatchdogRejoin.get(guild.id) || 0;
      if (Date.now() - lastAudio > WATCHDOG_MS && Date.now() - lastRejoin > WATCHDOG_COOLDOWN_MS) {
        lastWatchdogRejoin.set(guild.id, Date.now());
        existing.destroy();
        await connect(guild, target);
      }
    } finally {
      syncingGuilds.delete(guild.id);
    }
  }

  const idleFlushTimer = setInterval(() => {
    const now = Date.now();
    for (const buffer of audioBuffers.values()) {
      if (buffer.totalBytes && now - buffer.lastAppendAt > IDLE_FLUSH_MS) {
        flushUserAudio(buffer.guild, buffer.voiceChannel, buffer.userId, "idle");
      }
    }
  }, 1000);
  idleFlushTimer.unref();

  const syncTimer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      void syncGuild(guild).catch((error) => console.error("Voice sync failed:", error.message));
    }
  }, 5000);
  syncTimer.unref();

  function destroy() {
    clearInterval(idleFlushTimer);
    clearInterval(syncTimer);
    for (const guild of client.guilds.cache.values()) {
      getVoiceConnection(guild.id)?.destroy();
      clearGuildAudio(guild.id);
    }
  }

  return { destroy, syncGuild };
}
