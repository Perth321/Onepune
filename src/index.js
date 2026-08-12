import { Client, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || "Perth321/Onepune";
const schedulePath = "data/schedules.json";
const schedules = [];
let saveQueue = Promise.resolve();

if (!token) { console.error("DISCORD_BOT_TOKEN is not set"); process.exit(1); }

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates
] });

function apiHeaders() { return { Authorization: "Bearer " + githubToken, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Onepune-Bot" }; }

async function loadSchedules() {
  if (!githubToken) return;
  const response = await fetch("https://api.github.com/repos/" + repository + "/contents/" + schedulePath + "?ref=main", { headers: apiHeaders() });
  if (response.status === 404) return;
  if (!response.ok) throw new Error("Could not load schedules: " + response.status);
  const body = await response.json();
  const parsed = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
  schedules.push(...(Array.isArray(parsed) ? parsed : []));
}

async function saveSchedules() {
  if (!githubToken) return;
  saveQueue = saveQueue.then(async () => {
    const url = "https://api.github.com/repos/" + repository + "/contents/" + schedulePath;
    const currentResponse = await fetch(url + "?ref=main", { headers: apiHeaders() });
    const current = currentResponse.status === 200 ? await currentResponse.json() : null;
    const payload = { message: "chore: update attendance schedule", content: Buffer.from(JSON.stringify(schedules, null, 2) + "\n").toString("base64"), branch: "main" };
    if (current?.sha) payload.sha = current.sha;
    const response = await fetch(url, { method: "PUT", headers: { ...apiHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error("Could not save schedules: " + response.status);
  }).catch(error => console.error(error.message));
  return saveQueue;
}

function textWithoutMention(content) { return content.replace(new RegExp("<@!?" + client.user.id + ">", "g"), " ").replace(/\s+/g, " ").trim(); }
function parseTime(text) {
  const match = text.match(/(?:ตอน|เวลา|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(ทุ่ม|โมงเย็น|โมงค่ำ|โมง|นาฬิกา|am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]); const minute = Number(match[2] || 0); const unit = (match[3] || "").toLowerCase();
  if (minute > 59) return null;
  if (["ทุ่ม", "โมงเย็น", "โมงค่ำ", "pm"].includes(unit) && hour < 12) hour += 12;
  if (unit === "am" && hour === 12) hour = 0;
  if (hour > 23) return null; return { hour, minute };
}
function nextTime(hour, minute) { const now = new Date(); const target = new Date(now); target.setHours(hour, minute, 0, 0); if (target <= now) target.setDate(target.getDate() + 1); return target; }
function thaiTime(date) { return date.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "long", timeStyle: "short" }); }
function chunks(text) { const out = []; for (let i = 0; i < text.length; i += 1800) out.push(text.slice(i, i + 1800)); return out; }
async function sendChunks(channel, text) { for (const part of chunks(text)) await channel.send(part); }
function nameOf(member) { return member.displayName || member.user.globalName || member.user.username; }

async function report(guild) {
  await guild.members.fetch();
  const members = [...guild.members.cache.values()].filter(member => !member.user.bot);
  const present = members.filter(member => Boolean(member.voice.channelId));
  const absent = members.filter(member => !member.voice.channelId);
  const names = list => list.length ? list.map(member => "- " + nameOf(member)).join("\n") : "- ไม่มี";
  return "**เช็กชื่อวันเพื่อน: " + guild.name + "**\nมาแล้ว " + present.length + "/" + members.length + " คน\n\n**มาแล้ว (อยู่ในห้องเสียง)**\n" + names(present) + "\n\n**ยังไม่มา**\n" + names(absent);
}
function help() { return "**Onepune**\n@Onepune วันนี้วันเพื่อนตอน 4 ทุ่ม = ตั้งเวลา 22:00\n@Onepune วันนี้วันเพื่อนตอน 22:30 = ตั้งเวลา 22:30\n@Onepune เช็กชื่อทันที = เช็กตอนนี้\n@Onepune ยกเลิกเวลา = ยกเลิกนัด\n\nสมาชิกที่อยู่ใน voice channel ตอนถึงเวลาจะถูกนับว่า มาแล้ว"; }

async function onMessage(message) {
  if (!message.guild || message.author.bot || !client.user || !message.mentions.users.has(client.user.id)) return;
  const text = textWithoutMention(message.content); const lower = text.toLowerCase();
  if (/^(ช่วย|help|คำสั่ง)/i.test(text)) return message.reply(help());
  if (/ยกเลิก|cancel|ลบเวลา/i.test(lower)) { const had = schedules.some(item => item.guildId === message.guild.id); schedules.splice(0, schedules.length, ...schedules.filter(item => item.guildId !== message.guild.id)); await saveSchedules(); return message.reply(had ? "ยกเลิกเวลานัดเช็กชื่อแล้วครับ" : "ยังไม่มีเวลาที่ตั้งไว้ครับ"); }
  if (/เช็กชื่อทันที|เช็คชื่อทันที|เช็กชื่อเลย|เช็คชื่อเลย|รายงานตอนนี้/i.test(lower)) { await message.reply("กำลังเช็กสมาชิกครับ..."); return sendChunks(message.channel, await report(message.guild)); }
  const time = parseTime(text);
  if (/วันนี้|วันเพื่อน|นัด|ตั้งเวลา|เช็กชื่อ|เช็คชื่อ/i.test(lower) && time) { const target = nextTime(time.hour, time.minute); schedules.splice(0, schedules.length, ...schedules.filter(item => item.guildId !== message.guild.id)); schedules.push({ guildId: message.guild.id, channelId: message.channel.id, targetAt: target.toISOString() }); await saveSchedules(); return message.reply("รับทราบครับ ตั้งเวลาเช็กชื่อเป็น **" + thaiTime(target) + "** แล้ว"); }
  return message.reply(help());
}

async function processSchedules() {
  const due = schedules.filter(item => new Date(item.targetAt).getTime() <= Date.now());
  for (const item of due) { const guild = client.guilds.cache.get(item.guildId); const channel = guild?.channels.cache.get(item.channelId); schedules.splice(0, schedules.length, ...schedules.filter(value => value !== item)); if (!guild || !channel || !channel.isTextBased()) continue; try { await sendChunks(channel, "ถึงเวลาเช็กชื่อวันเพื่อนแล้วครับ\n" + await report(guild)); } catch (error) { await channel.send("เช็กชื่อไม่สำเร็จ: " + error.message).catch(() => {}); } }
  if (due.length) await saveSchedules();
}

client.once("ready", async readyClient => { console.log("Logged in as " + readyClient.user.tag); await loadSchedules().catch(error => console.error(error.message)); setInterval(() => processSchedules().catch(error => console.error(error.message)), 10000); await processSchedules(); });
client.on("messageCreate", message => onMessage(message).catch(error => console.error(error.message)));
client.on("error", error => console.error("Discord error:", error.message));
client.login(token);