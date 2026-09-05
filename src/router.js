'use strict';

// interaction 分发路由。独立成模块是为了让 e2etest 能直接驱动它——
// index.js 里的 client.on 回调无法在测试中加载（会触发登录）。

const rp = require('./redpacket');
const balance = require('./commands/balance');

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === '额度查询') {
      await balance.execute(interaction);
    } else if (interaction.isButton() && interaction.customId === 'rp_open') {
      await balance.handleOpenButton(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('rp_grab_')) {
      await rp.handleGrab(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId === 'rp_create') {
      await balance.handleModalSubmit(interaction);
    } else if (interaction.isAutocomplete()) {
      // 本 bot 无自动补全，无需应答
    } else {
      // 未知交互必须有应答 + 有日志：静默丢弃会让用户看到「交互失败」而服务端无痕
      console.warn(`[router] 未匹配的交互: customId=${interaction.customId || '-'}, commandName=${interaction.commandName || '-'}`);
      if (interaction.isRepliable() && !interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: '未知操作，请重试或联系管理员。', ephemeral: true });
      }
    }
  } catch (err) {
    console.error('交互处理异常:', err);
    const content = '出错了，请稍后再试。';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content);
      } else if (interaction.isRepliable()) {
        await interaction.reply({ content, ephemeral: true });
      }
    } catch (replyErr) {
      // 双重故障（处理失败 + 错误回复也失败）：只能留日志
      console.error('[router] 错误回复也失败:', replyErr.message);
    }
  }
}

module.exports = { handleInteraction };
