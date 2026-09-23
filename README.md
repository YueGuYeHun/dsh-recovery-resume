# dsh-recovery-resume

**DSH 重启后，自动把被中断的任务接起来继续做 —— 并且要求 Agent 先核对真实状态，而不是简单发一句「继续」。**

> **English summary** — A DSH host plugin that resumes turns interrupted by a host
> restart or crash. It hooks `agent/created` / `agent/status → idle` (the moment a
> session actually becomes live), reads the trailing `turn/end reason=interrupted`
> that DSH's own crash repair writes, and enqueues a continuation message that
> **requires the agent to verify real-world state first** — never assume a side
> effect succeeded or failed. It also re-arms an `active` goal so goal rounds keep
> advancing. Cross-restart attempt limits and a cooldown prevent runaway resume loops.
> Written and tested against DSH `0.1.6-alpha.1` on macOS 13 (Intel).

---

## 它解决什么问题

DSH 保证「重启后**会话还在**」——你重新打开就能看到原来的对话，被截断的回合也会被补上
`turn/end reason=interrupted`。但它**不会**因此做任何事：那个回合就静静躺在事件流里，
**直到有人再发一条消息**。所以你会看到：窗口回来了、对话在，但 Agent 不动了。

这个插件补的就是这一环：它等着会话真正活起来，然后替你把任务接上。

**续跑消息不是「继续」两个字。** 重启之后外部世界可能已经变了（下载到一半、推送成功但
没记下结果），所以消息要求 Agent **先查证据再动手**：确认中断前那一步到底做成了没有，
不确定就用幂等的方式重做，确认之后再从正确的位置接着走。**不许假定成功，也不许假定失败。**

---

## 安装

```bash
# 直接从 GitHub 安装（推荐）
dsh plugin --profile web add github:flandre2233/dsh-recovery-resume

# 或先克隆再以本地目录安装（想改代码时用）
git clone https://github.com/flandre2233/dsh-recovery-resume.git
dsh plugin --profile web add link:"$(pwd)/dsh-recovery-resume"
```

装完**重启 DSH**（host 侧插件不会热加载）。

**零外部依赖**：不 import 任何 `@deepseek-ai/*` 包，运行时只用 Node 内置模块
（`node:crypto` / `node:fs` / `node:path`），也不需要 `node_modules`。
所以 GitHub 装或本地装都一样，不会有"解析不到包"的崩溃。

---

## 它是怎么判断的

判据很窄，**宁可不动作也不误动作**。只有下面几条同时成立才续跑：

| 条件 | 为什么 |
|---|---|
| 事件流最后一条 `turn/end` 的 reason 是 `interrupted` / `error` / `max-tokens` | 这三种才代表"非正常结束"；`completed` / `aborted`（你主动停）都不动 |
| 它之后**没有** `turn/start`、也**没有**你发的消息 | 有的话说明已经有人处理过了，不该再插手 |
| 中断发生在 **15 分钟**内 | 更早的不翻旧账 —— 你可能早就手动处理完了 |
| 会话真的活了（`agent/created` 或 `agent/status → idle`） | 这正是插件挂载点的意义：DSH 自己的崩溃修复写完 `turn/end` 之后才轮到它 |

**一个例外：永久性失败不续跑。** 如果上次失败是认证问题（`AUTH`/401）、配额耗尽、
上下文超限这类重试无益的原因，插件直接跳过并记日志 —— 不会拿你的钱去撞墙。
判断用的是 **DSH 官方错误码表**（`DEFAULT_RETRYABLE_CODES`），不是自编正则。

---

## 防失控（三层）

「崩 → 续 → 崩 → 续」如果没人叫停，每一圈都在烧 token。所以有三层限制：

| 层 | 限制 | 边界 |
|---|---|---|
| 1 | 同一进程内，同一会话最多续 **1** 次 | 进程内计数 |
| 2 | **跨重启账本**：连续未成功最多 **3** 次 | `$DSH_HOME/recovery-attempts.json` |
| 3 | 两次续跑至少间隔 **5 分钟** | 挡住紧密循环 |

**退避只惩罚失败**：如果两次尝试之间任务有进展（事件流序号前进了），计数**清零** ——
不会因为你连续重启了几次就把你锁在门外。账本 7 天后自动清理。

超限时插件**只写日志、停下等人**，不做任何动作。

另外它会**重新武装 `active` 状态的 goal**（就是界面上那个"继续"按钮用的同一个 API），
让目标自己继续推进；**`paused` / `blocked` 的目标绝不动** —— 那是你主动停的。

---

## 怎么确认它在工作

```bash
# 1. 插件确实被加载了（权威判据：打印组合后的插件树）
dsh --profile web --dump-config | grep -A2 recovery-resume

# 2. 看它每一步的判断（所有输出都带 dsh-recovery-resume 前缀）
tail -50 ~/.dsh/host.log | grep dsh-recovery-resume
```

正常触发时会长这样（真实日志）：

```
dsh-recovery-resume: agent 创建 id=session-xxx status=idle
dsh-recovery-resume: ★ 发现未处理的中断（reason=interrupted turnSeq=8451 lastTool=bash）
dsh-recovery-resume: 续跑消息已入队 session-xxx
dsh-recovery-resume: 已重新武装 goal xxx
```

**什么都没发生**时的常见说法（都是正常的，不是故障）：

| 日志 | 含义 |
|---|---|
| `无需续跑（尾部没有未处理的中断）` | 上次是正常结束 / 你已经处理过了 |
| `跳过 …（上次失败是永久性的…）` | 认证、配额、上下文超限 → 重试无益，正确行为 |
| `跳过 …（本次进程已续跑 1 次）` | 一层限制生效 |
| `冷却中（还需 N 秒）` | 三层限制生效 |
| 一行日志都没有 | 插件没被加载 —— 先跑上面的 `--dump-config` |

---

## 测试

```bash
bash test/run.sh          # 共 82 个用例，零依赖，不需要 DSH 在运行
```

用例偏重「**不该动**」的情形：你主动暂停 / `blocked` / `aborted` 的目标绝不重新武装、
太老的中断不翻旧账、账本到上限后等再久也不放行、消息 id 必须唯一。

---

## 已知限制

- **只有 host 侧重启才触发。** 你没有重启、但模型调用失败（`error`）也会触发；
  `completed` / `aborted` 不会。
- **多标签页同时开同一会话**靠 host 侧单实例与账本去重，插件本身没有锁。
- **只在 macOS 13 (Intel) + DSH `0.1.6-alpha.1` 上实测过。** 插件只用公开的
  `ctx` / `session` / `agent` 接口，理论上跨平台，但其他环境没有实测数据。
- **它不恢复"未完成的外部操作"。** 推送、下载、部署这类副作用是否真的完成，
  只能由 Agent 按消息里的要求去查证 —— 插件不替它判断。

## 卸载

```bash
dsh plugin --profile web remove dsh-recovery-resume
```

账本文件 `$DSH_HOME/recovery-attempts.json` 可以留着（7 天自动清理），也可以直接删。

## 详细的判断依据与验证记录

设计推理、源码出处、真实环境验证记录、错误码表出处、以及每次修正背后的实测，
都放在 [`docs/notes.md`](docs/notes.md) —— **README 保持简短，细节给想深挖的人**。

## 许可

MIT，见 [LICENSE](LICENSE)。
