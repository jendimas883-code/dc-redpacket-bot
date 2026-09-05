'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const crypto = require('node:crypto');
const store = require('./store');
const api = require('./api');

const EXPIRY_MINUTES = Number(process.env.EXPIRY_MINUTES || 120);
const MAX_COUNT = Number(process.env.MAX_COUNT || 100);
const MAX_TOTAL = Number(process.env.MAX_TOTAL || 1000000);
const UNIT_NAME = process.env.UNIT_NAME || '额度';
const SWEEP_INTERVAL_MS = 30_000;
const CREDIT_RETRY_DELAY_MS = 60_000;

let client = null;
function setClient(c) { client = c; }

const fmt = (n) => Number(n).toLocaleString('en-US');

// 网站明确拒绝、重试也不可能成功的错误。NETWORK/5xx/HTTP_408/409/425 属于结果未知
// （请求可能已在网站生效）——判成未知最多多试几次（同 ref 幂等，重试安全），
// 判成确定丢的是真钱，所以拿不准一律按未知处理，交给 sweep 收敛
const DEFINITIVE_CODES = new Set(['USER_NOT_FOUND', 'INSUFFICIENT_BALANCE', 'UNAUTHORIZED']);
const AMBIGUOUS_HTTP = new Set(['HTTP_408', 'HTTP_409', 'HTTP_425']);
function isDefinitive(err) {
  const code = err?.code || '';
  return DEFINITIVE_CODES.has(code)
    || (/^HTTP_4\d\d$/.test(code) && !AMBIGUOUS_HTTP.has(code));
}

function parseAmount(text) {
  const t = String(text || '').trim();
  if (!/^\d{1,12}$/.test(t)) return null;
  return Number(t);
}

// ---------- 消息渲染 ----------

function balanceCard(userId, balance) {
  return {
    embeds: [new EmbedBuilder()
      .setTitle('💰 额度查询')
      .setColor(0xf1c40f)
      .setDescription(`<@${userId}> 的可用额度：**${fmt(balance)}** ${UNIT_NAME}`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('rp_open')
        .setLabel('🧧 红包盲盒')
        .setStyle(ButtonStyle.Primary),
    )],
    ephemeral: true,
  };
}

function packetEmbed(packet, claims) {
  const done = packet.status !== 'active';
  const lines = claims.slice(0, 20).map((c, i) => {
    let tag = '';
    if (c.credit_status === 'failed') {
      tag = c.refund_status === 'ok' ? '（未到账，已退回发起者）'
        : c.refund_status === 'pending' ? '（未到账，退回中）' : '（未到账）';
    }
    return `${i + 1}. <@${c.user_id}> — **${fmt(c.amount)}** ${UNIT_NAME}${tag}`;
  });
  if (claims.length > 20) lines.push(`…等共 ${claims.length} 人`);

  const footer = packet.status === 'expired'
    ? (packet.refund_status === 'ok'
      ? `已过期，剩余 ${fmt(packet.remaining_amount)} ${UNIT_NAME}已退回`
      : packet.refund_status === 'failed'
        ? `已过期，剩余 ${fmt(packet.remaining_amount)} ${UNIT_NAME}退回失败，请联系管理员`
        : packet.remaining_amount > 0 ? '已过期，剩余额度退回中…' : '已过期')
    : packet.status === 'finished' ? '已抢完'
      : `剩余 ${packet.remaining_count}/${packet.count} 份 · ${
        new Date(packet.expires_at).toLocaleString('zh-CN')} 过期`;

  return new EmbedBuilder()
    .setTitle('🧧 红包盲盒')
    .setColor(done ? 0x95a5a6 : 0xe74c3c)
    .setDescription(
      `<@${packet.sender_id}> 发红包盲盒了！\n` +
      `总额度 **${fmt(packet.total_amount)}** ${UNIT_NAME} · 共 **${packet.count}** 份，拼手气～`)
    .addFields({
      name: '已领取',
      value: lines.length ? lines.join('\n') : '还没有人领取，快来抢第一手！',
    })
    .setFooter({ text: footer })
    .setTimestamp();
}

function packetComponents(packet) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rp_grab_${packet.id}`)
      .setLabel('🧧 点击抢盲盒')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(packet.status !== 'active'),
  )];
}

async function refreshMessage(packet) {
  if (!client || !packet.message_id) return;
  try {
    const channel = await client.channels.fetch(packet.channel_id);
    const msg = await channel.messages.fetch(packet.message_id);
    const claims = store.stmts.listClaims.all(packet.id);
    await msg.edit({
      embeds: [packetEmbed(packet, claims)],
      components: packetComponents(packet),
    });
  } catch (err) {
    console.error(`[redpacket] 刷新红包消息失败 (packet ${packet.id}):`, err.message);
  }
}

// ---------- 发红包 ----------

async function createPacket({ guildId, channel, senderId, countText, totalText }) {
  const count = parseAmount(countText);
  const total = parseAmount(totalText);
  if (!count || count < 1 || count > MAX_COUNT) {
    return { ok: false, error: `红包个数需为 1 ~ ${MAX_COUNT} 的整数` };
  }
  if (!total || total < count) {
    return { ok: false, error: `总额度需为不小于份数（${count}）的整数，保证每份至少 1 ${UNIT_NAME}` };
  }
  if (total > MAX_TOTAL) {
    return { ok: false, error: `单个红包总额度不能超过 ${fmt(MAX_TOTAL)} ${UNIT_NAME}` };
  }

  let balance;
  try {
    ({ balance } = await api.getBalance(senderId));
  } catch (err) {
    const msg = err.code === 'USER_NOT_FOUND'
      ? '网站里找不到你的账号，请先去网站用 Discord 登录一次'
      : `查询余额失败：${err.message}`;
    return { ok: false, error: msg };
  }
  if (balance < total) {
    return { ok: false, error: `可用额度不足：当前 ${fmt(balance)}，需要 ${fmt(total)}` };
  }

  const deductRef = `send_${guildId}_${senderId}_${Date.now()}_${crypto.randomUUID()}`;

  // 先落库（creating，此时还没扣款），之后的每一步失败都有记录可查、可收敛
  let packet;
  try {
    const id = store.stmts.insertPacket.run({
      guild_id: guildId,
      channel_id: channel.id,
      sender_id: senderId,
      total_amount: total,
      count,
      expires_at: Date.now() + EXPIRY_MINUTES * 60_000,
      deduct_ref: deductRef,
      created_at: Date.now(),
      status: 'creating',
    }).lastInsertRowid;
    packet = store.stmts.getPacket.get(id);
  } catch (err) {
    console.error('[redpacket] 红包落库失败（尚未扣款，无资金影响）:', err);
    return { ok: false, error: '创建红包失败，请稍后重试' };
  }

  try {
    await api.deduct(senderId, total, deductRef);
  } catch (err) {
    if (isDefinitive(err)) {
      store.stmts.cancelPacket.run(packet.id);
      const msg = err.code === 'USER_NOT_FOUND'
        ? '网站里找不到你的账号，请先去网站用 Discord 登录一次'
        : `扣款失败：${err.message}`;
      return { ok: false, error: msg };
    }
    // 扣款结果未知（超时/断连）：钱可能扣了也可能没扣，sweep 会用同一 ref
    // 重试到确定结果，然后把额度原路退回，这里不退款不作废
    console.error(`[redpacket] 扣款结果未知，待 sweep 核对 (packet ${packet.id}, ref ${deductRef}):`, err.message);
    return { ok: false, error: '网络波动，红包没有发出去，额度正在核对，稍后会自动退回' };
  }

  try {
    const msg = await channel.send({
      embeds: [packetEmbed(packet, [])],
      components: packetComponents(packet),
    });
    store.stmts.setMessageId.run(msg.id, packet.id);
    store.stmts.activatePacket.run(packet.id);
    return { ok: true, packet: store.stmts.getPacket.get(packet.id) };
  } catch (err) {
    // 发红包后半程失败，把扣掉的钱退回去。退款键固定 refund_${deductRef}：
    // sweep 的 cancelled 分支用同一个键重试，网站幂等层恰好去重（H1 教训：换键 = 双退款）
    console.error('[redpacket] 创建红包失败，退款中:', err);
    let refunded = true;
    try {
      await api.credit(senderId, total, 'redpacket_refund', `refund_${deductRef}`);
    } catch (refundErr) {
      refunded = false;
      console.error('[redpacket] 退款失败，已标记待 sweep 重试:', refundErr, deductRef);
    }
    // 红包从未面世，作废它，否则过期 sweep 会把剩余额度再退一次。
    // 作废与 pending 标记同事务落库（E1）：进程死在中间也不会留下谁都看不见的孤儿行
    store.cancelPacketTx(packet.id, refunded ? null : 'pending');
    return {
      ok: false,
      error: refunded ? '发送失败，额度已退回，请稍后重试' : '发送失败，额度退回遇到网络问题，稍后会自动重试',
    };
  }
}

// ---------- 抢红包 ----------

async function handleGrab(interaction) {
  const packetId = Number(interaction.customId.slice('rp_grab_'.length));
  const userId = interaction.user.id;
  const now = Date.now();

  const result = store.claimTx(packetId, userId, now);
  if (!result.ok) {
    const text = {
      not_found: '这个红包不存在',
      not_active: '手慢了，红包已结束',
      empty: '手慢了，红包已被抢完',
      already: '你已经领过这个红包啦',
    }[result.reason] || '领取失败';
    await interaction.reply({ content: text, ephemeral: true });
    const packet = store.stmts.getPacket.get(packetId);
    if (packet && packet.status !== 'active') await refreshMessage(packet);
    return;
  }

  // 先应答占用 Discord 3 秒窗口；入账要等网站（最长 10 秒），完成后编辑同一条回复
  await interaction.deferReply({ ephemeral: true });

  // 入账失败不回滚领取资格，状态一律留给 sweep 收敛；这里只按错误类型选文案
  let creditNote;
  try {
    await api.credit(userId, result.amount, 'redpacket_claim', `claim_${result.claimId}`);
    store.stmts.setClaimCreditStatus.run('ok', result.claimId);
    creditNote = 'ok';
  } catch (err) {
    creditNote = isDefinitive(err) ? 'rejected' : 'unknown';
    console.error(`[redpacket] 入账失败，待重试 (claim ${result.claimId}):`, err.message);
  }

  const note = {
    ok: `🎉 抢到 **${fmt(result.amount)}** ${UNIT_NAME}！已存入你的额度`,
    rejected: `🎉 抢到 **${fmt(result.amount)}** ${UNIT_NAME}！这份额度暂时无法入账，会退回红包发起者`,
    unknown: `🎉 抢到 **${fmt(result.amount)}** ${UNIT_NAME}！入账稍有延迟，稍后自动到账`,
  }[creditNote];
  await interaction.editReply({ content: note });
  await refreshMessage(store.stmts.getPacket.get(packetId));
}

// ---------- 过期退款 + 待重试入账 ----------

async function expireSweep(now = Date.now()) {
  // 0) 收敛创建中途断掉的红包：用同一个 deduct ref 重试到确定结果，
  //    确认扣上后原路退回；确认没扣上则作废。任何一步网络失败都留在 creating 下轮再试。
  for (const p of store.stmts.getStaleCreating.all(now - CREDIT_RETRY_DELAY_MS)) {
    let deducted = false;
    try {
      await api.deduct(p.sender_id, p.total_amount, p.deduct_ref);
      deducted = true;
      await api.credit(p.sender_id, p.total_amount, 'redpacket_refund', `refund_${p.deduct_ref}`);
      store.stmts.cancelPacket.run(p.id);
    } catch (err) {
      if (isDefinitive(err)) {
        // 扣款被网站明确拒绝 = 钱没扣，直接作废；扣款成功后退款被明确拒绝 = 终态 failed 留人工
        store.cancelPacketTx(p.id, deducted ? 'failed' : null);
        if (deducted) {
          console.error(`[redpacket] 退款被网站拒绝，需人工处理 (packet ${p.id}, ref refund_${p.deduct_ref}):`, err.message);
        }
      } else {
        console.error(`[redpacket] 创建核对未收敛，下轮重试 (packet ${p.id}):`, err.message);
      }
    }
  }

  // 1) 补发之前入账失败的领取
  for (const c of store.stmts.getPendingCredits.all(now - CREDIT_RETRY_DELAY_MS)) {
    try {
      await api.credit(c.user_id, c.amount, 'redpacket_claim', `claim_${c.id}`);
      store.stmts.setClaimCreditStatus.run('ok', c.id);
    } catch (err) {
      if (isDefinitive(err)) {
        // 重试永远不会成功（如用户从未登录网站）：终态 failed，份额退回发送者，
        // 两步同事务，防止这笔钱既不入账也不退回被凭空销毁（H3）
        store.failClaimTx(c.id);
        console.error(`[redpacket] 入账被网站拒绝，份额将退回发起者 (claim ${c.id}):`, err.message);
      } else {
        console.error(`[redpacket] 入账重试失败 (claim ${c.id}):`, err.message);
      }
    }
  }

  // 1b) 把被明确拒绝的领取份额退回发送者（独立键 refund_claim_，与该份额的入账键不重合）
  for (const c of store.stmts.getPendingClaimRefunds.all()) {
    try {
      await api.credit(c.sender_id, c.amount, 'redpacket_refund', `refund_claim_${c.id}`);
      store.stmts.setClaimRefundStatus.run('ok', c.id);
    } catch (err) {
      if (isDefinitive(err)) {
        store.stmts.setClaimRefundStatus.run('failed', c.id);
        console.error(`[redpacket] 份额退款被网站拒绝，停止重试，需人工处理 (claim ${c.id}):`, err.message);
      } else {
        console.error(`[redpacket] 份额退款重试失败 (claim ${c.id}):`, err.message);
      }
    }
  }

  // 2) 到期的红包标记过期
  const newlyExpired = store.stmts.getActiveExpired.all(now);
  for (const p of newlyExpired) {
    store.stmts.expirePacket.run(p.id);
    await refreshMessage(store.stmts.getPacket.get(p.id));
  }

  // 3) 退回剩余/全部额度。退款键按 status 分流（H1 教训：换键 = 绕过网站幂等）：
  //    cancelled（从未面世的红包）→ 用扣款 ref 派生的键，与首次补偿退款同一键，重试恰好去重；
  //    expired（发出后没人抢完的剩余）→ 独立的一笔钱，用 refund_<packetId>。
  //    其他组合不换键不静默跳过，留日志人工处理。
  for (const p of store.stmts.getPendingRefunds.all()) {
    let ref;
    if (p.status === 'cancelled') {
      if (!p.deduct_ref) {
        console.error(`[redpacket] 作废红包缺少 deduct_ref，无法构造退款幂等键，需人工处理 (packet ${p.id})`);
        continue;
      }
      ref = `refund_${p.deduct_ref}`;
    } else if (p.status === 'expired') {
      ref = `refund_${p.id}`;
    } else {
      console.error(`[redpacket] 未预期的待退款组合 (packet ${p.id}, status ${p.status})，留人工处理`);
      continue;
    }
    try {
      await api.credit(p.sender_id, p.remaining_amount, 'redpacket_refund', ref);
      store.stmts.setRefundStatus.run('ok', p.id);
      await refreshMessage(store.stmts.getPacket.get(p.id));
    } catch (err) {
      if (isDefinitive(err)) {
        store.stmts.setRefundStatus.run('failed', p.id);
        console.error(`[redpacket] 退款被网站明确拒绝，停止重试，需人工处理 (packet ${p.id}, ref ${ref}):`, err.message);
      } else {
        console.error(`[redpacket] 退款失败，待重试 (packet ${p.id}):`, err.message);
      }
    }
  }
}

function startSweeper() {
  const timer = setInterval(() => {
    expireSweep().catch((err) => console.error('[redpacket] sweep 异常:', err));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = {
  setClient,
  balanceCard,
  createPacket,
  handleGrab,
  expireSweep,
  startSweeper,
  parseAmount,
  UNIT_NAME,
  EXPIRY_MINUTES,
};
