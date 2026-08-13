import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import prism from "prism-media";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const MAX_AUDIO_SECONDS = 15;
const MAX_PCM_BYTES = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * MAX_AUDIO_SECONDS;
const MIN_PCM_BYTES = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 0.25;

export function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function humanMembers(channel) {
  return [...channel.members.values()].filter((member) => !member.user.bot);
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
  const attachedConnections = new WeakSet();
  const recordingUsers = new Set();
  const leavingTimers = new Map();
  const syncingGuilds = new Set();
  const errorNoticeAt = new Map();
  let transcriptionsInFlight = 0;

  async function processRecording(guild, voiceChannel, userId, pcm) {
    if (pcm.length < MIN_PCM_BYTES || transcriptionsInFlight >= 2) return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) return;

    transcriptionsInFlight += 1;
    try {
      const text = await transcribe(pcmToWav(pcm));
      const textChannel = responseChannel(guild, voiceChannel);
      if (text && textChannel) await onTranscript({ guild, member, text, textChannel, voiceChannel });
    } catch (error) {
      console.error("Voice transcription failed:", error.message);
      const channel = responseChannel(guild, voiceChannel);
      const previousNotice = errorNoticeAt.get(guild.id) || 0;
      if (
        channel &&
        [401, 402, 403, 429].includes(error.status) &&
        Date.now() - previousNotice >= 5 * 60 * 1000
      ) {
        errorNoticeAt.set(guild.id, Date.now());
        await channel.send({
          content:
            error.status === 402
              ? "🎙️ เครดิต OpenRouter สำหรับถอดเสียงไม่พอ จึงพักรับคำสั่งเสียงชั่วคราว"
              : "🎙️ ระบบถอดเสียง OpenRouter ใช้งานไม่ได้ชั่วคราว กรุณาตรวจคีย์หรือโควตา",
          allowedMentions: { parse: [] },
        }).catch(() => null);
      }
    } finally {
      transcriptionsInFlight -= 1;
    }
  }

  function recordUser(connection, guild, voiceChannel, userId) {
    const recordingKey = guild.id + ":" + userId;
    if (recordingUsers.has(recordingKey)) return;
    recordingUsers.add(recordingKey);

    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
    const chunks = [];
    let bytes = 0;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      recordingUsers.delete(recordingKey);
      const pcm = Buffer.concat(chunks, Math.min(bytes, MAX_PCM_BYTES)).subarray(0, MAX_PCM_BYTES);
      void processRecording(guild, voiceChannel, userId, pcm);
    };
    const timer = setTimeout(() => {
      opusStream.destroy();
      decoder.end();
      finish();
    }, (MAX_AUDIO_SECONDS + 1) * 1000);
    timer.unref();

    decoder.on("data", (chunk) => {
      if (bytes >= MAX_PCM_BYTES) return;
      const remaining = MAX_PCM_BYTES - bytes;
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      bytes += kept.length;
    });
    decoder.once("end", finish);
    decoder.once("close", finish);
    decoder.once("error", (error) => {
      console.error("Voice decoder failed:", error.message);
      finish();
    });
    opusStream.once("error", (error) => {
      console.error("Voice receive failed:", error.message);
      finish();
    });
    opusStream.once("close", () => clearTimeout(timer));
    opusStream.pipe(decoder);
  }

  async function connect(guild, voiceChannel) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    if (!attachedConnections.has(connection)) {
      attachedConnections.add(connection);
      connection.receiver.speaking.on("start", (userId) =>
        recordUser(connection, guild, voiceChannel, userId),
      );
    }
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      const channel = responseChannel(guild, voiceChannel);
      await channel?.send({
        content:
          `🎙️ เข้าห้อง **${voiceChannel.name}** แล้ว พูดขึ้นต้นด้วย **วันเพื่อน** เพื่อสั่งงาน ` +
          "(คลิปคำพูดสั้น ๆ จะถูกส่งไป OpenRouter เพื่อถอดเสียง)",
        allowedMentions: { parse: [] },
      }).catch(() => null);
    } catch (error) {
      console.error("Could not join voice in " + guild.name + ":", error.message);
      connection.destroy();
    }
  }

  async function syncGuild(guild) {
    if (!enabled || !guild?.available) return;
    if (syncingGuilds.has(guild.id)) return;
    syncingGuilds.add(guild.id);
    try {
      const existing = getVoiceConnection(guild.id);
      const currentChannel = existing
        ? guild.channels.cache.get(existing.joinConfig.channelId)
        : null;
      if (currentChannel && humanMembers(currentChannel).length) {
        clearTimeout(leavingTimers.get(guild.id));
        leavingTimers.delete(guild.id);
        return;
      }

      const target = [...guild.channels.cache.values()]
        .filter((channel) => channel.type === ChannelType.GuildVoice && humanMembers(channel).length)
        .sort((a, b) => humanMembers(b).length - humanMembers(a).length)[0];
      if (target) {
        clearTimeout(leavingTimers.get(guild.id));
        leavingTimers.delete(guild.id);
        if (existing) existing.destroy();
        await connect(guild, target);
        return;
      }

      if (existing && !leavingTimers.has(guild.id)) {
        const timer = setTimeout(() => {
          getVoiceConnection(guild.id)?.destroy();
          leavingTimers.delete(guild.id);
        }, 30_000);
        timer.unref();
        leavingTimers.set(guild.id, timer);
      }
    } finally {
      syncingGuilds.delete(guild.id);
    }
  }

  function destroy() {
    for (const guild of client.guilds.cache.values()) getVoiceConnection(guild.id)?.destroy();
    for (const timer of leavingTimers.values()) clearTimeout(timer);
    leavingTimers.clear();
  }

  return { destroy, syncGuild };
}
