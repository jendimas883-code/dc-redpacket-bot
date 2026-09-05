# DC 红包盲盒机器人

Discord 机器人：用户查询自己在网站上的额度，一键发"拼手气红包盲盒"到频道，其他人点按钮抢，没人领的部分到期自动退回。

## 功能

- `/额度查询` — 查看可用额度，卡片下方有「🧧 红包盲盒」按钮
- 点击按钮弹出表单，填**红包个数**和**总额度**，确认后红包发到当前频道
- 其他人点「🧧 点击抢盲盒」按钮抢，微信式拼手气拆分，每人限领一份
- 过期（默认 **2 小时**，可配置）后剩余额度自动退回发送者
- bot 重启不丢账：红包和领取记录在 SQLite，未领完的红包重启后照常退款

网站对接：bot 不直接碰网站数据库，只调 3 个接口（查余额 / 扣款 / 入账）。接口由网站团队按 [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) 实现；实现好之前，bot 自带 mock 模式可以完整跑通全部流程。

## 准备：创建 Discord 应用（约 5 分钟）

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**，起个名字。
2. 左侧 **Bot** → **Reset Token**，复制 token（只显示一次）。
3. 左侧 **General Information** → 复制 **Application ID**。
4. 左侧 **OAuth2 → URL Generator**：勾选 `bot` 和 `applications.commands` 两个 scope；Bot Permissions 勾选 `Send Messages`、`Embed Links`、`Read Message History`。复制生成的 URL，在浏览器打开，把 bot 拉进你的服务器。
5. 服务器里右键 bot 头像可复制其 ID；服务器 ID：设置里打开"开发者模式"后右键服务器名复制。

不需要开启任何 Privileged Gateway Intents。

## 安装与配置

需要 Node.js 20+。

```bash
npm install
copy .env.example .env   # Windows；Linux/Mac 用 cp
```

编辑 `.env`：

| 变量 | 说明 |
|---|---|
| `DISCORD_TOKEN` | 上一步拿到的 bot token |
| `CLIENT_ID` | Application ID |
| `GUILD_ID` | 测试服务器 ID（可选，填了命令秒级生效；留空则全局注册，最长等 1 小时） |
| `MOCK_API` | `true` 用内置 mock（默认）；网站接口就绪后改 `false` |
| `API_BASE_URL` / `API_KEY` | 真实网站接口地址和密钥（`MOCK_API=false` 时必填） |
| `EXPIRY_MINUTES` | 红包过期分钟数，默认 `120` |
| `MAX_COUNT` / `MAX_TOTAL` | 单包份数 / 总额度上限，默认 `100` / `1000000` |
| `UNIT_NAME` | 额度显示名称，默认 `额度` |
| `DB_PATH` | SQLite 文件位置，默认 `./data/bot.db` |

mock 模式下每个用户初始有 10000 额度（可用 `MOCK_START_BALANCE` 改），重启清零。

## 运行

```bash
npm start          # 前台运行
npm run selftest   # 核心逻辑自测（不需要 Discord token）
```

生产环境建议 pm2：

```bash
npm install -g pm2
pm2 start src/index.js --name dc-redpacket-bot
pm2 save
```

## 验证清单

1. `npm start` 后日志出现"斜杠命令注册完成"
2. 服务器里输入 `/额度查询`，出现额度卡片和红包按钮（mock 模式应显示 10,000）
3. 点「🧧 红包盲盒」→ 填个数和总额度 → 频道出现红包消息
4. 另一个账号点按钮抢 → 卡片实时更新领取列表和金额
5. 等过期（可临时把 `EXPIRY_MINUTES` 调小测试）→ 卡片显示"已过期"，剩余额度退回发送者

## 项目结构

```
src/
├── index.js            # 入口：登录、命令注册、交互分发
├── commands/balance.js # /额度查询 + 红包表单（Modal）
├── redpacket.js        # 发红包、抢、拼手气拆分、过期退款
├── store.js            # SQLite 记录（红包 / 领取 / 退款状态）
├── api.js              # 网站 API 适配层（唯一对接点）
├── mockApi.js          # 内置 mock，行为与 docs/API_CONTRACT.md 一致
└── apiError.js
docs/API_CONTRACT.md    # 给网站团队的接口文档
scripts/selftest.js     # 核心逻辑自测
```

## 给网站团队的对接要点

见 [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)。两件事最重要：

1. **扣款必须原子**（事务内校验余额并扣减，防并发扣成负数）；
2. **扣款/入账都按 `ref` 幂等去重**（bot 网络重试会带同一个 `ref`，重复请求不得重复记账）。

联调：网站侧实现完接口 → bot `.env` 改 `MOCK_API=false`、填 `API_BASE_URL` 和 `API_KEY` → 重启 bot，零代码改动。
