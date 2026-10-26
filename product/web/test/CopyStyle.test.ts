import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 界面文案判据。2026-10-01 做过一轮全量清理（禁用的装饰字形、说谎的能力描述、
 * 一个概念两三种叫法、中文串里混用半角标点），这一条钉住它不许长回去。
 *
 * 只扫**字符串字面量与 JSX 文本**，注释与代码本身不算 —— 注释里出现 `...` 或箭头是正常书写。
 */
const SRC = path.resolve(import.meta.dirname, '../src')
const files = () => fs.readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(name => /\.(tsx|ts)$/.test(name))

/** 项目口径：不用彩色 emoji、不用装饰性字形，图标一律单色 SVG（AGENTS §5、用户 2026-09 起）。 */
const BANNED_GLYPHS = [
  0x1F3AF, 0x1F448, 0x1F4A1, 0x1F50D, 0x1F9EA, 0x2605, 0x26A0, 0xFE0F,
  0x2302, 0x23F3, 0x2022, 0x22EE, 0x25CB, 0x25CC, 0x25CF, 0x25D0,
  0x26AA, 0x2705, 0x2713, 0x2715, 0x274C, 0x2039, 0x203A, 0x00AB, 0x00BB, 0x27F3, 0x29C9,
].map(code => String.fromCodePoint(code))

/**
 * 这份清单曾经直接写成字面量，结果链路上有五个字形被吞成了空串 —— 而
 * `BANNED_GLYPHS.find(mark => text.includes(mark))` 拿到 `''` 是 falsy，
 * 判据既不报错也不拦东西，💡 与 👈 就这么在"全量清理已完成"的绿底下留到了下一轮。
 * 所以清单按码位写、由 `String.fromCodePoint` 组装，下面那条自检先把"清单里没有空项"钉住。
 */
test('判据的禁字形清单本身不能有空项', () => {
  const broken = BANNED_GLYPHS.map((mark, index) => [index, mark] as const).filter(([, mark]) => !mark)
  assert.deepEqual(broken, [], `清单里有空字符串：${broken.map(([index]) => index).join(', ')}`)
  assert.equal(new Set(BANNED_GLYPHS).size, BANNED_GLYPHS.length, '清单里有重复码位')
})

/** 手机口径的说法：这台服务是电脑上的产品，界面不许教用户"在手机上做某事"。 */
const BANNED_PHONE_PHRASES = ['手机上用', '手机能访问这台电脑', '手机真的访问得到', '手机或电脑', '零流量', '主屏幕', '扫码登录 legadoQ']

/** 说谎的能力描述：这些句子指向界面上不存在的按钮/不存在的机制。 */
const BANNED_CLAIMS = ['缓存并下载到本设备', '按包里的规则名匹配', '界面上暂未提供入口']

/** 抓字符串字面量与 JSX 文本（粗略但够用：单双反引号里的内容 + >…< 之间的可见文字）。 */
function visibleText(code: string): Array<{ text: string; line: number }> {
  const hits: Array<{ text: string; line: number }> = []
  const literal = /(['"`])((?:\\.|(?!\1)[^\\\n\r])*)\1/g
  let match: RegExpExecArray | null
  while ((match = literal.exec(code)) !== null) {
    hits.push({ text: match[2], line: code.slice(0, match.index).split('\n').length })
  }
  const jsxText = />([^<>{}]+)</g
  while ((match = jsxText.exec(code)) !== null) {
    // 这里原先要求"必须含中文"，于是 `<button>\n  ›\n</button>` 这种**只有字形**的图标按钮
    // 整个从判据里消失了 —— 上一轮清理后残留的 ‹ › ⟳ ⌂ ⧉ 就是这么漏掉的。
    if (!match[1].trim()) continue
    hits.push({ text: match[1], line: code.slice(0, match.index).split('\n').length })
  }
  return hits.filter(hit => !isCode(hit.text))
}

/**
 * 两类东西不算"界面文案"，判据不许碰：
 * - 书签脚本（bookmarklet）这种整段代码字符串 —— 它的括号与点是语法，不是排版；
 * - 模板串里 `${...}` 插值表达式内部的括号（`String(x ?? '未命名')` 是代码）。
 */
function isCode(text: string) {
  return text.length > 200 || /javascript:|function\s*\(|=>|\bdocument\.|\bwindow\.|\.cookie/.test(text)
}

/** 标点判据只看真人看到的文字：插值表达式先抠掉再判断括号。 */
function proseOf(text: string) {
  return text.replace(/\$\{[^}]*\}/g, '')
}

test('判据自己先要可信：字符串、只有字形的图标按钮、中文省略号都要扫得到', () => {
  const BULB = String.fromCodePoint(0x1F4A1)
  const ANGLE = String.fromCodePoint(0x203A)
  const sample = `const a = '正在加载…'\nconst b = "${BULB} 成功"\nconst c = '正在加载...'\nconst d = '选择 (全部)'\nconst e = <button title="前进">\n  ${ANGLE}\n</button>\n// 注释里有 ${BULB} 不算\n`
  const found = visibleText(sample)
  assert.ok(found.some(item => item.text.includes(BULB)), '要能抓到字符串里的 astral 平面 emoji')
  assert.ok(found.some(item => item.text.trim() === ANGLE), '要能抓到"只有一个字形"的图标按钮')
  assert.ok(found.some(item => item.text.includes('...')), '要能抓到中文串里的三个点')
  assert.ok(!found.some(item => item.text.includes('注释里有')), '注释不该算进去')
})

/** 空串混进清单时 `find` 会返回 falsy，整条判据静默失效 —— 所以逐个字形对着扫描器验一遍。 */
test('反向对照：清单里每一个字形都必须被扫描器抓到', () => {
  const missed = BANNED_GLYPHS.filter(mark => {
    const found = visibleText(`const x = <p>${mark}</p>\nconst y = '正常文字'\n`)
    return !found.some(hit => hit.text.includes(mark))
  })
  assert.deepEqual(missed, [], `扫描器对这几个字形是瞎的：${missed.map(mark => 'U+' + (mark.codePointAt(0) ?? 0).toString(16).toUpperCase()).join(' ')}`)
})

for (const name of files()) {
  test(`${name}：界面文案不越界`, () => {
    const code = fs.readFileSync(path.join(SRC, name), 'utf8')
    // 去掉行注释与块注释，避免"文档里写着不许用某个字形"被自己的判据打死。
    // 块注释要按整段抹（占位换成空格，行号不变）：`{ /** … */ }` 夹在 JSX 里时，
    // 注释文字会被">…< 之间的可见文字"那条规则当成界面文案捞出来。
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
      .split('\n')
      .map(line => line.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
      .join('\n')
    const offenders: string[] = []
    for (const { text, line } of visibleText(stripped)) {
      const glyph = BANNED_GLYPHS.find(mark => text.includes(mark))
      if (glyph) offenders.push(`第 ${line} 行有装饰字形 ${glyph}：${text.slice(0, 40)}`)
      const phone = BANNED_PHONE_PHRASES.find(phrase => text.includes(phrase))
      if (phone) offenders.push(`第 ${line} 行是手机口径「${phone}」：${text.slice(0, 40)}`)
      const claim = BANNED_CLAIMS.find(phrase => text.includes(phrase))
      if (claim) offenders.push(`第 ${line} 行引用了不存在的能力「${claim}」`)
      if (/[\u3400-\u9fff]/.test(text)) {
        const prose = proseOf(text)
        if (prose.includes('...')) offenders.push(`第 ${line} 行中文串里用了三个点，应为 …：${text.slice(0, 40)}`)
        if (/\([^)]*[\u3400-\u9fff][^)]*\)/.test(prose)) offenders.push(`第 ${line} 行中文串里用了半角括号：${text.slice(0, 40)}`)
      }
    }
    assert.deepEqual(offenders, [], `${name} 有 ${offenders.length} 处文案越界：\n  ${offenders.slice(0, 8).join('\n  ')}`)
  })
}

test('书源在界面上以名字出现，不再直接甩 sourceId', () => {
  const switchModal = fs.readFileSync(path.join(SRC, 'sources', 'SourceSwitchModal.tsx'), 'utf8')
  assert.ok(switchModal.includes('sourceLabel('), '换源弹窗要用 sourceLabel，而不是把裸 sourceId 当标题')
  assert.ok(!/<strong>\{c\.result\.sourceId\}<\/strong>/.test(switchModal), '候选行不许再直接渲染 sourceId')
  const offline = fs.readFileSync(path.join(SRC, 'components', 'OfflineCacheModal.tsx'), 'utf8')
  // 只禁"当文字渲染"的裸 id；React 的 key 与调用参数里出现 sourceId 是对的。
  assert.ok(!/<[a-z]+[^>]*>\{book\.sourceId\}</.test(offline), '离线缓存那一行不该把裸书源 id 当文字显示')
})

test('一个概念一个名字（复检 / 体检 / 夜读 / 缓存全本）', () => {
  const all = files().map(name => [name, fs.readFileSync(path.join(SRC, name), 'utf8')] as const)
  const visible = (name: string, code: string) => code.split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .filter(line => /['"`>][^'"`]*[\u3400-\u9fff]/.test(line))
    .map(line => `${name}:${line.trim().slice(0, 60)}`)
  const offenders = all.flatMap(([name, code]) => visible(name, code).filter(where =>
    /正在努力探测中|重新抽检|正在抽检|>夜间</.test(where),
  ))
  assert.deepEqual(offenders, [], `这些行的叫法已统一，别改回去：\n  ${offenders.join('\n  ')}`)
})

/**
 * `CHANGELOG.md` 打进 jar、由「更新日志」页原样渲染，所以它和界面代码一样是**用户会看到的文字**：
 * 里面写"删掉了哪些装饰字形"时不能把那些字形贴出来，否则这一页自己就成了唯一还在用它们的地方。
 * 标点规则不适用（markdown 的链接与代码片段本来就用半角括号与三个点）。
 */
test('随包的更新日志里不出现装饰字形', () => {
  const file = path.resolve(import.meta.dirname, '../../CHANGELOG.md')
  const text = fs.readFileSync(file, 'utf8')
  const offenders: string[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const glyph = BANNED_GLYPHS.find(mark => line.includes(mark))
    if (glyph) {
      const code = 'U+' + (glyph.codePointAt(0) ?? 0).toString(16).toUpperCase()
      offenders.push(`第 ${index + 1} 行有装饰字形 ${code}：${line.trim().slice(0, 50)}`)
    }
  })
  assert.deepEqual(offenders, [], `CHANGELOG.md 会被界面直接显示：\n  ${offenders.join('\n  ')}`)
})

/** 服务端 `RuleRunner` 的调试轨迹直接显示在「书源调试」弹窗里，同样算界面文案。 */
test('书源调试的轨迹标签不出现装饰字形', () => {
  const file = path.resolve(import.meta.dirname, '../../app/src/main/kotlin/io/legado/rules/RuleRunner.kt')
  const offenders: string[] = []
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!/DebugTrace\(/.test(line)) return
    const glyph = BANNED_GLYPHS.find(mark => line.includes(mark))
    if (glyph) offenders.push(`第 ${index + 1} 行的轨迹标签带装饰字形：${line.trim().slice(0, 60)}`)
  })
  assert.deepEqual(offenders, [], `轨迹标签会被原样显示：\n  ${offenders.join('\n  ')}`)
})
