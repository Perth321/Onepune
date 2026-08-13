import assert from "node:assert/strict";
import test from "node:test";

import { PermissionFlagsBits } from "discord.js";
import { createServerToolExecutor } from "../src/server-tools.js";

function fakeMessage({ administrator = false, owner = false } = {}) {
  const authorId = "111111111111111";
  return {
    author: { id: authorId },
    member: {
      permissions: {
        has: (permission) => administrator && permission === PermissionFlagsBits.Administrator,
      },
    },
    guild: {
      id: "222222222222222",
      ownerId: owner ? authorId : "333333333333333",
    },
  };
}

test("rejects voice moderation tools for non-administrators", async () => {
  let queued = false;
  const execute = createServerToolExecutor({
    message: fakeMessage(),
    queueAction: () => {
      queued = true;
    },
  });
  const result = await execute("set_server_mute", {
    member_id: "444444444444444",
    enabled: true,
  });

  assert.equal(result.ok, false);
  assert.equal(queued, false);
  assert.match(result.error, /owner or an Administrator/u);
});

test("queues voice moderation for the owner and preserves confirmation metadata", async () => {
  let queued;
  const execute = createServerToolExecutor({
    message: fakeMessage({ owner: true }),
    queueAction: (action) => {
      queued = { id: "action-1", ...action };
      return queued;
    },
  });
  const result = await execute("set_server_deaf", {
    member_id: "444444444444444",
    enabled: true,
    reason: "เสียงดัง",
  });

  assert.equal(result.status, "awaiting_user_confirmation");
  assert.equal(queued.adminOnly, true);
  assert.equal(queued.args.enabled, true);
});
