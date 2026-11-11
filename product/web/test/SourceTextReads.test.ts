import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * SourceTextReads 基线：把「测试读哪个源码文件当文本」集中登记，只许单调缩小。
 *
 * 为什么需要它：拆 hot 文件（ReaderScreen / SourcesPage / ShelfPage ...）之前，
 * 测试套件里有大量 readFileSync 读源码文本的断言钉在具体文件上。不先登记基线，
 * 每拆一刀都要改一批测试、且说不清哪些是「随拆文件迁移」、哪些是「新增耦合」，
 * 拆分收益被测试维护吃掉（研究-架构现状与演进适配性 §3.2#1）。
 *
 * 口径（与基线生成时一致，改口径必须重新生成基线）：
 *   - 统计 web/test/*.test.ts 里**字面量** ../src/… 引用的出现次数（按被引用的源文件汇总）；
 *     覆盖 read('../src/…') 与 readFileSync(new URL('../src/…', import.meta.url)) 两种主流写法。
 *   - import / export-from 行是运行时依赖，不是文本断言，不计。
 *   - 动态拼接（path.join(SRC, name)）与全量扫描门禁不钉具体文件，不在登记范围。
 *   - 只数 .ts / .tsx / .css 结尾的引用；fixtures / public / 后端文件不在本基线范围。
 *
 * 规则（同 tools/verify/depth-check.mjs 的 KNOWN_DEEP 纪律）：
 *   - 基线外出现新的被引用源文件 → 红（新增文本断言要先评估、登记，不许悄悄长）
 *   - 某文件引用次数超过基线     → 红（耦合变深）
 *   - 某文件引用次数低于基线     → 红（基线必须同步缩小，防止退化成长期豁免）
 * 拆文件时的合法操作：把断言随代码迁移，然后**在同一次提交里**把基线条目从旧文件挪到新文件
 * （总数不增）；评审时盯着「总数只许减少」。
 */

const TEST_DIR = import.meta.dirname

function collectSourceTextReads(): { counts: Map<string, number>; testFiles: number; totalRefs: number } {
  const files = fs.readdirSync(TEST_DIR)
    .filter(name => name.endsWith('.test.ts') && name !== 'SourceTextReads.test.ts')
    .sort()
  const counts = new Map<string, number>()
  let totalRefs = 0
  for (const name of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, name), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(import|export)\b/.test(line) || /^\s*\} from\b/.test(line)) continue
      for (const m of line.matchAll(/['"](\.\.\/src\/[^'"]+)['"]/g)) {
        const rel = m[1].slice('../src/'.length)
        if (!/\.(ts|tsx|css)$/.test(rel)) continue
        const key = 'src/' + rel
        counts.set(key, (counts.get(key) ?? 0) + 1)
        totalRefs++
      }
    }
  }
  return { counts, testFiles: files.length, totalRefs }
}

// 基线快照：2026-11-12，HEAD 20cd5c1 + 第 1 批降成本 + 第 2 批 ShelfPage 两模态外移（BookModals 判据登记 +3）。
// 136 个测试文件 / 256 处引用 / 88 个源文件。**只许缩小**：拆文件迁移断言时同步挪条目，总数不增。
const BASELINE: Record<string, number> = {
  'src/app/AppHeader.tsx': 7,
  'src/app/pages.tsx': 2,
  'src/components/DiagnosticsStrip.tsx': 1,
  'src/components/FirstRunAgreement.tsx': 1,
  'src/components/Logo.tsx': 1,
  'src/components/LogsModal.tsx': 1,
  'src/components/PwaManager.tsx': 11,
  'src/components/ReplaceRulesModal.tsx': 1,
  'src/components/ServerPortModal.tsx': 1,
  'src/components/TocRulesModal.tsx': 3,
  'src/features/ai/agentStream.ts': 2,
  'src/features/ai/AiChatModal.tsx': 4,
  'src/features/ai/AiConnectionsModal.tsx': 2,
  'src/features/ai/AiFloatingBall.tsx': 13,
  'src/features/ai/AiMcpModal.tsx': 3,
  'src/features/ai/AiPromptsModal.tsx': 3,
  'src/features/ai/AiSkillsModal.tsx': 1,
  'src/features/ai/AiToolsModal.tsx': 1,
  'src/features/ai/AiToolsSection.tsx': 1,
  'src/features/bookshelf/BookInfoEditModal.tsx': 1,
  'src/features/bookshelf/BookManageModal.tsx': 1,
  'src/features/bookshelf/LibraryPage.tsx': 2,
  'src/features/bookshelf/ShelfPage.tsx': 7,
  'src/features/explore/ExplorePage.tsx': 2,
  'src/features/reader/dialogs/BookSearchDialog.tsx': 3,
  'src/features/reader/dialogs/RefreshChaptersModal.tsx': 1,
  'src/features/reader/dialogs/TocDrawerHeader.tsx': 2,
  'src/features/reader/Md3Chrome.tsx': 1,
  'src/features/reader/NoteHighlights.tsx': 2,
  'src/features/reader/notes/noteExport.ts': 2,
  'src/features/reader/notes/NotesPanel.tsx': 3,
  'src/features/reader/notes/NoteToolbar.tsx': 1,
  'src/features/reader/ReaderBody.tsx': 5,
  'src/features/reader/ReaderCatalog.tsx': 2,
  'src/features/reader/ReaderChrome.tsx': 4,
  'src/features/reader/ReaderHeader.tsx': 3,
  'src/features/reader/ReaderOverlays.tsx': 1,
  'src/features/reader/ReaderScreen.tsx': 16,
  'src/features/reader/settingsPanel/BehaviorTab.tsx': 1,
  'src/features/reader/settingsPanel/OtherSettingsPanel.tsx': 4,
  'src/features/reader/settingsPanel/readerSettings.ts': 3,
  'src/features/reader/settingsPanel/SkinModal.tsx': 1,
  'src/features/reader/tts/ttsBarPosition.ts': 3,
  'src/features/reader/tts/ttsEngine.ts': 1,
  'src/features/reader/tts/TtsPlayerBar.tsx': 1,
  'src/features/reader/tts/useReaderTts.ts': 1,
  'src/features/reader/useReaderCacheStatus.ts': 1,
  'src/features/reader/useReaderChapterContent.ts': 2,
  'src/features/reader/useReaderNotes.ts': 1,
  'src/features/reader/useReaderPageTurn.ts': 1,
  'src/features/reader/useReaderPositionJump.ts': 2,
  'src/features/reader/useReadingLog.ts': 1,
  'src/features/rss/RssPanel.tsx': 1,
  'src/features/settings/CookieSection.tsx': 1,
  'src/features/settings/SettingsPage.tsx': 2,
  'src/features/settings/settingsSections.ts': 2,
  'src/features/source-editor/SourceDebugModal.tsx': 1,
  'src/features/source-editor/SourceEditorPanel.tsx': 3,
  'src/features/source-editor/SourceHealthModal.tsx': 2,
  'src/features/source-editor/SourcesPage.tsx': 7,
  'src/lib/aiChatStore.ts': 6,
  'src/lib/aiToolGroups.ts': 1,
  'src/lib/api/client.ts': 1,
  'src/lib/api/domains/agent.ts': 4,
  'src/lib/api/domains/reader.ts': 3,
  'src/lib/api/domains/sources.ts': 1,
  'src/lib/api/domains/system.ts': 3,
  'src/lib/api/index.ts': 2,
  'src/lib/api/types.ts': 10,
  'src/lib/cookieApi.ts': 1,
  'src/lib/nav.ts': 2,
  'src/lib/pageMeta.ts': 2,
  'src/lib/performance.ts': 1,
  'src/lib/searchStore.ts': 1,
  'src/lib/selectionStore.ts': 2,
  'src/lib/shelfLayout.ts': 1,
  'src/lib/uiContext.ts': 3,
  'src/lib/useFocusTrap.ts': 2,
  'src/main.tsx': 20,
  'src/plugins/about/AboutModal.tsx': 3,
  'src/plugins/about/AboutPage.tsx': 1,
  'src/plugins/about/FeatureGuide.tsx': 1,
  'src/plugins/about/GuideModal.tsx': 1,
  'src/plugins/backup/BackupModal.tsx': 1,
  'src/plugins/backup/BackupPage.tsx': 1,
  'src/plugins/reading-log/ReadingLogModal.tsx': 1,
  'src/plugins/reading-log/ReadingLogPage.tsx': 2,
  'src/styles.css': 19,
}

test('SourceTextReads 扫描面哨兵：扫不到足够用例时「无新增」不可信', () => {
  const { testFiles, totalRefs, counts } = collectSourceTextReads()
  assert.ok(testFiles >= 100, `测试文件只扫到 ${testFiles} 个，明显偏少——先确认 TEST_DIR 路径有效`)
  assert.ok(totalRefs >= 150, `源码文本引用只扫到 ${totalRefs} 处，明显偏少——扫描口径可能被改坏`)
  assert.ok(counts.size >= 50, `被引用源文件只扫到 ${counts.size} 个，明显偏少`)
})

test('读源码文本的断言只许减少：新增要登记、变深要拦、变浅要缩基线', () => {
  const { counts } = collectSourceTextReads()
  const fresh = [...counts.keys()].filter(k => !(k in BASELINE)).sort()
  const grown = [...counts.entries()]
    .filter(([k, n]) => k in BASELINE && n > BASELINE[k])
    .map(([k, n]) => `${k}: ${BASELINE[k]} → ${n}`)
    .sort()
  const shrunk = Object.keys(BASELINE)
    .filter(k => (counts.get(k) ?? 0) < BASELINE[k])
    .map(k => `${k}: ${BASELINE[k]} → ${counts.get(k) ?? 0}`)
    .sort()
  assert.deepEqual(fresh, [],
    '出现基线外的「读源码文本」引用——新断言请先评估是否必要，确要保留则登记进 BASELINE（评审盯总数不增）')
  assert.deepEqual(grown, [],
    '这些源文件被文本断言钉得更深了——拆分/重构请随代码迁移断言，不要新增耦合')
  assert.deepEqual(shrunk, [],
    '这些文件的引用已经变浅——请把 BASELINE 对应条目同步缩小（基线只许单调缩小，不许留过期豁免）')
})