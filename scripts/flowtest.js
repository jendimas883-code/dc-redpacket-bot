'use strict';

// 整体流程演练：npm run flowtest
// 模拟一个「红包日」：5 位用户互相发红包、抢红包、尝试作弊、红包过期，
// 全部走真实处理代码（commands/balance.js、redpacket.js、store 事务、mock 扣入账）。
// 最后做总账核对：全场额度必须守恒——除抢到和退回外，任何一笔钱都不能凭空消失或出现。

process.env.DB_PATH = './.tmp-flowtest/flowtest.db';
process.env.MOCK_API = 'true';

const assert = require('node:assert');
const fs = require('node:fs');

// 只清自己的临时目录，绝不碰生产库所在的 ./data
fs.rmSync('./.tmp-flowtest', { recursive: true, force: true });

const store = require('../src/store');
const mockApi = require('../src/mockApi');
const rp = require('../src/redpacket');
const balance = require('../src/commands/balance');

const USERS = ['alice', 'bob', 'carol', 'dave', 'eve'];
const START = 10000;

// ---------- 假的 Discord 环境 ----------

let msgSeq = 0;
const messageRegistry = {};
const messagePacket = {};     // messageId -> packetId
const sentMessages = [];      // { id, packetId, payload }

const J = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const norm = (p) => ({ ...p, embeds: (p?.embeds ?? []).map(J), components: (p?.components ?? []).map(J) });

function fakeMessage(id) {
  return { id, edit: async () => {} };
}

const channel = {
  id: 'ch1',
  messages: { fetch: async (id) => messageRegistry[id] },
  send: async (payload) => {
    const id = `m${++msgSeq}`;
    messageRegistry[id] = fakeMessage(id);
    const cid = norm(payload).components[0].components[0].custom_id;
    messagePacket[id] = Number(cid.slice('rp_grab_'.length));
    sentMessages.push({ id, packetId: messagePacket[id], payload });
    return messageRegistry[id];
  },
};

rp.setClient({ channels: { fetch: async () => channel } });

function makeInteraction(over = {}) {
  const calls = { deferReply: [], editReply: [], reply: [], showModal: [] };
  const i = {
    user: { id: over.userId, bot: false },
    guildId: 'g1',
    channelId: 'ch1',
    channel,
    customId: over.customId || '',
    deferred: false,
    fields: { getTextInputValue: (k) => (over.fieldValues ? over.fieldValues[k] : '') },
    async deferReply(opts) { this.deferred = true; calls.deferReply.push(opts); },
    async editReply(p) { calls.editReply.push(p); return p; },
    async reply(p) { this.replied = true; calls.reply.push(p); },
    async showModal() {},
    ...over,
  };
  return { i, calls };
}

// ---------- 高层动作 ----------

async function queryBalance(userId) {
  const { i, calls } = makeInteraction({ userId });
  await balance.execute(i);
  const m = norm(calls.editReply[0]).embeds[0].description.match(/\*\*([\d,]+)\*\*/);
  assert(m, `${userId} 的额度卡片应包含数字`);
  return Number(m[1].replace(/,/g, ''));
}

async function sendPacket(userId, count, total) {
  const { i, calls } = makeInteraction({ userId, fieldValues: { count: String(count), total: String(total) } });
  await balance.handleModalSubmit(i);
  return calls.editReply[0].content;
}

async function grab(userId, packetId) {
  const { i, calls } = makeInteraction({ userId, customId: `rp_grab_${packetId}` });
  await rp.handleGrab(i);
  const payload = calls.editReply[0] || calls.reply[0];
  return payload.content;
}

const bal = async (u) => (await mockApi.getBalance(u)).balance;
const packetRow = (id) => store.stmts.getPacket.get(id);

let step = 0;
function section(title) { console.log(`\n${++step}. ${title}`); }

async function main() {
  const packets = {};

  section('发红包：alice 出 4 份 / 100，bob 出 2 份 / 50，carol 出 3 份 / 30');
  assert.match(await sendPacket('alice', 4, 100), /红包盲盒已发到/);
  assert.match(await sendPacket('bob', 2, 50), /红包盲盒已发到/);
  assert.match(await sendPacket('carol', 3, 30), /红包盲盒已发到/);
  const [idA, idB, idC] = sentMessages.map((m) => m.packetId);
  packets[idA] = 'alice 4份/100';
  packets[idB] = 'bob 2份/50';
  packets[idC] = 'carol 3份/30';
  assert.strictEqual(await queryBalance('alice'), START - 100, 'alice 扣款后余额');
  assert.strictEqual(await queryBalance('bob'), START - 50, 'bob 扣款后余额');
  assert.strictEqual(await queryBalance('carol'), START - 30, 'carol 扣款后余额');
  console.log(`   红包 A(#${idA}) B(#${idB}) C(#${idC}) 全部发出，扣款正确`);

  section('抢红包：A 被 bob/carol/dave 抢走 3 份，B 被 carol/eve 抢完，C 被 alice/eve/bob 抢完');
  for (const [uid, pid] of [['bob', idA], ['carol', idA], ['dave', idA],
    ['carol', idB], ['eve', idB], ['alice', idC], ['eve', idC], ['bob', idC]]) {
    const text = await grab(uid, pid);
    assert.match(text, /抢到 \*\*\d+\*\*/, `${uid} 抢红包 #${pid} 应成功：${text}`);
  }
  assert.strictEqual(packetRow(idB).status, 'finished', 'B 应被抢完关闭');
  assert.strictEqual(packetRow(idC).status, 'finished', 'C 应被抢完关闭');
  console.log('   8 笔领取全部到账，B、C 抢完自动关闭');

  section('作弊尝试：重复领取、抢已抢完的红包，一律拒绝');
  assert.match(await grab('bob', idA), /已经领过/, '重复领取应被拒绝');
  assert.match(await grab('eve', idB), /已被抢完/, '抢已抢完的红包应被拒绝');
  console.log('   bob 重复领取被拒 ✓，eve 抢已关闭的 B 被拒 ✓');

  section('非法表单：份数/总额不合法、超额红包，一律拒绝且不扣款');
  const daveBefore = await bal('dave');
  assert.match(await sendPacket('dave', 3, 2), /至少/);
  assert.match(await sendPacket('dave', 0, 10), /个数/);
  assert.match(await sendPacket('dave', 1, 9999999), /不能超过/);
  assert.strictEqual(await bal('dave'), daveBefore, 'dave 余额分文未动');
  assert.strictEqual(sentMessages.length, 3, '不应产生新红包消息');
  console.log('   3 笔非法请求全部拒绝 ✓');

  section('过期退款：A 剩 1 份无人领 → 时间快进 → 剩余额度退回 alice，再抢提示已结束');
  const aliceBefore = await bal('alice');
  const remaining = packetRow(idA).remaining_amount;
  assert(remaining > 0 && packetRow(idA).remaining_count === 1, 'A 应剩 1 份待过期');
  store.db.prepare('UPDATE redpackets SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, idA);
  await rp.expireSweep();
  const expired = packetRow(idA);
  assert.strictEqual(expired.status, 'expired');
  assert.strictEqual(expired.refund_status, 'ok');
  assert.strictEqual(await bal('alice'), aliceBefore + remaining, `alice 应收到退款 ${remaining}`);
  assert.match(await grab('eve', idA), /已结束/, '过期后再抢应提示已结束');
  console.log(`   A 过期，剩余 ${remaining} 已原路退回 alice ✓，过期红包不可再抢 ✓`);

  section('兜底 sweep：再跑两遍也不应改变任何余额（幂等）');
  await rp.expireSweep();
  await rp.expireSweep();
  const snapshot = {};
  for (const u of USERS) snapshot[u] = await bal(u);

  section('总账核对：金额守恒 + 无残留状态');
  const total = USERS.reduce((s, u) => s + snapshot[u], 0);
  assert.strictEqual(total, USERS.length * START,
    `全场总额 ${total} 应等于初始 ${USERS.length * START}，不允许凭空增减`);
  const stragglers = store.db.prepare(
    "SELECT COUNT(*) AS n FROM redpackets WHERE status IN ('active', 'creating')").get().n;
  assert.strictEqual(stragglers, 0, '不应有未了结的红包');
  const badClaims = store.db.prepare(
    "SELECT COUNT(*) AS n FROM claims WHERE credit_status != 'ok'").get().n;
  assert.strictEqual(badClaims, 0, '所有领取都应入账成功');
  const pendingRefunds = store.db.prepare(
    "SELECT COUNT(*) AS n FROM redpackets WHERE refund_status = 'pending'").get().n;
  assert.strictEqual(pendingRefunds, 0, '不应有未完成的退款');

  console.log('\n———— 结账单 ————');
  for (const u of USERS) console.log(`  ${u.padEnd(6)} 余额 ${String(snapshot[u]).padStart(6)}`);
  const claimCount = store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n;
  console.log(`  红包 3 个：2 个抢完、1 个过期退回；领取 ${claimCount} 笔全部到账`);
  console.log(`  总账：${USERS.length} 人合计 ${total} = 初始 ${USERS.length * START} ✓ 分毫不差`);
  console.log('\n整体流程演练：全部通过 ✓');
  store.db.close();
  // 绿灯才清场：失败保留现场供排查，下次开跑时开头的 rmSync 兜底保证无残留
  fs.rmSync('./.tmp-flowtest', { recursive: true, force: true });
}

main().catch((err) => {
  console.error('流程演练失败:', err);
  process.exit(1);
});
