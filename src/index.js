import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  createOpenRouterClient,
  detectTranslationDirection,
  isAssistantInvocation,
  removeAssistantInvocation,
} from "./ai.js";

const token = process.env.DISCORD_BOT_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || "Perth321/Onepune";
const schedulePath = "data/schedules.json";
const autoTranslateEnabled = process.env.AUTO_TRANSLATE_ENABLED !== "false";
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const schedules = [];
const ai = createOpenRouterClient();
const conversationHistory = new Map();
const aiCooldowns = new Map();
let saveQueue = Promise.resolve();
const AI_COOLDOWN_MS = 5000;
const MAX_HISTORY_MESSAGES = 8;
const onepuneCommand = new SlashCommandBuilder()
  .setName("onepune")
  .setDescription("เปิดแผงควบคุมเช็กชื่อวันเพื่อน")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());
const onepuneCommandData = onepuneCommand.toJSON();

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

function parseTimeInput(text) {
  const match = text.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(ทุ่ม|โมงเย็น|โมงค่ำ|โมง|นาฬิกา|am|pm)?$/iu,
  );
  if (!match) return null;
  return parseTime(match[1], match[2], match[3]);
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

function scheduleForGuild(guildId) {
  return schedules.find((item) => item.guildId === guildId);
}

function scheduleSummary(guildId) {
  const schedule = scheduleForGuild(guildId);
  if (!schedule) return "ยังไม่มีนัดหมายสำหรับเซิร์ฟเวอร์นี้";

  return (
    "นัดหมายถัดไป: **" +
    thaiTime(new Date(schedule.targetAt)) +
    "**\nช่องแจ้งผล: <#" +
    (schedule.notifyChannelId || schedule.channelId) +
    ">"
  );
}

function panelEmbed(guild) {
  return new EmbedBuilder()
    .setColor(0x6d5dfc)
    .setTitle("Onepune")
    .setDescription(
      "แผงควบคุมเช็กชื่อสมาชิกในห้องเสียงของ **" +
        guild.name +
        "**\n\n" +
        scheduleSummary(guild.id) +
        "\n\nเลือกการทำงานจากปุ่มด้านล่างได้เลย",
    )
    .setFooter({ text: "เลือกช่องใหม่ได้จากรายการล่าสุดของเซิร์ฟเวอร์ทุกครั้ง" });
}

function panelButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("onepune:set:" + userId)
      .setLabel("ตั้งเวลา")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("onepune:status:" + userId)
      .setLabel("ดูสถานะ")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("onepune:cancel:" + userId)
      .setLabel("ยกเลิกนัดหมาย")
      .setStyle(ButtonStyle.Danger),
  );
}

async function registerCommandForGuild(guild) {
  try {
    const existingCommands = await guild.commands.fetch();
    const existing = existingCommands.find((command) => command.name === "onepune");

    if (existing) {
      await guild.commands.edit(existing.id, onepuneCommandData);
    } else {
      await guild.commands.create(onepuneCommandData);
    }
  } catch (error) {
    console.error("Could not register /onepune in " + guild.name + ":", error.message);
  }
}

async function showPanel(interaction) {
  await interaction.reply({
    embeds: [panelEmbed(interaction.guild)],
    components: [panelButtons(interaction.user.id)],
    ephemeral: true,
  });
}

async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === "onepune") {
    return showPanel(interaction);
  }

  if (!interaction.guild) return;

  if (interaction.isButton()) {
    const [prefix, action, userId] = interaction.customId.split(":");
    if (prefix !== "onepune") return;

    if (userId !== interaction.user.id) {
      return interaction.reply({
        content: "แผงนี้เปิดโดยผู้ใช้อื่น ให้พิมพ์ `/onepune` เพื่อเปิดแผงของคุณเองครับ",
        ephemeral: true,
      });
    }

    if (action === "set") {
      const modal = new ModalBuilder()
        .setCustomId("onepune:time:" + interaction.user.id)
        .setTitle("ตั้งเวลาเช็กชื่อ");
      const timeInput = new TextInputBuilder()
        .setCustomId("time")
        .setLabel("เวลาไทย เช่น 22:30 หรือ 4 ทุ่ม")
        .setPlaceholder("22:30")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(20);

      modal.addComponents(new ActionRowBuilder().addComponents(timeInput));
      return interaction.showModal(modal);
    }

    if (action === "status") {
      return interaction.reply({ content: scheduleSummary(interaction.guild.id), ephemeral: true });
    }

    if (action === "cancel") {
      const current = scheduleForGuild(interaction.guild.id);
      if (!current) {
        return interaction.reply({ content: "เซิร์ฟเวอร์นี้ยังไม่มีนัดหมายครับ", ephemeral: true });
      }

      removeSchedule(current);
      await saveSchedules();
      return interaction.reply({ content: "ยกเลิกนัดหมายของเซิร์ฟเวอร์นี้แล้วครับ", ephemeral: true });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("onepune:time:")) {
    const userId = interaction.customId.split(":")[2];
    if (userId !== interaction.user.id) return;

    const timeText = interaction.fields.getTextInputValue("time").trim();
    const time = parseTimeInput(timeText);
    if (!time) {
      return interaction.reply({
        content: "เวลายังไม่ถูกต้องครับ ลองใช้รูปแบบ `22:30` หรือ `4 ทุ่ม`",
        ephemeral: true,
      });
    }

    await interaction.guild.channels.fetch().catch(() => null);
    const channelMenu = new ChannelSelectMenuBuilder()
      .setCustomId("onepune:channel:" + userId + ":" + time.hour + ":" + time.minute)
      .setPlaceholder("เลือกช่องแจ้งผล")
      .setMinValues(1)
      .setMaxValues(1)
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    return interaction.reply({
      content:
        "เวลา **" +
        String(time.hour).padStart(2, "0") +
        ":" +
        String(time.minute).padStart(2, "0") +
        " น.**\nเลือกช่องแจ้งผลจากรายการด้านล่างได้เลยครับ รายการนี้จะใช้ช่องล่าสุดของเซิร์ฟเวอร์",
      components: [new ActionRowBuilder().addComponents(channelMenu)],
      ephemeral: true,
    });
  }

  if (interaction.isChannelSelectMenu() && interaction.customId.startsWith("onepune:channel:")) {
    const [, , userId, hourText, minuteText] = interaction.customId.split(":");
    if (userId !== interaction.user.id) {
      return interaction.reply({ content: "เมนูนี้เปิดโดยผู้ใช้อื่นครับ", ephemeral: true });
    }

    const notifyChannel = interaction.guild.channels.cache.get(interaction.values[0]);
    if (!notifyChannel || !notifyChannel.isTextBased()) {
      return interaction.reply({ content: "ช่องนี้ไม่ใช่ช่องข้อความที่ใช้ส่งรายงานได้ครับ", ephemeral: true });
    }

    const target = nextTime(Number(hourText), Number(minuteText));
    const current = scheduleForGuild(interaction.guild.id);
    if (current) removeSchedule(current);
    schedules.push({
      guildId: interaction.guild.id,
      notifyChannelId: notifyChannel.id,
      targetAt: target.toISOString(),
    });
    await saveSchedules();

    return interaction.update({
      content:
        "ตั้งนัดหมายเรียบร้อยครับ\nเช็กชื่อเวลา **" +
        thaiTime(target) +
        "** และส่งผลที่ <#" +
        notifyChannel.id +
        ">",
      components: [],
    });
  }
}

function chunks(text) {
  const output = [];
  for (let index = 0; index < text.length; index += 1800) output.push(text.slice(index, index + 1800));
  return output;
}

async function sendChunks(channel, text) {
  for (const part of chunks(text)) {
    await channel.send({ content: part, allowedMentions: { parse: [] } });
  }
}

function aiConversationKey(message) {
  return [message.guild.id, message.channel.id, message.author.id].join(":");
}

function isAiCoolingDown(userId) {
  const now = Date.now();
  const previous = aiCooldowns.get(userId) || 0;
  if (now - previous < AI_COOLDOWN_MS) return true;
  aiCooldowns.set(userId, now);
  return false;
}

async function replyWithAi(message, task) {
  if (!process.env.OPENROUTER_API_KEY) {
    return message.reply({
      content: "ระบบแปลและสนทนายังไม่ได้ตั้งค่า OPENROUTER_API_KEY ครับ",
      allowedMentions: { repliedUser: false },
    });
  }
  if (isAiCoolingDown(message.author.id)) return;

  await message.channel.sendTyping().catch(() => null);
  try {
    const response = await task();
    for (const part of chunks(response)) {
      await message.reply({
        content: part,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
  } catch (error) {
    console.error("AI request failed:", error.message);
    await message.reply({
      content: "ตอนนี้ระบบแปล/สนทนาตอบไม่สำเร็จครับ ลองใหม่อีกครั้งในอีกสักครู่",
      allowedMentions: { repliedUser: false },
    });
  }
}

async function handleAssistantChat(message) {
  const key = aiConversationKey(message);
  const history = conversationHistory.get(key) || [];
  const prompt =
    removeAssistantInvocation(message.content, client.user?.id) ||
    "ทักทายฉันและถามว่ามีอะไรให้ช่วย";

  await replyWithAi(message, async () => {
    const response = await ai.chat(history, prompt);
    conversationHistory.set(
      key,
      [...history, { role: "user", content: prompt }, { role: "assistant", content: response }].slice(
        -MAX_HISTORY_MESSAGES,
      ),
    );
    return response;
  });
}

async function handleAutomaticTranslation(message) {
  if (!autoTranslateEnabled) return;
  if (message.content.trimStart().startsWith("/")) return;
  if (message.content.length > 1800) return;
  if (/^(https?:\/\/\S+|<a?:\w+:\d+>)$/u.test(message.content.trim())) return;

  const direction = detectTranslationDirection(message.content);
  if (!direction) return;
  await replyWithAi(message, () => ai.translate(message.content, direction));
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
  if (command) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return message.reply("คำสั่งตั้งนัดหมายต้องมีสิทธิ์ Manage Server ครับ");
    }
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

  if (isAssistantInvocation(message.content, client.user.id)) {
    return handleAssistantChat(message);
  }

  return handleAutomaticTranslation(message);
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
  for (const guild of readyClient.guilds.cache.values()) {
    await registerCommandForGuild(guild);
  }
  await loadSchedules().catch((error) => console.error(error.message));
  setInterval(() => processSchedules().catch((error) => console.error(error.message)), 10000);
  await processSchedules();
});

client.on("guildCreate", (guild) => registerCommandForGuild(guild));
client.on("interactionCreate", (interaction) =>
  handleInteraction(interaction).catch((error) => console.error("Interaction failed:", error.message)),
);
client.on("messageCreate", (message) => onMessage(message).catch((error) => console.error(error.message)));
client.on("error", (error) => console.error("Discord error:", error.message));
client.login(token);
