'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
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
  const lines = claims.slice(0, 20).map((c, i) =>
    `${i + 1}. <@${c.user_id}> — **${fmt(c.amount)}** ${UNIT_NAME}`);
  if (claims.length > 20) lines.push(`…等共 ${claims.length} 人`);

  const footer = packet.status === 'expired'
    ? (packet.refund_status === 'ok'
      ? `已过期，剩余 ${fmt(packet.remaining_amount)} ${UNIT_NAME}已退回`
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

  const deductRef = `send_${guildId}_${senderId}_${Date.now()}`;
  try {
    await api.deduct(senderId, total, deductRef);
  } catch (err) {
    return { ok: false, error: `扣款失败：${err.message}` };
  }

  let packet;
  try {
    const id = store.stmts.insertPacket.run({
      guild_id: guildId,
      channel_id: channel.id,
      sender_id: senderId,
      total_amount: total,
      count,
      expires_at: Date.now() + EXPIRY_MINUTES * 60_000,
    }).lastInsertRowid;
    packet = store.stmts.getPacket.get(id);

    const msg = await channel.send({
      embeds: [packetEmbed(packet, [])],
      components: packetComponents(packet),
    });
    store.stmts.setMessageId.run(msg.id, id);
    packet.message_id = msg.id;
    return { ok: true, packet };
  } catch (err) {
    // 发红包后半程失败，把扣掉的钱退回去（credit 幂等，重试安全）
    console.error('[redpacket] 创建红包失败，退款中:', err);
    try {
      await api.credit(senderId, total, 'redpacket_refund', `refund_send_${deductRef}`);
    } catch (refundErr) {
      console.error('[redpacket] 退款也失败了，需人工处理:', refundErr, deductRef);
    }
    return { ok: false, error: '发送失败，额度已退回，请稍后重试' };
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

  // 入账失败不回滚领取资格，标记 pending 由定时任务用同一幂等键重试
  let creditOk = true;
  try {
    await api.credit(userId, result.amount, 'redpacket_claim', `claim_${result.claimId}`);
    store.stmts.setClaimCreditStatus.run('ok', result.claimId);
  } catch (err) {
    creditOk = false;
    console.error(`[redpacket] 入账失败，待重试 (claim ${result.claimId}):`, err.message);
  }

  await interaction.reply({
    content: creditOk
      ? `🎉 抢到 **${fmt(result.amount)}** ${UNIT_NAME}！已存入你的额度`
      : `🎉 抢到 **${fmt(result.amount)}** ${UNIT_NAME}！入账稍有延迟，稍后自动到账`,
    ephemeral: true,
  });
  await refreshMessage(store.stmts.getPacket.get(packetId));
}

// ---------- 过期退款 + 待重试入账 ----------

async function expireSweep(now = Date.now()) {
  // 1) 补发之前入账失败的领取
  for (const c of store.stmts.getPendingCredits.all(now - CREDIT_RETRY_DELAY_MS)) {
    try {
      await api.credit(c.user_id, c.amount, 'redpacket_claim', `claim_${c.id}`);
      store.stmts.setClaimCreditStatus.run('ok', c.id);
    } catch (err) {
      console.error(`[redpacket] 入账重试失败 (claim ${c.id}):`, err.message);
    }
  }

  // 2) 到期的红包标记过期
  const newlyExpired = store.stmts.getActiveExpired.all(now);
  for (const p of newlyExpired) {
    store.stmts.expirePacket.run(p.id);
    await refreshMessage(store.stmts.getPacket.get(p.id));
  }

  // 3) 退回剩余额度给发送者
  for (const p of store.stmts.getPendingRefunds.all()) {
    try {
      await api.credit(p.sender_id, p.remaining_amount, 'redpacket_refund', `refund_${p.id}`);
      store.stmts.setRefundStatus.run('ok', p.id);
      await refreshMessage(store.stmts.getPacket.get(p.id));
    } catch (err) {
      console.error(`[redpacket] 退款失败，待重试 (packet ${p.id}):`, err.message);
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
