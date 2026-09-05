'use strict';

require('dotenv/config');
const {
  Client, GatewayIntentBits, Events, REST, Routes,
} = require('discord.js');

const store = require('./store');
const rp = require('./redpacket');
const balance = require('./commands/balance');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('缺少 DISCORD_TOKEN 或 CLIENT_ID，请复制 .env.example 为 .env 并填写。');
  process.exit(1);
}
if ((process.env.MOCK_API || 'true').toLowerCase() !== 'true' && !process.env.API_BASE_URL) {
  console.error('MOCK_API=false 时必须配置 API_BASE_URL。');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands(rest) {
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: [balance.command] });
  console.log(`斜杠命令注册完成（${GUILD_ID ? `服务器 ${GUILD_ID}` : '全局'}）`);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`已登录：${c.user.tag}`);
  rp.setClient(client);
  try {
    await registerCommands(new REST().setToken(DISCORD_TOKEN));
  } catch (err) {
    console.error('命令注册失败:', err);
  }
  // 启动时先扫一遍，恢复上次重启遗留的过期红包 / 待重试入账
  rp.expireSweep().catch((err) => console.error('[sweep] 启动扫描异常:', err));
  rp.startSweeper();
  console.log(`红包过期时间 ${rp.EXPIRY_MINUTES} 分钟，数据文件 ${store.DB_PATH}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === '额度查询') {
      await balance.execute(interaction);
    } else if (interaction.isButton() && interaction.customId === 'rp_open') {
      await balance.handleOpenButton(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('rp_grab_')) {
      await rp.handleGrab(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId === 'rp_create') {
      await balance.handleModalSubmit(interaction);
    }
  } catch (err) {
    console.error('交互处理异常:', err);
    const payload = { content: '出错了，请稍后再试。', ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload.content);
      } else if (interaction.isRepliable()) {
        await interaction.reply(payload);
      }
    } catch { /* 消息可能已过期，忽略 */ }
  }
});

process.on('SIGINT', () => client.destroy());
process.on('SIGTERM', () => client.destroy());

client.login(DISCORD_TOKEN);
