'use strict';

const {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} = require('discord.js');
const api = require('../api');
const rp = require('../redpacket');

const command = {
  name: '额度查询',
  description: '查询可用额度，并可发红包盲盒',
};

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const { balance } = await api.getBalance(interaction.user.id);
    await interaction.editReply(rp.balanceCard(interaction.user.id, balance));
  } catch (err) {
    const msg = err.code === 'USER_NOT_FOUND'
      ? '网站里找不到你的账号，请先去网站用 Discord 登录一次再来查额度～'
      : `查询失败：${err.message}`;
    await interaction.editReply({ content: `❌ ${msg}`, embeds: [], components: [] });
  }
}

async function handleOpenButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('rp_create')
    .setTitle('🧧 发红包盲盒')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('count')
        .setLabel('红包个数')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(`1 ~ ${process.env.MAX_COUNT || 100}`)
        .setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('total')
        .setLabel(`总额度（${rp.UNIT_NAME}）`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('每个人至少抢到 1，整数')
        .setRequired(true)),
    );
  await interaction.showModal(modal);
}

async function handleModalSubmit(interaction) {
  // Modal 提交后 3 秒内必须应答，先挂起再处理扣款/发消息
  await interaction.deferReply({ ephemeral: true });

  const result = await rp.createPacket({
    guildId: interaction.guildId,
    channel: interaction.channel,
    senderId: interaction.user.id,
    countText: interaction.fields.getTextInputValue('count'),
    totalText: interaction.fields.getTextInputValue('total'),
  });

  if (!result.ok) {
    await interaction.editReply({ content: `❌ ${result.error}` });
    return;
  }
  await interaction.editReply({
    content: `✅ 红包盲盒已发到 <#${interaction.channelId}>，额度已扣除。` +
      `${rp.EXPIRY_MINUTES} 分钟内没人抢的部分会自动退回。`,
  });
}

module.exports = { command, execute, handleOpenButton, handleModalSubmit };
