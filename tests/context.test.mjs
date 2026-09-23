/**
 * 最小上下文提取单测：extractKeyPoints / clip / contentText
 *
 * 零依赖，脱离 DSH 直接跑：
 *   node tests/context.test.mjs
 *
 * 重点钉两件事：
 *   ① 只认**结构性**的结局未知标记（`data.error.code`），不要把正文里出现的同名
 *      字符串当成标记 —— 本机实测过：那个码在会话里既出现在结构字段（27 条），
 *      也出现在我研究时的正文里（14 条）。混淆两者会提取出假关键点。
 *   ② 上限必须生效（不截断就等于把上下文又倒回去，违背优化的初衷）。
 */

import assert from 'node:assert/strict'
import { extractKeyPoints, clip, contentText, MAX_ASSISTANT_CHARS, MAX_UNCONFIRMED } from '../lib/context.js'

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

/** 造一条"结局未知的工具结果"事件 —— 形状抄自本机真实事件。 */
const unknownResult = (seq, callId, turn = 5) => ({
  type: 'tool/result',
  seq,
  time: Date.now(),
  data: {
    turn,
    step: 1,
    message: {
      id: `interrupted-tool-result-${callId}`,
      role: 'user',
      source: { kind: 'tool', callId },
    },
    error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
  },
})

const call = (seq, callId, name) => ({
  type: 'tool/call',
  seq,
  time: Date.now(),
  data: { turn: 5, callId, name },
})

const assistant = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: Date.now(),
  data: { turn: 5, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

const turnEnd = (seq, reason = 'interrupted') => ({
  type: 'turn/end',
  seq,
  time: Date.now(),
  data: { turn: 5, reason },
})

console.log('── contentText / clip ──')

test('contentText 能压平分块数组', () => {
  assert.equal(contentText([{ type: 'text', text: 'abc' }, { type: 'image' }, { type: 'text', text: 'def' }]), 'abcdef')
  assert.equal(contentText('直接字符串'), '直接字符串')
  assert.equal(contentText(undefined), '')
})

test('clip 超长时截断并标注', () => {
  const long = 'x'.repeat(MAX_ASSISTANT_CHARS + 50)
  const out = clip(long)
  assert.ok(out.length < long.length)
  assert.match(out, /已截断/)
})

test('clip 把多行压成一行（省 token）', () => {
  assert.equal(clip('第一行\n\n第二行   第三行'), '第一行 第二行 第三行')
})

console.log('── extractKeyPoints ──')

test('★ 只认结构性标记，正文里的同名字符串不算', () => {
  const textOnly = {
    type: 'tool/result',
    seq: 1,
    data: { turn: 1, message: { content: [{ type: 'text', text: '我研究时写了 TOOL_OUTCOME_UNKNOWN 这个词' }] } },
  }
  const got = extractKeyPoints([textOnly, turnEnd(2)], 1)
  assert.deepEqual(got.unconfirmed, [])
})

test('★ 结构性 TOOL_OUTCOME_UNKNOWN 能被提取，并反查出工具名', () => {
  const events = [call(1, 'call_A', 'bash'), unknownResult(2, 'call_A'), turnEnd(3)]
  const got = extractKeyPoints(events, 2)
  assert.deepEqual(got.unconfirmed, ['bash'])
})

test('TOOL_NOT_STARTED 同样提取', () => {
  const ev = {
    type: 'tool/result',
    seq: 2,
    data: { turn: 5, message: { source: { kind: 'tool', callId: 'call_B' } }, error: { code: 'TOOL_NOT_STARTED' } },
  }
  const got = extractKeyPoints([call(1, 'call_B', 'write'), ev, turnEnd(3)], 2)
  assert.deepEqual(got.unconfirmed, ['write'])
})

test('多个未知调用按时间顺序、且受上限约束', () => {
  const events = []
  for (let i = 0; i < 6; i += 1) {
    events.push(call(i * 2 + 1, `call_${i}`, `tool${i}`))
    events.push(unknownResult(i * 2 + 2, `call_${i}`))
  }
  events.push(turnEnd(99))
  const got = extractKeyPoints(events, events.length - 1)
  assert.equal(got.unconfirmed.length, MAX_UNCONFIRMED, `应被截到 ${MAX_UNCONFIRMED} 个`)
})

test('最后一条 assistant 文本被提取（且截断）', () => {
  const events = [assistant(1, '我准备先跑测试'), turnEnd(2)]
  const got = extractKeyPoints(events, 1)
  assert.equal(got.lastAssistant, '我准备先跑测试')
})

test('回合序号被提取', () => {
  const events = [assistant(1, 'x'), turnEnd(2)]
  assert.equal(extractKeyPoints(events, 1).turn, 5)
})

test('空事件流 / 非法下标不炸', () => {
  assert.deepEqual(extractKeyPoints([], -1).unconfirmed, [])
  assert.deepEqual(extractKeyPoints([], 0).unconfirmed, [])
})

test('只有 tool/result 没有对应 tool/call 时，工具名标注为未知', () => {
  const events = [unknownResult(1, 'call_orphan'), turnEnd(2)]
  assert.deepEqual(extractKeyPoints(events, 1).unconfirmed, ['(未知工具)'])
})

console.log(`\n  context: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
