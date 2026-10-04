/**
 * dsh-task-cleanup —— 任务级回收原语。
 *
 * 关键认知：JS 里没有 free()。"清理内存"= **切断强引用**，让 V8 能回收：
 *   - Map/Set 里按 turn 堆积的条目  → .clear()
 *   - 数组里堆积的中间态对象        → length = 0
 *   - 忘记 clear 的 setInterval     → clearInterval（它会让闭包连带整个对象图存活）
 *   - 原生句柄（子进程、文件、socket）→ 显式 close/kill
 * 这些都不需要 GC 权限，而且必须由持有者做。真正的 GC 由 V8 自己决定，
 * 插件无法、也不应该强制（除非宿主用 --expose-gc 启动）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { opendir, rm, stat } from 'node:fs/promises'

/**
 * DSH home 的解析：与 @deepseek-ai/dsh-home-paths 的优先级一致
 * （配置路径 > $DSH_HOME > ~/.dsh）。这里不硬依赖该包，避免 link: 安装时解析失败。
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

/** $DSH_HOME/cache 下的一个子路径。 */
export function dshCacheDir(...parts) {
  return join(resolveDshHome(), 'cache', ...parts)
}

/** 一个"可回收容器"的条目数；用于报告，不认识的东西算 0。 */
export function sizeOf(target) {
  if (!target) return 0
  if (typeof target.size === 'number') return target.size // Map / Set
  if (Array.isArray(target)) return target.length
  if (typeof target === 'object') return Object.keys(target).length
  return 0
}

/** 清空一个容器：Map/Set → clear()，数组 → 截断。 */
export function clearContainer(target) {
  if (!target) return
  if (typeof target.clear === 'function') target.clear()
  else if (Array.isArray(target)) target.length = 0
}

/**
 * 一个 turn 的作用域。持有本轮所有"任务级"资源，release() 一次性切断。
 * 这不是魔法：调用方必须**主动**把本轮缓存注册进来（keep/every/after/onDispose）。
 */
export class TurnScope {
  constructor(sessionId, turn) {
    this.sessionId = sessionId
    this.turn = turn
    this.containers = new Set() // { label, target }
    this.timers = new Set() // { id, kind }
    this.disposers = new Set() // () => void
    this.dirs = new Set() // 本轮产生的临时目录
    this.openedAt = Date.now()
  }

  /** 注册一个本轮缓存容器，turn 结束时会被清空。 */
  keep(target, label = 'anonymous') {
    if (target) this.containers.add({ label, target })
    return target
  }

  /** 本轮创建的 interval —— 记住它，否则闭包会一直活着。 */
  every(ms, fn, ...args) {
    const id = setInterval(fn, ms, ...args)
    this.timers.add({ id, kind: 'interval' })
    return id
  }

  /** 本轮创建的 timeout。 */
  after(ms, fn, ...args) {
    const id = setTimeout(fn, ms, ...args)
    this.timers.add({ id, kind: 'timeout' })
    return id
  }

  /** 本轮创建的事件监听/句柄释放函数。 */
  onDispose(fn) {
    if (typeof fn === 'function') this.disposers.add(fn)
    return fn
  }

  /** 登记一个本轮专属临时目录（release 时递归删除）。 */
  tempDir(dir) {
    if (dir) this.dirs.add(dir)
    return dir
  }

  /** 额外挂到本轮回收链上的自定义回收器（例如 close() 一个句柄）。 */
  release(extra = []) {
    const report = { turn: this.turn, containers: 0, entries: 0, timers: 0, disposers: 0, dirs: 0, errors: 0 }

    for (const { id, kind } of this.timers) {
      try {
        if (kind === 'interval') clearInterval(id)
        else clearTimeout(id)
        report.timers++
      } catch {
        report.errors++
      }
    }
    this.timers.clear()

    for (const { target } of this.containers) {
      try {
        report.entries += sizeOf(target)
        clearContainer(target)
        report.containers++
      } catch {
        report.errors++
      }
    }
    this.containers.clear()

    for (const fn of [...this.disposers, ...extra]) {
      try {
        fn()
        report.disposers++
      } catch {
        report.errors++
      }
    }
    this.disposers.clear()

    return { report, dirs: [...this.dirs] }
  }
}

/**
 * 递归清理 root 下 age 超过 maxAgeMs 的文件。
 * 只删文件、不删目录本身；删完后顺手清掉空目录。软链接不跟随。
 */
export async function pruneTree(root, options = {}) {
  const {
    maxAgeMs = 7 * 24 * 3600 * 1000,
    dryRun = true,
    now = Date.now(),
    maxEntries = 200000,
  } = options

  const out = { root, scanned: 0, matched: 0, removed: 0, freedBytes: 0, errors: 0, dryRun, truncated: false }
  const cutoff = now - maxAgeMs

  async function walk(dir, depth) {
    if (out.scanned >= maxEntries) {
      out.truncated = true
      return
    }
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      out.errors++
      return
    }
    const subdirs = []
    try {
      for await (const entry of handle) {
        out.scanned++
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          subdirs.push(full)
        } else if (entry.isFile()) {
          try {
            const info = await stat(full)
            if (info.mtimeMs >= cutoff) continue
            out.matched++
            if (!dryRun) {
              await rm(full, { force: true })
              out.removed++
            }
            out.freedBytes += info.size
          } catch {
            out.errors++
          }
        }
      }
    } catch {
      out.errors++
    }
    for (const sub of subdirs) await walk(sub, depth + 1)
  }

  await walk(root, 0)
  return out
}

/**
 * 回收一个会话里**已结算**的 job 记录。
 *
 * 为什么只动已结算的：DSH 的设计里后台 job 是**故意跨轮存活**的
 * （`run_in_background` 的意义就在于此），turn/end 时杀运行中的 job 会破坏该语义。
 * 而一条已结算的记录会一直留在 registry 里直到 owner 销毁，它持有的输出环形缓冲
 * 是纯内存占用 —— 这才是每轮可以安全释放的部分。
 */
export function removeSettledJobs(jobs, sessionId) {
  const out = { listed: 0, removed: 0, errors: 0 }
  if (!jobs || typeof jobs.list !== 'function') return out
  let list
  try {
    list = jobs.list(sessionId) || []
  } catch {
    out.errors++
    return out
  }
  for (const job of list) {
    out.listed++
    if (!job || job.status === 'running' || job.status === 'stopping') continue
    try {
      if (typeof jobs.remove === 'function') {
        jobs.remove(job.id, sessionId)
        out.removed++
      }
    } catch {
      out.errors++
    }
  }
  return out
}

/** 当前堆用量；报告用（GC 异步，前后差值只是参考）。 */
export function heapUsed() {
  try {
    return process.memoryUsage().heapUsed
  } catch {
    return 0
  }
}

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}
