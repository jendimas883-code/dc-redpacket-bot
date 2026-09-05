# AGENTS.md — dc-redpacket-bot 项目规范

Discord 红包盲盒机器人：查网站额度、发拼手气红包、抢红包、过期退回。技术面与运行方式见 [README.md](README.md)；对外接口契约见 [docs/API_CONTRACT.md](docs/API_CONTRACT.md)；工作流参数（测试命令、机械闸、风险面、协作模型）在 [.zcode/workflow.md](.zcode/workflow.md)。本文件是项目事实源，与 workflow.md 冲突时先改这里再同步。

## 架构边界（不可打破）

- **bot 不碰网站数据库**。与网站的全部交互收敛在 `src/api.js` 一个适配层，只有 3 个调用：`getBalance` / `deduct` / `credit`。换接口只改 api.js + API_CONTRACT.md。
- `src/mockApi.js` 是 `MOCK_API=true` 时的同签名实现，**行为必须与 API_CONTRACT.md 一致**（尤其幂等语义）——selftest 对 mock 断言幂等，改 mock 语义先过测试。
- Discord 侧只做展示与收集：`src/index.js`（入口/分发）、`src/commands/balance.js`（命令+表单）、`src/redpacket.js`（业务）、`src/store.js`（SQLite 状态）。业务逻辑不 import discord.js（redpacket.js 除外：渲染与刷新消息），保证 selftest 无 token 可跑。

## 资金红线（绝对型不变量，任何 diff 触及都要最严格对待）

1. **记账恰好一次**：扣款/入账/退款全部靠 `ref` 幂等，网络重试带同一个 ref 不得重复记账。ref 命名约定见 workflow.md〈风险面〉，改格式需迁移论证。
2. **扣款前置校验**：发红包先 `getBalance` 校验再 `deduct`；校验通过≠扣款成功，扣款失败原样返回错误，不产生红包记录。
3. **失败必有补偿**：任何"钱已动、后续步骤失败"的路径都要退回（见 `createPacket` 的 catch 退款），入账失败落 pending 由 `expireSweep` 用同一幂等键重试，禁止丢钱。
4. **并发安全**：抢红包的判重、扣减、状态流转全在 `store.claimTx` 事务内（better-sqlite3 同步事务），禁止移出事务或改成异步判断。
5. **金额是整数**：额度最小单位 1，全程整数运算（SQLite INTEGER + Number），禁止引入浮点/小数；输入走 `parseAmount` 白名单（`/^\d{1,12}$/`）。

## 代码风格

- CommonJS（`require` / `module.exports`），每文件顶部 `'use strict';`，2 空格缩进，单引号，分号。
- 用户可见文案（embed/按钮/错误提示）用中文；代码注释也用中文，只写代码本身说不清的约束（如"入账失败不回滚领取资格"），不写流水账。
- 错误日志统一 `console.error('[模块名] 描述:', err)`；面向用户的信息永远中文、不含堆栈。
- 配置一律走 `.env`（读 `process.env` + 默认值），新配置项同步三处：`.env.example`、README 配置表格、实际使用处。

## 测试规范

- 两套自测脚本（无测试框架，见 workflow.md〈测试命令〉）：
  - `scripts/selftest.js` — 核心逻辑，每个用例是 `ok('名字', fn)`；改 store/redpacket/mockApi 必须在这里补用例。
  - `scripts/e2etest.js` — 用假 interaction 对象驱动真实 handler；改 commands/ 或交互流程在这里补用例。
- **资金路径的用例必须含失败注入**（发送失败退款、入账失败补发——参照现有 `频道发送失败时自动退款` / `入账失败的领取由 sweep 补发` 用例）。
- 测试自带环境（临时 DB + MOCK_API），跑完不残留：两套都 `fs.rmSync('./data', ...)` 清场。
- 提交前跑 `npm run selftest && npm run e2etest`，两段"全部通过 ✓"才算绿。

## 环境与依赖

- Node ≥20（本机 v24）。依赖保持最小：目前只有 discord.js / better-sqlite3 / dotenv，加依赖先问一句"标准库或现有依赖能不能干"。
- **better-sqlite3 原生模块**：本机 npm 走 npmmirror、无 VS 编译环境，安装必须用二进制镜像：
  ```bash
  npm_config_better_sqlite3_binary_host_mirror="https://registry.npmmirror.com/-/binary/better-sqlite3" npm install
  ```
  升级 better-sqlite3 大版本后先 `node -e "require('better-sqlite3')(':memory:')"` 确认预编译二进制加载成功。
- 安全：`DISCORD_TOKEN` / `API_KEY` 只存在于 `.env`（gitignore），不进日志、不进提交、不写进任何文档示例。

## 部署

前台 `npm start`；生产 pm2（`pm2 start src/index.js --name dc-redpacket-bot`）。重启不丢账：未领完红包与 pending 入账由启动时 `expireSweep()` 扫描恢复——依赖"DB 是唯一真相，消息展示可以重建"这一原则。
