/**
 * 最小上下文的提取（瑠璃 2026-09-23）
 *
 * 目标（主人提的问题）：重启后的续跑消息**不要**重述一大堆上下文，只给 agent
 * 它自己查不到、或查起来很贵的**关键点**，其余让它自己去核对。
 *
 * 为什么这是对的优化方向（有实测依据）：
 *   - 一个挂满工具的会话，第一轮基线 ≈ 41K tokens（本机实测）。插件注入的这
 *     几百 token 相比之下可以忽略；真正的浪费是**让 agent 重新翻一遍历史**。
 *   - DSH 的崩溃修复**已经把结局未知的工具调用写进了模型可见的历史**：
 *     `tool/result` 事件带 `error.code = TOOL_OUTCOME_UNKNOWN`（本机此类会话里
 *     结构性出现 27 次）。所以那类信息**不必重复注入** —— 只挑真正需要重述的。
 *   - `compaction/summary` 事件里存着压缩摘要（结构化 `data.summary`），是现成的
 *     "关键点"来源，可在需要时当作更省的回退。
 *
 * 因此这里只提取三样，且都有上限：
 *   ① 中断前最后一条 assistant 文本（截断）—— agent 中断时"正打算做什么"
 *   ② 结局未知的工具调用名（最多 N 个）—— 提醒哪几步的结论不可信
 *   ③ 该回合的 turn 序号 —— 让它知道断在哪一轮
 */

/** 每个字段的字符上限（避免注入膨胀）。 */
export const MAX_ASSISTANT_CHARS = 240
export const MAX_UNCONFIRMED = 3

/** 从长文本里取前 n 个字符，并标出被截断。 */
export function clip(text, max = MAX_ASSISTANT_CHARS) {
  if (typeof text !== 'string') return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…（已截断）`
}

/** 把 content（字符串或分块数组）压成纯文本。 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      out += part.text
    }
  }
  return out
}

/**
 * 从一个 `turn/end` 的位置往前提取"最小关键点"。
 *
 * @param {readonly object[]} events 完整事件流
 * @param {number} endIndex 最后一条 turn/end 的下标
 * @returns {{turn?: number, lastAssistant?: string, unconfirmed: string[]}}
 */
export function extractKeyPoints(events, endIndex) {
  const out = { unconfirmed: [] }
  if (!Array.isArray(events) || endIndex < 0) return out

  // ② 结局未知的工具调用：崩溃修复给它们写了 TOOL_OUTCOME_UNKNOWN。
  //    注意：这是**结构性**标记（data.error.code），不是我研究时的正文 ——
  //    本机实测过 27 条这种事件。
  const unconfirmed = []
  const seen = new Set()
  for (let i = endIndex; i >= 0 && unconfirmed.length < MAX_UNCONFIRMED; i -= 1) {
    const event = events[i]
    if (!event || event.type !== 'tool/result') continue
    const code = event.data && event.data.error && event.data.error.code
    if (code !== 'TOOL_OUTCOME_UNKNOWN' && code !== 'TOOL_NOT_STARTED') continue
    const callId = event.data && event.data.message && event.data.message.source
      && event.data.message.source.callId
    if (typeof callId !== 'string' || seen.has(callId)) continue
    seen.add(callId)
    // 用 callId 反查工具名（tool/call 在同一段里）
    let name
    for (let j = i; j >= 0; j -= 1) {
      const e2 = events[j]
      if (e2 && e2.type === 'tool/call' && e2.data && e2.data.callId === callId) {
        name = e2.data.name || e2.data.tool
        break
      }
    }
    unconfirmed.push(typeof name === 'string' && name !== '' ? name : '(未知工具)')
  }
  out.unconfirmed = unconfirmed.reverse()   // 还原时间顺序

  // ① 中断前最后一条 assistant 文本 + ③ 该回合序号
  for (let i = endIndex; i >= 0; i -= 1) {
    const event = events[i]
    if (!event) continue
    if (out.turn === undefined && typeof event.data?.turn === 'number') out.turn = event.data.turn
    if (event.type === 'assistant/message') {
      const text = contentText(event.data && event.data.message && event.data.message.content)
      if (text.trim() !== '') {
        out.lastAssistant = clip(text)
        break
      }
    }
  }
  return out
}
