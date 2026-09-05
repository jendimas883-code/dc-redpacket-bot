'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/bot.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS redpackets (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    message_id       TEXT,
    sender_id        TEXT NOT NULL,
    total_amount     INTEGER NOT NULL,
    count            INTEGER NOT NULL,
    remaining_amount INTEGER NOT NULL,
    remaining_count  INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    deduct_ref       TEXT,
    created_at       INTEGER,
    status           TEXT NOT NULL DEFAULT 'active',
    refund_status    TEXT NOT NULL DEFAULT 'none'
  );
  CREATE TABLE IF NOT EXISTS claims (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    packet_id     INTEGER NOT NULL REFERENCES redpackets(id),
    user_id       TEXT NOT NULL,
    amount        INTEGER NOT NULL,
    claimed_at    INTEGER NOT NULL,
    credit_status TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(packet_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_claims_packet ON claims(packet_id);
`);

// 老库平滑升级：新列已存在时 ALTER 会报错，忽略即可
try { db.exec('ALTER TABLE redpackets ADD COLUMN deduct_ref TEXT'); } catch { /* 已有该列 */ }
try { db.exec('ALTER TABLE redpackets ADD COLUMN created_at INTEGER'); } catch { /* 已有该列 */ }

const stmts = {
  insertPacket: db.prepare(`
    INSERT INTO redpackets (guild_id, channel_id, sender_id, total_amount, count,
                            remaining_amount, remaining_count, expires_at,
                            deduct_ref, created_at, status)
    VALUES (@guild_id, @channel_id, @sender_id, @total_amount, @count,
            @total_amount, @count, @expires_at,
            @deduct_ref, @created_at, @status)`),
  setMessageId: db.prepare('UPDATE redpackets SET message_id = ? WHERE id = ?'),
  getPacket: db.prepare('SELECT * FROM redpackets WHERE id = ?'),
  getActiveExpired: db.prepare(
    "SELECT * FROM redpackets WHERE status = 'active' AND expires_at <= ?"),
  getStaleCreating: db.prepare(
    "SELECT * FROM redpackets WHERE status = 'creating' AND created_at <= ?"),
  activatePacket: db.prepare(
    "UPDATE redpackets SET status = 'active' WHERE id = ? AND status = 'creating'"),
  // 作废从未成功面世的红包：不能再被抢，也不会被过期 sweep 二次退款
  cancelPacket: db.prepare(
    "UPDATE redpackets SET status = 'cancelled' WHERE id = ? AND status IN ('creating', 'active')"),
  finishPacket: db.prepare("UPDATE redpackets SET status = 'finished' WHERE id = ?"),
  expirePacket: db.prepare(`
    UPDATE redpackets
    SET status = 'expired',
        refund_status = CASE WHEN remaining_amount > 0 THEN 'pending' ELSE 'none' END
    WHERE id = ? AND status = 'active'`),
  setRefundStatus: db.prepare('UPDATE redpackets SET refund_status = ? WHERE id = ?'),
  getPendingRefunds: db.prepare("SELECT * FROM redpackets WHERE refund_status = 'pending'"),
  insertClaim: db.prepare(`
    INSERT INTO claims (packet_id, user_id, amount, claimed_at, credit_status)
    VALUES (?, ?, ?, ?, ?)`),
  getClaim: db.prepare('SELECT * FROM claims WHERE packet_id = ? AND user_id = ?'),
  listClaims: db.prepare('SELECT * FROM claims WHERE packet_id = ? ORDER BY id'),
  setClaimCreditStatus: db.prepare('UPDATE claims SET credit_status = ? WHERE id = ?'),
  getPendingCredits: db.prepare(`
    SELECT c.*, p.id AS packet_id FROM claims c JOIN redpackets p ON p.id = c.packet_id
    WHERE c.credit_status = 'pending' AND c.claimed_at <= ?`),
};

const claimTx = db.transaction((packetId, userId, now) => {
  const packet = stmts.getPacket.get(packetId);
  if (!packet) return { ok: false, reason: 'not_found' };
  if (packet.expires_at <= now) return { ok: false, reason: 'not_active' };
  if (packet.status !== 'active') {
    return { ok: false, reason: packet.status === 'finished' ? 'empty' : 'not_active' };
  }
  if (packet.remaining_count <= 0) return { ok: false, reason: 'empty' };
  if (stmts.getClaim.get(packetId, userId)) return { ok: false, reason: 'already' };

  const amountTaken = splitRand(packet.remaining_amount, packet.remaining_count);
  const info = stmts.insertClaim.run(packetId, userId, amountTaken, now, 'pending');
  const newAmount = packet.remaining_amount - amountTaken;
  const newCount = packet.remaining_count - 1;
  db.prepare('UPDATE redpackets SET remaining_amount = ?, remaining_count = ? WHERE id = ?')
    .run(newAmount, newCount, packetId);
  if (newCount === 0) stmts.finishPacket.run(packetId);
  return { ok: true, claimId: info.lastInsertRowid, amount: amountTaken };
});

// 微信式拼手气：本次可抢区间 [1, min(2倍人均, 剩余-后面每人保底1)]，最后一份拿全部剩余
function splitRand(remainingAmount, remainingCount) {
  if (remainingCount === 1) return remainingAmount;
  const avg2 = Math.floor((remainingAmount / remainingCount) * 2);
  const upper = Math.min(avg2, remainingAmount - remainingCount + 1);
  return 1 + Math.floor(Math.random() * upper);
}

module.exports = { db, stmts, claimTx, splitRand, DB_PATH };
