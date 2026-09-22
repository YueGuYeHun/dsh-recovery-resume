/**
 * 判据单测：inspectTail / renderResumePrompt / decideRearm
 *
 * 零依赖，脱离 DSH 直接跑：
 *   node test/logic.test.mjs
 *
 * 为什么这些用例值得单独立文件：这条链上最容易出错的就是"判据"本身 ——
 * 开发过程中我写错过好几个"看起来合理"的判据（陈旧锁用 stat 取 mtime 恒真、
 * 把时间戳当秒数比较恒真……）。所以每个边界都钉一个用例，尤其是**不该动**的情形。
 */

import assert from 'node:assert/strict'
import { inspectTail, renderResumePrompt, decideRearm } from '../lib/logic.js'

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
const ev = (type, seq, data = {}, time = NOW) => ({ type, seq, data, time })

console.log('── inspectTail（该不该续跑）──')

test('尾部是未处理的 interrupted（对象形状）→ 续跑', () => {
  const got = inspectTail([ev('turn/start', 1), ev('turn/end', 2, { reason: { kind: 'interrupted' } })], NOW)
  assert.equal(got.resume, true)
  assert.equal(got.reason, 'interrupted')
})

test('reason 是字符串形状也认（实测事件流里两种都出现过）→ 续跑', () => {
  const got = inspectTail([ev('turn/end', 2, { reason: 'interrupted' })], NOW)
  assert.equal(got.resume, true)
})

test('之后有 turn/start（已被处理）→ 不续跑', () => {
  const got = inspectTail([ev('turn/end', 2, { reason: 'interrupted' }), ev('turn/start', 3)], NOW)
  assert.equal(got.resume, false)
})

test('之后有真人消息（已被处理）→ 不续跑', () => {
  const got = inspectTail(
    [ev('turn/end', 2, { reason: 'interrupted' }), ev('user/message', 3, { source: { kind: 'user' } })],
    NOW,
  )
  assert.equal(got.resume, false)
})

test('之后只有插件消息（不算已处理）→ 仍续跑', () => {
  const got = inspectTail(
    [ev('turn/end', 2, { reason: 'interrupted' }), ev('user/message', 3, { source: { kind: 'plugin', plugin: 'x' } })],
    NOW,
  )
  assert.equal(got.resume, true)
})

test('正常完成 completed → 不续跑', () => {
  assert.equal(inspectTail([ev('turn/end', 2, { reason: { kind: 'completed' } })], NOW).resume, false)
})

test('用户主动停止 aborted → 不续跑', () => {
  assert.equal(inspectTail([ev('turn/end', 2, { reason: 'aborted' })], NOW).resume, false)
})

test('16 分钟前的中断（太老）→ 不翻旧账', () => {
  const old = [ev('turn/end', 2, { reason: 'interrupted' }, NOW - 16 * 60 * 1000)]
  assert.equal(inspectTail(old, NOW).resume, false)
})

test('error / max-tokens 也算机器造成的中断 → 续跑', () => {
  assert.equal(inspectTail([ev('turn/end', 2, { reason: { kind: 'error' } })], NOW).resume, true)
  assert.equal(inspectTail([ev('turn/end', 2, { reason: { kind: 'max-tokens' } })], NOW).resume, true)
})

test('空事件流 / 没有 turn/end → 不续跑', () => {
  assert.equal(inspectTail([], NOW).resume, false)
  assert.equal(inspectTail([ev('turn/start', 1)], NOW).resume, false)
})

test('lastTool 能回溯出来（用于提示哪一步没确认）', () => {
  const got = inspectTail([ev('tool/call', 1, { name: 'bash' }), ev('turn/end', 2, { reason: 'interrupted' })], NOW)
  assert.equal(got.lastTool, 'bash')
})

console.log('── renderResumePrompt（消息内容）──')

test('包含"必须核对"与"不要假定"这类硬要求，不是干巴巴"继续"', () => {
  const text = renderResumePrompt({ reason: 'interrupted', turnSeq: 1, lastTool: 'bash' })[0].text
  assert.match(text, /必须/)
  assert.match(text, /不要根据对话历史假定/)
  assert.match(text, /bash/)
})

test('没有 lastTool 时不出现空的工具名', () => {
  const text = renderResumePrompt({ reason: 'interrupted', turnSeq: 1 })[0].text
  assert.doesNotMatch(text, /最后一个工具调用是「」/)
})

console.log('── decideRearm（要不要重新武装 goal）──')

const base = { id: 'g1', revision: 2, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 4 }

test('active + disarmed + interrupted → 重新武装', () => {
  assert.equal(decideRearm({ ...base }, 'interrupted').rearm, true)
})

test('★ 用户暂停的 goal（paused）→ 绝不动', () => {
  assert.equal(decideRearm({ ...base, phase: 'paused' }, 'interrupted').rearm, false)
})

test('★ blocked → 绝不动', () => {
  assert.equal(decideRearm({ ...base, phase: 'blocked' }, 'interrupted').rearm, false)
})

test('已 complete → 不动', () => {
  assert.equal(decideRearm({ ...base, phase: 'complete' }, 'interrupted').rearm, false)
})

test('已经 armed → 不重复武装', () => {
  assert.equal(decideRearm({ ...base, activation: 'armed' }, 'interrupted').rearm, false)
})

test('用户主动停止（aborted）/ 正常完成（completed）→ 不动', () => {
  assert.equal(decideRearm({ ...base }, 'aborted').rearm, false)
  assert.equal(decideRearm({ ...base }, 'completed').rearm, false)
})

test('轮次已用尽 → 不动', () => {
  assert.equal(decideRearm({ ...base, roundsStarted: 4 }, 'interrupted').rearm, false)
})

test('没有 goal → 不动', () => {
  assert.equal(decideRearm(undefined, 'interrupted').rearm, false)
})

test('缺 id/revision → 不动（宁可不动，也不要用错的 revision 去改）', () => {
  assert.equal(decideRearm({ phase: 'active', activation: 'disarmed' }, 'interrupted').rearm, false)
})

console.log(`\n  logic: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
