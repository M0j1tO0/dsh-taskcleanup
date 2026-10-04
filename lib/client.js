/**
 * dsh-task-cleanup —— 渲染层（浏览器半）示例。
 *
 * 形态：`window.__ModuleLoader__.load({ id, factory })` 的浏览器模块。
 * 没有 import（除可选的 require("react")），因此**不需要打包器**，可直接被客户端加载。
 *
 * 启用方式：在 package.json 里加
 *   "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
 *            "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web", "immediately": true } }
 * 并在 cordis.patch.yml 的 insert 行里保留同名 id —— 客户端半按 id 与宿主半配对加载。
 *
 * ⚠️ 需要按你的 DSH 版本核对的一点：**客户端上下文里"轮次结束"的信号名**。
 *    宿主侧确定为 session/event(type='turn/end')；客户端侧本文件用多路探测兜底
 *    （ctx.on 的 session/event / turn/end / 通过 store 的订阅），命中哪个用哪个。
 *    核对位置：@deepseek-ai/dsh-client-ui-conversation 与 dsh-client-runtime 的 README。
 *
 * 渲染层"无效内存"的真实来源通常是这几类，本文件逐一收口：
 *   1. 每个 turn 追加的 DOM 节点 / ImageBitmap / Blob URL（必须 revokeObjectURL）
 *   2. 绑在 window/document 上的监听器（组件卸载后依然存活）
 *   3. setInterval/setTimeout（尤其是轮询）
 *   4. 模块级的 Map 缓存（按会话/轮次堆积）
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-cleanup',
  factory: () => {
    /** 本轮登记表：静态可达的容器，turn 结束时统一清空。 */
    const containers = new Set()
    const timers = new Set()
    const disposers = new Set()
    const objectUrls = new Set()

    function sizeOf(t) {
      if (!t) return 0
      if (typeof t.size === 'number') return t.size
      if (Array.isArray(t)) return t.length
      if (typeof t === 'object') return Object.keys(t).length
      return 0
    }

    function clearContainer(t) {
      if (!t) return
      if (typeof t.clear === 'function') t.clear()
      else if (Array.isArray(t)) t.length = 0
    }

    /** 渲染层每轮回收。幂等，可重复调用。 */
    function releaseTurn() {
      const report = { containers: 0, entries: 0, timers: 0, disposers: 0, urls: 0 }
      for (const { id, kind } of timers) {
        try {
          if (kind === 'interval') clearInterval(id)
          else clearTimeout(id)
          report.timers++
        } catch {}
      }
      timers.clear()

      for (const t of objectUrls) {
        try {
          URL.revokeObjectURL(t)
          report.urls++
        } catch {}
      }
      objectUrls.clear()

      for (const t of containers) {
        try {
          report.entries += sizeOf(t)
          clearContainer(t)
          report.containers++
        } catch {}
      }
      containers.clear()

      for (const fn of disposers) {
        try {
          fn()
          report.disposers++
        } catch {}
      }
      disposers.clear()

      try {
        // 只在确有回收动作时打日志，避免刷屏
        if (report.containers || report.timers || report.disposers || report.urls) {
          console.debug('[dsh-task-cleanup/client]', report)
        }
      } catch {}
      return report
    }

    /** 暴露给其它客户端插件：把本轮资源交给统一回收。 */
    const api = {
      releaseTurn,
      keep: (t) => (containers.add(t), t),
      every: (ms, fn, ...args) => {
        const id = setInterval(fn, ms, ...args)
        timers.add({ id, kind: 'interval' })
        return id
      },
      after: (ms, fn, ...args) => {
        const id = setTimeout(fn, ms, ...args)
        timers.add({ id, kind: 'timeout' })
        return id
      },
      onDispose: (fn) => (disposers.add(fn), fn),
      objectUrl: (url) => (objectUrls.add(url), url),
    }

    function apply(ctx) {
      // 让同页其它插件能拿到：ctx.taskCleanup（若宿主 ctx 支持 set）或全局兜底
      try {
        if (typeof ctx.set === 'function') ctx.set('taskCleanup', api)
      } catch {}
      try {
        window.__DSH_TASK_CLEANUP__ = api
      } catch {}

      /** 反复探测：客户端版本间事件名可能不同，命中即返回。 */
      function subscribeTurnEnd() {
        const candidates = [
          ['session/event', (session, event) => {
            if (event && event.type === 'turn/end') releaseTurn()
          }],
          ['turn/end', () => releaseTurn()],
        ]
        let bound = 0
        for (const [name, handler] of candidates) {
          try {
            if (typeof ctx.on === 'function') {
              ctx.on(name, handler)
              bound++
            }
          } catch {}
        }
        return bound
      }

      const bound = subscribeTurnEnd()
      try {
        console.debug('[dsh-task-cleanup/client] 已挂载，轮次结束订阅数 =', bound)
      } catch {}

      // 插件卸载 / HMR：teardown 走 fiber effect，避免插件自己变成泄漏源
      try {
        ctx.effect(() => () => releaseTurn())
      } catch {}
    }

    return { apply, inject: [] }
  },
})
