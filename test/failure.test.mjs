/**
 * 失败分类单测：failureFacts / isTransientFailure
 *
 * 零依赖，脱离 DSH 直接跑：
 *   node test/failure.test.mjs
 *
 * ⚠️ 这套提取逻辑**没有真实样本对照过**：本机会话里 `reason=error` 的事件一条都没有
 * （实测全是 completed / interrupted / aborted）。所以这里的用例都是按 DSH 的
 * LlmFailure 载荷形状构造的，覆盖重点是**畸形输入不能炸**、以及**判据要偏保守**
 * （看不清原因时放行，宁可多试一次，也不要因为解析失败就永远不续跑）。
 */

import assert from 'node:assert/strict'
import { failureFacts, isTransientFailure, DSH_RETRYABLE_CODES, PERMANENT_CODES } from '../lib/failure.js'

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

console.log('── failureFacts（容错提取）──')

test('从 reason.error 取 code / status / message', () => {
  const f = failureFacts({ kind: 'error', error: { code: 'RATE_LIMIT_EXCEEDED', status: 429, message: 'too many' } })
  assert.equal(f.code, 'RATE_LIMIT_EXCEEDED')
  assert.equal(f.status, 429)
  assert.equal(f.message, 'too many')
})

test('容错 statusCode / httpStatus 两种别名', () => {
  assert.equal(failureFacts({ error: { statusCode: 503 } }).status, 503)
  assert.equal(failureFacts({ error: { httpStatus: 500 } }).status, 500)
})

test('★ 畸形输入不炸（字符串 / null / 空对象 / 嵌套缺失）', () => {
  assert.deepEqual(failureFacts('interrupted'), {})
  assert.deepEqual(failureFacts(null), {})
  assert.deepEqual(failureFacts(undefined), {})
  assert.deepEqual(failureFacts({}), {})
  assert.deepEqual(failureFacts({ kind: 'error' }), {})
  assert.deepEqual(failureFacts({ error: null }), {})
})

test('顶层也放 code/message 时认得出来（形状兜底）', () => {
  const f = failureFacts({ kind: 'error', code: 'UPSTREAM', message: 'bad gateway' })
  assert.equal(f.code, 'UPSTREAM')
  assert.equal(f.message, 'bad gateway')
})

console.log('── isTransientFailure（该不该重试）──')

test('★ 401 / 403 → 不重试（认证/权限）', () => {
  assert.equal(isTransientFailure({ status: 401 }).retry, false)
  assert.equal(isTransientFailure({ status: 403 }).retry, false)
})

test('★ 余额 / 配额不足 → 不重试', () => {
  assert.equal(isTransientFailure({ message: 'Insufficient Balance' }).retry, false)
  assert.equal(isTransientFailure({ code: 'QUOTA_EXCEEDED', message: 'quota exceeded' }).retry, false)
  assert.equal(isTransientFailure({ message: 'billing issue' }).retry, false)
})

test('★ API key / 凭据问题 → 不重试', () => {
  assert.equal(isTransientFailure({ code: 'INVALID_API_KEY' }).retry, false)
  assert.equal(isTransientFailure({ message: 'unauthorized' }).retry, false)
  assert.equal(isTransientFailure({ message: 'credential expired' }).retry, false)
})

test('★ 模型不存在 / 上下文超限 / 请求非法 → 不重试', () => {
  assert.equal(isTransientFailure({ message: 'model not found: gpt-x' }).retry, false)
  assert.equal(isTransientFailure({ message: 'context length exceeded' }).retry, false)
  assert.equal(isTransientFailure({ message: 'invalid request' }).retry, false)
})

test('网络 / 超时 / 5xx / 429 → 重试', () => {
  assert.equal(isTransientFailure({ message: 'network error' }).retry, true)
  assert.equal(isTransientFailure({ message: 'request timed out' }).retry, true)
  assert.equal(isTransientFailure({ status: 503, message: 'upstream unavailable' }).retry, true)
  assert.equal(isTransientFailure({ status: 429, message: 'rate limited' }).retry, true)
})

test('★ 判据偏保守：看不清原因时放行（宁可多试一次）', () => {
  const v = isTransientFailure({})
  assert.equal(v.retry, true)
  assert.match(v.why, /无法判定/)
})

test('why 里带上可复核的原因（便于日志排查）', () => {
  assert.match(isTransientFailure({ status: 401 }).why, /401/)
  assert.match(isTransientFailure({ message: 'network error' }).why, /可重试|保守|无法判定/)
})

console.log('── ★ DSH 官方码表（权威判据，不是我的正则）──')

test('★ TRANSPORT（真实网络失败码）→ 续跑（这就是真实测试抓到的漏洞）', () => {
  const v = isTransientFailure({ code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' })
  assert.equal(v.retry, true)
  assert.equal(v.source, 'dsh-retry-policy')
})

test('★ DSH 官方五个可重试码全部放行', () => {
  for (const code of DSH_RETRYABLE_CODES) {
    const v = isTransientFailure({ code })
    assert.equal(v.retry, true, `${code} 应放行`)
  }
  assert.deepEqual([...DSH_RETRYABLE_CODES].sort(), ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
})

test('★ 已知永久性码全部拦下', () => {
  for (const code of PERMANENT_CODES) {
    const v = isTransientFailure({ code })
    assert.equal(v.retry, false, `${code} 应拦下`)
  }
})

test('★ AUTH（实测的真实码，配 401）→ 拦下', () => {
  const v = isTransientFailure({ code: 'AUTH', status: 401, message: 'Authentication Fails, Your api key: ****0000 is invalid' })
  assert.equal(v.retry, false)
})

test('码不分大小写（源码里是大写，但不该假设调用方一定给大写）', () => {
  assert.equal(isTransientFailure({ code: 'transport' }).retry, true)
  assert.equal(isTransientFailure({ code: 'auth' }).retry, false)
})

test('未知码 → 放行（保守），并标明来源是保守默认', () => {
  const v = isTransientFailure({ code: 'SOMETHING_NEW' })
  assert.equal(v.retry, true)
  assert.equal(v.source, 'conservative-default')
})

console.log(`\n  failure: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
