import { ChannelType, PermissionFlagsBits } from "discord.js";

const textChannelTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

function tool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

export const serverTools = [
  tool("get_server_overview", "Get the current Discord server's basic statistics."),
  tool("list_channels", "List channels in the current Discord server."),
  tool("list_roles", "List roles in the current Discord server."),
  tool(
    "find_member",
    "Find up to 10 server members by display name or username.",
    { query: { type: "string", minLength: 1, maxLength: 100 } },
    ["query"],
  ),
  tool(
    "create_text_channel",
    "Queue creation of a text channel. This requires Manage Channels permission and user confirmation.",
    {
      name: { type: "string", minLength: 1, maxLength: 100 },
      topic: { type: "string", maxLength: 1024 },
    },
    ["name"],
  ),
  tool(
    "rename_channel",
    "Queue renaming a channel. This requires Manage Channels permission and user confirmation.",
    {
      channel_id: { type: "string", pattern: "^[0-9]{15,22}$" },
      new_name: { type: "string", minLength: 1, maxLength: 100 },
    },
    ["channel_id", "new_name"],
  ),
  tool(
    "set_slowmode",
    "Queue changing slowmode for a text channel. Seconds must be 0 to 21600. Requires Manage Channels permission and confirmation.",
    {
      channel_id: { type: "string", pattern: "^[0-9]{15,22}$" },
      seconds: { type: "integer", minimum: 0, maximum: 21600 },
    },
    ["channel_id", "seconds"],
  ),
  tool(
    "timeout_member",
    "Queue timing out a member for 1 to 10080 minutes. Requires Moderate Members permission and confirmation.",
    {
      member_id: { type: "string", pattern: "^[0-9]{15,22}$" },
      minutes: { type: "integer", minimum: 1, maximum: 10080 },
      reason: { type: "string", maxLength: 200 },
    },
    ["member_id", "minutes"],
  ),
  tool(
    "set_server_mute",
    "Queue server-muting or unmuting a voice member. Only the server owner or an Administrator may request this, and confirmation is required.",
    {
      member_id: { type: "string", pattern: "^[0-9]{15,22}$" },
      enabled: { type: "boolean", description: "true to server-mute; false to unmute" },
      reason: { type: "string", maxLength: 200 },
    },
    ["member_id", "enabled"],
  ),
  tool(
    "set_server_deaf",
    "Queue server-deafening or undeafening a voice member. Only the server owner or an Administrator may request this, and confirmation is required.",
    {
      member_id: { type: "string", pattern: "^[0-9]{15,22}$" },
      enabled: { type: "boolean", description: "true to server-deafen; false to undeafen" },
      reason: { type: "string", maxLength: 200 },
    },
    ["member_id", "enabled"],
  ),
];

const mutationPermissions = {
  create_text_channel: PermissionFlagsBits.ManageChannels,
  rename_channel: PermissionFlagsBits.ManageChannels,
  set_slowmode: PermissionFlagsBits.ManageChannels,
  timeout_member: PermissionFlagsBits.ModerateMembers,
  set_server_mute: PermissionFlagsBits.Administrator,
  set_server_deaf: PermissionFlagsBits.Administrator,
};

const adminOnlyMutations = new Set(["set_server_mute", "set_server_deaf"]);

function cleanName(value) {
  return String(value || "").trim().slice(0, 100);
}

function snowflake(value) {
  const normalized = String(value || "").trim();
  return /^[0-9]{15,22}$/u.test(normalized) ? normalized : null;
}

function validateMutation(name, args) {
  if (name === "create_text_channel") {
    const channelName = cleanName(args.name);
    if (!channelName) throw new Error("Channel name is required");
    return { name: channelName, topic: String(args.topic || "").trim().slice(0, 1024) };
  }
  if (name === "rename_channel") {
    const channelId = snowflake(args.channel_id);
    const newName = cleanName(args.new_name);
    if (!channelId || !newName) throw new Error("Valid channel_id and new_name are required");
    return { channelId, newName };
  }
  if (name === "set_slowmode") {
    const channelId = snowflake(args.channel_id);
    const seconds = Number(args.seconds);
    if (!channelId || !Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
      throw new Error("Valid channel_id and seconds from 0 to 21600 are required");
    }
    return { channelId, seconds };
  }
  if (name === "timeout_member") {
    const memberId = snowflake(args.member_id);
    const minutes = Number(args.minutes);
    if (!memberId || !Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
      throw new Error("Valid member_id and minutes from 1 to 10080 are required");
    }
    return { memberId, minutes, reason: String(args.reason || "").trim().slice(0, 200) };
  }
  if (name === "set_server_mute" || name === "set_server_deaf") {
    const memberId = snowflake(args.member_id);
    if (!memberId || typeof args.enabled !== "boolean") {
      throw new Error("Valid member_id and boolean enabled are required");
    }
    return {
      memberId,
      enabled: args.enabled,
      reason: String(args.reason || "").trim().slice(0, 200),
    };
  }
  throw new Error("Unknown server mutation tool");
}

export function createServerToolExecutor({ message, queueAction }) {
  return async (name, args = {}) => {
    const { guild } = message;
    if (!guild) return { ok: false, error: "This tool only works inside a server" };

    if (name === "get_server_overview") {
      return {
        ok: true,
        server: { id: guild.id, name: guild.name, members: guild.memberCount },
        counts: {
          channels: guild.channels.cache.size,
          roles: Math.max(0, guild.roles.cache.size - 1),
          boosts: guild.premiumSubscriptionCount || 0,
        },
      };
    }
    if (name === "list_channels") {
      await guild.channels.fetch().catch(() => null);
      return {
        ok: true,
        channels: [...guild.channels.cache.values()]
          .sort((a, b) => a.rawPosition - b.rawPosition)
          .slice(0, 100)
          .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type })),
      };
    }
    if (name === "list_roles") {
      await guild.roles.fetch().catch(() => null);
      return {
        ok: true,
        roles: [...guild.roles.cache.values()]
          .filter((role) => role.id !== guild.id)
          .sort((a, b) => b.position - a.position)
          .slice(0, 100)
          .map((role) => ({ id: role.id, name: role.name, members: role.members.size })),
      };
    }
    if (name === "find_member") {
      const query = String(args.query || "").trim().toLocaleLowerCase();
      if (!query) return { ok: false, error: "A search query is required" };
      await guild.members.fetch({ query: query.slice(0, 100), limit: 10 }).catch(() => null);
      const members = [...guild.members.cache.values()]
        .filter((member) =>
          [member.displayName, member.user.username, member.user.globalName]
            .filter(Boolean)
            .some((value) => value.toLocaleLowerCase().includes(query)),
        )
        .slice(0, 10)
        .map((member) => ({ id: member.id, displayName: member.displayName, bot: member.user.bot }));
      return { ok: true, members };
    }

    const permission = mutationPermissions[name];
    if (!permission) return { ok: false, error: "Unknown tool" };
    const adminOnly = adminOnlyMutations.has(name);
    const isOwnerOrAdmin =
      guild.ownerId === message.author.id ||
      message.member?.permissions.has(PermissionFlagsBits.Administrator);
    if (adminOnly && !isOwnerOrAdmin) {
      return { ok: false, error: "Only the server owner or an Administrator may use this voice action" };
    }
    if (!adminOnly && !message.member?.permissions.has(permission)) {
      return { ok: false, error: "The requesting user does not have the required Discord permission" };
    }
    const validatedArgs = validateMutation(name, args);
    const queued = queueAction({ name, args: validatedArgs, permission, adminOnly });
    return {
      ok: true,
      status: "awaiting_user_confirmation",
      actionId: queued.id,
      instruction: "Tell the user to review and press the confirmation button below. Do not claim completion yet.",
    };
  };
}

export async function executeServerAction(interaction, action) {
  const isOwnerOrAdmin =
    interaction.guild.ownerId === interaction.user.id ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (action.adminOnly && !isOwnerOrAdmin) {
    throw new Error("คำสั่งเสียงนี้ใช้ได้เฉพาะเจ้าของเซิร์ฟเวอร์หรือ Administrator");
  }
  if (!action.adminOnly && !interaction.memberPermissions?.has(action.permission)) {
    throw new Error("คุณไม่มีสิทธิ์ Discord ที่จำเป็นสำหรับคำสั่งนี้แล้ว");
  }

  const reason = `Onepune agent action confirmed by ${interaction.user.username} (${interaction.user.id})`;
  const { guild } = interaction;
  if (action.name === "create_text_channel") {
    const channel = await guild.channels.create({
      name: action.args.name,
      topic: action.args.topic || undefined,
      type: ChannelType.GuildText,
      reason,
    });
    return `สร้างช่อง <#${channel.id}> เรียบร้อยแล้ว`;
  }

  if (action.name === "rename_channel") {
    const channel = await guild.channels.fetch(action.args.channelId);
    if (!channel) throw new Error("ไม่พบช่องที่ต้องการเปลี่ยนชื่อ");
    await channel.setName(action.args.newName, reason);
    return `เปลี่ยนชื่อช่องเป็น **${action.args.newName}** เรียบร้อยแล้ว`;
  }

  if (action.name === "set_slowmode") {
    const channel = await guild.channels.fetch(action.args.channelId);
    if (!channel || !textChannelTypes.has(channel.type) || typeof channel.setRateLimitPerUser !== "function") {
      throw new Error("ช่องนี้ไม่รองรับ slowmode");
    }
    await channel.setRateLimitPerUser(action.args.seconds, reason);
    return `ตั้ง slowmode ของ <#${channel.id}> เป็น **${action.args.seconds} วินาที** แล้ว`;
  }

  if (action.name === "timeout_member") {
    const member = await guild.members.fetch(action.args.memberId);
    if (!member.moderatable) throw new Error("บอทจัดการสมาชิกคนนี้ไม่ได้ กรุณาตรวจลำดับยศของบอท");
    await member.timeout(action.args.minutes * 60_000, action.args.reason || reason);
    return `พักการใช้งาน <@${member.id}> เป็นเวลา **${action.args.minutes} นาที** แล้ว`;
  }

  if (action.name === "set_server_mute" || action.name === "set_server_deaf") {
    const member = await guild.members.fetch(action.args.memberId);
    if (!member.voice.channelId) throw new Error("สมาชิกคนนี้ไม่ได้อยู่ในห้องเสียง");
    if (!member.manageable) throw new Error("บอทจัดการสมาชิกคนนี้ไม่ได้ กรุณาตรวจลำดับยศของบอท");
    const auditReason = action.args.reason || reason;
    if (action.name === "set_server_mute") {
      await member.voice.setMute(action.args.enabled, auditReason);
      return `${action.args.enabled ? "ปิด" : "เปิด"}ไมค์ของ <@${member.id}> เรียบร้อยแล้ว`;
    }
    await member.voice.setDeaf(action.args.enabled, auditReason);
    return `${action.args.enabled ? "ปิด" : "เปิด"}เสียงที่ได้ยินของ <@${member.id}> เรียบร้อยแล้ว`;
  }

  throw new Error("ไม่รู้จักคำสั่งจัดการเซิร์ฟเวอร์นี้");
}
