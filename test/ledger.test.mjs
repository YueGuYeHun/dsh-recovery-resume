/**
 * 账本单测：跨重启的续跑上限与冷却
 *
 * 零依赖，脱离 DSH 直接跑：
 *   node test/ledger.test.mjs
 *
 * 为什么这些用例最重要：账本是**防失控**的唯一屏障。没有它就会出现
 * "崩 → 续 → 崩 → 续"的无上限循环，每一圈都在烧 token。
 * 所以这里专门钉死：到上限必须拒绝、上限之后等再久也不放行、别的会话不受影响。
 */

import assert from 'node:assert/strict'
import {
  checkLedger, recordAttempt, pruneLedger, effectiveCooldown,
  detectProgressSinceLastAttempt, resetAttempts, recordAttemptWithTurn,
} from '../lib/ledger.js'

let pass = 0
let fail = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    pass += 1
  } catch (error) {
    console.log(`  ❌ ${name}\n     ${error && error.message ? error.message : error}`)
    fail += 1
  }
}

const NOW = Date.now()
const MIN = 60 * 1000

console.log('── checkLedger（放行 / 拒绝）──')

test('全新会话（账本里没有）→ 放行', () => {
  assert.equal(checkLedger({}, 's1', NOW).allow, true)
})

test('刚续过（冷却中）→ 拒绝，且原因说明还需等多久', () => {
  const d = recordAttempt({}, 's1', NOW)
  const v = checkLedger(d, 's1', NOW + 1000)
  assert.equal(v.allow, false)
  assert.match(v.why, /冷却中/)
})

test('冷却期满 → 放行（已续跑 1 次 → 冷却 10 分钟）', () => {
  const d = recordAttempt({}, 's1', NOW)
  // 自适应退避：第 1 次之后冷却翻倍为 10 分钟，所以 5 分钟时**仍应被拒**
  assert.equal(checkLedger(d, 's1', NOW + 5 * MIN + 1).allow, false)
  assert.equal(checkLedger(d, 's1', NOW + 10 * MIN + 1).allow, true)
})

test('★ 连续 3 次都没带来进展 → 拒绝（这才是防失控）', () => {
  let d = recordAttempt({}, 's1', NOW)
  d = recordAttempt(d, 's1', NOW + 6 * MIN)
  d = recordAttempt(d, 's1', NOW + 12 * MIN)
  assert.equal(d.s1.attempts, 3)
  const v = checkLedger(d, 's1', NOW + 20 * MIN)
  assert.equal(v.allow, false)
  assert.match(v.why, /连续 3 次/)
})

test('★ 到上限之后，等再久也不放行（冷却不能绕过上限）', () => {
  let d = recordAttempt({}, 's1', NOW)
  d = recordAttempt(d, 's1', NOW + 6 * MIN)
  d = recordAttempt(d, 's1', NOW + 12 * MIN)
  assert.equal(checkLedger(d, 's1', NOW + 24 * 60 * MIN).allow, false)
})

test('别的会话不受影响（计数按会话隔离）', () => {
  let d = recordAttempt({}, 's1', NOW)
  d = recordAttempt(d, 's1', NOW + 6 * MIN)
  d = recordAttempt(d, 's1', NOW + 12 * MIN)
  assert.equal(checkLedger(d, 's2', NOW).allow, true)
})

test('账本条目缺字段时不炸（坏数据按 0 次处理）', () => {
  assert.equal(checkLedger({ s1: {} }, 's1', NOW).allow, true)
  assert.equal(checkLedger({ s1: null }, 's1', NOW).allow, true)
})

console.log('── recordAttempt（记账）──')

test('每次记账 attempts 递增，history 记录时间戳', () => {
  let d = recordAttempt({}, 's1', NOW)
  d = recordAttempt(d, 's1', NOW + MIN)
  assert.equal(d.s1.attempts, 2)
  assert.deepEqual(d.s1.history, [NOW, NOW + MIN])
  assert.equal(d.s1.lastAt, NOW + MIN)
})

test('history 有上限（不会无限增长）', () => {
  let d = {}
  for (let i = 0; i < 20; i += 1) d = recordAttempt(d, 's1', NOW + i * MIN)
  assert.ok(d.s1.history.length <= 10, `history 长度 ${d.s1.history.length} 应 ≤ 10`)
})

test('不改动传入的对象（纯函数）', () => {
  const before = {}
  recordAttempt(before, 's1', NOW)
  assert.deepEqual(before, {})
})

console.log('── pruneLedger（清理老条目）──')

test('清掉超过保留期的会话', () => {
  const old = {
    s_old: { attempts: 1, lastAt: NOW - 8 * 24 * 60 * MIN },
    s_new: { attempts: 1, lastAt: NOW },
  }
  assert.deepEqual(Object.keys(pruneLedger(old, NOW)), ['s_new'])
})

test('保留期内的条目不动', () => {
  const d = { s1: { attempts: 2, lastAt: NOW - 60 * MIN } }
  assert.deepEqual(Object.keys(pruneLedger(d, NOW)), ['s1'])
})

console.log('── effectiveCooldown（自适应退避）──')

test('★ 冷却随尝试次数翻倍、且有上限', () => {
  assert.equal(effectiveCooldown(0), 5 * MIN)
  assert.equal(effectiveCooldown(1), 10 * MIN)
  assert.equal(effectiveCooldown(2), 20 * MIN)
  assert.equal(effectiveCooldown(3), 30 * MIN, '应封顶在 30 分钟')
  assert.equal(effectiveCooldown(9), 30 * MIN)
})

test('★ 连续失败时，固定 5 分钟挡不住的情形被退避挡住', () => {
  let d = recordAttempt({}, 's1', NOW)
  // 第 1 次续跑后：要等 10 分钟（不是 5 分钟）
  assert.equal(checkLedger(d, 's1', NOW + 6 * MIN).allow, false, '6 分钟时仍应在冷却中')
  assert.equal(checkLedger(d, 's1', NOW + 10 * MIN + 1).allow, true)
})

console.log('── ★ 退避前的"上次成功了吗"判定（实测修正的设计缺陷）──')

test('★ 上次续跑之后有新 turn/end → 判定成功（应清零退避）', () => {
  const d = recordAttemptWithTurn({}, 's1', NOW, 100)
  assert.equal(detectProgressSinceLastAttempt(d, 's1', 200).success, true)
})

test('★ 同一个 turn/end（没进展）→ 不算成功（冷却继续生效）', () => {
  const d = recordAttemptWithTurn({}, 's1', NOW, 100)
  assert.equal(detectProgressSinceLastAttempt(d, 's1', 100).success, false)
})

test('★ 清零后退避撤销：这次不该被自己的防失控挡住', () => {
  // 判据说明（我第一版把这条写错了）：不能在 60 分钟处断言"被挡住"——
  // 第 1 次续跑的冷却经退避后只有 10 分钟，60 分钟早就过了，那条断言本身不成立。
  // 正确的判据是在**冷却期内**比较"清零前 vs 清零后"：
  let d = recordAttemptWithTurn({}, 's1', NOW, 100)
  assert.equal(checkLedger(d, 's1', NOW + 5 * MIN).allow, false, '未清零时，5 分钟内应被退避挡住')
  d = resetAttempts(d, 's1')
  assert.equal(checkLedger(d, 's1', NOW + 5 * MIN).allow, true, '清零后，同样的时刻应放行（退避已撤销）')
})

test('★ 没有 lastTurnSeq 的旧账本 → 视为有进展（迁移，2026-09-23 修正）', () => {
  // 这条断言在 2026-09-23 被**故意反过来**了，原因是实测踩到的坑：
  // 旧版账本没有 lastTurnSeq，原实现返回 success:false → 判据无声失效 →
  // 明明任务往前走过了却仍按"连续失败"吃退避 → 网络恢复后也不再有第二次机会。
  // 现在没有可比对的 seq 时取"对续跑有利"的解读，并标记 migrated 以便观测。
  const d = recordAttempt({}, 's1', NOW)
  const r = detectProgressSinceLastAttempt(d, 's1', 999)
  assert.equal(r.success, true)
  assert.equal(r.migrated, true)
})

test('resetAttempts 不改动传入对象（纯函数）', () => {
  const d = recordAttemptWithTurn({}, 's1', NOW, 1)
  const before = JSON.stringify(d)
  resetAttempts(d, 's1')
  assert.equal(JSON.stringify(d), before)
})

console.log(`\n  ledger: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
