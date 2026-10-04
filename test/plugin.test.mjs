/**
 * 用假 ctx 驱动插件，验证"turn/end 真的切断了引用、清了定时器"。
 * 这不是模拟：定时器与容器都是真对象，清理效果可观测。
 *
 *   node test/plugin.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { apply } from '../lib/index.js'
import { TurnScope, dshCacheDir, pruneTree, removeSettledJobs, sizeOf } from '../lib/reclaim.js'

let passed = 0
let failed = 0
/** 同步与异步用例统一排队，最后一次性结算，避免异步用例假通过。 */
const pending = []
function test(name, fn) {
  pending.push(
    Promise.resolve()
      .then(() => fn())
      .then(() => {
        passed++
        console.log(`  ok   ${name}`)
      })
      .catch((err) => {
        failed++
        console.error(`  FAIL ${name}\n       ${(err && err.message) || String(err)}`)
      }),
  )
}

/** 最小 Cordis 上下文替身：只实现本插件用到的 on / emit / effect / get / logger。 */
function fakeCtx(services = {}) {
  const handlers = new Map()
  const effects = []
  return {
    logger: { info() {}, warn() {} },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {
        const list = handlers.get(name) || []
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
    },
    emit(name, payload) {
      for (const fn of handlers.get(name) || []) fn(payload)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    get(name) {
      return services[name] ?? null
    },
    /** 测试驱动用 */
    fire(name, ...args) {
      for (const fn of [...(handlers.get(name) || [])]) fn(...args)
    },
    fireEffectDisposers() {
      for (const d of effects.splice(0)) d()
    },
    listenerCount(name) {
      return (handlers.get(name) || []).length
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('== TurnScope 原语 ==')

test('release() 清空 Map/Set/Array 并返回条目统计', () => {
  const scope = new TurnScope('s1', 1)
  const m = scope.keep(new Map([['a', 1], ['b', 2]]), 'acc')
  const arr = scope.keep([1, 2, 3], 'frames')
  const set = scope.keep(new Set([1, 2]), 'seen')
  const { report } = scope.release()
  assert.equal(m.size, 0, 'Map 应被清空')
  assert.equal(arr.length, 0, '数组应被截断')
  assert.equal(set.size, 0, 'Set 应被清空')
  assert.equal(report.entries, 7, '条目数应为 2+3+2')
  assert.equal(report.containers, 3)
})

test('release() 真的清掉了本轮 interval（闭包不再存活）', async () => {
  const scope = new TurnScope('s1', 1)
  let ticks = 0
  scope.every(10, () => {
    ticks++
  })
  await sleep(35)
  const before = ticks
  assert.ok(before >= 1, `清理前应已跳动，实际 ${before}`)
  const { report } = scope.release()
  assert.equal(report.timers, 1)
  const frozen = ticks
  await sleep(40)
  assert.equal(ticks, frozen, '清理后定时器不应再跳动')
})

test('onDispose 注册的句柄释放函数会被调用一次', () => {
  const scope = new TurnScope('s1', 1)
  let closed = 0
  scope.onDispose(() => {
    closed++
  })
  scope.release()
  scope.release()
  assert.equal(closed, 1, '重复 release 不应重复调用')
})

test('release() 里某个回收器抛异常不影响其它回收器', () => {
  const scope = new TurnScope('s1', 1)
  let ok = 0
  scope.keep(new Map([['x', 1]]))
  scope.onDispose(() => {
    throw new Error('boom')
  })
  scope.onDispose(() => {
    ok++
  })
  const { report } = scope.release()
  assert.equal(ok, 1, '后续回收器仍应执行')
  assert.equal(report.errors, 1, '异常应被计入 errors')
})

console.log('== 插件 turn 生命周期 ==')

test('apply 必须返回 undefined（Cordis 会把返回值当 effect 体校验）', () => {
  const ctx = fakeCtx()
  const ret = apply(ctx, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  assert.equal(ret, undefined, 'apply 返回值必须是 undefined，否则真实 Cordis 抛 Invalid effect')
})

test('turn/start → turn/end 触发其它插件登记的回收器', () => {
  const ctx = fakeCtx()
  apply(ctx, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })

  const otherPluginCache = new Map([['k1', 'v1'], ['k2', 'v2']])
  let sinkCalls = 0
  // 另一个插件用文档约定的广播事件把自己挂进本轮回收
  ctx.on('task-cleanup/collect', (sinks) => {
    sinks.push(() => {
      sinkCalls++
      otherPluginCache.clear()
    })
  })

  const session = { id: 'sess-A' }
  ctx.fire('session/event', session, { type: 'turn/start', data: { turn: 7 } })
  assert.equal(otherPluginCache.size, 2, '轮次进行中缓存应还在')

  ctx.fire('session/event', session, { type: 'turn/end', data: { turn: 7, reason: 'completed' } })
  assert.equal(sinkCalls, 1, '回收器应被调用一次')
  assert.equal(otherPluginCache.size, 0, 'turn 结束后缓存应被清空')
})

test('turn/end 没有对应 turn/start 时不抛错（空轮/被拒绝的轮）', () => {
  const ctx = fakeCtx()
  apply(ctx, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  ctx.fire('session/event', { id: 'sess-B' }, { type: 'turn/end', data: { turn: 1 } })
  ctx.fire('session/event', { id: 'sess-B' }, { type: 'turn/end', data: { turn: 1 } })
  assert.ok(true)
})

test('多会话互不串味：A 的 turn/end 不影响 B 的本轮缓存', () => {
  const ctx = fakeCtx()
  apply(ctx, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })

  const cacheA = new Map([['a', 1]])
  const cacheB = new Map([['b', 1]])
  let collectTarget = null
  ctx.on('task-cleanup/collect', (sinks) => {
    sinks.push(() => (collectTarget === 'A' ? cacheA : cacheB).clear())
  })

  ctx.fire('session/event', { id: 'A' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.fire('session/event', { id: 'B' }, { type: 'turn/start', data: { turn: 1 } })
  collectTarget = 'A'
  ctx.fire('session/event', { id: 'A' }, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(cacheA.size, 0, 'A 应被清空')
  assert.equal(cacheB.size, 1, 'B 不受影响')
})

test('session/disposed 兜底释放残留（会话中途销毁）', () => {
  const ctx = fakeCtx()
  apply(ctx, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  const cache = new Map([['x', 1]])
  let called = 0
  ctx.on('task-cleanup/collect', (sinks) => {
    sinks.push(() => {
      called++
      cache.clear()
    })
  })
  ctx.fire('session/event', { id: 'C' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.fire('session/disposed', { id: 'C' })
  assert.equal(called, 1)
  assert.equal(cache.size, 0)
})

test('插件卸载（fiber effect）会全量释放未结束的轮次', () => {
  const ctx = fakeCtx()
  apply(ctx, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  const cache = new Map([['y', 1]])
  ctx.on('task-cleanup/collect', (sinks) => {
    sinks.push(() => cache.clear())
  })
  ctx.fire('session/event', { id: 'D' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.fireEffectDisposers()
  assert.equal(cache.size, 0, '卸载时未结束的轮次也应释放')
  assert.equal(sizeOf(cache), 0)
})

test('损坏的事件负载不会让插件抛错', () => {
  const ctx = fakeCtx()
  apply(ctx, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  ctx.fire('session/event', null, null)
  ctx.fire('session/event', undefined, { type: 'turn/end' })
  ctx.fire('session/event', { id: 'E' }, { type: 'turn/start', data: null })
  ctx.fire('session/event', { id: 'E' }, { type: 'turn/end', data: null })
  assert.ok(true)
})

console.log('== 已结算 job 记录回收 ==')

test('只回收已结算的 job，运行中的必须留着', () => {
  const removed = []
  const jobs = {
    list: () => [
      { id: 'bash-1', status: 'running' },
      { id: 'bash-2', status: 'completed' },
      { id: 'bash-3', status: 'stopping' },
      { id: 'bash-4', status: 'failed' },
    ],
    remove: (id, owner) => removed.push([id, owner]),
  }
  const r = removeSettledJobs(jobs, 'sess-A')
  assert.equal(r.listed, 4)
  assert.equal(r.removed, 2, '只应回收 completed/failed')
  assert.deepEqual(removed, [['bash-2', 'sess-A'], ['bash-4', 'sess-A']])
})

test('没有 jobs 服务时静默降级', () => {
  const r = removeSettledJobs(null, 'sess-A')
  assert.deepEqual(r, { listed: 0, removed: 0, errors: 0 })
  const r2 = removeSettledJobs({ list: () => { throw new Error('nope') } }, 'sess-A')
  assert.equal(r2.errors, 1)
})

console.log('== 磁盘清理安全性 ==')

console.log('  .. dry-run 真实验证（对 ~/.dsh/cache，只读不写）')
const cache = dshCacheDir()
if (existsSync(cache)) {
  const r = await pruneTree(cache, { maxAgeMs: 0, dryRun: true, maxEntries: 5000 })
  test('dryRun 统计到文件但绝不删除', () => {
    assert.equal(r.removed, 0, 'dryRun 下 removed 必须为 0')
    assert.ok(r.scanned >= 0)
    console.log(`       （扫描 ${r.scanned} 个条目，匹配 ${r.matched} 个，释放估算 ${r.freedBytes} 字节）`)
  })
} else {
  console.log('  skip 未找到', cache)
}

test('目标目录不存在时不抛错，只累加 errors', async () => {
  const r = await pruneTree('Z:\\definitely\\missing\\dsh-cleanup-test', { maxAgeMs: 0, dryRun: true })
  assert.equal(r.removed, 0)
  assert.ok(r.errors >= 1)
})

await Promise.all(pending)
console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
