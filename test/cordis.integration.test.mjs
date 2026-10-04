/**
 * 真实 Cordis 集成测试：不造假 ctx，直接用本机 profile 里那份
 * @deepseek-ai/cordis 4.0.1 建 Context，走真实的 plugin 注册 / 事件总线 / fiber effect。
 *
 * 验证的是假 ctx 测不到的部分：
 *   1. 插件的导出形态（对象式 { name, apply }）Cordis 是否接受
 *   2. 真实 ctx.on / ctx.emit 下 turn/end 能否触发回收
 *   3. 真实 ctx.effect 的 disposer 语义能否兜底释放
 *   4. 真实 ctx.logger / ctx.get 是否存在（缺失时插件必须静默降级）
 *
 *   node test/cordis.integration.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'

const CORDIS_CANDIDATES = [
  'C:\\Users\\ASUS\\.dsh\\profiles\\node_modules\\@deepseek-ai\\cordis\\lib\\index.js',
  'C:\\Users\\ASUS\\.dsh\\profiles\\desktop\\node_modules\\@deepseek-ai\\cordis\\lib\\index.js',
]

const cordisPath = CORDIS_CANDIDATES.find((p) => existsSync(p))
if (!cordisPath) {
  console.log('skip: 未找到本机 @deepseek-ai/cordis，跳过集成测试')
  process.exit(0)
}

const { Context, Service } = await import(pathToFileURL(cordisPath).href)
console.log('cordis 来源:', cordisPath)

let passed = 0
let failed = 0
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
        if (process.env.DSH_CLEANUP_DEBUG && err && err.stack) console.error(err.stack)
      }),
  )
}

const PLUGIN = { name: 'dsh-task-cleanup-test', apply }

console.log('== 真实 Cordis 运行时 ==')

test('Cordis 接受对象式插件导出，并以 (ctx, config) 调用 apply', async () => {
  const ctx = new Context()
  if (process.env.DSH_CLEANUP_DEBUG) {
    ctx.on('internal/get', (c, prop, error, next) => {
      Error.stackTraceLimit = 50
      console.error(`[internal/get] prop=${String(prop)}\n${new Error('trace').stack}`)
      return next()
    })
  }

  let seen = null
  const probe = {
    name: 'dsh-task-cleanup-test',
    apply(c, config) {
      // 注意：Cordis 传给 apply 的是该 fiber 自己的子上下文，不是注册时的根 ctx，
      // 所以断言时**绝不能**把两个上下文交给 assert 去比较/打印 —— 失败时
      // util.inspect 会读代理的 .href 而抛出 "cannot get property href without inject"，
      // 把真正的失败原因盖掉。这里只记录原始类型。
      const probeOf = (fn) => {
        try {
          return typeof fn()
        } catch (err) {
          return `throw:${err && err.message}`
        }
      }
      seen = {
        hasLoggerInfo: probeOf(() => c.logger.info),
        hasEffect: probeOf(() => c.effect),
        hasOn: probeOf(() => c.on),
        hasEmit: probeOf(() => c.emit),
        hasGet: probeOf(() => c.get),
        hasProvide: probeOf(() => c.provide),
        dryRun: config && config.dryRun,
        ret: apply(c, config),
      }
    },
  }

  const fork = ctx.plugin(probe, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  if (fork && typeof fork.then === 'function') await fork
  if (typeof ctx.start === 'function') await ctx.start()

  assert.ok(seen, 'apply 必须被调用（对象式导出被 Cordis 接受）')
  assert.equal(seen.dryRun, true, 'config 应原样传入（对应 cordis.patch.yml 的 config 块）')
  assert.equal(seen.hasLoggerInfo, 'function', 'fiber 上下文上应有 logger.info')
  assert.equal(seen.hasEffect, 'function', 'fiber 上下文上应有 effect')
  assert.equal(seen.hasOn, 'function', 'fiber 上下文上应有 on')
  assert.equal(seen.hasEmit, 'function', 'fiber 上下文上应有 emit')
  assert.equal(seen.hasGet, 'function', 'fiber 上下文上应有 get')
  assert.equal(seen.hasProvide, 'function', 'fiber 上下文上应有 provide')
  // ★ 关键回归断言：apply 返回非 undefined 会让真实 Cordis 抛 TypeError: Invalid effect
  assert.equal(seen.ret, undefined, 'apply 必须返回 undefined')

  if (typeof ctx.stop === 'function') await ctx.stop()
})

test('taskCleanup 服务注册后可从根上下文取到（provide 通道可用）', async () => {
  const ctx = new Context()
  const fork = ctx.plugin(PLUGIN, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  if (fork && typeof fork.then === 'function') await fork
  if (typeof ctx.start === 'function') await ctx.start()

  const svc = typeof ctx.get === 'function' ? ctx.get('taskCleanup') : null
  assert.ok(svc, 'taskCleanup 服务应已注册（否则日志里会有 warn）')
  assert.equal(typeof svc.release, 'function')
  assert.equal(typeof svc.pruneNow, 'function')
  assert.equal(typeof svc.collect, 'function')

  // 编程式登记一个回收器，验证 API 通道与事件通道等价
  const cache = new Map([['p', 1]])
  ctx.emit('session/event', { id: 'API' }, { type: 'turn/start', data: { turn: 1 } })
  svc.collect('API', () => cache.clear())
  ctx.emit('session/event', { id: 'API' }, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(cache.size, 0, 'taskCleanup.collect 登记的回调应在 turn/end 时执行')

  if (typeof ctx.stop === 'function') await ctx.stop()
})

test('真实事件总线上 turn/end 触发回收器', async () => {
  const ctx = new Context()
  const fork = ctx.plugin(PLUGIN, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  if (fork && typeof fork.then === 'function') await fork
  if (typeof ctx.start === 'function') await ctx.start()

  const cache = new Map([['a', 1], ['b', 2]])
  let sinkCalls = 0
  ctx.on('task-cleanup/collect', (sinks) => {
    sinks.push(() => {
      sinkCalls++
      cache.clear()
    })
  })

  const session = { id: 'cordis-sess' }
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(cache.size, 2, '轮次进行中不应被清')

  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  assert.equal(sinkCalls, 1)
  assert.equal(cache.size, 0, '真实事件总线上 turn/end 应清空缓存')

  if (typeof ctx.stop === 'function') await ctx.stop()
})

test('真实 fiber dispose 会走 ctx.effect 兜底释放未结束的轮次', async () => {
  const ctx = new Context()
  const fork = ctx.plugin(PLUGIN, { dryRun: true, reportHeap: false, removeSettledJobs: false, minPruneIntervalMs: 1e9 })
  if (fork && typeof fork.then === 'function') await fork
  if (typeof ctx.start === 'function') await ctx.start()

  const cache = new Map([['x', 1]])
  ctx.on('task-cleanup/collect', (sinks) => {
    sinks.push(() => cache.clear())
  })
  ctx.emit('session/event', { id: 'S' }, { type: 'turn/start', data: { turn: 3 } })
  assert.equal(cache.size, 1)

  // 卸载插件：fiber dispose → effect disposer 应触发全量释放
  if (fork && typeof fork.dispose === 'function') await fork.dispose()
  else if (typeof ctx.stop === 'function') await ctx.stop()

  assert.equal(cache.size, 0, '插件卸载时应释放未结束的轮次')
})

test('ctx.get 存在且对未知服务返回空（jobs 缺失时静默降级）', async () => {
  const ctx = new Context()
  const fork = ctx.plugin(PLUGIN, { dryRun: true, reportHeap: false, removeSettledJobs: true, minPruneIntervalMs: 1e9 })
  if (fork && typeof fork.then === 'function') await fork
  if (typeof ctx.start === 'function') await ctx.start()

  const got = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
  assert.ok(got === null || got === undefined, '没有 jobs 服务时不应拿到东西')

  // 有 removeSettledJobs=true 但没有 jobs 服务，turn/end 不能抛错
  ctx.emit('session/event', { id: 'S2' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'S2' }, { type: 'turn/end', data: { turn: 1 } })

  if (typeof ctx.stop === 'function') await ctx.stop()
})

test('真实运行时的 Service 基类仍然从本插件所依赖的同一份 cordis 导出', () => {
  assert.equal(typeof Service, 'function', 'Service 应可导出（说明 cordis 版本与 DSH 一致）')
})

await Promise.all(pending)
console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
