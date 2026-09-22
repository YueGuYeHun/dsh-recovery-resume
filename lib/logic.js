import { failureFacts, isTransientFailure } from './failure.js'

/**
 * dsh-recovery-resume 的纯逻辑（零依赖，可脱离 DSH 单独测试）
 *
 * 为什么拆出来：入口要 import `@deepseek-ai/dsh-llm` 才能构造消息，那个包只有
 * 在 DSH 环境里才解析得到。判据逻辑是整件事最容易出错的部分（我这一路上已经
 * 写错过好几个"看起来合理"的判据），所以必须能脱离 DSH 单测。
 */

/** 认为"值得续跑"的非人为回合结束原因。 */
export const RESUMABLE = new Set(['interrupted', 'error', 'max-tokens'])

/** 多久之内算"新鲜"的打断（毫秒）。太老的打断不翻旧账。 */
export const FRESH_MS = 15 * 60 * 1000

/**
 * 读取 reason.kind —— 实测事件流里 reason 有两种形状：
 * 字符串（`reason=interrupted`）或对象（`{kind: 'completed'}`）。
 */
export function reasonKind(reason) {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

function eventTime(event) {
  const t = event && typeof event.time === 'number' ? event.time : undefined
  return t === undefined ? undefined : t
}

/**
 * 从事件流尾部判断"有没有一件被打断、且之后没人处理过的事"。
 *
 * 判据（每条都对应一个单测用例）：
 *   - 尾部最后一条 turn/end 的 reason 属于 RESUMABLE
 *   - 该 turn/end 之后没有 turn/start
 *   - 该 turn/end 之后没有 source.kind === 'user' 的消息
 *     （插件/系统消息不算"已处理"——否则我们自己的续跑消息会把后续判断堵死）
 *   - 时间上足够新（默认 15 分钟内）
 *
 * @returns {{resume: false} | {resume: true, turnSeq: number, reason: string, lastTool?: string}}
 */
export function inspectTail(events, now, freshMs = FRESH_MS) {
  if (!Array.isArray(events) || events.length === 0) return { resume: false }

  let lastEndIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event && event.type === 'turn/end') {
      lastEndIndex = i
      break
    }
  }
  if (lastEndIndex < 0) return { resume: false }

  const lastEnd = events[lastEndIndex]
  const rawReason = lastEnd.data && lastEnd.data.reason
  const kind = reasonKind(rawReason)
  if (kind === undefined || !RESUMABLE.has(kind)) return { resume: false }

  // `error` 还要再分一层：认证失败 / 余额不足 / 模型不存在这类**重试也没用**的，
  // 续跑等于白烧一轮 token。判定见 lib/failure.js（偏保守：看不清原因就放行）。
  let failure
  if (kind === 'error') {
    const facts = failureFacts(rawReason)
    const verdict = isTransientFailure(facts)
    if (!verdict.retry) {
      return { resume: false, skippedError: { ...facts, why: verdict.why } }
    }
    failure = { ...facts, why: verdict.why }
  }

  const at = eventTime(lastEnd)
  if (at !== undefined && now - at > freshMs) return { resume: false }

  for (let i = lastEndIndex + 1; i < events.length; i += 1) {
    const event = events[i]
    if (!event) continue
    if (event.type === 'turn/start') return { resume: false }
    if (event.type === 'user/message') {
      const source = event.data && event.data.source
      if (source && source.kind === 'user') return { resume: false }
    }
  }

  // 最后一个工具调用：用来告诉 agent「哪一步的结局没被确认」
  let lastTool
  for (let i = lastEndIndex; i >= 0; i -= 1) {
    const event = events[i]
    if (event && event.type === 'tool/call') {
      const name = event.data && (event.data.name || event.data.tool)
      if (typeof name === 'string') lastTool = name
      break
    }
  }

  return {
    resume: true,
    turnSeq: lastEnd.seq,
    reason: kind,
    ...(lastTool ? { lastTool } : {}),
    ...(failure ? { failure } : {}),
  }
}

/**
 * 续跑消息文本。
 *
 * 关键：**不是"继续"两个字**。重启之后外部世界可能已经变了（下载到一半、推送
 * 成功但没记下结果），所以要求 agent 先核对真实状态，不许假定成功或失败。
 */
export function renderResumePrompt(info) {
  const toolLine = info.lastTool
    ? `\n中断前最后一个工具调用是「${info.lastTool}」—— 它可能已经执行成功、执行到一半、或根本没跑起来。`
    : ''

  // ── 最小关键点（只在有信息时附加，避免消息膨胀）────────────────────────
  // 设计意图：**不重述上下文**。DSH 的崩溃修复已经把"结局未知的工具调用"写进了
  // 模型可见的历史（tool/result 带 error.code=TOOL_OUTCOME_UNKNOWN，本机实测 27 条），
  // 所以这里只补 agent 自己查不到或不值得再翻的三样，且都有硬上限。
  const keys = info.keyPoints
  let keyBlock = ''
  if (keys !== undefined && keys !== null) {
    const lines = []
    if (typeof keys.turn === 'number') lines.push(`- 断在第 ${keys.turn} 回合`)
    if (Array.isArray(keys.unconfirmed) && keys.unconfirmed.length > 0) {
      lines.push(
        `- 结局**未确认**的工具调用（${keys.unconfirmed.length} 个，最有可能是问题所在）：` +
          keys.unconfirmed.map((n) => `「${n}」`).join('、'),
      )
    }
    if (typeof keys.lastAssistant === 'string' && keys.lastAssistant !== '') {
      lines.push(`- 中断前你最后说的是：${keys.lastAssistant}`)
    }
    if (lines.length > 0) {
      keyBlock = `\n已从事件流提取的关键点（**不完整**，其余请自己去查）：\n${lines.join('\n')}\n`
    }
  }

  return [
    {
      type: 'text',
      text:
        '<recovery_resume>\n' +
        '这台机器上的 DSH 刚刚重启过（宿主进程被换掉了），你上一回合因此被中断。' +
        `中断原因：${info.reason}。${toolLine}\n` +
        keyBlock +
        '\n' +
        '继续之前**必须先核对真实状态**：\n' +
        '1. 先看工作区 / 进程 / 日志，确认中断前那一步到底做成了没有 —— ' +
        '不要根据对话历史假定它成功，也不要假定它失败。\n' +
        '2. 如果那一步的结果不确定（下载进度、推送是否真的成功、文件写到哪个程度），' +
        '去查实际证据；必要时用幂等的方式重做。\n' +
        '3. 确认实际状态之后，从正确的位置接着做，不要重复已经完成的动作。\n' +
        '\n' +
        '做完要给出可复核的证据（命令输出、文件内容、退出码）。' +
        '如果无法继续（缺前提、外部不可用），如实说明并停下。\n' +
        '</recovery_resume>',
    },
  ]
}

/**
 * 判断"要不要把这个 goal 重新武装"。
 *
 * 这是"重新取得继续执行的授权"那一环。判断必须保守，因为 `ctx.goals.resume()`
 * 同时接受 `paused` 和 `blocked`（DSH 源码实测），**无条件调用会覆盖主人主动
 * 暂停的目标** —— 那是不能接受的。
 *
 * 因此只对 `phase === "active"` 的目标动手，且要求这次中断是"机器造成的"
 * （interrupted / error / max-tokens），而不是人主动停的。
 *
 * @returns {{rearm: false, why: string} | {rearm: true, id: string, revision: number}}
 */
export function decideRearm(goal, reason) {
  if (goal === undefined || goal === null) return { rearm: false, why: '没有 goal' }
  if (goal.phase !== 'active') return { rearm: false, why: `phase=${goal.phase}（只处理 active）` }
  if (goal.activation === 'armed') return { rearm: false, why: '已经是 armed（无需重复授权）' }
  if (!RESUMABLE.has(reason)) return { rearm: false, why: `中断原因 ${reason} 不是机器造成的` }
  if (typeof goal.roundsStarted === 'number' && typeof goal.maxGoalRounds === 'number'
      && goal.roundsStarted >= goal.maxGoalRounds) {
    return { rearm: false, why: `轮次已用尽 ${goal.roundsStarted}/${goal.maxGoalRounds}` }
  }
  if (typeof goal.id !== 'string' || typeof goal.revision !== 'number') {
    return { rearm: false, why: 'goal 缺少 id/revision' }
  }
  return { rearm: true, id: goal.id, revision: goal.revision }
}
