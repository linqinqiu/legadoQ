import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「加入关于（名称，开发者，更新日志，检查更新，用户协议，开源许可，免责声明）」（用户 2026-10-02）。
 * 这七样是用户点名要的清单，少一样就是没做完 —— 而"少一样"在界面上不会报错，
 * 所以按名字逐项判，而不是"页面上有字"。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const page = read('../src/pages/AboutPage.tsx')

/**
 * 判"某句话不许出现在界面上"要先把注释摘掉。
 * 注释里为了讲清"为什么以前是错的"必然会写出那个词，不摘就是判据逮住自己的说明文字
 * （`opensource-hygiene-check` 扫 WebDAV 残留时扫到"断言没有 WebDAV"的那份测试，同一个病）。
 */
const withoutComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(line => !/^\s*\/\/\s/.test(line))
  .join('\n')
  .replace(/(^|[^:])\/\/[^'"`\n]*$/g, '$1')

test('七样点名要的东西都在这一页上', () => {
  for (const [label, pattern] of [
    ['名称', /info\?\.title/],
    ['版本', /about-facts[\s\S]*?版本/],
    ['开发者', /开发者/],
    ['更新日志', /onOpenChangelog/],
    ['检查更新', /检查更新/],
    ['用户协议', /title="用户协议"/],
    ['开源许可', /title="开源许可"/],
    ['免责声明', /title="免责声明"/],
  ] as const) {
    assert.match(page, pattern, `关于页缺「${label}」`)
  }
})

test('版本与仓库都来自服务端，界面不写死', () => {
  assert.match(page, /api\.about\(\)/)
  // 字面量版本号会造出第二个事实来源（这条在本项目里翻过车，见 version-check.mjs）
  assert.doesNotMatch(page, /['"`]\d+\.\d+\.\d+['"`]/, 'AboutPage 里出现了写死的版本号')
  assert.match(read('../src/lib/api.ts'), /about: \(\) => request<AboutInfo>\('\/api\/about'\)/)
})

test('检查更新是点了才打，且地址不接受用户输入', () => {
  assert.match(read('../src/lib/api.ts'), /checkUpdate: \(\) => request<UpdateCheckResult>\('\/api\/about\/update-check', \{ method: 'POST' \}\)/)
  const server = read('../../app/src/main/kotlin/io/legado/ops/UpdateCheck.kt')
  assert.match(server, /System\.getenv\("LEGADO_REPO"\)/, '仓库 slug 只有一个可覆盖的来源')
  assert.doesNotMatch(server, /call\.request\.queryParameters/, '检查更新不许从请求参数里拼 URL —— 那是开在本机上的 SSRF 门')
  assert.match(server, /connectTimeout/, '外网请求必须有超时，不然「检查更新」能把页面钉死')
  // 要列发布列表，不能只取 /releases/latest：CI 每推一次 main 就把滚动构建发成标签 `latest`，
  // `/releases/latest` 于是永远返回 `tag_name="latest"`，版本比较把它当"有新版本"（用户 2026-10-11）。
  assert.match(server, /releases\?per_page/, '要列全部发布，从里面分出「版本号发布」与「滚动构建」')
  assert.match(read('../../app/src/main/kotlin/io/legado/http/Routes.kt'), /post\("\/about\/update-check"\)[\s\S]*?requireSameOriginWrite/)
})

test('许可那一栏说的是真话：运行时依赖与协议都列出来', () => {
  assert.match(page, /GPL-3\.0/)
  for (const name of ['Ktor', 'Jsoup', 'Rhino', 'React']) {
    assert.ok(page.includes(name), `第三方依赖表里少了 ${name}`)
  }
  // 借鉴过语义的上游必须点名，尤其 AGPL 那条：不写出来就会被后来人当成可以拷
  assert.match(page, /LegadoTeam\/legado/)
})

test('许可那一栏不许说"未拷代码"：随包的上游数据要认下来', () => {
  // 2026-10-05 实测：`app/src/main/resources/assets/txtTocRule.json` 与上游那份 `cmp` **逐字节相同**。
  // 这一句"借鉴设计，未拷代码"因此是假话 —— 同协议（GPL-3.0）分发没问题，撒谎才是问题。
  const shown = withoutComments(page)
  assert.doesNotMatch(shown, /未拷代码|不拷代码/)
  assert.match(shown, /分章规则表/)
  assert.match(shown, /原样副本|语义参照与随包的上游数据/)
})

test('开发者那一格不许兜底成别人的仓库，也不把配置项说给使用者', () => {
  // 原来 `UpdateCheck.repository` 硬写着别人家的 slug（这份代码 clone 来的地方），
  // 于是「关于」页把那名字当成本项目的开发者、项目主页与检查更新的目标。
  // 用户 2026-10-05：「GitHub 账号是我本人的，不要将仓库放到别人手里」。
  const shown = withoutComments(page)
  assert.doesNotMatch(shown, /lukelzlz/)
  // 界面上不该出现 LEGADO_REPO 这种开发者配置项（用户 2026-10-11「检查更新不当」）
  assert.doesNotMatch(shown, /LEGADO_REPO/)
  const server = withoutComments(read('../../app/src/main/kotlin/io/legado/ops/UpdateCheck.kt'))
  assert.doesNotMatch(server, /lukelzlz\/legado/)
  // 默认回本项目自己的仓库 —— 于是「检查更新」出厂就能用，不再永远回 not_configured
  assert.match(server, /DEFAULT_REPOSITORY\s*=\s*"linqinqiu\/qingyue"/)
})

test('路由与样式都接上了', () => {
  // 「关于」是**插件**（plugins/），可独立卸载。
  // 深链映射到对应浮层，页面本身在 plugins/about/AboutModal.tsx 里渲染。
  assert.match(read('../src/main.tsx'), /'#about': 'about'/, '旧深链要映射到「关于」浮层')
  assert.match(read('../src/plugins/about/AboutModal.tsx'), /<AboutPage[\s\S]{0,300}onOpenChangelog=\{/)
  assert.match(read('../src/components/AppHeader.tsx'), /<span>关于<\/span>/)
  assert.match(read('../src/styles.css'), /\.about-page \{/)
})

/**
 * 「顶栏『我的』菜单堆太多」（用户 2026-10-03 拍板要瘦）。收掉的两条不是删功能：
 * 「更新日志」本来就有两条路（顶栏版本芯片 + 这一页那颗按钮），「快捷键」这一页给一条。
 */
test('「我的」菜单不再重复列「更新日志」「快捷键」，这两条从「关于」进', () => {
  assert.match(page, /onOpenShortcuts/, '关于页要有快捷键的入口')
  assert.match(page, /<button type="button" className="ghost-button" onClick=\{onOpenShortcuts\}>快捷键<\/button>/)
  // 「关于」现在是独立浮层：它拿到的是宿主传进来的回调，不是实验室的 actions 表。
  const aboutModal = read('../src/plugins/about/AboutModal.tsx')
  assert.match(aboutModal, /onOpenShortcuts=\{onOpenShortcuts\}/,
    '关于浮层要把快捷键按钮接到宿主回调上')
  // 同一轮把 5 个弹窗布尔收成一个 openModal，写法从 setShowShortcuts(true) 变成 setOpenModal('shortcuts')。
  assert.match(read('../src/main.tsx'), /openShortcuts: \(\) => openModalDirect\('shortcuts'\)/,
    '宿主那边要真的把 openShortcuts 接上，不是摆个死按钮')
  const header = read('../src/components/AppHeader.tsx')
  assert.doesNotMatch(header, /<span>快捷键<\/span>/, '菜单里那条已经收进「关于」')
  assert.doesNotMatch(header, /<span>更新日志<\/span>/, '菜单里那条与顶栏版本芯片是同一个目标，留芯片')
  assert.match(header, /onClick=\{\(\) => onOpenChangelog\?\.\(\)\}/, '顶栏那颗版本芯片仍然直接进更新日志')
})
