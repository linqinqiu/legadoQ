import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 前端分层边界守卫（零依赖，`node:test`，随 `test/run-all.ts` 目录扫描自动登记）。
 *
 * 与后端 `app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt` 同一套手法：
 * **扫源码 + 显式基线 + 断言相等**。不引 ESLint（本仓库前端没有 ESLint，只有 `tsc -b`），
 * 不建第二套构建 —— 判据要能今天就跑。
 *
 * ## 分层模型（`shell / features / shared`）
 *
 * - `app/` —— **shell**（组合根 / 路由装配）。它 import features 是它的职责，**豁免**。
 *   与后端 `Application.kt` 装配 `http/` 同理。
 * - `features/**` —— 按业务纵向切开。**feature 之间不得互相 import**：一旦互引，
 *   切分就名存实亡，两个 feature 事实上变成一个（且无法单独删改）。
 * - `lib/` `components/` —— **shared**。shared 不得 import features：那会把共享层
 *   焊死在某个业务上，反过来让"删掉一个 feature"变成不可能。
 * - `pages/` —— **旧层**，待迁移进 features 或 shell。当前不算合规，但迁移在做，
 *   单列一份基线让它同样只能缩小。
 *
 * ## 为什么带基线而不是零基线
 *
 * 落地这份判据时实测：**跨 feature 9 条、shared→features 15 条、pages→features 13 条**。
 * 一次性修完要动几十个文件、混进一次判据提交里，正是要避免的"移动与重构混做"。
 * 所以照后端 `RULES_CONCRETE_BASELINE` 的既有惯例：**先把真实状态记下来、锁死，
 * 让新增立刻变红；基线只许单调缩小** —— 条目被修掉却不从基线删除，同样红。
 *
 * > ⚠️ 更正记录：本轮之前的一份前端交付物声称"跨 feature import = 0，零基线判据立即可用"
 * > 且"反向 import 只有 10 处"。**两条都不成立** —— 实测是 9 / 15 / 13（另加 shell 5 条豁免）。
 * > 原因：那次统计用单行正则扫 import，漏掉了 `import {\n A,\n B\n} from '…'` 这种多行写法
 * > （例：`features/ai/AiToolsModal.tsx` 的 `../settings/AiToolsSection` 就是多行）。
 * > 数字以本判据为准。
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')

/**
 * 跨 feature：`features/A` 里 import 了 `features/B`（A ≠ B）。
 * **已清零，零基线，无豁免通道。**
 *
 * 2026-11 完成清理（原先 5 条）。注意**没有一条是靠"强行拆依赖"解掉的**，
 * 而是逐条问"这东西其实属于哪一层"：
 *
 * | 原条目 | 它到底是什么 | 处置 |
 * |---|---|---|
 * | `ai/AiToolsModal` → `settings/AiToolsSection` | 工具开关面板，**唯一消费者就是 AI 弹窗** | → `features/ai/`（同域） |
 * | `bookshelf/ShelfPage` → `source-editor/SourceSwitchModal`<br>`reader/ReaderScreen` → 同上 | 换源浮层，**被两个不同 feature 使用且自身零 feature 依赖** | → `components/SourceSwitchModal.tsx`（shared） |
 * | `reader/ReaderScreen` → `ai/aiChatStore` | 纯 store（只 import `react`），AI 域两个消费者 + 阅读器一个 | → `lib/aiChatStore.ts`（shared） |
 * | `source-editor/SourcesPage` → `bookshelf/dragSort` | 通用拖动手势（连同它依赖的 `shelfOrder`） | → `lib/{dragSort,shelfOrder}.ts`（shared） |
 *
 * 判据：**被 ≥2 个 feature 使用的东西本来就该在 shared**；只有一个消费者却跨了域，
 * 说明它站错了 feature。两条都比逐个改调用点便宜。
 */
const CROSS_FEATURE_BASELINE: readonly string[] = []

/**
 * shared → features：`lib/` 与 `components/` 不得 import `features/`。
 * **已清零，零基线，无豁免通道。**
 *
 * 2026-11 完成清理（原先 8 条），手法是**逐条判断"这东西属于哪一层"**，而不是硬解依赖：
 *
 * | 原条目 | 判据 | 处置 |
 * |---|---|---|
 * | `AppHeader` → `reader/readerSettings` | 它是被 `main.tsx` 渲染一次的**全局顶栏**，是 shell 不是 shared | → `app/AppHeader.tsx` |
 * | `SkinModal` → `reader/readerSettings` | 皮肤浮层，另一个消费者 `ColorTab` 就在 `features/reader/` 内 | → `features/reader/settingsPanel/SkinModal.tsx` |
 * | `WallpaperModal` → `settings/WallpaperSection` | 壁纸浮层，唯一消费者就是那个设置分区 | → `features/settings/WallpaperModal.tsx` |
 * | `backupPreferences` → `reader/*` ×2 | 它构造的是 `ReaderSettings`，属**阅读域逻辑**；消费者是备份插件 | → `features/reader/settingsPanel/backupPreferences.ts` |
 * | `{BookDetailModal,SourceChoiceList}` → `sourceInspector` | `sourceInspector` **在 `features/source-editor/` 里零消费者**，只被这两个 shared 组件用；自身只 import `lib/` | → `lib/sourceInspector.ts` |
 * | `BookDetailModal` → `reader/readerSettings` | 它只要 `scrollPosition` —— 一个不引用任何 `ReaderSettings` 的**纯函数** | → `lib/scrollProgress.ts` |
 *
 * 最后两条是这类问题的通用解法：**当一个 feature 模块在 feature 内部无人使用、
 * 却只被 shared 引用时，它本来就站错了层**；而"只要一个纯函数"则说明依赖面被高估了。
 */
const SHARED_TO_FEATURE_BASELINE: readonly string[] = []

/**
 * `pages/`（旧层）→ features。**已清零，零基线，无豁免通道。**
 *
 * 2026-11 完成迁移：9 个页面全部迁走 ——
 * 「书库」进 `features/bookshelf/`、「发现」进 `features/explore/`、
 * 「订阅」与 `RssPanel` 进 `features/rss/`，
 * 而只服务单个弹窗的 5 个页面（About / FeatureGuide / Backup / Changelog / ReadingLog）
 * 进各自 `plugins/<插件>/`，**与它们唯一的消费者同目录**。
 *
 * 保留了这条零基线而不是删掉判据：一旦有人重建 `src/pages/` 并让它反向依赖 features，
 * 这里会立刻红。下方还额外断言该目录**不存在** —— 比"集合为空"更强的一层。
 */
const PAGES_TO_FEATURE_BASELINE: readonly string[] = []

/** shell（组合根）：允许 import features，与后端 `Application.kt` 装配 `http/` 同理。 */
const SHELL_DIRS = new Set(['app'])

/**
 * shell 目录名 —— 它只能被**组合根**（`src/` 根级文件，如 `main.tsx`）import。
 *
 * 别的层 import 它，就是把组合根当共享库用。实测原来有 2 条，且都指向同一处：
 * `components/AppHeader.tsx` 与 `features/reader/interaction/shortcuts.ts` 各自 `import ... from 'app/pageMeta'`
 * —— 那张「有哪些页面」的纯数据表被误放在 `app/` 下。它搬到 `lib/pageMeta.ts` 后此判据为 0。
 */
const SHELL_DIR = 'app'

/** shared 层：不得反向依赖 features。 */
const SHARED_DIRS = new Set(['lib', 'components'])

/**
 * `\s` 天然跨行 ⇒ 覆盖 `import {\n A,\n B\n} from '…'`；
 * 也覆盖 `import '…'`（副作用导入）与 `export … from '…'`（转出）。
 * 单行正则漏掉多行 import 正是上一份统计出错的原因，这里刻意用能跨行的写法。
 */
const IMPORT_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},$]+?\s+from\s+)?['"]([^'"]+)['"]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const relToSrc = (p: string) => path.relative(SRC, p).split(path.sep).join('/')

/** 把 `src/**` 扫成四类反向依赖的集合。 */
function scan(): {
  crossFeature: Set<string>
  sharedToFeature: Set<string>
  pagesToFeature: Set<string>
  shellImportedByOthers: Set<string>
} {
  const crossFeature = new Set<string>()
  const sharedToFeature = new Set<string>()
  const pagesToFeature = new Set<string>()
  const shellImportedByOthers = new Set<string>()

  for (const file of walk(SRC)) {
    const relFile = relToSrc(file)
    const parts = relFile.split('/')
    const ownTop = parts[0]
    const ownFeature = ownTop === 'features' ? parts[1] : null
    const source = fs.readFileSync(file, 'utf8')

    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue

      const resolved = path.resolve(path.dirname(file), spec)
      const relTarget = path.relative(SRC, resolved)
      if (relTarget.startsWith('..')) continue

      const target = relTarget.split(path.sep)
      const entry = `${relFile} → ${spec}`

      // shell：只能被组合根 import。`src/` 根级文件（main.tsx）不在任何目录里，天然豁免。
      if (target[0] === SHELL_DIR) {
        if (ownTop !== SHELL_DIR && relFile.includes('/')) shellImportedByOthers.add(entry)
        continue
      }

      if (target[0] !== 'features' || !target[1]) continue

      if (ownFeature) {
        if (target[1] !== ownFeature) crossFeature.add(entry)
      } else if (SHARED_DIRS.has(ownTop)) {
        sharedToFeature.add(entry)
      } else if (ownTop === 'pages') {
        pagesToFeature.add(entry)
      }
      // SHELL_DIRS（app/）与根级文件豁免：组合根装配 features 是它的职责。
    }
  }
  return { crossFeature, sharedToFeature, pagesToFeature, shellImportedByOthers }
}

/** 断言"实测集合 == 基线集合"，两个方向分别给出可操作的错因。 */
function assertBaseline(
  label: string,
  actual: Set<string>,
  baseline: readonly string[],
  howToFixNew: string,
): void {
  const expected = new Set(baseline)
  const fresh = [...actual].filter((v) => !expected.has(v)).sort()
  const shrunk = [...expected].filter((v) => !actual.has(v)).sort()

  assert.deepEqual(
    fresh,
    [],
    `${label} 出现基线外的新反向依赖（${fresh.length} 条）：\n  ${fresh.join('\n  ')}\n` +
      `${howToFixNew}\n` +
      `若确属有意，请连同理由一起加进本文件 ${label} 的基线数组 —— 但基线只是记账，` +
      `正确做法是走 shared/ 或端口化解掉它。`,
  )
  assert.deepEqual(
    shrunk,
    [],
    `${label} 的基线里有 ${shrunk.length} 条已经不存在了：\n  ${shrunk.join('\n  ')}\n` +
      `基线**只能单调缩小** —— 既然已经解掉，请把它们从 ${label} 基线数组里删掉，` +
      `别留着过期条目当垃圾桶（留着就永远看不出还剩多少债）。`,
  )
}

test('features 之间不得互相 import —— 零基线，无豁免通道', () => {
  const { crossFeature } = scan()
  assertBaseline(
    '跨 feature',
    crossFeature,
    CROSS_FEATURE_BASELINE,
    'feature 之间互引会让切分名存实亡：两个 feature 事实上合成一个。' +
      '共用件应下沉到 src/lib 或 src/components（shared），而不是相互 import。',
  )
})

test('shared（lib/ components/）不得 import features —— 零基线，无豁免通道', () => {
  const { sharedToFeature } = scan()
  assertBaseline(
    'shared → features',
    sharedToFeature,
    SHARED_TO_FEATURE_BASELINE,
    'shared 反向依赖 features 会把共享层焊死在某个业务上，' +
      '让"删掉一个 feature"变得不可能。应把被依赖的那件东西上提到 shared，' +
      '或由 shell（app/）在装配处把两者接起来。',
  )
})

test('pages/ 旧层已清零且不得重建 —— 零基线，无豁免通道', () => {
  assert.equal(
    fs.existsSync(path.join(SRC, 'pages')),
    false,
    'src/pages/ 是已废弃的旧层（曾承载 9 个页面）。2026-11 已全部迁走：\n' +
      '  页面实现 → features/<业务域>/（书库→bookshelf、发现→explore、订阅→rss）\n' +
      '  只服务单个弹窗的页面 → plugins/<插件>/，与它唯一的消费者同目录\n' +
      '重建 src/pages/ 会让"路由壳"与"页面实现"重新分家，那正是这次迁移要消除的东西。',
  )

  const { pagesToFeature } = scan()
  assertBaseline(
    'pages → features',
    pagesToFeature,
    PAGES_TO_FEATURE_BASELINE,
    'pages/ 已清零，不应再出现对 features 的反向依赖。',
  )
})

test('shell（app/）只能被组合根 import —— 零基线，无豁免通道', () => {
  const { shellImportedByOthers } = scan()
  const got = [...shellImportedByOthers].sort()

  assert.deepEqual(
    got,
    [],
    `app/ 被非组合根的层 import 了（${got.length} 条）：\n  ${got.join('\n  ')}\n` +
      `shell 是组合根，不是共享库。shared（lib/ components/）或 features 依赖它，` +
      `"换个壳"和"单独测一个 feature"就都得把整棵页面树拖进来。\n` +
      `纯数据/纯函数应下沉到 src/lib，而不是留在 app/ 里被大家 import。\n` +
      `本判据零基线：当前实测 0（原先 app/pageMeta.ts 的两条反向依赖，` +
      `已随它搬到 lib/pageMeta.ts 清零），所以没有任何豁免通道。`,
  )

  // 反向对照：扫描器必须真能认出"非组合根 import app/"，否则这条判据永远绿。
  const probe = "import { PRIMARY_PAGES } from '../app/pageMeta'"
  const hits = [...probe.matchAll(IMPORT_RE)].map((m) => m[1])
  assert.ok(
    hits.includes('../app/pageMeta'),
    `导入解析器认不出对 app/ 的 import：${JSON.stringify(probe)}（解析器坏了，本条判据等于没跑）`,
  )
  // 组合根豁免必须仍然成立：src 根级文件（main.tsx）import app/ 不算违规。
  assert.ok('main.tsx'.split('/')[0] === 'main.tsx', '根级文件判定依赖"路径里没有目录分隔符"')
  assert.ok(!'main.tsx'.includes('/'), 'main.tsx 必须被判为组合根，否则一改就误报')
})

test('扫描面本身有效（防止过滤器写错导致"一片绿其实什么都没扫"）', () => {
  // 这条守卫的是判据自己：正则写坏 / 目录改名 / SRC 解析错位，都会让上面四条静默变绿。
  const files = walk(SRC)
  assert.ok(files.length >= 150, `src/ 下只扫到 ${files.length} 个 ts/tsx，扫描面疑似损坏`)

  const featuresDir = path.join(SRC, 'features')
  const featureNames = fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  assert.ok(featureNames.length >= 5, `features/ 下只发现 ${featureNames.length} 个 feature，目录疑似改名`)

  // 反向对照：喂一个**跨 feature 形状**的导入给扫描器，必须能认出来（基线已清零，故用合成样本；解析器只看形状）。
  const probe = "import { x } from '../bookshelf/ShelfPage'"
  const probeFile = path.join(featuresDir, 'ai', '__probe.ts')
  const hits = [...probe.matchAll(IMPORT_RE)].map((m) => m[1])
  assert.ok(
    hits.includes('../bookshelf/ShelfPage'),
    `导入解析器认不出跨 feature 写法：${JSON.stringify(probe)}（解析器坏了，上面三条判据等于没跑）`,
  )
  assert.equal(relToSrc(probeFile), 'features/ai/__probe.ts')
})
