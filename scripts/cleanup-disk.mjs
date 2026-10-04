#!/usr/bin/env node
/**
 * cleanup-disk.mjs —— 供 DSH 的 Stop hook（Claude Code 兼容）调用的独立清理脚本。
 *
 * 为什么钩子只能做磁盘这一类：钩子是在**独立子进程**里跑的，
 * 它看不到也动不了宿主的堆内存、定时器和句柄。所以分工是：
 *   内存/句柄/job → 宿主 Cordis 插件（lib/index.js）
 *   磁盘/临时文件 → 可以用本脚本以 Stop hook 的形式零代码接入
 *
 * 安全默认值：
 *   - 不给 --dir 就退出（绝不猜目录）
 *   - 不给 --yes 就是 dry-run（只统计不删）
 *   - 默认跳过 attachments 目录（删了会让历史会话缺附件）
 *
 * 用法：
 *   node cleanup-disk.mjs --dir "%USERPROFILE%\.dsh\cache" --max-age-days 7            # 预演
 *   node cleanup-disk.mjs --dir "%USERPROFILE%\.dsh\cache" --max-age-days 7 --yes      # 真删
 */

import { opendir, rm, stat } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'

function parseArgs(argv) {
  const out = { dir: null, maxAgeDays: 7, yes: false, includeAttachments: false, maxEntries: 200000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i]
    else if (a === '--max-age-days') out.maxAgeDays = Number(argv[++i])
    else if (a === '--yes') out.yes = true
    else if (a === '--include-attachments') out.includeAttachments = true
    else if (a === '--max-entries') out.maxEntries = Number(argv[++i])
  }
  return out
}

function formatBytes(bytes) {
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

const args = parseArgs(process.argv.slice(2))

if (!args.dir) {
  console.error('[cleanup-disk] 缺少 --dir <目录>，拒绝运行（绝不会自动猜目录）。')
  process.exit(2)
}
if (!Number.isFinite(args.maxAgeDays) || args.maxAgeDays < 0) {
  console.error('[cleanup-disk] --max-age-days 必须是非负数。')
  process.exit(2)
}

const root = resolve(args.dir)
const home = join(homedir(), '.dsh')
if (!root.toLowerCase().startsWith(home.toLowerCase())) {
  console.error(`[cleanup-disk] 拒绝清理 DSH home 之外的目录：${root}`)
  process.exit(2)
}

const cutoff = Date.now() - args.maxAgeDays * 24 * 3600 * 1000
const report = { scanned: 0, matched: 0, removed: 0, freed: 0, errors: 0, skipped: 0 }

async function walk(dir) {
  if (report.scanned >= args.maxEntries) return
  let handle
  try {
    handle = await opendir(dir)
  } catch {
    report.errors++
    return
  }
  const subdirs = []
  try {
    for await (const entry of handle) {
      report.scanned++
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!args.includeAttachments && entry.name === 'attachments') {
          report.skipped++
          continue
        }
        subdirs.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        if (info.mtimeMs >= cutoff) continue
        report.matched++
        if (args.yes) {
          await rm(full, { force: true })
          report.removed++
        }
        report.freed += info.size
      } catch {
        report.errors++
      }
    }
  } catch {
    report.errors++
  }
  for (const sub of subdirs) await walk(sub)
}

await walk(root)

const verb = args.yes ? '已删除' : '可删除(dry-run)'
console.log(
  `[cleanup-disk] ${root} (${basename(root)}) : ${verb} ${report.matched} 个文件 / ${formatBytes(report.freed)}` +
    ` | 扫描 ${report.scanned}, 跳过 ${report.skipped} 个目录, 错误 ${report.errors}`,
)
if (!args.yes) console.log('[cleanup-disk] 预演模式；确认无误后加 --yes 真正执行。')
