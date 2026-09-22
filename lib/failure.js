/**
 * 失败分类：不是所有 `error` 都值得续跑（瑠璃 2026-09-23）
 *
 * 为什么要做：原来的判据只看 `reason.kind === 'error'` 就续跑。如果上次失败是
 * "API key 无效"或"余额不足"，续跑必然再失败一次 —— **白烧一轮 token**。
 * 这个判断借鉴了 dsh-client-auto-continue 的做法（其 `isTransientFailure`），
 * 但它不是照抄：那边还带用户自定义 pattern 等配置，这里只要最必要的分类。
 *
 * ⚠️ 诚实标注：本机会话里 `reason=error` 的事件**一条都没有**（实测：全是
 * completed / interrupted / aborted），所以**这套提取逻辑没有真实样本对照过**。
 * 因此：
 *   - 提取是防御式的（字段缺失、形状不同都不炸）
 *   - 判据偏保守：**看不清原因时按"可重试"处理**（宁可多试一次，也不要因为
 *     解析不了就永远不续跑）
 *   - 有单测覆盖各种畸形输入
 */

/** 永久性失败：重试没有意义（认证、配额、模型不存在、上下文超限、请求非法）。 */
// 注意：分隔符要覆盖 **空格 / 下划线 / 连字符** 三种。我第一版只写了 `[_-]?`，
// 结果 `model not found`、`invalid request` 这类**带空格的自然写法全部漏判**
// （单测抓到的）—— 而真实错误消息里空格写法最常见。
const SEP = '[ _-]?'
const PERMANENT_PATTERNS = [
  /auth|unauthor|forbidden|credential|api[_-]?key|permission/i,
  // 配额类：`insufficient balance` 要有前缀，但 `quota exceeded` 常常单独出现 —— 两种都要认
  new RegExp(`insufficient[^]*?(balance|quota)|quota[^]*?exceed|billing|payment`, 'i'),
  new RegExp(`model.*not${SEP}found|unknown${SEP}model|not.*support.*model`, 'i'),
  new RegExp(`context.*(length|limit|overflow|exceed)|token.*limit|max.*context`, 'i'),
  new RegExp(`invalid${SEP}request|bad${SEP}request`, 'i'),
]

/** 临时性失败：网络与上游抖动，值得重试。 */
const TRANSIENT_PATTERN = /network|timeout|timed ?out|econn|etimedout|socket|upstream|temporar|\b5\d\d\b|\b429\b/i

/**
 * 从 `turn/end` 的 reason 里尽量挖出「code / status / message」三样事实。
 * 形状按 DSH 的 LlmFailure 载荷猜（`reason.error`），并容错其他可能的位置。
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

/** 把三样事实合成一段小写文本，供正则匹配。 */
function haystackOf(facts) {
  return `${facts.code || ''} ${facts.status === undefined ? '' : facts.status} ${facts.message || ''}`.toLowerCase()
}

/**
 * 这次失败值不值得自动续跑？
 *
 * @param {{code?: string, status?: number, message?: string}} facts
 * @returns {{retry: boolean, why: string}}
 */
export function isTransientFailure(facts) {
  const haystack = haystackOf(facts)

  // 401 / 403 明确是认证/权限问题，重试无益
  if (facts.status === 401 || facts.status === 403) {
    return { retry: false, why: `HTTP ${facts.status}（认证/权限）` }
  }
  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(haystack)) {
      return { retry: false, why: `命中永久性失败特征：${pattern.source}` }
    }
  }
  if (TRANSIENT_PATTERN.test(haystack)) {
    return { retry: true, why: '命中临时性失败特征（网络/超时/上游抖动）' }
  }
  // 保守：看不清原因就别拦着
  return { retry: true, why: '无法判定为永久性失败，按可重试处理' }
}
