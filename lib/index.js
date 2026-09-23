/**
 * dsh-recovery-resume —— 重启后自动续跑被中断的任务（瑠璃 2026-09-18）
 *
 * 为什么自己写：这台机器上已经装了第三方 dsh-client-auto-continue，但它**从没触发过**
 * （实测：4 次中断、host.log 里只有"已启动"一行、没有 `扫描发现中断`、没有任何
 * source=plugin 的消息）。读它的代码找到了结构上的原因：
 *
 *   它的启动扫描 `scanInterrupted()` 遍历的是 **live agents**（代码注释原文
 *   「只扫 live agents」），而它跑在服务启动后 3 秒 —— 那一刻**会话还没变成活
 *   agent**（没有任何人打开它）。于是候选集为空、扫描"成功"返回、永不再看第二眼。
 *   等页面加载、会话真正活起来时，已经没有任何东西会回头检查了。
 *
 * 本插件的挂载点就选在"会话真的活了"这一刻：`agent/created` + `agent/status`。
 * 那一刻 DSH 的崩溃修复（`dsh-session` 的 `interruptedTurnClosers`，由 agent-loop
 * 在加载会话时调用）已经给未闭合的回合补上了 `turn/end reason=interrupted`，
 * 所以可以直接读事件流判断。
 *
 * 判据与文案在 ./logic.js 里（零依赖、可脱离 DSH 单测）。
 */

import { buildUserMessage } from './message.js'
import { decideRearm, inspectTail, renderResumePrompt } from './logic.js'
import { extractKeyPoints } from './context.js'
import {
  COOLDOWN_MS,
  MAX_CONSECUTIVE_FAILED_RESUMES,
  checkLedger,
  detectProgressSinceLastAttempt,
  pruneLedger,
  readLedger,
  recordAttemptWithTurn,
  resetAttempts,
  writeLedger,
} from './ledger.js'

const PLUGIN = 'dsh-recovery-resume'

/** 同一会话在同一进程内的续跑次数上限。 */
const MAX_ATTEMPTS_PER_SESSION = 1

/** agent 变成 idle 之后等多久再判断（毫秒）：让崩溃修复与页面加载先完成。 */
const SETTLE_MS = 3000

/**
 * 跨重启账本的位置。
 *
 * 为什么需要它（我第一版的真实漏洞）：进程内的计数在服务重启后归零，于是
 * "崩 → 续 → 崩 → 续"没有任何东西叫停，每一圈都在烧 token。账本给这条循环
 * 加上跨重启的上限（3 次）与冷却（5 分钟），超限只写日志、等人确认。
 */
const LEDGER_PATH = `${process.env.DSH_HOME || `${process.env.HOME}/.dsh`}/recovery-attempts.json`

export const name = PLUGIN

export function apply(ctx) {
  // 用 console 直写而不是 ctx.logger：实测 ctx.logger.info 的输出在 host.log 里
  // 一行都找不到，而 dsh-client-auto-continue 用 console.info 的输出能进 host.log。
  // 排查"插件到底有没有加载"时必须有个可靠的出口，所以这一行放在最前面。
  console.log(`[${PLUGIN}] apply() 被调用 —— 插件已加载`)

  /** 已经在本次进程里续跑过的会话 → 次数。 */
  const attempted = new Map()

  ctx.inject(['agents', 'goals'], (scoped) => {
    scoped.on('agent/created', ({ agent }) => {
      console.log(`${PLUGIN}: agent 创建 id=${agent.id} status=${agent.status}`)
      schedule(agent, scoped)
    })
    scoped.on('agent/status', ({ agent, status }) => {
      console.log(`${PLUGIN}: agent 状态 id=${agent.id} -> ${status}`)
      if (status === 'idle') schedule(agent, scoped)
    })
  })

  function schedule(agent, scoped) {
    const timer = setTimeout(() => {
      try {
        consider(agent, scoped)
      } catch (error) {
        console.error(`${PLUGIN}: 判断异常 ${agent && agent.id}: ${errText(error)}`)
      }
    }, SETTLE_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function errText(error) {
    return error && error.message ? error.message : String(error)
  }

  function consider(agent, scoped) {
    if (!agent) return
    if (agent.status !== 'idle') {
      console.log(`${PLUGIN}: 跳过（status=${agent.status} ≠ idle）`)
      return
    }
    const session = agent.session
    if (!session) {
      console.error(`${PLUGIN}: agent 没有 session，跳过`)
      return
    }
    const done = attempted.get(session.id) || 0
    if (done >= MAX_ATTEMPTS_PER_SESSION) {
      console.log(`${PLUGIN}: 跳过 ${session.id}（本次进程已续跑 ${done} 次）`)
      return
    }

    // 跨重启的账本：进程内计数重启就归零，光靠它挡不住"崩—续—崩"的循环。
    // 注意：**账本检查必须放在"要不要续跑"之后** —— 见下面 2026-09-23 的实测修正。
    let ledgerState = readLedger(LEDGER_PATH)
    if (ledgerState.error !== undefined) {
      console.error(`${PLUGIN}: 账本读取失败（按空账本处理）: ${ledgerState.error}`)
    }
    let ledger = ledgerState.data

    // 事件流的读取方式（实测纠错）：DSH 0.1.6-alpha.1 上正确 API 是
    // `session.snapshotEvents()`；我上一版写的 `session.events` 在这里**不存在**
    // （host.log 实测：「读不到 … 的事件流（session.events 不是数组）」）。
    // 老版本（0.1.2 之前）才是属性 `events`，所以保留回退链 —— 这个写法抄自
    // dsh-client-auto-continue 的 snapshotSessionEvents()。
    let events
    try {
      if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
      else if (Array.isArray(session.events)) events = session.events
    } catch (error) {
      console.error(`${PLUGIN}: snapshotEvents() 抛错 ${session.id}: ${errText(error)}`)
      return
    }
    if (!Array.isArray(events)) {
      // 故意不用 `|| []` 掩盖：读不到事件流说明 API 名不对，必须看得见
      console.error(`${PLUGIN}: 读不到 ${session.id} 的事件流（既没有 snapshotEvents() 也没有 events）`)
      return
    }

    let info = inspectTail(events, Date.now())
    if (!info.resume) {
      if (info.skippedError !== undefined) {
        console.log(
          `${PLUGIN}: 跳过 ${session.id}（上次失败是永久性的，重试无益：` +
            `${info.skippedError.why}` +
            `${info.skippedError.code ? ` code=${info.skippedError.code}` : ''}）`,
        )
      } else {
        console.log(`${PLUGIN}: ${session.id} 无需续跑（尾部没有未处理的非人为中断）`)
      }
      return
    }

    console.log(
      `${PLUGIN}: ★ ${session.id} 发现未处理的中断（reason=${info.reason} turnSeq=${info.turnSeq}` +
        `${info.lastTool ? ` lastTool=${info.lastTool}` : ''}）→ 发送续跑消息`,
    )

    // ── 退避前的"上次成功了吗"判定（2026-09-23 实测修正）────────────────────
    // 实测踩到的反直觉缺陷：自适应退避原来对所有情况都生效，于是
    //   续跑成功 → 任务继续 → 又被打断 → 冷却已是 20 分钟 → **被自己的防失控挡住**
    //   （日志原文：「距上次续跑仅 243s，冷却中（本次冷却 1200s，还需 957s）」）
    // 正确语义：退避只惩罚**连续失败**。若这次的 turn/end 比上次续跑时新，
    // 说明上次续跑之后任务确实往前走了 → 上次成功 → 计数与冷却清零。
    const progress = detectProgressSinceLastAttempt(ledger, session.id, info.turnSeq)
    if (progress.success) {
      console.log(
        `${PLUGIN}: 上次续跑之后任务有进展（turnSeq ${progress.prevSeq} → ${info.turnSeq}）` +
          `→ 判定上次续跑成功，清零退避计数`,
      )
      ledger = resetAttempts(ledger, session.id)
      try {
        writeLedger(LEDGER_PATH, ledger)
      } catch (error) {
        console.error(`${PLUGIN}: 清零账本写入失败: ${errText(error)}`)
      }
    }

    const verdict = checkLedger(ledger, session.id, Date.now())
    if (!verdict.allow) {
      console.log(`${PLUGIN}: 跳过 ${session.id}（${verdict.why}）`)
      return
    }

    // 最小关键点：只补 agent 自己查不到或不值得再翻的几样（见 lib/context.js 的说明）。
    // 提取失败绝不影响主流程 —— 关键点是优化，不是必需品。
    let endIndex = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i] && events[i].type === 'turn/end' && events[i].seq === info.turnSeq) { endIndex = i; break }
    }
    try {
      info = { ...info, keyPoints: extractKeyPoints(events, endIndex) }
    } catch (error) {
      console.error(`${PLUGIN}: 关键点提取失败（不影响续跑）: ${errText(error)}`)
    }

    let message
    try {
      // source 只放官方类型定义里有的两个字段（`{ kind: 'plugin', plugin: string }`）。
      // 曾经多传过一个 `turnSeq` —— 它在 dsh-llm 的类型定义里零命中，属于自造字段；
      // 需要这个序号的地方本来就用 `info.turnSeq`，不必塞进消息来源标记里。
      message = buildUserMessage({
        content: renderResumePrompt(info),
        source: { kind: PLUGIN, plugin: PLUGIN },
      })
    } catch (error) {
      console.error(`${PLUGIN}: 构造消息失败: ${errText(error)}`)
      return
    }

    try {
      agent.followup(message)
      attempted.set(session.id, done + 1)
      console.log(`${PLUGIN}: 续跑消息已入队 ${session.id}（messageId=${message && message.id}）`)
      // 落盘记账：这一步让"跨重启上限"生效。写失败要看得见（不能静默 ——
      // 静默失败的后果是防失控机制悄悄失效）。
      try {
        const now = Date.now()
        const updated = recordAttemptWithTurn(pruneLedger(ledger, now), session.id, now, info.turnSeq)
        writeLedger(LEDGER_PATH, updated)
        console.log(
          `${PLUGIN}: 账本已更新 ${session.id} → 累计续跑 ${updated[session.id].attempts} 次` +
            `（本次 turnSeq=${info.turnSeq}）` +
            `（连续未成功上限 ${MAX_CONSECUTIVE_FAILED_RESUMES}，冷却 ${COOLDOWN_MS / 1000}s）`,
        )
      } catch (ledgerWriteError) {
        console.error(`${PLUGIN}: 账本写入失败（防失控计数不生效！）: ${errText(ledgerWriteError)}`)
      }
    } catch (error) {
      console.error(`${PLUGIN}: followup 失败 ${session.id}: ${errText(error)}`)
    }

    // ── 重新取得"继续执行"的授权 ──────────────────────────────────────────
    // goal 的 activation 是**进程内**的（DSH 源码注释原文：process-local activation
    // state, initially disarmed），每次服务启动都会被 disarm —— 所以哪怕目标还在
    // phase=active，重启后也没人有资格继续它是。这里把它重新武装（=主人界面上
    // 点那个按钮的同一个 API）。
    //
    // 延后 1.5 秒做：先让上面的续跑消息占住这一轮，goal 轮次排在它后面
    // （驱动器的开轮条件是 agent idle，且它会看到 competingQueued 而让位）。
    const rearmTimer = setTimeout(() => {
      try {
        rearmGoal(scoped, agent, info.reason)
      } catch (error) {
        console.error(`${PLUGIN}: 重新武装异常 ${session.id}: ${errText(error)}`)
      }
    }, 1500)
    if (typeof rearmTimer.unref === 'function') rearmTimer.unref()
  }

  /**
   * 只对 `phase === "active"` 的目标重新武装 —— `ctx.goals.resume()` 源码里同时
   * 接受 paused/blocked，无条件调用会覆盖主人主动暂停的目标，那是不能做的。
   * 判断全在 ./logic.js 的 decideRearm 里（有单测）。
   */
  function rearmGoal(scoped, agent, reason) {
    let goal
    try {
      goal = scoped.goals.get(agent)
    } catch (error) {
      console.error(`${PLUGIN}: 读 goal 失败 ${agent.id}: ${errText(error)}`)
      return
    }
    const decision = decideRearm(goal, reason)
    if (!decision.rearm) {
      console.log(`${PLUGIN}: 不重新武装 goal（${decision.why}）`)
      return
    }
    try {
      scoped.goals.resume(agent, { id: decision.id, revision: decision.revision })
      console.log(`${PLUGIN}: ★ 已重新武装 goal ${decision.id}（revision=${decision.revision}）→ 目标可继续推进`)
    } catch (error) {
      // revision 可能在这一瞬被推进过；按新 revision 再试一次（只重试一次）
      console.error(`${PLUGIN}: 重新武装失败（将按最新 revision 重试一次）: ${errText(error)}`)
      try {
        const fresh = scoped.goals.get(agent)
        if (fresh && typeof fresh.id === 'string' && typeof fresh.revision === 'number') {
          scoped.goals.resume(agent, { id: fresh.id, revision: fresh.revision })
          console.log(`${PLUGIN}: ★ 重试成功，已重新武装 goal ${fresh.id}（revision=${fresh.revision}）`)
        }
      } catch (retryError) {
        console.error(`${PLUGIN}: 重新武装重试仍失败: ${errText(retryError)}`)
      }
    }
  }
}
