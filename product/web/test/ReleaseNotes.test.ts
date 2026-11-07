import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 发行说明必须说两件事：**这版改了什么**、**怎么用起来**。
 *
 * 以前 Release 正文是写死在 workflow 里的一段「本 Release 由 Actions 自动生成」，
 * 用户点进 Releases 页只看到 commit 哈希和产物名，不知道这一版加了什么，
 * 也不知道下下来之后怎么跑（用户 2026-11-08：「发布发行版要有更新日志更新内容和使用简介」）。
 *
 * 现在正文由 workflow 从 `product/CHANGELOG.md` 摘当前版本那一段，再拼上使用简介生成，
 * 写进 `product/release-body.md` 交给 action。这份判据盯的就是这条链路还在。
 *
 * 第二件事（2026-11-08 当天补）：**普通用户不该为了用这个去装 Java**。所以正文第一段
 * 必须是"下载 Windows 免安装包、解压双击"，jar 只作为"已经装了 Java 的人"的后路；
 * 而这句话要有依据 —— CI 必须真的在 Windows 上打这个包、并把它挂进发行资产。
 */
const here = import.meta.dirname
const repo = path.resolve(here, '../../..')
const workflow = fs.readFileSync(path.resolve(repo, '.github/workflows/build-jar.yml'), 'utf8')

test('发布正文从 CHANGELOG 摘，而不是再写一份手抄日志', () => {
  assert.match(workflow, /name: Compose release notes/, '要有拼装发布说明的步骤')
  assert.match(workflow, /product\/CHANGELOG\.md/, '更新内容要取自 CHANGELOG')
  assert.match(workflow, /awk -v needle="\[\$VERSION\]"/, '按版本号定位那一段')
  assert.match(workflow, /release-body\.md/, '要落成一个正文文件')
})

test('action 用 body_path 读正文，不内联 body', () => {
  // working-directory 只对 run 生效，action 的路径相对仓库根 —— 少写 product/ 会在发版那一步
  // 报 "file not found"，而前面的构建全绿。
  assert.match(workflow, /body_path: product\/release-body\.md/, '要用 body_path，且路径带 product/')
  assert.doesNotMatch(workflow, /^\s+body: \|/m, '正文不该再内联在 workflow 里（两处会漂移）')
})

test('正文里有使用简介：这是什么 / 怎么用 / 其它用法 / 升级', () => {
  for (const heading of ['## 这是什么', '## 怎么用', '## 其它用法', '## 从旧版升级']) {
    assert.ok(workflow.includes(heading), `发布正文缺少「${heading}」`)
  }
  assert.match(workflow, /127\.0\.0\.1:1234/, '要给出访问地址')
})

test('使用简介先给零安装的便携包，再给 jar 后路', () => {
  assert.match(workflow, /不需要安装 Java/, '要明说便携包不用装 Java')
  assert.match(workflow, /legadoq\.exe/, '要给出双击哪个文件')
  assert.match(workflow, /java -jar legado\.jar/, 'jar 路径也要留着')

  const desktop = workflow.indexOf('## 怎么用（推荐：不用装任何东西）')
  const jar = workflow.indexOf('java -jar legado.jar')
  assert.ok(desktop > 0 && jar > desktop, '零安装路径必须排在 jar 之前')
})

test('CI 真的在 Windows 上打便携包，并把它挂进发行资产', () => {
  assert.match(workflow, /runs-on: windows-latest/, 'jpackage 只能在 Windows 上出 Windows app-image')
  assert.match(workflow, /package-desktop\.mjs/, '要跑真正的打包脚本，不要手搓 zip')
  assert.match(workflow, /runtime\/bin\/java\.exe/, '要核对包里自带运行时 —— 这是"不用装 Java"的唯一依据')
  assert.match(workflow, /legadoq-desktop-\*\.zip/, '便携包要作为发行资产上传')
  assert.match(workflow, /needs: \[build, desktop\]/, '桌面包没出来就不发版')
})

test('滚动构建（latest）没有版本段落时有兜底说明', () => {
  assert.match(workflow, /main 的滚动构建：下面是最近一版的更新记录/, 'latest 要说明"这不是本版专属"')
})

test('桌面包依赖的图标脚本必须入库，不能被 .gitignore 挡住', () => {
  // 0.2.31 发版实测：`assets/app.ico` 是生成物不入库，package-desktop.mjs 缺图标时会调
  // `tools/verify/make-ico.mjs` 现场拼一份 —— 而那个脚本当时躺在 .gitignore 里，CI 上
  // 报 "Cannot find module .../make-ico.mjs"，整条发版链停在打包那一步。
  const ignore = fs.readFileSync(path.resolve(repo, 'product/.gitignore'), 'utf8')
  assert.ok(
    !/^\/tools\/verify\/make-ico\.mjs$/m.test(ignore),
    'make-ico.mjs 不能出现在 product/.gitignore 里：CI 的 Windows job 要跑它',
  )
  assert.ok(
    fs.existsSync(path.resolve(repo, 'product/tools/verify/make-ico.mjs')),
    'make-ico.mjs 要在仓库里',
  )
  const packager = fs.readFileSync(path.resolve(repo, 'product/scripts/package-desktop.mjs'), 'utf8')
  assert.match(packager, /make-ico\.mjs/, '打包脚本要能调到它（这条盯的是调用点还在）')
})
