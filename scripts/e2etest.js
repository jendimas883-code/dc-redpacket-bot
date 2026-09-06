'use strict';

// 端到端交互测试：npm run e2etest
// 用假的 Discord interaction 对象驱动真实的事件处理代码（commands/balance.js、redpacket.js），
// 完整走一遍：查额度 → 弹表单 → 发红包 → 抢 → 重复领 → 抢完 → 输入校验 → 余额不足 →
// 发送失败退款 → 过期退款 → 止损（补偿被网站明确拒绝 → failed 终态）。
// 不需要 Discord token，不需要网站接口。

process.env.DB_PATH = './.tmp-e2etest/e2etest.db';
process.env.MOCK_API = 'true';

const assert = require('node:assert');
const fs = require('node:fs');

// 只清自己的临时目录，绝不碰生产库所在的 ./data
fs.rmSync('./.tmp-e2etest', { recursive: true, force: true });

const store = require('../src/store');
const mockApi = require('../src/mockApi');
const rp = require('../src/redpacket');
const balance = require('../src/commands/balance');

// ---------- 假的 Discord 环境 ----------

let msgSeq = 0;
const messageRegistry = {};   // messageId -> fakeMessage（记录所有 edit 调用）
const editsOf = {};           // messageId -> [{ embeds, components }]
const sentMessages = [];      // channel.send 收到的 { messageId, payload }

function fakeMessage(id) {
  editsOf[id] = [];
  return {
    id,
    edit: async (payload) => { editsOf[id].push(payload); return this; },
  };
}

const channel = {
  id: 'ch1',
  messages: { fetch: async (id) => messageRegistry[id] },
  send: async (payload) => {
    if (channel.shouldFailSend) throw new Error('boom');
    const id = `m${++msgSeq}`;
    messageRegistry[id] = fakeMessage(id);
    sentMessages.push({ id, payload });
    return messageRegistry[id];
  },
};

// refreshMessage 走的就是这条路径：client.channels.fetch -> messages.fetch -> edit
rp.setClient({ channels: { fetch: async () => channel } });

// discord.js builder（Embed/ActionRow/Modal）统一转成 JSON 再断言，不碰 .data 内部结构
const J = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const norm = (p) => ({
  ...p,
  embeds: (p?.embeds ?? []).map(J),
  components: (p?.components ?? []).map(J),
});

function makeInteraction(over = {}) {
  const calls = { deferReply: [], editReply: [], reply: [], showModal: [] };
  const i = {
    user: { id: 'u1', bot: false },
    guildId: 'g1',
    channelId: 'ch1',
    channel,
    customId: '',
    commandName: '',
    deferred: false,
    replied: false,
    fields: {
      getTextInputValue: (k) => (over.fieldValues ? over.fieldValues[k] : ''),
    },
    async deferReply(opts) { this.deferred = true; calls.deferReply.push(opts); },
    async editReply(p) { calls.editReply.push(p); return p; },
    async reply(p) { this.replied = true; calls.reply.push(p); },
    async showModal(m) { calls.showModal.push(m); },
    // 冷审 F4：补齐真实 discord.js 的类型判定方法，路由层测试需要它们；
    // 注意假对象的 deferred/replied 仍是同步置位，与真实 REST 后置位有差异
    isChatInputCommand: () => over.kind === 'command',
    isButton: () => over.kind === 'button',
    isModalSubmit: () => over.kind === 'modal',
    isAutocomplete: () => false,
    isRepliable: () => true,
    ...over,
  };
  return { i, calls };
}

async function submitModal(userId, count, total, over = {}) {
  const { i, calls } = makeInteraction({
    user: { id: userId, bot: false },
    fieldValues: { count, total },
    ...over,
  });
  await balance.handleModalSubmit(i);
  return calls;
}

// ---------- 断言 ----------

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log('— /额度查询 —');
  await ok('显示可用额度和红包按钮', async () => {
    const { i, calls } = makeInteraction({});
    await balance.execute(i);
    assert.strictEqual(calls.deferReply[0].ephemeral, true, '应当是仅自己可见');
    const payload = norm(calls.editReply[0]);
    assert.match(payload.embeds[0].description, /10,000/, 'mock 新用户应有 10000 额度');
    const btn = payload.components[0].components[0];
    assert.strictEqual(btn.custom_id, 'rp_open');
  });

  console.log('— 点「红包盲盒」按钮弹表单 —');
  await ok('弹出含个数/总额度两个输入框的表单', async () => {
    const { i, calls } = makeInteraction({ customId: 'rp_open' });
    await balance.handleOpenButton(i);
    const modal = J(calls.showModal[0]);
    assert.strictEqual(modal.custom_id, 'rp_create');
    const inputs = modal.components.flatMap((r) => r.components);
    assert.deepStrictEqual(inputs.map((c) => c.custom_id), ['count', 'total']);
    assert.ok(inputs.every((c) => c.required));
  });

  console.log('— interaction 路由（冷审 F1/F4 防复发）—');
  await ok('未知按钮必须有应答有日志，不得静默丢弃', async () => {
    const { handleInteraction } = require('../src/router');
    const { i, calls } = makeInteraction({ kind: 'button', customId: 'rp_what_999' });
    await handleInteraction(i);
    assert.match(calls.reply[0].content, /未知操作/, '未知交互应回复用户');
  });
  await ok('rp_grab_ 按钮分发到抢红包处理', async () => {
    const { handleInteraction } = require('../src/router');
    const { i, calls } = makeInteraction({
      kind: 'button', customId: 'rp_grab_99999', user: { id: 'uRouter', bot: false },
    });
    await handleInteraction(i);
    assert.match(calls.editReply[0].content, /不存在/, '应路由到 handleGrab（不存在的红包被拒）');
  });
  await ok('/额度查询 分发到命令处理', async () => {
    const { handleInteraction } = require('../src/router');
    const { i, calls } = makeInteraction({
      kind: 'command', commandName: '额度查询', user: { id: 'uRouter', bot: false },
    });
    await handleInteraction(i);
    assert.strictEqual(calls.deferReply.length, 1, '应路由到 balance.execute');
    assert.match(norm(calls.editReply[0]).embeds[0].description, /uRouter/);
  });

  console.log('— 表单提交发红包 —');
  await ok('正常发红包：扣款、频道出消息、回复确认', async () => {
    const calls = await submitModal('u1', '3', '90');
    assert.match(calls.editReply[0].content, /红包盲盒已发到/);
    assert.strictEqual(sentMessages.length, 1);
    const emb = norm(sentMessages[0].payload).embeds[0];
    assert.match(emb.description, /<@u1>/);
    assert.match(emb.description, /\*\*90\*\*/);
    assert.strictEqual((await mockApi.getBalance('u1')).balance, 10000 - 90);
    const p = store.stmts.getPacket.get(1);
    assert.strictEqual(p.status, 'active');
    assert.strictEqual(p.message_id, 'm1');
  });

  const grabbed = {};
  await ok('别人点按钮能抢到，入账且消息更新', async () => {
    const before = (await mockApi.getBalance('u2')).balance;
    const { i, calls } = makeInteraction({ customId: 'rp_grab_1', user: { id: 'u2', bot: false } });
    await rp.handleGrab(i);
    assert.strictEqual(calls.deferReply[0].ephemeral, true, '应先在 3 秒窗口内应答');
    const m = calls.editReply[0].content.match(/抢到 \*\*(\d+)\*\*/);
    assert(m, `回复应包含抢到金额：${calls.editReply[0].content}`);
    grabbed.u2 = Number(m[1]);
    assert.strictEqual(
      (await mockApi.getBalance('u2')).balance,
      before + grabbed.u2,
      'mock 起始额度 + 抢到金额');
    const emb = norm(editsOf.m1.at(-1)).embeds[0];
    const field = emb.fields[0].value;
    assert.match(field, new RegExp(`<@u2> — \\*\\*${grabbed.u2}\\*\\*`));
  });

  await ok('同一人不能重复领', async () => {
    const before = (await mockApi.getBalance('u2')).balance;
    const { i, calls } = makeInteraction({ customId: 'rp_grab_1', user: { id: 'u2', bot: false } });
    await rp.handleGrab(i);
    assert.match(calls.editReply[0].content, /已经领过/);
    assert.strictEqual((await mockApi.getBalance('u2')).balance, before);
  });

  await ok('抢完最后一份后红包关闭，再来的人提示抢完', async () => {
    for (const uid of ['u3', 'u4']) {
      const { i, calls } = makeInteraction({ customId: 'rp_grab_1', user: { id: uid, bot: false } });
      await rp.handleGrab(i);
      assert.match(calls.editReply[0].content, /抢到/, `${uid} 应能抢到`);
    }
    assert.strictEqual(store.stmts.getPacket.get(1).status, 'finished');
    const before = (await mockApi.getBalance('u5')).balance;
    const { i, calls } = makeInteraction({ customId: 'rp_grab_1', user: { id: 'u5', bot: false } });
    await rp.handleGrab(i);
    assert.match(calls.editReply[0].content, /已被抢完/);
    assert.strictEqual((await mockApi.getBalance('u5')).balance, before);
    const last = norm(editsOf.m1.at(-1));
    assert.strictEqual(last.embeds[0].footer.text, '已抢完');
    const btn = last.components[0].components[0];
    assert.strictEqual(btn.disabled, true, '抢完后按钮应禁用');
  });

  console.log('— 表单输入校验 —');
  await ok('非法个数/总额 < 份数 被拒绝', async () => {
    for (const [count, total, pattern] of [
      ['0', '10', /个数/], ['abc', '10', /个数/], ['3', '2', /至少/],
    ]) {
      const beforeMsgs = sentMessages.length;
      const calls = await submitModal('u1', count, total);
      assert.match(calls.editReply[0].content, pattern, `count=${count} total=${total}`);
      assert.strictEqual(sentMessages.length, beforeMsgs, '不应发消息');
    }
  });

  await ok('余额不足被拒绝，不发消息不扣款', async () => {
    mockApi.balances.set('uPoor', 5);
    const calls = await submitModal('uPoor', '1', '10');
    assert.match(calls.editReply[0].content, /不足/);
    assert.strictEqual((await mockApi.getBalance('uPoor')).balance, 5);
    assert.strictEqual(sentMessages.length, 1);
  });

  await ok('频道发送失败时自动退款', async () => {
    const before = (await mockApi.getBalance('u1')).balance;
    channel.shouldFailSend = true;
    try {
      const calls = await submitModal('u1', '2', '20');
      assert.match(calls.editReply[0].content, /已退回/);
    } finally {
      channel.shouldFailSend = false;
    }
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before, '扣掉的钱应原路退回');
    // 双退款回归（F1）：作废的红包绝不能被过期 sweep 再退一次
    const row = store.stmts.getPacket.get(
      store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id);
    assert.strictEqual(row.status, 'cancelled', '发送失败的红包应作废');
    assert.strictEqual(row.refund_status, 'none');
    await rp.expireSweep();
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before, 'sweep 不得对作废红包二次退款');
  });

  console.log('— 扣款结果未知收敛 —');
  await ok('扣款超时（结果未知）→ sweep 用同一 ref 重试并自动退回', async () => {
    const api = require('../src/api');
    const { ApiError } = require('../src/apiError');
    const before = (await mockApi.getBalance('u1')).balance;
    const origDeduct = api.deduct;
    api.deduct = async () => { throw new ApiError('NETWORK', '模拟超时'); };
    let calls;
    try {
      calls = await submitModal('u1', '2', '20');
    } finally {
      api.deduct = origDeduct;
    }
    assert.match(calls.editReply[0].content, /核对/, '应告知用户额度在核对中');
    const pid = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
    const creating = store.stmts.getPacket.get(pid);
    assert.strictEqual(creating.status, 'creating', '红包应停在 creating 等待收敛');
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before, '此时不应扣款');
    assert.strictEqual(sentMessages.length, 1, '不应发出红包消息');

    // 时间快进，sweep 接管：重试扣款（同 ref 幂等）→ 确认扣上 → 原路退回 → 作废
    store.db.prepare('UPDATE redpackets SET created_at = ? WHERE id = ?')
      .run(Date.now() - 120_000, pid);
    await rp.expireSweep();
    const done = store.stmts.getPacket.get(pid);
    assert.strictEqual(done.status, 'cancelled', '收敛后红包应作废');
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before, '额度应自动退回');
  });

  await ok('首次退款超时但网站已入账 → sweep 用同一键收敛，恰好一次（双退款防复发）', async () => {
    const api = require('../src/api');
    const { ApiError } = require('../src/apiError');
    const before = (await mockApi.getBalance('u1')).balance;
    const origCredit = api.credit;
    let firstRefundSeen = false;
    // 模拟"站点已入账、响应超时"：先真实入账，再抛 NETWORK
    api.credit = async (discordId, amount, purpose, ref) => {
      const r = await mockApi.credit(discordId, amount, purpose, ref);
      if (!firstRefundSeen && String(ref).startsWith('refund_')) {
        firstRefundSeen = true;
        throw new ApiError('NETWORK', '模拟退款响应超时');
      }
      return r;
    };
    let calls;
    let pid;
    try {
      channel.shouldFailSend = true;
      try {
        calls = await submitModal('u1', '2', '20');
      } finally {
        channel.shouldFailSend = false;
      }
      assert.match(calls.editReply[0].content, /稍后会自动重试/, '退款结果未知应告知稍后自动重试');
      pid = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
      const row = store.stmts.getPacket.get(pid);
      assert.strictEqual(row.status, 'cancelled');
      assert.strictEqual(row.refund_status, 'pending', '退款结果未知应标记 pending 交给 sweep');
      assert.strictEqual((await mockApi.getBalance('u1')).balance, before, '首次退款其实已生效');
      // sweep 在补丁作用域内跑：阶段 3 用同一键 refund_${deduct_ref} 重试，应被 mock 幂等去重
      await rp.expireSweep();
    } finally {
      api.credit = origCredit;
    }
    assert.strictEqual(store.stmts.getPacket.get(pid).refund_status, 'ok', 'sweep 应以同一键收敛');
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before, '不得二次入账（换键旧实现会多退 20）');
    await rp.expireSweep();
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before, '重复 sweep 仍稳定');
  });

  await ok('deduct 已在网站生效但返回 408 → 按结果未知收敛，不得静默作废吞钱', async () => {
    const api = require('../src/api');
    const { ApiError } = require('../src/apiError');
    const before = (await mockApi.getBalance('u1')).balance;
    const origDeduct = api.deduct;
    let firstDeductSeen = false;
    api.deduct = async (discordId, amount, ref) => {
      await mockApi.deduct(discordId, amount, ref); // 站点事务已提交
      if (!firstDeductSeen) {
        firstDeductSeen = true;
        throw new ApiError('HTTP_408', '请求超时'); // 首次响应超时；重试时网站正常应答
      }
      return { balance: (await mockApi.getBalance(discordId)).balance };
    };
    let calls;
    let pid;
    try {
      calls = await submitModal('u1', '2', '20');
      assert.match(calls.editReply[0].content, /核对/, '408 属结果未知，应走核对流程而非作废');
      pid = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
      assert.strictEqual(store.stmts.getPacket.get(pid).status, 'creating');
      assert.strictEqual((await mockApi.getBalance('u1')).balance, before - 20, '站点已扣款');
      store.db.prepare('UPDATE redpackets SET created_at = ? WHERE id = ?')
        .run(Date.now() - 120_000, pid);
      await rp.expireSweep();
    } finally {
      api.deduct = origDeduct;
    }
    assert.strictEqual(store.stmts.getPacket.get(pid).status, 'cancelled');
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before, '同 ref 重试去重后退款，资金回到原点');
  });

  await ok('deduct 已在网站生效但返回 429（限流）→ 按结果未知收敛，不得作废吞钱', async () => {
    const api = require('../src/api');
    const { ApiError } = require('../src/apiError');
    const before = (await mockApi.getBalance('u1')).balance;
    const origDeduct = api.deduct;
    let firstDeductSeen = false;
    api.deduct = async (discordId, amount, ref) => {
      await mockApi.deduct(discordId, amount, ref); // 站点事务已提交
      if (!firstDeductSeen) {
        firstDeductSeen = true;
        throw new ApiError('HTTP_429', '请求过于频繁');
      }
      return { balance: (await mockApi.getBalance(discordId)).balance };
    };
    let pid;
    try {
      await submitModal('u1', '2', '20');
      pid = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
      assert.strictEqual(store.stmts.getPacket.get(pid).status, 'creating', '429 属结果未知，不得作废');
      store.db.prepare('UPDATE redpackets SET created_at = ? WHERE id = ?')
        .run(Date.now() - 120_000, pid);
      await rp.expireSweep();
    } finally {
      api.deduct = origDeduct;
    }
    assert.strictEqual(store.stmts.getPacket.get(pid).status, 'cancelled');
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before, '限流后的同键重试应收敛退款');
  });

  await ok('入账被网站明确拒绝（USER_NOT_FOUND）→ 份额退回发送者且恰一次', async () => {
    const api = require('../src/api');
    const { ApiError } = require('../src/apiError');
    const origCredit = api.credit;
    // 只拦 claim_ 入账键。份额退款键 refund_claim_…（前缀是 refund_）会放行到 mock——
    // 注意：若退款键前缀改成完全不含 claim_ 字样的形式，本用例仍会通过但不再覆盖
    // 份额退款路径；若改成 claim_ 开头则会显式失败。改键时必须回来更新本用例
    api.credit = async (discordId, amount, purpose, ref) => {
      if (String(ref).startsWith('claim_')) throw new ApiError('USER_NOT_FOUND', '用户不存在');
      return mockApi.credit(discordId, amount, purpose, ref);
    };
    let grabCalls;
    let claimId;
    let u6AfterSend;
    let u7Before;
    try {
      await submitModal('u6', '1', '5');
      u6AfterSend = (await mockApi.getBalance('u6')).balance;
      u7Before = (await mockApi.getBalance('u7')).balance;
      const pid = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
      const { i, calls } = makeInteraction({ customId: `rp_grab_${pid}`, user: { id: 'u7', bot: false } });
      await rp.handleGrab(i);
      grabCalls = calls;
      claimId = store.db.prepare('SELECT MAX(id) AS id FROM claims').get().id;
      store.db.prepare('UPDATE claims SET claimed_at = ? WHERE id = ?').run(Date.now() - 120_000, claimId);
      // sweep 在补丁作用域内跑：入账重试仍被拒 → 份额改道退回发送者
      await rp.expireSweep();
    } finally {
      api.credit = origCredit;
    }
    assert.match(grabCalls.editReply[0].content, /退回红包发起者/, '明确拒绝时应如实告知份额去向');
    const c = store.db.prepare('SELECT credit_status, refund_status FROM claims WHERE id = ?').get(claimId);
    assert.strictEqual(c.credit_status, 'failed', '入账应标记 failed 终态');
    assert.strictEqual(c.refund_status, 'ok', '份额应退回发送者');
    assert.strictEqual((await mockApi.getBalance('u7')).balance, u7Before, '领取者未入账');
    assert.strictEqual((await mockApi.getBalance('u6')).balance, u6AfterSend + 5, '发送者应收回该份额');
    await rp.expireSweep();
    assert.strictEqual((await mockApi.getBalance('u6')).balance, u6AfterSend + 5, '连跑两遍 sweep 不得二次退款');
  });

  console.log('— 过期退款 —');
  await ok('过期后剩余额度退回发送者，消息标记已过期', async () => {
    // u4 发一个 4 份 40 的红包，只被 u5 领走一份
    const senderBefore = (await mockApi.getBalance('u4')).balance;
    await submitModal('u4', '4', '40');
    const packetId = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
    const u5Before = (await mockApi.getBalance('u5')).balance;
    const { i, calls } = makeInteraction({ customId: `rp_grab_${packetId}`, user: { id: 'u5', bot: false } });
    await rp.handleGrab(i);
    const claimAmt = Number(calls.editReply[0].content.match(/抢到 \*\*(\d+)\*\*/)[1]);
    const afterClaims = store.stmts.getPacket.get(packetId);
    assert.strictEqual(afterClaims.remaining_count, 3);

    // 时间快进到过期
    store.db.prepare('UPDATE redpackets SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, packetId);
    await rp.expireSweep();

    const done = store.stmts.getPacket.get(packetId);
    assert.strictEqual(done.status, 'expired');
    assert.strictEqual(done.refund_status, 'ok');
    assert.strictEqual(
      (await mockApi.getBalance('u4')).balance,
      senderBefore - 40 + afterClaims.remaining_amount,
      '发送者应收到剩余额度退款');
    assert.strictEqual(
      (await mockApi.getBalance('u5')).balance,
      u5Before + claimAmt,
      '领取者不受过期影响');
    const msgId = sentMessages.at(-1).id;
    const emb = norm(editsOf[msgId].at(-1)).embeds[0];
    assert.match(emb.footer.text, /已过期/);
    assert.match(emb.footer.text, /已退回/);
  });

  console.log('— 止损：补偿被网站明确拒绝 → failed 终态，停止重试 —');
  // 止损 = failed 行脱离全部待办队列（getStaleCreating / getPendingClaimRefunds /
  // getPendingRefunds 均按状态过滤）。钉法：计数 sweep 后所有 credit+deduct 调用增量
  // 必须为 0（含 throw 前的调用，防换键/换对象绕过前缀过滤），配余额不变作账面二保险。
  // 以下用例依赖前面的用例已把各自的 pending 全部收敛完毕，计数不被遗留行污染。
  await ok('阶段0：确认扣款后补偿退款被明确拒绝 → failed 止损，不再重试', async () => {
    const api = require('../src/api');
    const { ApiError } = require('../src/apiError');
    const before = (await mockApi.getBalance('u1')).balance;
    const origDeduct = api.deduct;
    const origCredit = api.credit;
    try {
      // 站点事务已提交、响应丢失：首调真实扣款后抛 NETWORK，红包停在 creating
      let deductSeen = false;
      api.deduct = async (discordId, amount, ref) => {
        await mockApi.deduct(discordId, amount, ref);
        if (!deductSeen) {
          deductSeen = true;
          throw new ApiError('NETWORK', '模拟扣款响应超时');
        }
        return { balance: (await mockApi.getBalance(discordId)).balance };
      };
      api.credit = async () => { throw new ApiError('USER_NOT_FOUND', '用户不存在'); };
      const calls = await submitModal('u1', '2', '20');
      assert.match(calls.editReply[0].content, /核对/, '扣款结果未知应告知额度在核对中');
      const pid = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
      assert.strictEqual(store.stmts.getPacket.get(pid).status, 'creating');
      store.db.prepare('UPDATE redpackets SET created_at = ? WHERE id = ?')
        .run(Date.now() - 120_000, pid);
      // 阶段0：同 ref 重试扣款（mock 幂等去重）→ 确认扣上 → 补偿退款被明确拒绝 → failed
      await rp.expireSweep();
      const row = store.stmts.getPacket.get(pid);
      assert.strictEqual(row.status, 'cancelled');
      assert.strictEqual(row.refund_status, 'failed', '补偿退款被明确拒绝应标 failed 止损');
      assert.strictEqual((await mockApi.getBalance('u1')).balance, before - 20,
        '钱滞留待人工处理，账面不得变动');

      let apiCalls = 0;
      api.credit = async (...a) => { apiCalls += 1; return origCredit(...a); };
      api.deduct = async (...a) => { apiCalls += 1; return origDeduct(...a); };
      await rp.expireSweep();
      assert.strictEqual(apiCalls, 0, 'failed 止损后 sweep 不得再发起任何资金调用');
      assert.strictEqual((await mockApi.getBalance('u1')).balance, before - 20);
    } finally {
      api.deduct = origDeduct;
      api.credit = origCredit;
    }
  });

  await ok('阶段3：作废红包的补偿退款被明确拒绝 → failed 止损，不再重试', async () => {
    const api = require('../src/api');
    const { ApiError } = require('../src/apiError');
    const before = (await mockApi.getBalance('u1')).balance;
    const origCredit = api.credit;
    try {
      // 首退响应丢失（未入账）→ cancelled + pending
      api.credit = async () => { throw new ApiError('NETWORK', '模拟退款响应丢失'); };
      channel.shouldFailSend = true;
      try {
        await submitModal('u1', '2', '20');
      } finally {
        channel.shouldFailSend = false;
      }
      const pid = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
      const row = store.stmts.getPacket.get(pid);
      assert.strictEqual(row.status, 'cancelled');
      assert.strictEqual(row.refund_status, 'pending', '首退结果未知应标 pending');
      assert.strictEqual((await mockApi.getBalance('u1')).balance, before - 20, '首退未生效');

      // 阶段3 cancelled 臂：同键 refund_${deduct_ref} 重试这次被网站明确拒绝 → failed
      api.credit = async () => { throw new ApiError('USER_NOT_FOUND', '用户不存在'); };
      await rp.expireSweep();
      assert.strictEqual(store.stmts.getPacket.get(pid).refund_status, 'failed',
        '明确拒绝应标 failed 止损');
      assert.strictEqual((await mockApi.getBalance('u1')).balance, before - 20);

      let apiCalls = 0;
      api.credit = async (...a) => { apiCalls += 1; return origCredit(...a); };
      await rp.expireSweep();
      assert.strictEqual(apiCalls, 0, 'failed 止损后 sweep 不得再发起任何资金调用');
    } finally {
      api.credit = origCredit;
    }
  });

  await ok('阶段1+1b：入账与份额退回都被明确拒绝 → failed 止损，消息如实展示', async () => {
    const api = require('../src/api');
    const { ApiError } = require('../src/apiError');
    const origCredit = api.credit;
    // 2 份包：1 份被抢（入账/份额退款全被拒 → 止损），1 份走正常过期退款作对照
    await submitModal('u8', '2', '10');
    const pid = store.db.prepare('SELECT MAX(id) AS id FROM redpackets').get().id;
    const msgId = sentMessages.at(-1).id;
    const senderAfterSend = (await mockApi.getBalance('u8')).balance;
    const grabberBefore = (await mockApi.getBalance('u9')).balance;
    try {
      // 只拦 claim_ 入账与 refund_claim_ 份额退款两个键，放行对照份额的 refund_<id>
      api.credit = async (discordId, amount, purpose, ref) => {
        const r = String(ref);
        if (r.startsWith('claim_') || r.startsWith('refund_claim_')) {
          throw new ApiError('USER_NOT_FOUND', '用户不存在');
        }
        return origCredit(discordId, amount, purpose, ref);
      };
      const { i, calls } = makeInteraction({
        customId: `rp_grab_${pid}`, user: { id: 'u9', bot: false },
      });
      await rp.handleGrab(i);
      const grabbed = Number(calls.editReply[0].content.match(/抢到 \*\*(\d+)\*\*/)[1]);
      const claimId = store.db.prepare('SELECT MAX(id) AS id FROM claims').get().id;
      store.db.prepare('UPDATE claims SET claimed_at = ? WHERE id = ?')
        .run(Date.now() - 120_000, claimId);
      // 阶段1 重试入账仍被拒 → failClaimTx；阶段1b 份额退款被拒 → failed 止损
      await rp.expireSweep();
      const c = store.db.prepare(
        'SELECT credit_status, refund_status FROM claims WHERE id = ?').get(claimId);
      assert.strictEqual(c.credit_status, 'failed');
      assert.strictEqual(c.refund_status, 'failed', '份额退款被明确拒绝应标 failed 止损');
      assert.strictEqual((await mockApi.getBalance('u9')).balance, grabberBefore, '领取者未入账');
      assert.strictEqual((await mockApi.getBalance('u8')).balance, senderAfterSend,
        '份额滞留待人工，发送者未收到');

      // 1b 止损路径不刷新消息：借阶段2 的过期刷新让 embed 反映 failed 终态
      store.db.prepare('UPDATE redpackets SET expires_at = ? WHERE id = ?')
        .run(Date.now() - 1000, pid);
      await rp.expireSweep();
      assert.strictEqual((await mockApi.getBalance('u8')).balance,
        senderAfterSend + (10 - grabbed), '未领份额应正常过期退回（对照组）');
      const emb = norm(editsOf[msgId].at(-1)).embeds[0];
      assert.match(emb.footer.text, /已过期.*已退回/);
      const rowLine = emb.fields[0].value;
      assert.match(rowLine, new RegExp(`<@u9> — \\*\\*${grabbed}\\*\\*`), '应列出 failed 份额的行');
      assert.match(rowLine, /（未到账，退回失败，请联系管理员）/, 'failed 份额应如实标注退回失败');
    } finally {
      api.credit = origCredit;
    }
    let apiCalls = 0;
    api.credit = async (...a) => { apiCalls += 1; return origCredit(...a); };
    try {
      await rp.expireSweep();
    } finally {
      api.credit = origCredit;
    }
    assert.strictEqual(apiCalls, 0, 'failed 止损后 sweep 不得再发起任何资金调用');
  });

  const failed = process.exitCode === 1 ? '有失败项！' : '全部通过 ✓';
  console.log(`\n${passed} 项检查完成 — ${failed}`);
  store.db.close();
}

run().catch((err) => {
  console.error('端到端测试异常:', err);
  process.exit(1);
});
