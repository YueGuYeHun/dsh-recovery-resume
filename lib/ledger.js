/**
 * 续跑账本 —— 跨重启的持久化计数（瑠璃 2026-09-19）
 *
 * 为什么必须有它：（这是我第一版设计里的真实漏洞）
 * 我原来只用了一个**进程内的** `Map` 记"这个会话续跑过几次"，上限 1 次。
 * 但宿主一重启这个 Map 就归零了 —— 于是出现下面这条无上限的循环：
 *
 *     任务被中断 → 重启 → 插件续跑 → 又中断 → 又重启 → 插件又续跑 → …
 *
 * 每一圈都在烧 token，而且**没有任何东西会叫停**。这正是主人定的花钱护栏
 * （"绝不在没有事件触发的情况下跑完整轮次"）要防的东西，所以必须落盘。
 *
 * 现在有两层限制：
 *   1. **进程内**：同一宿主里同一会话最多续 1 次（`MAX_ATTEMPTS_PER_SESSION`）
 *   2. **跨重启**（本文件）：磁盘账本最多 3 次；且两次续跑之间必须有冷却间隔
 * 超过上限只写日志、不再自动续跑，交给主人决定。
 *
 * 账本里的时间戳同时用来做两件事：冷却判断，以及**老条目清理**（只保留
 * RETENTION_DAYS 天内的会话，免得文件无限增长）。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 跨重启的续跑次数上限。超过就停下等人。 */
export const MAX_ATTEMPTS_ACROSS_RESTARTS = 3

/** 两次续跑之间的基础间隔（毫秒），防止"崩—续—崩"的紧密循环。 */
export const COOLDOWN_MS = 5 * 60 * 1000

/** 连续失败时冷却的翻倍系数（借鉴 dsh-client-auto-continue 的 backoffFactor）。 */
export const BACKOFF_FACTOR = 2

/** 冷却的上限（毫秒）。 */
export const BACKOFF_MAX_MS = 30 * 60 * 1000

/**
 * 自适应退避：第 n 次续跑之后要等多久。
 *
 * 固定 5 分钟在"每次都失败"的情况下会**稳定地持续烧钱**（每 5 分钟一轮，永远不停）。
 * 让冷却随尝试次数翻倍，能在连续失败时自然把节奏放慢到上限。
 *
 * @param {number} attempts 已经续跑过的次数
 * @returns {number} 本次应等的毫秒数
 */
export function effectiveCooldown(attempts, base = COOLDOWN_MS, factor = BACKOFF_FACTOR, max = BACKOFF_MAX_MS) {
  const n = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0
  const raw = base * factor ** n
  return Math.min(raw, max)
}

/** 账本条目的保留天数。 */
export const RETENTION_DAYS = 7

/**
 * 读取账本。任何读取/解析问题都当成"空账本"并原样返回空对象 ——
 * 但要**报告**出来（调用方负责 console.error），不能静默吞掉。
 *
 * @param {string} path
 * @returns {{data: Record<string, {attempts: number, lastAt: number, history: number[]}>, error?: string}}
 */
export function readLedger(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, error: '账本内容不是对象' }
    }
    return { data: parsed }
  } catch (error) {
    const code = error && error.code
    if (code === 'ENOENT') return { data: {} }   // 首次运行：没有文件是正常的
    return { data: {}, error: error && error.message ? error.message : String(error) }
  }
}

/** 原子写入账本（先写临时文件再 rename，避免写一半崩掉留下坏 JSON）。 */
export function writeLedger(path, data) {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** 清掉过期条目（避免账本无限增长）。返回清理后的新对象。 */
export function pruneLedger(data, now, retentionDays = RETENTION_DAYS) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const out = {}
  for (const [sessionId, entry] of Object.entries(data)) {
    if (entry && typeof entry.lastAt === 'number' && entry.lastAt >= cutoff) out[sessionId] = entry
  }
  return out
}

/**
 * 判断"这次还允不允许续跑"。
 *
 * @param {Record<string, unknown>} data 账本
 * @param {string} sessionId
 * @param {number} now
 * @returns {{allow: true} | {allow: false, why: string}}
 */
export function checkLedger(data, sessionId, now, maxAttempts = MAX_ATTEMPTS_ACROSS_RESTARTS, cooldownMs = COOLDOWN_MS) {
  const entry = data[sessionId]
  if (entry === undefined || entry === null) return { allow: true }
  const attempts = typeof entry.attempts === 'number' ? entry.attempts : 0
  if (attempts >= maxAttempts) {
    return { allow: false, why: `跨重启已续跑 ${attempts} 次（上限 ${maxAttempts}），停下等人确认` }
  }
  const lastAt = typeof entry.lastAt === 'number' ? entry.lastAt : 0
  const elapsed = now - lastAt
  // 自适应：已续跑次数越多，冷却越长（连续失败时自然放慢，而不是稳定地每 5 分钟烧一轮）
  const cooldown = cooldownMs === COOLDOWN_MS ? effectiveCooldown(attempts) : cooldownMs
  if (elapsed < cooldown) {
    const wait = Math.ceil((cooldown - elapsed) / 1000)
    return {
      allow: false,
      why: `距上次续跑仅 ${Math.round(elapsed / 1000)}s，冷却中（本次冷却 ${Math.round(cooldown / 1000)}s，还需 ${wait}s）`,
    }
  }
  return { allow: true }
}

/** 记一次续跑：返回更新后的账本（不写盘，由调用方决定何时写）。 */
export function recordAttempt(data, sessionId, now) {
  const prev = data[sessionId]
  const attempts = (prev && typeof prev.attempts === 'number' ? prev.attempts : 0) + 1
  const history = Array.isArray(prev && prev.history) ? prev.history.slice(-9) : []
  history.push(now)
  return { ...data, [sessionId]: { attempts, lastAt: now, history } }
}

/**
 * 判断"上次续跑是不是成功了"。
 *
 * 为什么需要它（**真实测试抓到的设计缺陷**）：自适应退避原来对所有情况都生效。
 * 于是出现这条反直觉的链：
 *
 *   续跑成功 → 任务继续跑 → 又被打断 → 再来续跑时：冷却已经是 20 分钟 → **被挡住**
 *
 * 实测日志（2026-09-23）：「距上次续跑仅 243s，冷却中（本次冷却 1200s，还需 957s）」
 * —— 我自己的防失控机制把正常续跑挡住了。这显然是错的：
 * **退避只该惩罚"连续失败"，不该惩罚"上次成功了"**。
 *
 * 判据：如果这次的 `turn/end` 比上次续跑时记录的那条**更新**（seq 更大），
 * 说明上次续跑之后任务确实往前走了 → 上次是成功的 → 计数与冷却都该归零。
 *
 * @param {Record<string, unknown>} data 账本
 * @param {string} sessionId
 * @param {number} currentTurnSeq 本次发现的 turn/end 的 seq
 * @returns {{success: boolean, prevSeq?: number}}
 */
export function detectProgressSinceLastAttempt(data, sessionId, currentTurnSeq) {
  const entry = data[sessionId]
  if (entry === undefined || entry === null) return { success: false }
  const prevSeq = typeof entry.lastTurnSeq === 'number' ? entry.lastTurnSeq : undefined
  if (prevSeq === undefined) return { success: false }
  return { success: Number.isFinite(currentTurnSeq) && currentTurnSeq > prevSeq, prevSeq }
}

/** 清零某个会话的尝试记录（= 上次续跑被判定为成功，撤销退避）。 */
export function resetAttempts(data, sessionId) {
  if (data[sessionId] === undefined) return data
  const next = { ...data }
  delete next[sessionId]
  return next
}

/** 记一次续跑，同时记下当时的 turn/end seq（供下次判断"有没有进展"）。 */
export function recordAttemptWithTurn(data, sessionId, now, turnSeq) {
  const updated = recordAttempt(data, sessionId, now)
  return { ...updated, [sessionId]: { ...updated[sessionId], lastTurnSeq: turnSeq } }
}
