# dsh-recovery-resume

**DSH 宿主重启后，自动把被中断的任务接起来继续做 —— 并且要求 Agent 先核对真实状态，而不是简单发一句「继续」。**

> **English summary** — A DSH host plugin that resumes turns interrupted by a host
> restart/crash. It hooks `agent/created` / `agent/status → idle` (i.e. the moment a
> session actually becomes live), reads the recovered session log for a trailing
> `turn/end` with reason `interrupted`, and enqueues a continuation message that
> **requires the agent to verify real-world state first** (never assume a side effect
> succeeded or failed). It also re-arms an `active` goal so goal rounds keep advancing.
> Cross-restart attempt limits and a cooldown prevent runaway resume loops.
> Written and tested against DSH `0.1.6-alpha.1` on macOS 13 (Intel).

---

## 为什么需要它

DSH 自己**不**保证"重启后任务接着做"。它保证的是另外两件事：

| DSH 已经有的 | 说明 |
|---|---|
| **会话恢复** | 客户端把 `{sessionId}` 存进浏览器 localStorage（键 `dsh.sessions.current`），页面重载后重连 —— 所以你重启后**能看到原来的对话** |
| **崩溃修复** | `dsh-session` 的 `interruptedTurnClosers`（由 `dsh-agent-loop` 在加载会话时调用）会给未闭合的回合补上合成事件：`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` + 一条 `turn/end`，reason = `interrupted` |

但它**不会**因为这些去做任何事：新宿主起来后，那个被打断的回合就静静躺在事件流里，
**直到有人再发一条消息**。于是现象是：窗口回来了、对话在、但 Agent 像下班了一样不动。

这个插件补的就是这一环。

### 与现成方案的区别

社区里已有 `dsh-client-auto-continue`（作者 HsiangNianian，MIT）。它**功能更全**
（错误分类、退避、循环守卫、通知按钮），本插件是**独立实现**，只解决其中一件事。
两者在**扫描时机**上有关键差异（以下断言的源码出处为 `dsh-client-auto-continue`
**0.11.7** 的 `src/host/engine.ts`，行号可复核）：

| | `dsh-client-auto-continue` 0.11.7 | `dsh-recovery-resume` |
|---|---|---|
| 触发时机 | 宿主启动后**立即**扫描（`engine.ts:258` `void this.bootScanLoop()` → `:1006 scanLoop(Infinity, 3000)`） | `agent/created` / `agent/status → idle`，即**会话真正活起来之后** |
| 扫描范围 | `for (const agent of this.ctx.agents.list())`（`engine.ts:1044`）—— **只扫 live agents** | 同上，但因为在会话激活后才触发，候选集**不为空** |
| 扫完之后 | `if (await this.scanInterrupted()) return;`（`engine.ts:1013`）—— **扫一次即退出，不再复查** | 每次 agent 变 idle 都会重新判断 |

**为什么这个差异是决定性的**：宿主启动后 3 秒，那个会话通常**还没有变成 live agent**
（没有人打开它 —— 页面还没加载完）。于是候选集为空、扫描"成功"返回、之后再也不会看第二眼。
等页面加载、会话激活时，已经没有任何东西会回头检查了。

> 这不是本机特有的现象，而是上面三条控制流直接推出的结论。本机实测：
> 4 次宿主崩溃中断之后，`auto-continue` 每次都只打一行「已启动」，
> 没有任何判定日志、没有任何续跑消息（判据见「日志」一节）。

---

## 安装

```bash
# 从本地目录（开发用）
dsh plugin --profile web add link:/absolute/path/to/dsh-recovery-resume

# 或从 git 仓库
dsh plugin --profile web add github:<owner>/<repo>
```

装完**重启 DSH**（宿主侧插件不会热加载）：

```bash
~/.dsh/bin/cycle.sh          # 如果你有配套的 cycle 脚本
# 或者：退出 app 再打开
```

### 依赖说明（重要）

插件运行时 `import { createUserMessage } from '@deepseek-ai/dsh-llm'` —— 这个包由 DSH 提供，
不在 npm 上单独发布。如果你的插件源码放在 `$DSH_HOME` **之外**（例如 `~/Documents/...`）
再软链进 profile，Node 会从**真实路径**往上找 `node_modules`，从而**解析不到**这个包，
报 `Cannot find package '@deepseek-ai/dsh-llm'` —— **这会让整棵插件树崩溃**。

解决办法：在插件目录里放一个软链。

```bash
mkdir -p node_modules/@deepseek-ai
ln -sfn "$(dirname "$(readlink -f "$(which dsh)")")/../node_modules/@deepseek-ai/dsh-llm" \
        node_modules/@deepseek-ai/dsh-llm
```

（本机的实际做法见 `package.json` 注释与仓库根的 `.gitignore`；`node_modules/` 不入库。）

---

## 工作方式

```
宿主崩溃 / 被重启
      │
      ▼
新宿主启动 → 会话被打开 → agent 创建（status=idle）
      │                       │
      │                       └──► 本插件在这里触发（延迟 3s 让崩溃修复先完成）
      ▼
会话事件流里已有 turn/end reason=interrupted（由 DSH 的崩溃修复写入）
      │
      ▼
判据：尾部最后一条 turn/end 的 reason ∈ {interrupted, error, max-tokens}
      且其后没有 turn/start、没有 source.kind === 'user' 的消息
      且时间足够新（15 分钟内）
      │
      ▼
账本检查：跨重启续跑次数 < 3？距上次续跑 ≥ 5 分钟？
      │
      ├── 不通过 → 只写日志，停下等人
      ▼
投出续跑消息（agent.followup）→ 记一次账
      │
      ▼
若目标仍是 phase=active 且未用尽轮次 → 重新武装 goal（延后 1.5s，让续跑消息先占住这一轮）
      │
      ▼
Agent 自己核对状态、接着做
```

### 续跑消息长什么样

**不是**「继续」两个字。重启期间外部世界可能已经变了（下载到一半、`git push` 成功但没落记录、
文件只写了一半），所以消息**要求先核对**：

```xml
<recovery_resume>
这台机器上的 DSH 刚刚重启过（宿主进程被换掉了），你上一回合因此被中断。
中断原因：interrupted。
中断前最后一个工具调用是「bash」—— 它可能已经执行成功、执行到一半、或根本没跑起来。

继续之前**必须先核对真实状态**：
1. 先看工作区 / 进程 / 日志，确认中断前那一步到底做成了没有 —— 不要根据对话历史假定它成功，也不要假定它失败。
2. 如果那一步的结果不确定（下载进度、推送是否真的成功、文件写到哪个程度），去查实际证据；必要时用幂等的方式重做。
3. 确认实际状态之后，从正确的位置接着做，不要重复已经完成的动作。

做完要给出可复核的证据（命令输出、文件内容、退出码）。如果无法继续（缺前提、外部不可用），如实说明并停下。
</recovery_resume>
```

`{最后一个工具调用}` 是从事件流里回溯出的最后一条 `tool/call`，用来告诉 Agent
**哪一步的结局没被确认**。

---

## 防失控（三层限制）

这是本插件最需要注意的部分。没有它会出现**无上限的烧钱循环**：

```
任务被中断 → 重启 → 续跑 → 又中断 → 又重启 → 又续跑 → …（没有东西会叫停）
```

| 层 | 限制 | 位置 |
|---|---|---|
| 1 | 同一宿主内，同一会话最多续 **1** 次 | `MAX_ATTEMPTS_PER_SESSION` |
| 2 | **跨重启**最多续 **3** 次（落盘） | `lib/ledger.js` → `MAX_ATTEMPTS_ACROSS_RESTARTS` |
| 3 | 两次续跑之间至少间隔 **5 分钟** | `lib/ledger.js` → `COOLDOWN_MS` |

超过任一层限制时**只写日志、不再自动续跑**，把决定权交回给人。

账本文件：`$DSH_HOME/recovery-attempts.json`（默认 `~/.dsh/recovery-attempts.json`），
原子写入（先写 `.tmp` 再 rename），自动清理 7 天前的会话条目。

```json
{
  "session-d7fb7b06-…": { "attempts": 2, "lastAt": 1789726800000, "history": [1789710000000, 1789726800000] }
}
```

### 关于重新武装 goal

goal 的 `activation` 是**进程内**状态（DSH 源码注释原文：`process-local activation state,
initially disarmed`、`activation is deliberately absent`），所以每次宿主启动都会被 disarm ——
这正是 DSH 界面上「未运行的目标」（`phase.active.disarmed`）的含义。

本插件会把它重新武装（等同于点界面上那个按钮，调用 `ctx.goals.resume(agent, {id, revision})`），
**但只对 `phase === "active"` 的目标动手**：该 API 在源码里同时接受 `paused` 与 `blocked`，
无条件调用会覆盖用户主动暂停的目标。这条红线有单测钉死。

---

## 日志与排查

插件用 `console.log` / `console.error` 直写（**不是** `ctx.logger` —— 实测
`ctx.logger.info` 的输出在宿主日志里找不到，用它排查会白费一轮）。输出进宿主的 stdout，
即 `$DSH_HOME/host.log`。

一次成功的续跑长这样：

```
[dsh-recovery-resume] apply() 被调用 —— 插件已加载
dsh-recovery-resume: agent 创建 id=session-… status=idle
dsh-recovery-resume: agent 状态 id=session-… -> running
dsh-recovery-resume: session-… 无需续跑（尾部没有未处理的非人为中断）        ← 正常会话
dsh-recovery-resume: ★ session-… 发现未处理的中断（reason=interrupted turnSeq=6805 lastTool=bash）→ 发送续跑消息
dsh-recovery-resume: 续跑消息已入队 session-…（messageId=…）
dsh-recovery-resume: 账本已更新 session-… → 累计续跑 2 次（跨重启上限 3，冷却 300s）
dsh-recovery-resume: ★ 已重新武装 goal goal-…（revision=2）→ 目标可继续推进
```

被限制挡住时（这是**预期的**，不是故障）：

```
dsh-recovery-resume: 跳过 session-…（跨重启已续跑 3 次（上限 3），停下等人确认）
dsh-recovery-resume: 跳过 session-…（距上次续跑仅 42s，冷却中（还需 258s））
dsh-recovery-resume: 不重新武装 goal（phase=complete（只处理 active））
```

**确认插件到底有没有被加载**，用 DSH 自己的权威命令（会打印组合后的插件树）：

```bash
dsh --profile web --dump-config | grep -A2 recovery-resume
```

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `host.log` 里一行 `dsh-recovery-resume` 都没有 | 插件没被加载：先跑上面的 `--dump-config`；确认装完**重启过**宿主 |
| `读不到 … 的事件流（既没有 snapshotEvents() 也没有 events）` | DSH 版本的会话 API 变了。当前写法：优先 `session.snapshotEvents()`，回退属性 `session.events` |
| `Cannot find package '@deepseek-ai/dsh-llm'` | 见上面「依赖说明」，**会导致整棵插件树崩溃** |
| 插件把整棵树搞崩、DSH 起不来 | 从 `$DSH_HOME/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉本插件，再 `dsh plugin --profile web install` |

---

## 测试

`lib/logic.js` 与 `lib/ledger.js` **零依赖**（不 import 任何 DSH 包），
所以可以脱离 DSH 直接单测 —— 这也是把它们单独拆出来的原因：判据是整件事最容易出错的部分。

```bash
bash test/run.sh          # 跑全部；单文件也可以：node test/logic.test.mjs
```

每个用例都钉一个边界，尤其偏重「**不该动**」的情形：用户主动暂停 / blocked / aborted 的
目标绝不重新武装、太老的中断不翻旧账、账本到上限后等再久也不放行。

（本机实测：`logic` 22/22、`ledger` 12/12 通过，`bash test/run.sh` 退出码 0。）

---

## 已知限制

- **只在 DSH `0.1.6-alpha.1` + macOS 13（Intel）上实测过**。会话事件与 agent 生命周期
  属于 DSH 内部 API，**cross-version 兼容性没有保证**；升级 DSH 后请重新跑一遍测试。
- **"新鲜度"窗口固定 15 分钟**（`FRESH_MS`）。超过就不翻旧账 —— 一个几小时前的中断
  未必还该自动接着做。目前不可配置。
- **不判断"任务是否其实已经完成"**：判据只看 `turn/end` 的 reason 与之后有无新回合/用户消息。
  如果任务在被中断前已经做完了，续跑会多问一轮（消息里要求先核对状态，属于预期行为，
  但仍会消耗一轮）。DSH 的 goal 机制有 `complete` 动作可以表达"做完了"，本插件不代它判断。
- **子代理会话不处理**（`session.header.origin === 'subagent'` 直接跳过，与上游一致）。
- 多标签页/多窗口同时打开同一会话时，靠**宿主侧单实例**与账本去重；本插件本身没有锁。

---

## 卸载

```bash
# 1. 从 profile 移除（两处都要干净：dependencies 与 dsh.profile.bundles）
dsh plugin --profile web remove dsh-recovery-resume

# 2. 删账本（可选）
rm ~/.dsh/recovery-attempts.json

# 3. 重启宿主
```

---

## 许可

MIT（见 `LICENSE`）。

## 致谢

- 挂载点与消息构造方式参考了 DSH 自带的 `dsh-goal-round-driver`
  （`ctx.on('agent/created' / 'agent/status')` + `createUserMessage` + `agent.followup`）。
- 社区插件 `dsh-client-auto-continue` 在本插件之前就探索了这个问题域，
  其 `snapshotSessionEvents()` 的版本兼容写法被本插件借鉴（回退链）。
