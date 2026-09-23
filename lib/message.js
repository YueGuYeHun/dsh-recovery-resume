/**
 * 最小的 user 消息构造器 —— 零 host 依赖。
 *
 * 为什么不 import `@deepseek-ai/dsh-llm` 的 `createUserMessage`：
 *
 * host 包（`@deepseek-ai/dsh-llm`）不在本插件的 `dependencies` 里，装到别人机器上
 * 也解析不到。实测（2026-09-23）：本机靠插件目录里的 `node_modules/@deepseek-ai`
 * 软链才能解析成功，而那个软链指向**绝对路径**且被 `.gitignore` 挡住 ——
 * 临时移走软链后立刻 `MODULE_NOT_FOUND`。也就是说：**clone 下来装，插件会直接崩。**
 *
 * 生态里的通行做法是「不 import host 包」：同机已装的另外 5 个 out-of-tree 插件
 * （dsh-mcp-diag / dsh-mcp-watch / dsh-pet-status / dsh-whale-musume / whale-purse）
 * 一个都不 import，也都不需要 `node_modules`。本文件让本插件回到同一做法。
 *
 * 内联是否安全 —— 依据是实测，不是猜测：
 *
 * 1. **host 不校验消息**。`agent.followup(input)` 在 `dsh-agent-loop` 里的实现是
 *    `send(input, "next-turn", true)`，而 `send` 只做 `inbox.splice(...)` 入队，
 *    没有任何运行时断言。
 * 2. **字段要求只有 4 个**。`UserMessage` 是结构化类型（`interface Message` +
 *    `role: 'user'`）：`id` / `role` / `content` / `source`。没有私有类、没有
 *    `instanceof` 检查、没有 symbol 字段。
 * 3. **`id` 必须唯一且非空**。`dsh-agent-loop` 维护一个 `Set`，重复 id 会抛
 *    `message "…" is already pending`，而 undefined 会让多条消息共享同一个 key。
 *    所以这里每条都生成新的 UUID。
 * 4. **`createUserMessage` 本体只是** `createMessage({ ...input, role: 'user' })`，
 *    而 `createMessage` 只多做两件事：加 `brandString(randomUUID())` 生成的 id
 *    （`brandString` 仅编译期品牌，运行时返回原字符串）与 `deepFreeze`。
 *    **冻结不是语义要求**：host 自己的投影代码 `structuredClone` 输入，不要求预先冻结。
 * 5. **`source` 是纯数据**。host 只用它做 `source.kind === 'plugin' &&
 *    source.plugin === SOURCE` 这类判断，不调用其上的方法，所以普通对象字面量足够。
 * 6. **`content` 必须是块数组**，不是字符串。官方类型是 `content: ContentBlock[]`，
 *    文本块形如 `{ type: 'text', text: string }`。本插件用 `renderResumePrompt()`
 *    生成 content，它返回的正是这种块数组（实测：1 个 `{type:'text', text:…}` 块）
 *    —— 与 host 的 `dsh-command-goal` 用 `createUserMessage` 时的写法一致。
 *
 * 构造出来的对象已按官方类型逐字段核对过（`id`/`role`/`content`/`source` 四个字段，
 * 无多余字段），核对脚本与结果见仓库的验证记录。
 *
 * 为什么不用 `structuredClone` + `Object.freeze` 去"复刻"冻结语义：
 * 那会带来一个不必要的失败模式（调用方传进不可克隆的值时抛错），
 * 而没有任何代码依赖消息被冻结。少做一件没人要求的事。
 */

import { randomUUID } from 'node:crypto'

/**
 * 构造一条带唯一 id 的 user 消息。
 *
 * @param {{ content: unknown, source: { kind: string, plugin: string } }} input
 *   消息内容与来源标记。`source.plugin` 用插件自己的名字，
 *   这样 host 与客户端能认出这条消息是哪个插件投的（本插件据此判断"已处理"，
 *   不会把主人的消息误判成插件的）。
 * @returns {{ id: string, role: 'user', content: unknown, source: object }}
 *   可直接交给 `agent.followup()` 的消息对象。
 */
export function buildUserMessage(input) {
  return {
    id: randomUUID(),
    role: 'user',
    content: input.content,
    source: input.source,
  }
}
