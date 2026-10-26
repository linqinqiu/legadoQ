import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 前端命名与文件组织判据（对应 `docs/frontend-conventions.md`）。
 *
 * 现状是"大体统一、局部不一致"。这几条把已经在做的事钉住，
 * 防止后来人（或我自己）再引入例外 —— 规范写在文档里没人执行，
 * 三个月后就只剩文档了。
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')

/** 递归收集 src 下所有 .ts/.tsx。 */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const ALL = walk(SRC)
const rel = (f: string) => f.replace(SRC + path.sep, '').replaceAll('\\', '/')

test('导出方式统一：全仓零 export default', () => {
  const offenders = ALL.filter(f => /^\s*export\s+default\b/m.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(offenders.map(rel), [],
    '一律用 named export。default 导出改名时 IDE 跟不上，也搜不到使用处')
})

test('含 JSX 的组件文件用 PascalCase（三个例外除外）', () => {
  const EXEMPT = new Set(['main.tsx', 'app/pages.tsx', 'icons.tsx'])
  const offenders: string[] = []
  for (const f of ALL) {
    if (!f.endsWith('.tsx')) continue
    const r = rel(f)
    if (EXEMPT.has(r)) continue
    const base = path.basename(f, '.tsx')
    if (!/^[A-Z]/.test(base)) offenders.push(r)
  }
  assert.deepEqual(offenders, [],
    `这些 .tsx 文件名不是 PascalCase：${offenders.join(', ')}（例外只有 main/pages/icons）`)
})

test('hooks 文件以 use 开头，且导出同名函数', () => {
  const hooks = ALL.filter(f => /(^|\/)use[A-Z][^/]*\.tsx?$/.test(rel(f)))
  assert.ok(hooks.length > 0, '应至少有一个 hook（useEscapeClose / useReaderTts）')
  for (const f of hooks) {
    const base = path.basename(f).replace(/\.tsx?$/, '')
    const src = fs.readFileSync(f, 'utf8')
    assert.ok(src.includes(`export function ${base}`) || src.includes(`export const ${base}`),
      `${rel(f)} 应导出同名函数 ${base}`)
  }
})

test('features/ 下的目录职责与文档一致', () => {
  // features/ 只放"产品自带、不可卸载"的内容。
  // 能独立卸载的功能已判定为插件，住 plugins/。
  // 0.8.7 起只剩 ai：原先的 features/settings/（「界面偏好」）是**说谎控件** ——
  // 两个开关把值写进浏览器本地存储后没有任何地方读，描述的还是 0.8.4 就删掉的浮动窗口；
  // 那套 `builtinSettings.ts` 注册表连同分区一起删了，设置项的唯一来源是
  // `settings/settingsSections.ts`（见 SettingsPage.tsx 的说明）。
  const expected = ['ai']
  for (const d of expected) {
    assert.ok(fs.existsSync(path.join(SRC, 'features', d)),
      `features/${d}/ 应存在（产品自带内容）`)
  }
  // 反向：能卸载的功能不该再留在 features/ 里
  assert.ok(!fs.existsSync(path.join(SRC, 'features', 'modal')),
    'features/modal/ 不该存在 —— 那些功能已判定为插件')
  assert.ok(!fs.existsSync(path.join(SRC, 'features', 'plugins')),
    'features/plugins/ 不该存在 —— 插件住 plugins/')
  // 反向：删掉的"第二套设置分区来源"不该长回来（长回来就等于两套都能改）
  assert.ok(!fs.existsSync(path.join(SRC, 'features', 'settings')),
    'features/settings/ 不该存在 —— 设置分区只有 settings/settingsSections.ts 一个来源')
  assert.ok(!fs.existsSync(path.join(SRC, 'features', 'builtinSettings.ts')),
    'features/builtinSettings.ts 不该存在 —— 同上，别再开第二套注册表')
})
