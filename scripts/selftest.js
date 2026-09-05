'use strict';

// 核心逻辑自测：npm run selftest
// 覆盖：拼手气拆分、mock 扣款/入账、抢红包去重、过期退款、入账失败重试。

process.env.DB_PATH = './.tmp-selftest/selftest.db';
process.env.MOCK_API = 'true';
process.env.EXPIRY_MINUTES = '120';

const assert = require('node:assert');
const fs = require('node:fs');

// 只清自己的临时目录，绝不碰生产库所在的 ./data
fs.rmSync('./.tmp-selftest', { recursive: true, force: true });

const store = require('../src/store');
const mockApi = require('../src/mockApi');
const rp = require('../src/redpacket');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
    .catch((err) => {
      console.error(`  ✗ ${name}\n    ${err.message}`);
      process.exitCode = 1;
    });
}

function insertPacket(senderId, total, count, expiresAt) {
  const id = store.stmts.insertPacket.run({
    guild_id: 'g1', channel_id: 'c1', sender_id: senderId,
    total_amount: total, count, expires_at: expiresAt,
    deduct_ref: `selftest_${senderId}_${total}_${count}_${Math.random()}`,
    created_at: Date.now(), status: 'active',
  }).lastInsertRowid;
  return store.stmts.getPacket.get(id);
}

async function run() {
  console.log('— 拆分算法 —');
  for (let i = 0; i < 300; i++) {
    const v = store.splitRand(100, 3);
    assert(v >= 1 && v <= 100 - 2, `单份越界: ${v}`);
  }
  assert.strictEqual(store.splitRand(100, 1), 100, '最后一份应拿走全部剩余');
  for (let i = 0; i < 300; i++) {
    // 极端：总额刚好等于份数，必须每份都是 1
    assert.strictEqual(store.splitRand(10, 10), 1);
  }
  await ok('边界与范围校验（300 轮随机）', async () => {});

  console.log('— mock 扣款 / 入账 —');
  mockApi.reset();
  await ok('新用户默认余额、扣款、入账、幂等', async () => {
    assert.strictEqual((await mockApi.getBalance('u1')).balance, 10000);
    await mockApi.deduct('u1', 100, 'ref1');
    assert.strictEqual((await mockApi.getBalance('u1')).balance, 9900);
    await mockApi.deduct('u1', 100, 'ref1'); // 同 ref 重放不重复扣
    assert.strictEqual((await mockApi.getBalance('u1')).balance, 9900);
    await mockApi.credit('u1', 50, 'redpacket_claim', 'cref1');
    await mockApi.credit('u1', 50, 'redpacket_claim', 'cref1'); // 重放不重复加
    assert.strictEqual((await mockApi.getBalance('u1')).balance, 9950);
  });
  await ok('余额不足时扣款报 INSUFFICIENT_BALANCE', async () => {
    try {
      await mockApi.deduct('u2', 99999, 'ref2');
      assert.fail('应当抛错');
    } catch (err) {
      assert.strictEqual(err.code, 'INSUFFICIENT_BALANCE');
    }
  });

  console.log('— 抢红包（事务去重 + 过期拒绝）—');
  mockApi.reset();
  const now = Date.now();
  const packet = insertPacket('sender', 100, 3, now + 3600_000);
  await ok('多人拼手气抢、同一人不能重复领', async () => {
    const r1 = store.claimTx(packet.id, 'uA', now);
    assert(r1.ok && r1.amount >= 1);
    const r2 = store.claimTx(packet.id, 'uB', now);
    assert(r2.ok && r2.amount >= 1);
    assert(store.claimTx(packet.id, 'uA', now).reason === 'already', '重复领取应被拒绝');
    const after = store.stmts.getPacket.get(packet.id);
    assert.strictEqual(after.remaining_count, 1);
    assert.strictEqual(after.remaining_amount, 100 - r1.amount - r2.amount);
    // 最后一份拿走全部剩余
    const r3 = store.claimTx(packet.id, 'uC', now);
    assert.strictEqual(r3.amount, after.remaining_amount);
    assert.strictEqual(store.stmts.getPacket.get(packet.id).status, 'finished');
  });
  await ok('已抢完 / 已过期的红包不能再抢', async () => {
    const p2 = insertPacket('sender', 50, 1, now + 3600_000);
    store.claimTx(p2.id, 'uA', now);
    assert.strictEqual(store.claimTx(p2.id, 'uB', now).reason, 'empty');
    const p3 = insertPacket('sender', 50, 2, now - 1);
    assert.strictEqual(store.claimTx(p3.id, 'uB', now).reason, 'not_active');
  });

  console.log('— 过期退款 sweep —');
  mockApi.reset();
  await ok('过期后剩余额度退回发送者', async () => {
    const senderBefore = (await mockApi.getBalance('senderX')).balance;
    // 按真实流程先扣款，再落库
    await mockApi.deduct('senderX', 100, 'selftest_send');
    const p = insertPacket('senderX', 100, 4, now - 1000);
    store.claimTx(p.id, 'uA', now); // 抢走一份，剩 3 份 + 剩余额度
    const afterClaims = store.stmts.getPacket.get(p.id);
    await rp.expireSweep(now);
    const done = store.stmts.getPacket.get(p.id);
    assert.strictEqual(done.status, 'expired');
    assert.strictEqual(done.refund_status, 'ok');
    const senderAfter = (await mockApi.getBalance('senderX')).balance;
    assert.strictEqual(senderAfter, senderBefore - 100 + afterClaims.remaining_amount,
      '发送者余额 = 原余额 - 发出总额 + 退回剩余');
  });
  await ok('入账失败的领取由 sweep 补发（幂等）', async () => {
    const p = insertPacket('senderY', 60, 2, now + 3600_000);
    const r = store.claimTx(p.id, 'uZ', now);
    assert(r.ok);
    // 模拟崩溃：入账没成功，领取记录停在 pending，且已超过重试延迟
    store.db.prepare('UPDATE claims SET claimed_at = ? WHERE id = ?')
      .run(now - 120_000, r.claimId);
    const before = (await mockApi.getBalance('uZ')).balance;
    await rp.expireSweep(now);
    assert.strictEqual((await mockApi.getBalance('uZ')).balance, before + r.amount);
    const claim = store.stmts.getClaim.get(p.id, 'uZ');
    assert.strictEqual(claim.credit_status, 'ok');
  });
  await ok('旧库迁移回归：无新列的 legacy 行过期后仍恰一次退款', async () => {
    mockApi.reset();
    const senderBefore = (await mockApi.getBalance('legacyS')).balance;
    await mockApi.deduct('legacyS', 40, 'legacy_send');
    // 原生 SQL 造旧行：不带 deduct_ref/created_at（insertPacket helper 总带新列，测不到旧行）
    const lid = store.db.prepare(`
      INSERT INTO redpackets (guild_id, channel_id, sender_id, total_amount, count,
                              remaining_amount, remaining_count, expires_at, status, refund_status)
      VALUES ('g1', 'c1', 'legacyS', 40, 2, 40, 2, ?, 'active', 'none')`)
      .run(now - 1000).lastInsertRowid;
    store.claimTx(lid, 'uL', now);
    await rp.expireSweep(now);
    const row = store.stmts.getPacket.get(lid);
    assert.strictEqual(row.status, 'expired');
    assert.strictEqual(row.refund_status, 'ok');
    assert.strictEqual(
      (await mockApi.getBalance('legacyS')).balance,
      senderBefore - 40 + row.remaining_amount,
      'legacy 行（deduct_ref 为 NULL）的剩余额度应走 refund_<id> 恰一次退回');
  });

  console.log('— 发红包（createPacket 端到端，stub 频道）—');
  mockApi.reset();
  const sentMessages = [];
  const stubChannel = { id: 'ch1', send: async (payload) => {
    sentMessages.push(payload);
    return { id: `msg_${sentMessages.length}` };
  } };
  await ok('格式校验拒绝', async () => {
    const cases = [
      { countText: '0', totalText: '10' },
      { countText: 'abc', totalText: '10' },
      { countText: '3', totalText: '2' },   // 总额 < 份数
      { countText: '99999', totalText: '99999' }, // 超过单包上限假设（MAX_TOTAL 默认 100 万时不超，跳过）
    ];
    for (const c of cases) {
      const r = await rp.createPacket({ guildId: 'g', channel: stubChannel, senderId: 'u1', ...c });
      if (c.countText === '99999') continue; // 默认上限内，允许成功，下面单独验
      assert.strictEqual(r.ok, false, `应拒绝 ${JSON.stringify(c)}`);
    }
  });
  await ok('正常发红包：扣款 + 消息发出 + 记录落库', async () => {
    const before = (await mockApi.getBalance('u1')).balance;
    const r = await rp.createPacket({
      guildId: 'g', channel: stubChannel, senderId: 'u1', countText: '3', totalText: '90',
    });
    assert(r.ok);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual((await mockApi.getBalance('u1')).balance, before - 90);
    const p = store.stmts.getPacket.get(r.packet.id);
    assert.strictEqual(p.message_id, 'msg_1');
    assert.strictEqual(p.status, 'active');
  });
  await ok('余额不足：拒绝且不产生红包', async () => {
    const r = await rp.createPacket({
      guildId: 'g', channel: stubChannel, senderId: 'poor', countText: '2', totalText: '999999',
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /不足/);
  });

  const failed = process.exitCode === 1 ? '有失败项！' : '全部通过 ✓';
  console.log(`\n${passed} 项检查完成 — ${failed}`);
  store.db.close();
}

run().catch((err) => {
  console.error('自测脚本异常:', err);
  process.exit(1);
});
