/**
 * 失败分类：这次失败值不值得自动续跑（瑠璃 2026-09-23）
 *
 * ## 判据的来源（不再是"我猜的正则"）
 *
 * 第一版我用自己写的正则去匹配错误消息。**真实测试立刻抓到了漏洞**：
 * 网络失败的真实错误码是 **`TRANSPORT`**（`dsh-llm-deepseek/lib/index.js:2710`：
 * `throw new LlmError("DeepSeek Messages transport failed", "TRANSPORT")`），
 * 而我的正则表里没有它 —— 判成了"无法判定"。
 *
 * 查 DSH 源码后发现**官方本来就有一份权威码表**，模块标题就是
 * `@deepseek-ai/dsh-llm/retry-policy`：
 *
 *     const DEFAULT_RETRYABLE_CODES = Object.freeze([
 *       EMPTY_RESPONSE_CODE, "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"
 *     ])
 *
 * 这是 **DSH 自己对"哪些失败值得重试"的定义**，直接用它比我自己编正则可靠得多，
 * DSH 升级时跟着更新这张表即可。
 *
 * 另有一组永久性码，是 `dsh-llm` 里导出的具名常量：
 * `INVALID_CREDENTIAL` / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `IMAGE_OFFLOAD_REQUIRED`，
 * 以及**实测到**的 `AUTH`（401，消息为
 * "Authentication Fails, Your api key: ****0000 is invalid"）。
 * `dsh-llm` 的注释也点名了这类码的形状："`code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`)"。
 *
 * ## 判据顺序（先权威表，再兜底）
 *
 *   1. **DSH 官方可重试码** → 续跑
 *   2. **已知永久性码 / HTTP 401、403** → 跳过
 *   3. 命中永久性**文本**特征（余额、模型不存在、上下文超限…）→ 跳过
 *   4. 其余 → **放行**（保守：宁可多试一次，也不要因为不认识就永远不续跑；
 *      真正的浪费由账本的跨重启上限与自适应退避兜住）
 */

/**
 * DSH 官方的"可重试"码表。
 * 出处：`@deepseek-ai/dsh-llm` 的 `retry-policy` 模块（`DEFAULT_RETRYABLE_CODES`）。
 */
export const DSH_RETRYABLE_CODES = new Set([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/**
 * 已知的永久性码。前四个是 `dsh-llm` 导出的具名常量，
 * `AUTH` 是实测到的（`dsh-llm-deepseek` 在 401 时抛出）。
 */
export const PERMANENT_CODES = new Set([
  'INVALID_CREDENTIAL',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
  'AUTH',
])

/**
 * 永久性失败的**文本**兜底特征 —— 只在码不认识时才用。
 * ⚠️ 分隔符要覆盖 空格 / 下划线 / 连字符：第一版只写 `[_-]?`，
 * 结果 `model not found`、`invalid request` 这类**带空格的自然写法全部漏判**
 * （单测抓到的）。
 */
const SEP = '[ _-]?'
const PERMANENT_PATTERNS = [
  /auth|unauthor|forbidden|credential|api[_-]?key|permission/i,
  new RegExp(`insufficient[^]*?(balance|quota)|quota[^]*?exceed|billing|payment`, 'i'),
  new RegExp(`model.*not${SEP}found|unknown${SEP}model|not.*support.*model`, 'i'),
  new RegExp(`context.*(length|limit|window|overflow|exceed)|token.*limit|max.*context`, 'i'),
  new RegExp(`invalid${SEP}request|bad${SEP}request`, 'i'),
]

/**
 * 从 `turn/end` 的 reason 里挖出「code / status / message」三样事实。
 * 形状依据：`dsh-session` 的类型定义写明
 * `error: { kind: 'error'; error: LlmFailure }`，LlmFailure 带
 * `code`（稳定机器码）、`message`、可选的 `status`。
 *
 * 防御式提取：字段缺失、形状不同都不炸（有单测覆盖）。
 *
 * @returns {{code?: string, status?: number, message?: string}}
 */
export function failureFacts(reason) {
  const out = {}
  if (reason === null || typeof reason !== 'object') return out
  const candidates = [reason.error, reason.failure, reason.detail, reason]
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    if (out.code === undefined && typeof candidate.code === 'string') out.code = candidate.code
    if (out.message === undefined && typeof candidate.message === 'string') out.message = candidate.message
    if (out.status === undefined) {
      if (typeof candidate.status === 'number') out.status = candidate.status
      else if (typeof candidate.statusCode === 'number') out.status = candidate.statusCode
      else if (typeof candidate.httpStatus === 'number') out.status = candidate.httpStatus
    }
  }
  return out
}

/**
 * 这次失败值不值得自动续跑？
 *
 * @param {{code?: string, status?: number, message?: string}} facts
 * @returns {{retry: boolean, why: string, source?: string}}
 */
export function isTransientFailure(facts) {
  const code = typeof facts.code === 'string' ? facts.code.toUpperCase() : ''

  // ① DSH 官方码表优先
  if (code !== '' && DSH_RETRYABLE_CODES.has(code)) {
    return { retry: true, why: `DSH 官方可重试码 ${code}`, source: 'dsh-retry-policy' }
  }

  // ② 已知永久性码
  if (code !== '' && PERMANENT_CODES.has(code)) {
    return { retry: false, why: `永久性码 ${code}`, source: 'dsh-permanent-codes' }
  }

  // ③ HTTP 状态：401/403 是认证/权限，重试无益
  if (facts.status === 401 || facts.status === 403) {
    return { retry: false, why: `HTTP ${facts.status}（认证/权限）`, source: 'http-status' }
  }

  // ④ 文本兜底（码不认识时）
  const haystack = `${code} ${facts.status === undefined ? '' : facts.status} ${facts.message || ''}`.toLowerCase()
  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(haystack)) {
      return { retry: false, why: `命中永久性文本特征：${pattern.source}`, source: 'text-pattern' }
    }
  }

  // ⑤ 其余放行 —— 保守；真正的浪费由账本上限与退避兜住
  return {
    retry: true,
    why: code === '' ? '失败没有 code，无法判定为永久性，按可重试处理' : `未知码 ${code}，按可重试处理`,
    source: 'conservative-default',
  }
}
