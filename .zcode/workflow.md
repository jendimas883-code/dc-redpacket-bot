# dc-redpacket-bot 工作流参数

> 用户级十命令（/design /implement /ship 等）执行前先读本文件；本文件与命令正文冲突时以本文件为准。
> 事实源是项目根 `AGENTS.md`——转写自事实源的参数（代码风格、依赖环境）先改 AGENTS.md 再同步到这里。
> 建档：2026-09-05（初始提交 c677bd4 后）。

## 主分支

`main`

## 协作模型

**直推型**（个人单人项目，无评审人）：

- 小改动可直接提交 main，每提交保持可独立回退（英文 conventional commit，一个主题一个提交）。
- 触及〈风险面〉的改动从 main 建 `feat/*` / `fix/*` 分支，完成并过闸后再合并回 main。
- push 一律需用户批准（hook 强制，命令尾加 `#APPROVED`）；本项目无远程评审流程，合并即落地。
- 若日后转为多人 / PR 评审，改本节为 PR 型并同步 /ship 的流程。

## 测试命令

- **全量档（Exit 闸 / 机械闸用）**：
  ```bash
  npm run selftest && npm run e2etest && npm run flowtest
  ```
  预期输出各段 `全部通过 ✓`（2026-09-05 基线：selftest 11/11，e2etest 14/14，flowtest 全部通过）。数量随用例增加，汇报引用真实输出行。
- **分层**：三套脚本各覆盖一层：
  - `npm run selftest` = 核心逻辑（store 事务 / splitRand 拆分 / mockApi 幂等 / expireSweep / createPacket / 旧库迁移）
  - `npm run e2etest` = 交互层（假 Discord interaction 驱动 balance + redpacket 全流程 + 失败注入）
  - `npm run flowtest` = 整体流程演练（多用户多红包交错剧本 + 金额守恒总账核对）
  - `npm run soaktest` = 稳定性连跑（默认 10 轮 × 三套，传参可调轮数）
- 测试不需要 Discord token 和真实网站接口（强制 `MOCK_API=true`、`DB_PATH` 指向各自独立临时目录 `.tmp-selftest/`、`.tmp-e2etest/`、`.tmp-flowtest/`，整目录清空重建，**绝不碰生产库所在的 `./data/`**）。
- **不引入测试框架**（vitest/jest 等）：沿用 `scripts/` 现有自写断言风格（`node:assert` + `ok()` 包装 + `process.exitCode`）。新功能在对应层补用例，资金路径必须含失败注入用例。

## 机械闸

无独立闸门脚本，/ship 第一步逐项跑并引用输出：

1. `npm run selftest && npm run e2etest && npm run flowtest` 全绿（引用输出行）；
2. `node --check src/index.js`（入口文件不被测试加载，语法单独核；其余 src 模块已被测试 require 覆盖）；
3. `git status` 干净，无遗留临时文件 / 调试插桩（`.tmp-*` 测试目录跑完即清）。

无凭据文件：无前端 → 无 ui-check 凭据；`plan/.state/self-review.json` 仅在跑过 /self-review 后存在，存在时机械闸核对 branch/head 与实际一致。

## 风险面（绝对型不变量）

以下任一被 diff 触及 = 资金/恰好一级别，冷审必须逐条论证、修复必须过第十人协议、/self-review 必须显式问用户是否升级 /red-team：

- **资金恰好一次**：扣款（`createPacket` → `api.deduct`）、入账（`api.credit`）、退款（`redpacket_refund`）三条路径都靠 ref 幂等去重，重复请求不得重复记账。
- **幂等 ref 约定**：`send_<guild>_<sender>_<ts>_<uuid>`（扣款）/ `claim_{claimId}`（领取入账）/ `refund_{packetId}`（过期退回）/ `refund_${deductRef}` = `refund_send_<guild>_<sender>_<ts>_<uuid>`（发送失败补偿，**三处统一同键**：createPacket 内联首退、sweep 阶段 0、阶段 3 cancelled 臂）/ `refund_claim_{claimId}`（领取份额退回发送者）。改 ref 格式 = 改幂等键，需迁移与存量论证，不走快车道；**同一笔钱的补偿重试禁止换键**（换键 = 绕过网站幂等 = 双记账）。
- **SQLite 状态机**：`redpackets.status`（creating→active→finished/expired；失败面世→cancelled，终态）、`redpackets.refund_status`（none/pending/ok/failed 终态）、`claims.credit_status`（pending/ok/failed 终态）、`claims.refund_status`（none/pending/ok/failed 终态）。并发抢红包的正确性全靠 `store.claimTx` 事务——禁止把领取判断 / 扣减移出事务，禁止给非幂等的 credit 调用加"直接重试"；作废与补偿标记必须同事务（`cancelPacketTx` / `failClaimTx`），禁止拆成裸语句。
- **失败补偿收敛**：任何异步副作用（credit/deduct/发消息）失败都必须有补偿路径，且补偿以 DB 记录为准由 sweep 重试收敛（`expireSweep` 五段：收敛 creating 的未知扣款 → 补发 pending 入账（definitive 拒绝 → 份额退回发送者）→ 退回被拒份额 → 标记过期 → 按 status 分流退剩余/全部）；新增异步副作用必须回答"进程死在半路怎么办"。确定/未知错误判据在 `isDefinitive`：`HTTP_408/409/425`、5xx、NETWORK 一律按未知（同 ref 重试收敛），判成确定丢的是真钱。
- **对外契约**：`docs/API_CONTRACT.md` 是给网站团队的接口契约（含原子扣款、ref 幂等两条硬要求）。改它 = 改对外接口契约，不走快车道；`src/api.js` 是唯一对接点，mock（`src/mockApi.js`）与真实实现必须行为一致（selftest 对 mock 断言了幂等语义）。

## 路径

- `src/` 源码；`scripts/` 测试脚本；`docs/API_CONTRACT.md` 对外契约
- `data/` 运行时 SQLite（gitignore）；`.env` 秘密（gitignore，`.env.example` 是唯一模板，加配置项先改它和 README 表格）
- 〈主题文档目录〉：`plan/<主题>/`（design.md / tasks.md / diagnosis.md / handoff.md）
- 〈状态目录〉：`plan/.state/`（self-review.json、tmp/rev.diff 等，gitignore）

## 前端

无前端项目（纯 Discord bot，无 HTML/CSS/浏览器面）。ui-check、产物规则、前端类型检查均不适用。

## 验证环境

- 本机：Windows 10 / Git Bash / Node v24.11.1。`engines` 声明 `>=20`，实际以本机 Node 24 为准。
- **真实环境档 = mock 模式全流程自测**（两套测试 + 手动 `npm start` 过 README 验证清单）。
- 网站真实接口（`MOCK_API=false`）联调属外部依赖，未联调即显式声明「未验证」并附原因；涉及真实接口的改动不得预写"不连真实环境"。
- **原生模块安装注意**：本机 npm 走 npmmirror 且无 Visual Studio 编译环境，better-sqlite3 必须走二进制镜像安装，命令见 AGENTS.md〈环境与依赖〉。

## 产物规则

无构建产物（源码直跑，无编译/打包步骤）。不适用。

## 可选资产

- quality-bar：`~/.zcode/plan/quality-bar.md`（冷审阶段二照读；其中第 1 类资金 fail-closed / 第 6 类 mock 保真与本仓库风险面高度相关）。
- 案例分册路由表：无（项目尚无 casebook）。
- 路径索引脚本：无定义（备料时省略该项）。
