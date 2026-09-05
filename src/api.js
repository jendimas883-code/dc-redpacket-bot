'use strict';

// 网站 API 适配层。接口约定见 docs/API_CONTRACT.md，由网站团队实现。
// MOCK_API=true 时切换到内置 mock（src/mockApi.js），调用方无感知。

const { ApiError } = require('./apiError');

const BASE_URL = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY || '';
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 10000);

async function request(method, pathname, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE_URL + pathname, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Key': API_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError('NETWORK', `网站接口连不上：${err.cause?.code || err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应按错误处理 */ }

  if (!res.ok) {
    const code = data?.error?.code || `HTTP_${res.status}`;
    const message = data?.error?.message || `网站接口返回 ${res.status}`;
    throw new ApiError(code, message, res.status);
  }
  return data?.data ?? data ?? {};
}

async function getBalance(discordId) {
  const data = await request('GET', `/api/bot/users/${discordId}/balance`);
  if (typeof data.balance !== 'number') {
    throw new ApiError('BAD_RESPONSE', '网站返回的余额格式不对');
  }
  return data;
}

async function deduct(discordId, amount, ref) {
  return request('POST', '/api/bot/redpacket/deduct', {
    discordId, amount, ref, reason: 'redpacket_send',
  });
}

async function credit(discordId, amount, purpose, ref) {
  return request('POST', '/api/bot/redpacket/credit', {
    discordId, amount, purpose, ref,
  });
}

// MOCK_API 未配置时默认走 mock（本地开发零配置可跑），但真实部署忘配会静默用假额度——
// 所以 IS_MOCK 随模块导出，index.js 启动时必须把运行模式打到日志里
const IS_MOCK = (process.env.MOCK_API || 'true').toLowerCase() === 'true';

const impl = IS_MOCK
  ? require('./mockApi') // 惰性加载：真实模式下不引入 mock 模块
  : { getBalance, deduct, credit };

module.exports = { ...impl, ApiError, IS_MOCK };
