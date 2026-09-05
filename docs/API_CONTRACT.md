# Discord 红包机器人 — 网站 API 对接文档

Bot 通过这套接口读写网站的用户额度。**网站是 Discord OAuth 登录，所以网站用户表里的 Discord ID 就是 bot 的用户标识**，bot 直接用 Discord 用户 ID 调接口，没有绑定流程。

- 基地址由 bot 侧 `.env` 的 `API_BASE_URL` 配置，下文路径都是相对该基地址。
- 请求和响应均为 `application/json`。
- **金额一律使用整数最小单位**（比如 1 = 1 额度），避免浮点误差；bot 侧不会发送小数。
- 网站接口没实现之前，bot 可用内置 mock 模式（`MOCK_API=true`）独立运行，接口行为与本文档一致。

## 鉴权

每个请求带请求头：

```
X-Bot-Key: <API_KEY>
```

`API_KEY` 由网站生成后配置到 bot 的 `.env`，建议用长随机串。校验失败返回 `401`。

## 统一响应格式

成功（HTTP 200）：

```json
{ "ok": true, "data": { "...": "..." } }
```

失败（HTTP 4xx/5xx）：

```json
{
  "ok": false,
  "error": { "code": "INSUFFICIENT_BALANCE", "message": "余额不足" }
}
```

bot 会把 `error.code` 用于日志和重试判断，`error.message` 直接展示给用户，请写成用户能看懂的中文。

## 接口列表

### 1. 查询余额

```
GET /api/bot/users/{discordId}/balance
```

响应 `data`：

```json
{ "balance": 12345 }
```

- 用户不存在时返回 `404`，`error.code = "USER_NOT_FOUND"`。

### 2. 发红包扣款

```
POST /api/bot/redpacket/deduct
```

请求体：

```json
{
  "discordId": "123456789012345678",
  "amount": 500,
  "ref": "send_987654321_123456789012345678_1725300000000",
  "reason": "redpacket_send"
}
```

响应 `data`：

```json
{ "balance": 11845 }
```

**要求（重要）**：

- 必须是**数据库事务内的原子扣款**：余额不足则整体失败，绝不允许并发扣成负数。
- 余额不足返回 `409`，`error.code = "INSUFFICIENT_BALANCE"`。
- `ref` 是幂等键：同一个 `ref` 重复请求**不得重复扣款**，直接返回成功（网络重试时 bot 会带同一个 `ref`）。建议建一张唯一索引的流水表落实。

### 3. 红包入账（抢到 / 过期退回，同一个接口）

```
POST /api/bot/redpacket/credit
```

请求体（抢到）：

```json
{
  "discordId": "234567890123456789",
  "amount": 88,
  "purpose": "redpacket_claim",
  "ref": "claim_42"
}
```

请求体（过期退回给发送者）：

```json
{
  "discordId": "123456789012345678",
  "amount": 120,
  "purpose": "redpacket_refund",
  "ref": "refund_7"
}
```

响应 `data`：

```json
{ "balance": 88 }
```

**要求（重要）**：

- `ref` 全局唯一幂等：同一 `ref` 重复请求不得重复入账。bot 侧 `ref` 规则固定为 `claim_{领取记录ID}` 和 `refund_{红包ID}`，天然唯一，落库时对 `ref` 建唯一索引即可。
- 入账必须成功后 bot 才标记完成；网络抖动时 bot 会用同一 `ref` 重试，网站必须能正确去重。

## 错误码约定

| code | HTTP | 含义 | bot 的处理 |
|---|---|---|---|
| `USER_NOT_FOUND` | 404 | Discord ID 在网站没有对应用户 | 提示用户先在网站用 Discord 登录一次 |
| `INSUFFICIENT_BALANCE` | 409 | 余额不足 | 直接展示 message |
| `UNAUTHORIZED` | 401 | X-Bot-Key 不对 | 记日志，不重试 |
| `NETWORK` | - | bot 连不上网站（bot 侧错误码） | 记日志，红包退款走重试 |

## 实现顺序建议

先实现 1 和 2（查询 + 扣款），bot 即可发红包；3 影响抢和退款，抓紧跟上。联调时把 bot 的 `.env` 改为 `MOCK_API=false` + 真实 `API_BASE_URL` / `API_KEY` 即可，bot 代码零改动。
