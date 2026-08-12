import { Client, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || "Perth321/Onepune";
const schedulePath = "data/schedules.json";
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const schedules = [];
let saveQueue = Promise.resolve();

if (!token) {
  console.error("DISCORD_BOT_TOKEN is not set");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

function apiHeaders() {
  return {
    Authorization: "Bearer " + githubToken,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Onepune-Bot",
  };
}

async function loadSchedules() {
  if (!githubToken) return;

  const response = await fetch(
    "https://api.github.com/repos/" + repository + "/contents/" + schedulePath + "?ref=main",
    { headers: apiHeaders() },
  );
  if (response.status === 404) return;
  if (!response.ok) throw new Error("Could not load schedules: " + response.status);

  const body = await response.json();
  const encodedContent = body.content.replace(/\s/g, "");
  const parsed = JSON.parse(Buffer.from(encodedContent, "base64").toString("utf8"));
  if (!Array.isArray(parsed)) return;

  schedules.push(
    ...parsed.map((item) => ({
      ...item,
      notifyChannelId: item.notifyChannelId || item.channelId,
    })),
  );
}

async function saveSchedules() {
  if (!githubToken) return;

  saveQueue = saveQueue
    .then(async () => {
      const url = "https://api.github.com/repos/" + repository + "/contents/" + schedulePath;
      const currentResponse = await fetch(url + "?ref=main", { headers: apiHeaders() });
      const current = currentResponse.status === 200 ? await currentResponse.json() : null;
      const payload = {
        message: "chore: update attendance schedule",
        content: Buffer.from(JSON.stringify(schedules, null, 2) + "\n").toString("base64"),
        branch: "main",
      };
      if (current?.sha) payload.sha = current.sha;

      const response = await fetch(url, {
        method: "PUT",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("Could not save schedules: " + response.status);
    })
    .catch((error) => console.error(error.message));

  return saveQueue;
}

function removeSchedule(schedule) {
  const index = schedules.indexOf(schedule);
  if (index !== -1) schedules.splice(index, 1);
}

function textWithoutBotMention(content) {
  if (!client.user) return content.trim();
  const mentionPattern = new RegExp("<@!?" + client.user.id + ">", "g");
  return content.replace(mentionPattern, " ").replace(/\s+/g, " ").trim();
}

function parseTime(hourText, minuteText, unitText) {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  const unit = (unitText || "").toLowerCase();
  const twelveHourUnit = ["ทุ่ม", "โมงเย็น", "โมงค่ำ", "pm", "am"].includes(unit);

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59 || minute < 0) return null;
  if (twelveHourUnit && (hour < 1 || hour > 12)) return null;
  if (!twelveHourUnit && (hour < 0 || hour > 23)) return null;

  if (["ทุ่ม", "โมงเย็น", "โมงค่ำ", "pm"].includes(unit) && hour < 12) hour += 12;
  if (unit === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

function parseScheduleCommand(message) {
  const text = textWithoutBotMention(message.content);
  const match = text.match(
    /^วันเพื่อน\s+(\d{1,2})(?::(\d{2}))?\s*(ทุ่ม|โมงเย็น|โมงค่ำ|โมง|นาฬิกา|am|pm)?(?:\s+<#(\d+)>)?$/iu,
  );
  if (!match) return null;

  const time = parseTime(match[1], match[2], match[3]);
  if (!time) return { error: "เวลาที่ระบุไม่ถูกต้องครับ" };

  const requestedChannelId = match[4];
  const notifyChannel = requestedChannelId
    ? message.guild.channels.cache.get(requestedChannelId)
    : message.channel;

  if (!notifyChannel || !notifyChannel.isTextBased()) {
    return { error: "ช่องแจ้งเตือนนี้ไม่ใช่ช่องข้อความครับ" };
  }

  return { ...time, notifyChannel };
}

function nextTime(hour, minute) {
  const now = new Date();
  const bangkokNow = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  const targetInBangkok = new Date(
    Date.UTC(
      bangkokNow.getUTCFullYear(),
      bangkokNow.getUTCMonth(),
      bangkokNow.getUTCDate(),
      hour,
      minute,
      0,
      0,
    ),
  );

  if (targetInBangkok <= bangkokNow) targetInBangkok.setUTCDate(targetInBangkok.getUTCDate() + 1);
  return new Date(targetInBangkok.getTime() - BANGKOK_OFFSET_MS);
}

function thaiTime(date) {
  return date.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "long",
    timeStyle: "short",
  });
}

function chunks(text) {
  const output = [];
  for (let index = 0; index < text.length; index += 1800) output.push(text.slice(index, index + 1800));
  return output;
}

async function sendChunks(channel, text) {
  for (const part of chunks(text)) await channel.send(part);
}

function memberName(member) {
  return member.displayName || member.user.globalName || member.user.username;
}

async function attendanceReport(guild) {
  await guild.members.fetch();
  const members = [...guild.members.cache.values()].filter((member) => !member.user.bot);
  const present = members.filter((member) => Boolean(member.voice.channelId));
  const absent = members.filter((member) => !member.voice.channelId);
  const names = (list) =>
    list.length ? list.map((member) => "- " + memberName(member)).join("\n") : "- ไม่มี";

  return (
    "**เช็กชื่อวันเพื่อน: " +
    guild.name +
    "**\nสมาชิกทั้งหมด " +
    members.length +
    " คน\nมาแล้ว " +
    present.length +
    " คน\nยังไม่มา " +
    absent.length +
    " คน\n\n**มาแล้ว (อยู่ในห้องเสียง)**\n" +
    names(present) +
    "\n\n**ยังไม่มา**\n" +
    names(absent)
  );
}

async function onMessage(message) {
  if (!message.guild || message.author.bot || !client.user) return;

  const command = parseScheduleCommand(message);
  if (!command) return;
  if (command.error) return message.reply(command.error);

  const target = nextTime(command.hour, command.minute);
  schedules.splice(0, schedules.length, ...schedules.filter((item) => item.guildId !== message.guild.id));
  schedules.push({
    guildId: message.guild.id,
    notifyChannelId: command.notifyChannel.id,
    targetAt: target.toISOString(),
  });
  await saveSchedules();

  return message.reply(
    "รับทราบครับ จะเช็กสมาชิกทั้งเซิร์ฟเวอร์เวลา **" +
      thaiTime(target) +
      "** และแจ้งผลที่ <#" +
      command.notifyChannel.id +
      ">",
  );
}

async function processSchedules() {
  const due = schedules.filter((item) => new Date(item.targetAt).getTime() <= Date.now());
  let changed = false;

  for (const item of due) {
    const guild = client.guilds.cache.get(item.guildId);
    const channelId = item.notifyChannelId || item.channelId;
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;

    try {
      if (!guild || !channel || !channel.isTextBased()) continue;
      await sendChunks(channel, "ถึงเวลาเช็กชื่อวันเพื่อนแล้วครับ\n" + (await attendanceReport(guild)));
    } catch (error) {
      console.error("Attendance report failed:", error.message);
    } finally {
      removeSchedule(item);
      changed = true;
    }
  }

  if (changed) await saveSchedules();
}

client.once("ready", async (readyClient) => {
  console.log("Logged in as " + readyClient.user.tag);
  await loadSchedules().catch((error) => console.error(error.message));
  setInterval(() => processSchedules().catch((error) => console.error(error.message)), 10000);
  await processSchedules();
});

client.on("messageCreate", (message) => onMessage(message).catch((error) => console.error(error.message)));
client.on("error", (error) => console.error("Discord error:", error.message));
client.login(token);
