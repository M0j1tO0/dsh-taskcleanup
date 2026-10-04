/**
 * dsh-task-cleanup —— 每个轮次（turn）结束后回收任务级资源。
 *
 * 挂载点（全部来自 DSH 自己的公开事件，见 README 的"证据"一节）：
 *   session/event   type === 'turn/start'  → 打开一个 TurnScope
 *   session/event   type === 'turn/end'    → 释放该 scope + 清理过期磁盘缓存 + 回收已结算 job
 *   session/disposed                       → 兜底释放该会话残留
 *   ctx.effect(() => () => ...)            → 插件卸载/热重载时全量释放
 *
 * 注意：本插件只负责**任务级**资源。会话级资源（会话日志、会话投影缓存）由 DSH
 * 自己管理：dsh-session-projection-cache 在 turn/end 后刷新、在会话释放时丢弃内存快照。
 */

import {
  TurnScope,
  dshCacheDir,
  formatBytes,
  heapUsed,
  pruneTree,
  removeSettledJobs,
} from './reclaim.js'

const NAME = 'dsh-task-cleanup'

/** 复用同一份 fs/promises，避免每次清理都重新解析模块。 */
const fsPromises = import('node:fs/promises')

export const DEFAULTS = {
  /** 磁盘清理安全开关：true = 只统计不删除。先跑 true 观察，再改 false。 */
  dryRun: true,
  /** 清理目标根目录；留空 = [$DSH_HOME/cache]。 */
  pruneDirs: null,
  /** 只清 mtime 早于 now - 该值的文件；默认 7 天。 */
  pruneCacheMaxAgeMs: 7 * 24 * 3600 * 1000,
  /** 是否连 $DSH_HOME/cache/attachments 一起清。危险，默认 false。 */
  includeAttachments: false,
  /** 两次磁盘清理的最小间隔，避免连续多轮把磁盘打满；到时若被节流会补跑一次。 */
  minPruneIntervalMs: 10 * 60 * 1000,
  /** 单次遍历的文件数上限，防止极端目录把一轮拖很久。 */
  maxScanEntries: 200000,
  /** 回收本会话中"已结算"的 job 记录（释放其输出环形缓冲）。 */
  removeSettledJobs: true,
  /** 打印 heapUsed 前后对比（仅参考：V8 GC 是异步的）。 */
  reportHeap: true,
  /** 仅当宿主以 --expose-gc 启动时才会真正调用。 */
  forceGcWhenAvailable: false,
  /** 兜底周期清理，0 = 关闭（默认只在 turn/end 触发）。 */
  sweepEveryMs: 0,
}

function makeLogger(ctx) {
  const logger = ctx && ctx.logger
  const emit = (level, msg) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](msg)
      else if (logger && typeof logger.info === 'function') logger.info(msg)
    } catch {
      /* 日志失败绝不影响清理 */
    }
  }
  return {
    info: (msg) => emit('info', `[${NAME}] ${msg}`),
    warn: (msg) => emit('warn', `[${NAME}] ${msg}`),
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} config
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const log = makeLogger(ctx)

  /** sessionId -> TurnScope */
  const scopes = new Map()

  let lastPruneAt = 0
  let prunePending = false
  let disposed = false

  // ── 磁盘清理（尽力而为，绝不抛出） ────────────────────────────────────────
  function resolveDirs() {
    if (Array.isArray(cfg.pruneDirs) && cfg.pruneDirs.length) return cfg.pruneDirs.slice()
    const dirs = [dshCacheDir()]
    if (cfg.includeAttachments) dirs.push(dshCacheDir('attachments'))
    return dirs
  }

  async function runPrune(force = false) {
    if (disposed) return
    const now = Date.now()
    if (!force && now - lastPruneAt < cfg.minPruneIntervalMs) {
      prunePending = true
      return
    }
    lastPruneAt = now
    prunePending = false
    for (const dir of resolveDirs()) {
      try {
        const r = await pruneTree(dir, {
          maxAgeMs: cfg.pruneCacheMaxAgeMs,
          dryRun: cfg.dryRun,
          maxEntries: cfg.maxScanEntries,
          now,
        })
        const verb = cfg.dryRun ? '可回收' : '已回收'
        if (r.matched > 0 || r.errors > 0) {
          log.info(
            `磁盘缓存 ${dir}: ${verb} ${r.matched} 个文件 / ${formatBytes(r.freedBytes)}` +
              `（扫描 ${r.scanned}，错误 ${r.errors}${r.truncated ? '，已截断' : ''}）` +
              (cfg.dryRun ? ' [dryRun: 未删除]' : ''),
          )
        }
      } catch (err) {
        log.warn(`磁盘清理 ${dir} 失败（已忽略）: ${String(err)}`)
      }
    }
  }

  // ── 每轮回收 ──────────────────────────────────────────────────────────────
  function releaseScope(sid, reason) {
    const scope = scopes.get(sid)
    if (!scope) return
    scopes.delete(sid)

    const sinks = []
    try {
      ctx.emit('task-cleanup/collect', sinks)
    } catch {
      /* 没有监听者也无所谓 */
    }

    const before = cfg.reportHeap ? heapUsed() : 0
    const { report, dirs } = scope.release(sinks.filter((fn) => typeof fn === 'function'))

    // 本轮临时目录
    for (const dir of dirs) {
      if (cfg.dryRun) continue
      try {
        void fsPromises.then((fs) => fs.rm(dir, { recursive: true, force: true })).catch(() => {})
        report.dirs++
      } catch {
        report.errors++
      }
    }

    // 已结算 job 记录
    let jobs = null
    if (cfg.removeSettledJobs) {
      try {
        const svc = typeof ctx.get === 'function' ? ctx.get('jobs') : null
        jobs = removeSettledJobs(svc, sid)
      } catch {
        jobs = null
      }
    }

    if (cfg.forceGcWhenAvailable && typeof globalThis.gc === 'function') {
      try {
        globalThis.gc()
      } catch {
        /* 忽略 */
      }
    }

    if (cfg.reportHeap) {
      const after = heapUsed()
      const delta = after - before
      log.info(
        `turn ${report.turn} 结束(${reason}): 清空 ${report.containers} 个容器 / ${report.entries} 条目,` +
          ` 定时器 ${report.timers}, 自定义回收器 ${report.disposers}` +
          (jobs ? `, job 记录 ${jobs.removed}/${jobs.listed}` : '') +
          `, heap ${delta >= 0 ? '+' : ''}${formatBytes(Math.abs(delta))}（参考值）`,
      )
    } else {
      log.info(`turn ${report.turn} 结束(${reason}): 释放完成`)
    }

    void runPrune()
  }

  // ── 事件订阅（disposer 由 Cordis 的 fiber 兜底） ───────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      const sid = session && session.id ? session.id : 'default'
      const type = event && event.type
      if (type === 'turn/start') {
        scopes.set(sid, new TurnScope(sid, event.data ? event.data.turn : undefined))
        return
      }
      if (type === 'turn/end') {
        releaseScope(sid, (event.data && event.data.reason) || 'end')
      }
    } catch (err) {
      log.warn(`处理会话事件失败（已忽略）: ${String(err)}`)
    }
  })

  // 会话销毁：兜底释放残留（会话级资源由 DSH 自己回收，这里只收我们自己的账）
  ctx.on('session/disposed', (session) => {
    try {
      const sid = session && session.id ? session.id : null
      if (sid) releaseScope(sid, 'session/disposed')
    } catch {
      /* 忽略 */
    }
  })

  // 插件卸载 / 热重载：全量释放，避免插件自己变成泄漏源
  ctx.effect(() => () => {
    disposed = true
    for (const sid of [...scopes.keys()]) {
      try {
        releaseScope(sid, 'plugin/dispose')
      } catch {
        /* 忽略 */
      }
    }
    scopes.clear()
  })

  let sweepTimer = null
  if (cfg.sweepEveryMs > 0) {
    sweepTimer = setInterval(() => {
      if (prunePending) void runPrune(true)
      else void runPrune()
    }, cfg.sweepEveryMs)
    ctx.effect(() => () => clearInterval(sweepTimer))
  }

  log.info(`已启用：turn/end 回收${cfg.dryRun ? '（磁盘 dryRun 模式）' : '（磁盘实际删除）'}`)

  // 暴露给其它插件的最小接口。
  //
  // ⚠️ 两条 Cordis 硬约束（假 ctx 测不出来，必须用真实 Cordis 验证）：
  //   1. `apply` **绝不能返回非 effect 值**。Cordis 把 apply 的返回值当 effect 体校验
  //      （fiber.js `_execute`），返回普通对象会抛 `TypeError: Invalid effect`，
  //      插件会被判为启动失败。所以这里 return undefined。
  //   2. 想对外提供服务必须走 `ctx.provide(name, value)`（`ctx.set` 只能覆盖已 provide 的名字）。
  //      这也让其它插件可以用 `inject: ['taskCleanup']` 显式依赖。
  const api = {
    /** 登记一个本轮回收器（等价于监听 'task-cleanup/collect'）。 */
    collect(sid, fn) {
      const scope = scopes.get(sid)
      if (scope && typeof fn === 'function') scope.onDispose(() => fn())
    },
    /** 立刻释放某会话的当前轮（调试用）。 */
    release(sid, reason = 'manual') {
      releaseScope(sid, reason)
    },
    /** 立即跑一次磁盘清理（调试用，绕过节流）。 */
    pruneNow() {
      return runPrune(true)
    },
    /** 打开一个空作用域，供没有 session 事件的调用方使用。 */
    open(sid, turn) {
      const scope = new TurnScope(sid, turn)
      scopes.set(sid, scope)
      return scope
    },
  }

  try {
    if (typeof ctx.provide === 'function') ctx.provide('taskCleanup', api)
  } catch (err) {
    log.warn(`注册 taskCleanup 服务失败（事件通道仍可用）: ${String(err)}`)
  }

  return undefined
}

export default { name: NAME, apply }
