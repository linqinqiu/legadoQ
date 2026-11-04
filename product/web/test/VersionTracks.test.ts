import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 对外版本与内部构建号是两条轨：
 * - 对外版本只有一个真源（`product/app/build.gradle`），发布才变；
 * - 构建号是 `BUILD_NUMBER`，每项改动递增，一个对外版本可以对应很多次构建。
 *
 * 这两条以前混在一起，导致「版本号一样、包不一样」时界面与日志都分不出来。
 * 判据盯三件事：脚本能真的读出两个号、两个号真的进了构建产物与接口、发布脚本只记账不复制版本。
 */
const REPO = path.resolve(import.meta.dirname, '../../..')
const read = (...parts: string[]) => fs.readFileSync(path.resolve(REPO, ...parts), 'utf8')

test('version.mjs 能读出对外版本与构建号，且可被其它脚本导入', () => {
  const output = execFileSync(process.execPath, [path.resolve(REPO, 'scripts/version.mjs'), 'show'], {
    cwd: REPO,
    encoding: 'utf8',
  })
  const info = JSON.parse(output) as { external: string; build: number; buildFile: string }
  assert.match(info.external, /^\d+\.\d+\.\d+$/, '对外版本必须是 X.Y.Z')
  assert.equal(info.buildFile, 'BUILD_NUMBER')
  assert.ok(Number.isInteger(info.build) && info.build >= 0, `构建号应是非负整数，实际 ${info.build}`)

  // 脚本报的对外版本必须等于 gradle 真源，不能另存一份。
  const gradleVersion = read('product/app/build.gradle')
    .split('\n')
    .find((line) => /^\s*version\s*[:=]/.test(line))
    ?.match(/\d+\.\d+\.\d+/)?.[0]
  assert.equal(info.external, gradleVersion, 'version.mjs 与 app/build.gradle 的对外版本不一致')
  assert.match(read('BUILD_NUMBER'), /^\d+\n?$/)

  const script = read('scripts/version.mjs')
  assert.match(script, /export function externalVersion/)
  assert.match(script, /export function buildNumber/)
  assert.match(script, /export function bumpBuild/)
  assert.match(script, /export function setExternal/)
  assert.match(script, /invokedDirectly/, '被 release.mjs 导入时不能顺手跑 CLI')
})

test('构建号写进 jar 资源，并从 /healthz 与 /api/about 报出来', () => {
  const gradle = read('product/app/build.gradle')
  assert.match(gradle, /generateBuildInfo/)
  assert.match(gradle, /meta\/build-info\.properties/)
  assert.match(gradle, /inputs\.file\(buildNumberFile\)/, '构建号文件变了要重新生成资源')
  assert.match(gradle, /tasks\.named\('processResources'\)\s*\{\s*dependsOn 'generateBuildInfo'\s*\}/)
  // 文件不存在时不能登记成输入：Gradle 会先报 "input file doesn't exist"，
  // 而 Docker 的构建上下文只有 product/，没有仓库根的 BUILD_NUMBER（0.2.10 镜像红在这）。
  assert.match(gradle, /if \(buildNumberFile\.exists\(\)\) \{\s*inputs\.file\(buildNumberFile\)/)
  assert.match(gradle, /LEGADO_BUILD_NUMBER/, 'Docker 读不到文件时要用构建参数补号')
  assert.match(read('product/Dockerfile'), /ARG LEGADO_BUILD_NUMBER/)
  assert.match(read('.github/workflows/docker.yml'), /LEGADO_BUILD_NUMBER=\$\{\{ steps\.build\.outputs\.number \}\}/,
    'CI 要把仓库根的真实构建号传进 Docker 构建')

  const buildInfo = read('product/app/src/main/kotlin/io/legado/BuildInfo.kt')
  assert.match(buildInfo, /meta\/build-info\.properties/)
  assert.match(buildInfo, /getOrDefault\("0"\)/, '读不到注入文件时回落 0，而不是编一个号')
  assert.match(read('product/app/src/main/kotlin/io/legado/Application.kt'), /build = BuildInfo\.buildNumber/)
  // 0.2.14：系统域端点搬到 http/system/SystemRoutes.kt（Routes.kt 只留挂载调用）
  assert.match(read('product/app/src/main/kotlin/io/legado/http/system/SystemRoutes.kt'), /AboutInfo\([^)]*BuildInfo\.buildNumber\)/)
  assert.match(read('product/app/src/main/kotlin/io/legado/model/Models.kt'), /data class HealthStatus[\s\S]*?val build: String/)
  assert.match(read('product/app/src/main/kotlin/io/legado/model/Models.kt'), /data class AboutInfo[\s\S]*?val build: String/)
})

test('关于页把构建号显示出来，且不写死版本或构建号', () => {
  const page = read('product/web/src/pages/AboutPage.tsx')
  assert.match(page, /<dt>构建<\/dt>/)
  assert.match(page, /info\.build/)
  assert.match(page, /info\.build !== '0'/)
  assert.match(page, /未注入/)
  assert.match(read('product/web/src/lib/api/types.ts'), /AboutInfo = \{[^}]*build\?: string/)
})

test('npm 入口把日常 bump 与发布分开', () => {
  for (const pkgPath of ['package.json', 'product/package.json']) {
    const pkg = JSON.parse(read(pkgPath)) as { scripts?: Record<string, string> }
    for (const name of ['build:bump', 'version:show', 'release', 'release:dry']) {
      assert.ok(pkg.scripts?.[name], `${pkgPath} 缺 ${name} 脚本`)
    }
  }
  const doc = read('RELEASING.md')
  assert.match(doc, /npm run build:bump/)
  assert.match(doc, /npm run release:dry/)
  assert.match(doc, /npm run release/)
  assert.match(doc, /version-check/)
  assert.match(doc, /RELEASES\.md/)
  assert.match(doc, /package-desktop\.mjs/)
  assert.match(doc, /healthz/)
})

test('发布脚本只记账：校验、追加 RELEASES、打 tag、推送，不改对外版本', () => {
  const release = read('scripts/release.mjs')
  assert.match(release, /externalVersion/)
  assert.match(release, /buildNumber/)
  assert.match(release, /version-check\.mjs/)
  assert.match(release, /checkChangelog/)
  assert.match(release, /checkNotReleased/)
  assert.match(release, /RELEASES\.md/)
  assert.match(release, /git\(\["tag", "-a", tag/)
  assert.match(release, /git\(\["push", "origin", "HEAD"\]/)
  assert.match(release, /git\(\["push", "origin", tag\]/)
  // stdio: "inherit" 的 execFileSync 返回 null；提交/打 tag/推送都走这条，不能对返回值 trim。
  assert.match(release, /return inherit \? "" : output\.trim\(\)/)
  // 注释里可以说「改版本是 set-external 的事」，代码里不能真的去改。
  const code = release
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  assert.doesNotMatch(code, /setExternal\(|writeFileSync\(GRADLE/, '发布脚本不应改对外版本；那是 version.mjs set-external 的事')
})

test('文档不再把 release 说成会自动改版本，tag 与代码提交的关系写清楚', () => {
  const doc = read('RELEASING.md')
  assert.match(doc, /tag 指向记录提交，表里的 Commit 是代码提交/)
  assert.match(doc, /不使用预发布后缀/)
  assert.match(doc, /工作区必须干净/)
  // README 底部的许可段曾把 product/ 写成 legado/，会把人指到不存在的目录。
  const readme = read('README.md')
  assert.match(readme, /`product\/`：\*\*GPL-3\.0\*\*/)
  assert.doesNotMatch(readme, /`legado\/`：\*\*GPL-3\.0\*\*/)
})
