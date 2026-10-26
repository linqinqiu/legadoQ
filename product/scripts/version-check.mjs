#!/usr/bin/env node
/**
 * 版本号单一来源校验。
 *
 * 真源只有一个：`app/build.gradle` 的 `version = 'x.y.z'`（发行版的 manifest 就盖它）。
 * 其余三处都是**抄本**，抄本迟早会漂 —— 这个仓库栽过太多次"两处各存一份然后互相不一致"
 * （版本号、端点数、体检基线都栽过）。所以不靠人记得同步，靠一条命令把它们摆在一起比。
 *
 * 为什么要在 PR 阶段跑、而不是只在打 Tag 时跑（version-gate.yml 的 tag 任务已经比过一次）：
 * 等到打 Tag 才发现不一致，这一版已经发不出去了，而且错误是在发布那一刻才暴露的。
 * 平时每笔 PR 都过一遍，漂的那一刻就被逮住。
 *
 * 用法：
 *   node scripts/version-check.mjs        # 不一致就退出码 1
 *   node scripts/version-check.mjs --json # 机器可读
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const json = process.argv.includes('--json')

/** 从 app/build.gradle 取 project 级 version；排除 toolVersion 之类的相似字段。 */
function gradleVersion() {
  const file = path.join(ROOT, 'app/build.gradle')
  const text = fs.readFileSync(file, 'utf8')
  const line = text.split('\n').find(l => /^\s*version\s*[:=]/.test(l))
  const found = line?.match(/\d+\.\d+\.\d+/)?.[0]
  if (!found) throw new Error('app/build.gradle 里找不到 project 级 version = \'x.y.z\'')
  return { file, version: found }
}

function packageVersion(rel) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) return null
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!parsed.version) return null
  return { file, version: String(parsed.version).replace(/^v/i, '').trim() }
}

/** 外层 VERSION（安装根那份）；内层没有它，所以缺了不算错。 */
function plainVersion(rel) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) return null
  return { file, version: fs.readFileSync(file, 'utf8').replace(/^v/i, '').trim() }
}

const sources = [
  gradleVersion(),
  packageVersion('package.json'),
  packageVersion('web/package.json'),
  plainVersion('../VERSION'),
].filter(Boolean)

const expected = sources[0].version
const mismatched = sources.filter(s => s.version !== expected)
const rel = p => path.relative(ROOT, p).replaceAll('\\', '/')

if (json) {
  console.log(JSON.stringify({
    expected,
    ok: mismatched.length === 0,
    sources: sources.map(s => ({ file: rel(s.file), version: s.version, ok: s.version === expected })),
  }, null, 2))
} else if (mismatched.length === 0) {
  console.log(`[version-check] OK：${sources.length} 处版本一致，都是 ${expected}`)
  for (const s of sources) console.log(`  ${expected}  ${rel(s.file)}`)
} else {
  console.error(`[version-check] 版本不一致（真源 ${rel(sources[0].file)} = ${expected}）：`)
  for (const s of mismatched) console.error(`  ${s.version}  ${rel(s.file)}  ← 应为 ${expected}`)
  console.error('  改法：以 app/build.gradle 为准，把其余几处抄成同一个号。')
}

process.exit(mismatched.length === 0 ? 0 : 1)
