# dsh-taskcleanup
用于deepseek Harness插件,需要api辅助安装
安装后可实现在每个任务完成后自动清理任务无效内存和缓存
# dsh-task-cleanup

在每个**轮次（turn）结束**后，回收任务级的内存缓存、中间态对象、定时器、已结算的 job 记录与过期磁盘缓存。

本文档里所有 API 都来自**本机 DSH 0.2.0-rc.2 的真实代码/文档**，不是猜测。证据见 [附录：证据](#附录证据)。

---

## 1. 先明确一件事：DSH 里的"任务完成"是什么

DSH 没有一等的 "task" 概念，一次用户请求到模型停止 = 一个 **turn（轮次）**。轮次边界是一个持久化的会话事件：

| 事件 | 负载 | 含义 |
|---|---|---|
| `turn/start` | `{ turn }` | 轮次开始 |
| `turn/end` | `{ turn, reason }` | 轮次结束（含 `canceled` / `blocked` 等原因） |

订阅方式（宿主插件里）：

```js
ctx.on('session/event', (session, event) => {
  if (event.type === 'turn/start') { /* 打开本轮作用域 */ }
  if (event.type === 'turn/end')   { /* 释放本轮作用域 */ }
})
ctx.on('session/disposed', (session) => { /* 会话被销毁，兜底释放 */ })
```

注意 `turn/end` 的**覆盖边界**：`ask_user_question`、授权弹窗是"挂起的工具调用"，等待期间轮次不结束，`turn/end` 不会来。所以"每轮结束清理"覆盖不到"等用户点按钮的那一刻"。

---

## 2. 责任划分：哪些 DSH 已经替你做了

这决定了你要写的代码量。**很多"任务级缓存"DSH 自己已经管好了，不要重复造。**

| 资源 | DSH 的现状 | 你还要做什么 |
|---|---|---|
| 会话日志、会话投影缓存 | `dsh-session-projection-cache`：写入在 `turn/end` 后落地、会话释放时丢弃内存快照 | 不用管 |
| 会话级注册/资源 | Cordis 的 fiber：作用域 `dispose()` 时逆序宕掉该作用域每个注册；`agent.ctx` 上的注册只对该 agent 可见 | 不用管 |
| 后台 job / 子进程 | `dsh-jobs`：owner 或 service 销毁时取消并等待；会话归档时 `workspace/session-stop` 逐个 kill | 只回收**已结算**的记录（见 §5） |
| 工具输出 / 大文本 spill | `dsh-output-retention` + `dsh-spill`：有保留策略与落盘 | 可按 TTL 清 spill 文件 |
| **你自己插件里的** 每轮缓存 | 没人管，**必须你自己切断引用** | ← 这才是本插件的核心 |
| **浏览器/渲染层**的每轮 DOM、监听器、定时器、ObjectURL | 没人管 | 见 §6 |

一句话：**"清理无效内存"在 JS 里 = 切断强引用，不是调用 free。** V8 的 GC 无法、也不该被强制。

---

## 3. 三种落地方式（按侵入性排序）

| 方案 | 能清什么 | 代价 |
|---|---|---|
| **A. Stop hook 调外部脚本** | 只有磁盘/临时文件 | 零代码，但钩子跑在独立子进程里，**碰不到宿主内存** |
| **B. 宿主 Cordis 插件**（本目录主体） | 内存缓存、定时器、句柄、job 记录、磁盘 | 需要一个插件工程 |
| **C. 客户端半（渲染层）** | DOM、window 监听器、渲染层定时器、ObjectURL | 需要 `dsh.client` 清单，见 §6 |

**A 和 B 不冲突，推荐组合使用**：B 管内存，A 管磁盘（磁盘清理交给独立进程，失败也不影响会话）。

---

## 4. 方案 A：零代码，用 Stop hook 清磁盘

DSH 自带 Claude Code 兼容的钩子桥接。`Stop` 事件在"本轮停止时"触发，钩子以 **command 子进程**运行。

**第 1 步**：在 profile 里挂载桥接。编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，**追加**一段 `insert`：

```yaml
- insert:
    - id: hooks-claude-code
      name: "@deepseek-ai/dsh-hooks-claude-code"
      config:
        configPath: "C:\\Users\\ASUS\\Desktop\\dsh-task-cleanup\\examples\\hooks.json"
        defaultTimeoutMs: 60000
```

> 新增一行必须用 `insert` 形式。profile patch 里的**裸** `- id: xxx` 条目是"覆盖已存在行的 config"，桥接不在默认 bundle 栈里，裸 id 不会把它加进来。
>
> 本机在用的 profile 是 `desktop`（已装 3 个第三方插件、已配好模型）；`web` 是只有 `dsh-base` + `dsh-web-app` 的空白 profile。命令行请统一用 `--profile desktop`。

**第 2 步**：用 `examples/hooks.json`（已按本机路径填好），或自己改成：

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"…\\scripts\\cleanup-disk.mjs\" --dir \"C:\\Users\\ASUS\\.dsh\\cache\" --max-age-days 7", "timeout": 30 } ] }
    ]
  }
}
```

先跑**预演**（本机实测输出）：

```
[cleanup-disk] C:\Users\ASUS\.dsh\cache (cache) : 可删除(dry-run) 0 个文件 / 0 B | 扫描 1, 跳过 1 个目录, 错误 0
```

确认命中范围后可加 `--yes` 真正删除。脚本的安全约束：

- 不给 `--dir` 直接退出（绝不猜目录）
- 目标必须在 `DSH home` 之内，否则拒绝
- 不给 `--yes` 就是 dry-run
- 默认跳过 `attachments` 目录（那是会话附件，不是缓存）

> 钩子的能力上限（官方文档明说）：只有 `{type:'command'}` 会执行，`http`/`mcp_tool`/`prompt`/`agent` 会被跳过；除退出码 2 外的一切失败都是非阻塞失败。

---

## 5. 方案 B：宿主插件（本目录，已通过 14 项测试）

### 它做了什么

```
turn/start  → 建一个 TurnScope（本轮资源的唯一账本）
turn/end    → ① 清空本轮所有容器 ② 清掉本轮 interval/timeout
              ③ 调用登记的句柄释放器 ④ 删本轮临时目录
              ⑤ 回收本会话"已结算"的 job 记录 ⑥ 按 TTL 清过期磁盘缓存
session/disposed → 兜底释放该会话残留
插件卸载/HMR     → ctx.effect 兜底全量释放（插件自己不能变成泄漏源）
```

### 别的插件怎么把自己的缓存交进来

Cordis 是广播事件模型，不需要互相 import：

```js
// 其它插件里
const myPerTurnCache = new Map()
ctx.on('task-cleanup/collect', (sinks) => {
  sinks.push(() => myPerTurnCache.clear())   // 每个 turn 结束时被调用
})
```

本插件返回的接口也支持编程式调用：`collect(sid, fn)`、`release(sid)`、`pruneNow()`。

### 关键代码位置

| 文件 | 职责 |
|---|---|
| [lib/reclaim.js](lib/reclaim.js) | `TurnScope`（容器/定时器/释放器账本）、`pruneTree`（TTL 文件清理）、`removeSettledJobs`、home 路径解析 |
| [lib/index.js](lib/index.js) | 插件本体：事件订阅、配置、节流、报告 |
| [lib/client.js](lib/client.js) | 渲染层半（见 §6） |
| [scripts/cleanup-disk.mjs](scripts/cleanup-disk.mjs) | 独立清理脚本，供方案 A 的钩子调用 |
| [test/plugin.test.mjs](test/plugin.test.mjs) | 假 ctx 单测 15 项，含真实定时器与真实目录的只读验证 |
| [test/cordis.integration.test.mjs](test/cordis.integration.test.mjs) | 真实 Cordis 集成 6 项：插件注册契约、事件总线、fiber dispose、`provide` 通道 |

### 为什么只回收"已结算"的 job

后台 job 是**故意跨轮存活**的（这正是 `run_in_background` 的语义）。在 `turn/end` 杀运行中的 job 会直接破坏该语义。而一条已结算的记录会一直留在 registry 里直到 owner 销毁，它持有的**输出环形缓冲是纯内存占用** —— 这才是每轮可以安全释放的部分。所以：

```js
if (job.status === 'running' || job.status === 'stopping') continue  // 保留
// completed / failed / canceled → remove(job.id, sessionId)
```

运行中的 job 由 DSH 自己在会话归档 / owner 销毁时 kill，不用你操心。

### 安装

```powershell
# 把插件装进 desktop profile（link 形式，改代码即时生效）
dsh plugin --profile desktop add link:C:\Users\ASUS\Desktop\dsh-task-cleanup
```

`dsh plugin` 会写入 profile 的 `package.json` / `cordis.patch.yml`（在 workspace 之外，需要批准），并触发热重载。

手工等价的写法：把本目录 `link:` 到 `~/.dsh/profiles/desktop/node_modules/dsh-task-cleanup`，再把 `"dsh-task-cleanup"` 加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组（它自己的 `cordis.patch.yml` 负责插入宿主行）。

### 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `dryRun` | `true` | 磁盘只统计不删除。**先保持 true 观察几轮** |
| `pruneDirs` | `null` → `[$DSH_HOME/cache]` | 清理根目录 |
| `pruneCacheMaxAgeMs` | 7 天 | 只清 mtime 更早的文件 |
| `includeAttachments` | `false` | 是否连 `cache/attachments` 一起清（危险） |
| `minPruneIntervalMs` | 10 分钟 | 磁盘清理节流；被节流会补跑一次 |
| `maxScanEntries` | 200000 | 单次遍历上限，防止拖慢一轮 |
| `removeSettledJobs` | `true` | 回收已结算 job 记录 |
| `reportHeap` | `true` | 打印 heapUsed 前后对比（参考值） |
| `forceGcWhenAvailable` | `false` | 只有宿主带 `--expose-gc` 时才有实际效果 |
| `sweepEveryMs` | `0` | 兜底周期清理，0 = 关闭（只在 turn/end 触发） |

### 验证

```powershell
$node = "C:\Users\ASUS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "C:\Users\ASUS\Desktop\dsh-task-cleanup\test\plugin.test.mjs"              # 假 ctx 单测：15 项
& $node "C:\Users\ASUS\Desktop\dsh-task-cleanup\test\cordis.integration.test.mjs"  # 真实 Cordis：6 项
```

本机实测：**15 通过 / 0 失败** 和 **6 通过 / 0 失败**。

单测不是打桩：`release()` 清 interval 的用例真起了一个定时器、真等了 70ms 确认它不再跳；dry-run 用例真的只读遍历了 `~/.dsh/cache`（扫描 6 个条目、匹配 2 个、约 572KB）并断言 `removed === 0`。

集成测试用的是本机 profile 里那份**真实的 `@deepseek-ai/cordis`**（`~/.dsh/profiles/node_modules/@deepseek-ai/cordis`，实为指向 `…\deepseek-harness\vendor\cordis` 的链接），走真实的事件总线、真实的 fiber effect 与真实的 `ctx.provide`。

> 这套集成测试不是装饰 —— 它当场抓出一个假 ctx 测不出的**真 bug**：插件 `apply` 返回了 API 对象，而 Cordis 会把 `apply` 的返回值当作 effect 体校验，直接抛 `TypeError: Invalid effect`。修法见 §7 第 9 条。

---

## 6. 方案 C：渲染层（客户端半）

渲染层的"无效内存"来源和宿主完全不同：每个 turn 追加的 DOM 节点、挂在 `window`/`document` 上的监听器、轮询定时器、`URL.createObjectURL` 产生的 Blob URL。这些**组件卸载后依然存活**。

客户端半的形态（已验证）：

- 是浏览器模块：`window.__ModuleLoader__.load({ id, factory })`，`factory` 返回 `{ apply, inject }`
- 通过 `package.json` 的 `dsh.client` 清单声明，宿主半与客户端半**按同名 id 配对**
- 卸载/HMR 时 teardown 走 fiber effect —— 所以**凡是你在客户端 `setInterval` 的，必须挂 `ctx.effect(() => () => clearInterval(id))`**

`lib/client.js` 已实现这套账本（容器 / 定时器 / 释放器 / ObjectURL），启用方式是在 `package.json` 里加：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web", "immediately": true }
}
```

> **默认没打开**，因为客户端半一旦加载失败，影响面是 GUI 本身。先在 `desktop` profile 上单独验证再启用。
>
> ⚠️ 需要按你的 DSH 版本核对一处：**客户端上下文里"轮次结束"的信号名**。宿主侧确定为 `session/event(type='turn/end')`；客户端侧 `lib/client.js` 用多路探测兜底（`session/event` / `turn/end`），命中即用。核对位置：`@deepseek-ai/dsh-client-ui-conversation` 与 `dsh-client-runtime` 的文档。

---

## 7. 坑（这些比代码重要）

1. **不能强制 GC。** 你只能切断引用。`global.gc` 只在宿主以 `--expose-gc` 启动时存在；即使调用，堆内存报告也只能当参考值。
2. **不要在 `turn/end` 杀运行中的 job。** 会破坏 `run_in_background` 语义（见 §5）。
3. **别删 `sessions/`、`storages/`、`cache/attachments`。** 前两个是数据不是缓存；`attachments` 是历史会话引用的附件，删了会话就残缺。本机 `cache/attachments` 就在清理根目录下面，所以默认 `dryRun: true` + 排除 attachments 是刻意的。
4. **本机实测：`~/.dsh/cache` 里只有 6 个条目 / 572KB 可回收**（7 天内几乎没东西）。也就是说瓶颈通常不在磁盘，而在**你自己的插件/渲染层没切断的引用**。别期待清缓存能省出可观内存。
5. **不要用对象级 `inject` 等待服务。** 被依赖服务没就绪会把整个 `apply()` 无限推迟（社区插件 issue #152/#153 就是踩了这个竞态）。本插件用 `ctx.get('jobs')` 可选读取，缺失就静默降级。
6. **插件自己必须可回收。** 你 `setInterval` 的、你 `ctx.on` 之外的全局监听，都要挂到 fiber effect 上，否则清理插件本身变成泄漏源。
7. **`ask_user_question` 期间没有 `turn/end`。** 轮次挂着等用户输入，别指望那时的清理。
8. **HMR 与配置变更**：profile 配置变化会触发热重载；插件改动是否能免刷新生效，取决于 `pnpm run dev:web` 是否在跑。宿主半改动通常需要重启 DSH。
9. **`apply` 绝不能返回非 effect 值**（最容易踩、也最难查）。Cordis 把插件 `apply` 的返回值当 effect 体校验（`fiber._execute`）：返回普通对象会抛 `TypeError: Invalid effect`，插件被判启动失败 —— 而且**它的监听器已经注册过了**，于是表现为"看似能用，日志里却在报错"。所以 `apply` 必须 `return undefined`（或返回函数 / thenable / 迭代器 / `null`）。本插件为此专门留了回归断言。
10. **对外提供服务要 `ctx.provide(name, value)`，不是 `ctx.set(name, value)`。** `set` 只能覆盖**已经 provide 过**的名字，否则抛 `cannot set property "x" without provide`。用 `provide` 还有个好处：注册是挂在当前 fiber effect 上的，卸载即自动注销。
11. **别用 `assert`/`util.inspect` 去格式化一个 Cordis 上下文。** `inspect` 内部走 `isURL()` 会读代理的 `.href`，在未 `inject` 的上下文上直接抛 `cannot get property "href" without inject`，把真正的失败原因盖掉（本次调试就踩了这个坑，花了几个来回）。断言上下文时只比较原始类型。

---

## 8. 最短路径建议

1. 先按 §5 装宿主插件，保持 `dryRun: true`，跑几轮看日志里的 `清空 N 个容器 / M 条目, 定时器 K`。
2. 把你自己代码里**真正按轮堆积**的缓存，用 `ctx.on('task-cleanup/collect', ...)` 交进来。
3. 看几天报告，确认磁盘命中范围无误，再把 `dryRun: false`。
4. 需要渲染层清理时，再按 §6 单独验证客户端半。

---

## 附录：证据

| 结论 | 出处 |
|---|---|
| `turn/start` / `turn/end` 事件与 `{turn, reason}` 负载 | `@deepseek-ai/dsh-agent/lib/index.js:92,105`；`lib/types/consumed-work.js:57,76` |
| `ctx.on('session/event', (session, event) => …)` 与 `ctx.on('session/disposed', …)` 的真实用法 | 已装第三方插件 `~/.dsh/profiles/desktop/node_modules/dsh-whale-widget/lib/index.js:1011,1017` |
| `session.id` 取会话标识 | 同上 `:1012` |
| 投影缓存在 `turn/end` 后落地、会话释放时丢内存快照 | `@deepseek-ai/dsh-session-projection-cache/README.zh.md:57` |
| job 在 owner/service 销毁时取消、已结算记录保留至 owner 销毁 | `@deepseek-ai/dsh-jobs/lib/types/index.js:20-35` |
| 会话归档时 `workspace/session-stop` kill 运行中的 job | `@deepseek-ai/dsh-jobs/lib/types/archive-admission.js:32` |
| 钩子跑在子进程、只有 command 形态、失败非阻塞 | `@deepseek-ai/dsh-hook-protocol/README.zh.md:12,63,129` |
| `Stop` 事件时机与 `configPath` 配置 | `@deepseek-ai/dsh-hooks-claude-code/README.zh.md:37-64` |
| 插件包形态：`dsh.bundle.patch` + `cordis.patch.yml` 的 `insert` 行 | `dsh-whale-widget/package.json`、`dsh-whale-widget/cordis.patch.yml` |
| 客户端半形态：`window.__ModuleLoader__.load({id, factory})` | `@deepseek-ai/dsh-client-modules/lib/client.js:1`、`README.md:80` |
| `dsh.client` 清单字段 | `dsh-plugin-wallpaper-engine/package.json:65-76` |
| `link:` 本地安装命令 | `dsh-whale-widget/cordis.patch.yml:8-10` |
| `DSH_HOME` 解析优先级：配置路径 > `$DSH_HOME` > `~/.dsh` | `@deepseek-ai/dsh-home-paths/README.zh.md:34-39` |
| `ctx.effect` 返回 disposer 的用法 | 同上 whale-widget `lib/index.js:659` |
| `apply` 返回值被当 effect 体校验（返回对象即 `Invalid effect`） | `@deepseek-ai/cordis/lib/index.js` `fiber._execute`：`:1142-1143,1165`；插件 fiber 执行 `runtime.callback(this.ctx, this.config)` 见 `:1070` |
| 服务必须 `provide` 才能 `set` | `@deepseek-ai/cordis/lib/index.js:781-788`（`set`）与 `:799-823`（`provide`） |
| 传给 `apply` 的是该 fiber 的子上下文，不是注册时的根 ctx | `@deepseek-ai/cordis/lib/index.js:1053,1070` |

包路径均在安装目录 `…\DeepSeek Harness\resources\app.asar` 内（`dsh/node_modules/@deepseek-ai/…`）；`@deepseek-ai/cordis` 另有本机 profile 链接版本，位于 `~/.dsh/profiles/node_modules/@deepseek-ai/cordis`（实为 `…\deepseek-harness\vendor\cordis` 源码 checkout 的链接），集成测试用的就是它。
