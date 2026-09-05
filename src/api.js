'use strict';

// 网站 API 适配层。接口约定见 docs/API_CONTRACT.md，由网站团队实现。
// MOCK_API=true 时切换到内置 mock（src/mockApi.js），调用方无感知。

const { ApiError } = require('./apiError');
const mock = require('./mockApi');

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
  return request('GET', `/api/bot/users/${discordId}/balance`);
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

const impl = (process.env.MOCK_API || 'true').toLowerCase() === 'true' ? mock : {
  getBalance, deduct, credit,
};

module.exports = { ...impl, ApiError };
