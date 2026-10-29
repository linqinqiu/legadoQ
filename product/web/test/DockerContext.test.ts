import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 镜像构建能真的把前端编出来。
 *
 * 0.1.8 打 Tag 时 `Build and Publish Docker Image` 红了：`FeatureGuide.tsx` 用 `?raw` 引了
 * 仓库里的 `docs/功能说明.md`（产品说明只有一份，不在前端再抄），可 Dockerfile 的 web 阶段
 * 只把 `web/` 拷进 `/src/web`，Vite 到构建那一刻才报
 * `Could not resolve "../../../docs/功能说明.md?raw"` —— 本机能过、容器里才炸。
 *
 * 这类漂移不能靠"记得同步 Dockerfile"：只要有人新增一处跨目录 `?raw` 引用，
 * 这里就必须先红，而不是等发版。判据只认 Dockerfile 里真有一行 COPY 得着它。
 */
const WEB = fileURLToPath(new URL('..', import.meta.url)) // product/web/
const PRODUCT = path.dirname(WEB) // 构建上下文 = product/
const dockerfile = readFileSync(path.join(PRODUCT, 'Dockerfile'), 'utf8')
const dockerignore = readFileSync(path.join(PRODUCT, '.dockerignore'), 'utf8')

const toPosix = (p: string) => p.replaceAll('\\', '/')

/** 前端源码里所有 `?raw` 引入（相对路径），返回绝对路径。 */
function rawImports(): string[] {
  const root = path.join(WEB, 'src')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (/\.(tsx?|jsx?)$/.test(name)) {
        const text = readFileSync(full, 'utf8')
        for (const match of text.matchAll(/from\s+['"]([^'"]+\?raw)['"]/g)) {
          found.push(path.resolve(path.dirname(full), match[1].replace(/\?raw$/, '')))
        }
      }
    }
  }
  walk(root)
  return found
}

/** Dockerfile 里 COPY 的源路径（去掉构建阶段前缀与变量，按行取第一个源参数）。 */
function copiedSources(): string[] {
  return dockerfile
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^COPY\s/i.test(line))
    .map(line => {
      const parts = line.split(/\s+/).slice(1)
      const sources = parts.slice(0, -1).filter(p => !p.startsWith('--'))
      return sources.map(s => s.replace(/^\.\//, ''))
    })
    .flat()
}

test('跨目录 ?raw 引用的文件，Dockerfile 必须真拷进镜像', () => {
  const imports = rawImports()
  assert.ok(imports.length > 0, '一处 ?raw 引用都没找到：扫描逻辑失效了，判据等于没写')

  for (const abs of imports) {
    assert.ok(existsSync(abs), `${toPosix(path.relative(PRODUCT, abs))} 不存在：Vite 构建会直接失败`)

    const rel = toPosix(path.relative(PRODUCT, abs))
    assert.equal(rel.startsWith('..'), false, `${rel} 跑到构建上下文（product/）之外了，镜像里根本看不到`)

    // web/ 整目录会拷进 /src/web，目录内的引用天然可见；这里只管跨目录的那些。
    if (rel.startsWith('web/')) continue

    const dir = path.posix.dirname(rel)
    const covered = copiedSources().some(src => src === rel || src === dir || (dir !== '.' && src === `${dir}/`))
    assert.ok(
      covered,
      `Dockerfile 没把 ${rel} 拷进镜像：容器里 Vite 解析 ${rel} 时会报 Could not resolve（0.1.8 实际踩过）`,
    )

    const ignored = dockerignore
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .some(pattern => rel === pattern || rel.startsWith(`${pattern.replace(/\/$/, '')}/`))
    assert.equal(ignored, false, `${rel} 被 .dockerignore 挡在构建上下文外，COPY 会失败`)
  }
})
