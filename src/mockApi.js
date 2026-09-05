'use strict';

// 内置 mock：实现 docs/API_CONTRACT.md 约定的行为，网站接口没好之前用于本地开发测试。
// 每个新用户默认 10000 额度，钱在内存里，重启即重置。

const { ApiError } = require('./apiError');

const START_BALANCE = Number(process.env.MOCK_START_BALANCE || 10000);

/** discordId -> balance */
const balances = new Map();
/** 已处理过的幂等键（deduct/credit 各一套），重放直接返回成功 */
const seenDeduct = new Set();
const seenCredit = new Set();

function balanceOf(discordId) {
  if (!balances.has(discordId)) balances.set(discordId, START_BALANCE);
  return balances.get(discordId);
}

async function getBalance(discordId) {
  return { balance: balanceOf(discordId) };
}

async function deduct(discordId, amount, ref) {
  if (seenDeduct.has(ref)) return { balance: balanceOf(discordId) };
  const balance = balanceOf(discordId);
  if (balance < amount) {
    throw new ApiError('INSUFFICIENT_BALANCE', `余额不足：当前 ${balance}，需要 ${amount}`);
  }
  balances.set(discordId, balance - amount);
  seenDeduct.add(ref);
  return { balance: balance - amount };
}

async function credit(discordId, amount, purpose, ref) {
  if (seenCredit.has(ref)) return { balance: balanceOf(discordId) };
  const balance = balanceOf(discordId);
  balances.set(discordId, balance + amount);
  seenCredit.add(ref);
  return { balance: balance + amount };
}

/** 测试辅助：清空状态 */
function reset() {
  balances.clear();
  seenDeduct.clear();
  seenCredit.clear();
}

module.exports = { getBalance, deduct, credit, reset, balances };
