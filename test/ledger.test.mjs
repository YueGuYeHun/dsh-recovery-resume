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
import { checkLedger, recordAttempt, pruneLedger } from '../lib/ledger.js'

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

test('冷却期满 → 放行', () => {
  const d = recordAttempt({}, 's1', NOW)
  assert.equal(checkLedger(d, 's1', NOW + 5 * MIN + 1).allow, true)
})

test('★ 累计到上限 3 次 → 拒绝（这就是防失控）', () => {
  let d = recordAttempt({}, 's1', NOW)
  d = recordAttempt(d, 's1', NOW + 6 * MIN)
  d = recordAttempt(d, 's1', NOW + 12 * MIN)
  assert.equal(d.s1.attempts, 3)
  const v = checkLedger(d, 's1', NOW + 20 * MIN)
  assert.equal(v.allow, false)
  assert.match(v.why, /上限 3/)
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

console.log(`\n  ledger: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
