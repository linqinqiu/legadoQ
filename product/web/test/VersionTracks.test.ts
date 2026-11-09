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
  // 回落值必须是字面量 "0"（"不知道自己是第几次构建"），不能编一个看起来合理的数字。
  // 0.2.35 起 BuildInfo 把构建号与修订号合并成一次读取（buildMeta），断言跟着从
  // `getOrDefault("0")` 改成「读不到就取 "0"」这一条语义。
  assert.match(buildInfo, /\?\:\s*"0"/, '读不到注入文件时回落 0，而不是编一个号')
  assert.match(read('product/app/src/main/kotlin/io/legado/Application.kt'), /build = BuildInfo\.buildNumber/)
  // 0.2.14：系统域端点搬到 http/system/SystemRoutes.kt（Routes.kt 只留挂载调用）
  assert.match(read('product/app/src/main/kotlin/io/legado/http/system/SystemRoutes.kt'), /AboutInfo\([^)]*BuildInfo\.buildNumber\)/)
  assert.match(read('product/app/src/main/kotlin/io/legado/model/Models.kt'), /data class HealthStatus[\s\S]*?val build: String/)
  assert.match(read('product/app/src/main/kotlin/io/legado/model/Models.kt'), /data class AboutInfo[\s\S]*?val build: String/)
})

test('关于页把构建号显示出来，且不写死版本或构建号', () => {
  const page = read('product/web/src/plugins/about/AboutPage.tsx')
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

/**
 * `RELEASES.md` 的每一行都要能被 git 复算。
 *
 * 它不是手写日志，而是「版本 ← 构建号 ← 代码提交」的映射表：表错了，就再也回查不到
 * 「这一版到底是哪份代码」。2026-11-06 核对时量出三类历史缺口：
 *
 *  1. `0.2.15` / `0.2.16` 有 tag、有 Release，表里却没有行 —— 那两次是手工打 tag 发的，
 *     没走 `npm run release`（`git show v0.2.15:RELEASES.md` 里确实没有它们）。
 *  2. `0.2.10` 的 tag 打在「记录提交的下一个提交」上：当次发布脚本自己有 bug
 *     （`inherit` 分支对 null 返回值 trim），修完脚本才打的 tag。
 *  3. `0.2.16` 与 `0.2.17` 共用构建号 13：中间漏了一次 bump，tag 不移动所以留着。
 *
 * 所以判据按「记录提交必须落在 tag 提交的历史里」判，而不是要求两者相等 —— 后者会把 0.2.10
 * 判红，而那是真的、且按仓库规矩不能改的历史。构建号允许**一条**例外，列在下面，新版本不许再加。
 */
const BUILD_NUMBER_EXCEPTIONS: Record<string, string> = {
  '0.2.17': '与 0.2.16 共用 13（那次漏了 bump）；tag 不移动，只能留着',
}

/**
 * 远端没有 tag 的版本。`0.2.13` 的 tag 只在本地：那次 `npm run release` 的 push 没成功，
 * 记录行与本地 tag 都留下来了，远端从来没有这个 tag（所以也一直没有 GitHub Release）。
 * 不补推：推上去会触发 tag 构建，按 `make_latest` 的规则把 0.2.13 顶成 Latest、
 * 再发一个旧版本的包 —— 代价比"这一行只有本地能验"大得多。
 */
const TAG_EXCEPTIONS: Record<string, string> = {
  '0.2.13': 'tag 从未推到远端（那次 release 的 push 失败）；补推会把它顶成 Latest',
}

/**
 * tag 保留窗口的下界。
 *
 * 2026-11-07 清理过一次：31 个 Release / tag 收到 11 个，只留当前特性线（`v0.2.21` 起）。
 * 删掉的 20 个版本的代码提交仍在 main 历史里，变更记在 `product/CHANGELOG.md`，只是不再有
 * tag 这个锚点 —— 所以「每行都要有 tag」这条判据必须让位给窗口。
 *
 * 下界从现存 tag 反推（排除 [TAG_EXCEPTIONS] 里本来就不该计入的那些），这样再清理一次只改
 * 数据、不改判据；窗口内的版本仍然必须有 tag。
 */
const cmpVersion = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
const tagFloorOf = (tags: Iterable<string>) =>
  [...tags]
    .map((tag) => tag.replace(/^v/, ''))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && !TAG_EXCEPTIONS[v])
    .sort(cmpVersion)[0]

test('RELEASES.md 每一行都能被 git 复算：版本 / 构建号 / 提交 / tag', (t) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
  const tryGit = (...args: string[]) => {
    try { return git(...args) } catch { return null }
  }
  /*
   * 浅克隆里历史提交与 tag 根本不在对象库里，逐行复算会得到"每一行都错"这种读不懂的红。
   * 明确跳过并说清怎么补历史 —— 四个跑前端判据的 workflow 都已经 fetch-depth: 0，
   * 本地浅克隆请 `git fetch --unshallow`。跳过会出现在 node:test 的 skipped 计数里，不是静默通过。
   */
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    t.skip('仓库是浅克隆（fetch-depth: 1），拿不到 RELEASES.md 里的历史提交与 tag')
    return
  }
  const text = read('RELEASES.md')
  const rows = [...text.matchAll(/^\| (\d+\.\d+\.\d+) \| (\d+) \| ([0-9a-f]{7,40}) \|$/gm)]
    .map(m => ({ version: m[1], build: Number(m[2]), commit: m[3] }))
  assert.ok(rows.length >= 7, `RELEASES.md 只解析出 ${rows.length} 行，表头或格式被改坏了`)
  assert.match(text, /^\| 对外版本 \| 构建号 \| Commit \|$/m, '表头三列不能改')

  const problems: string[] = []

  /*
   * 一次 `cat-file --batch` 取回所有行要的两个文件：逐行 `git show` 要起 14 个进程，
   * 实测把这条判据拖到 2.5s（整套前端判据才 13s）。批量接口一次就够。
   * 切片按 header 里的**字节数**，不能按行切 —— build.gradle 里有中文注释，字节数≠字符数。
   */
  const wanted = rows.flatMap(row => [`${row.commit}:product/app/build.gradle`, `${row.commit}:BUILD_NUMBER`])
  const batch = execFileSync('git', ['cat-file', '--batch'], { cwd: REPO, input: wanted.join('\n') + '\n' })
  const blobs: string[] = []
  let cursor = 0
  for (const spec of wanted) {
    const headerEnd = batch.indexOf(0x0a, cursor)
    assert.ok(headerEnd > cursor, `cat-file 没回 ${spec} 的 header`)
    const header = batch.subarray(cursor, headerEnd).toString('utf8')
    if (/ missing$/.test(header)) {
      blobs.push('')
      cursor = headerEnd + 1
      continue
    }
    const size = Number(header.split(' ')[2])
    const start = headerEnd + 1
    blobs.push(batch.subarray(start, start + size).toString('utf8'))
    cursor = start + size + 1
  }

  // tag → 它指向的提交，也是一次取全（annotated tag 的 `%(*objectname)` 才是提交，`%(objectname)` 是 tag 对象）
  const tagCommits = new Map<string, string>()
  for (const line of git('for-each-ref', '--format=%(refname:short)|%(objectname)|%(*objectname)', 'refs/tags').split('\n')) {
    const [name, object, peeled] = line.trim().split('|')
    if (name) tagCommits.set(name, peeled || object)
  }
  const tagFloor = tagFloorOf(tagCommits.keys())

  let previousBuild = 0
  let previousVersion = '0.0.0'
  rows.forEach((row, index) => {
    const gradle = blobs[index * 2]
    const buildFile = blobs[index * 2 + 1]
    if (!gradle || !buildFile) { problems.push(`${row.version}：记录里的提交 ${row.commit} 在仓库里不存在`); return }

    // 记录提交上的两个号必须就是这一行写的号
    const version = /^\s*version\s*=\s*['"]([^'"]+)/m.exec(gradle)?.[1]
    const build = Number(buildFile.trim())
    if (version !== row.version) problems.push(`${row.version}：提交 ${row.commit} 上的 version 是 ${version}`)
    if (build !== row.build) problems.push(`${row.version}：提交 ${row.commit} 上的 BUILD_NUMBER 是 ${build}`)

    // tag 必须存在，且记录提交要落在它的历史里（相等或祖先）。
    // 窗口外的旧版本已被清理掉 tag，只要求记录行本身能复算，不再要求锚点。
    const tag = `v${row.version}`
    const tagCommit = tagCommits.get(tag)
    if (!tagCommit) {
      const outsideWindow = tagFloor !== undefined && cmpVersion(row.version, tagFloor) < 0
      if (!outsideWindow && !TAG_EXCEPTIONS[row.version]) problems.push(`${row.version}：没有 tag ${tag}`)
    }
    // 相等是常态（发布脚本把 tag 打在记录提交上），只有 0.2.10 那种历史例外才需要再查祖先。
    else if (tagCommit !== row.commit && tryGit('merge-base', '--is-ancestor', row.commit, tagCommit) === null) {
      problems.push(`${row.version}：记录提交 ${row.commit} 不在 tag ${tag} 的历史里`)
    }

    if (row.build <= previousBuild) {
      const excuse = BUILD_NUMBER_EXCEPTIONS[row.version]
      if (!excuse) problems.push(`${row.version}：构建号 ${row.build} 没有大于上一行的 ${previousBuild}`)
    }
    if (cmpVersion(row.version, previousVersion) <= 0) problems.push(`${row.version}：版本号没有大于上一行的 ${previousVersion}`)
    previousBuild = row.build
    previousVersion = row.version
  })

  // 反向：比最早一行更新的 tag 都必须在表里 —— 漏记过的正是 0.2.15 / 0.2.16
  const oldest = rows[0].version
  const missing = [...tagCommits.keys()]
    .map(t => t.replace(/^v/, ''))
    .filter(v => /^\d+\.\d+\.\d+$/.test(v) && cmpVersion(v, oldest) >= 0)
    .filter(v => !rows.some(row => row.version === v))
  if (missing.length) problems.push(`有 tag 但表里没有行：${missing.join('、')}`)

  // 最后一行就是当前仓库状态
  const currentVersion = /^\s*version\s*=\s*['"]([^'"]+)/m.exec(read('product/app/build.gradle'))?.[1]
  const currentBuild = Number(read('BUILD_NUMBER').trim())
  const last = rows[rows.length - 1]
  if (last.version !== currentVersion || last.build !== currentBuild) {
    problems.push(`最后一行是 ${last.version}/${last.build}，但仓库现在是 ${currentVersion}/${currentBuild}`)
  }

  assert.deepEqual(problems, [], `RELEASES.md 与 git 对不上：\n  ${problems.join('\n  ')}`)
})
