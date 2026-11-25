#!/usr/bin/env node
// 发布链静态契约：Docker 构建上下文、质量门禁与 job DAG 必须同时成立。
// 这里只读仓库文本，不构建产物、不依赖第三方 YAML 包，也不替代 actionlint。
//
// 跑法：
//   node product/tools/verify/delivery-check.mjs
//   node product/tools/verify/delivery-check.mjs SELF TEST
//   node product/tools/verify/delivery-check.mjs --self-test
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../../..')
const WORKFLOW_PATH = '.github/workflows/build-jar.yml'
const DOCKERFILE_PATH = 'product/Dockerfile'
const REQUIRED_QUALITY_COMMANDS = [
  'npm run protocol:check',
  'npm --prefix product run docs:api-check',
  'npm --prefix product run changelog:check',
  'npm --prefix product run version:check',
  'node product/tools/verify/delivery-check.mjs',
  'npm --prefix product run test:scripts',
]

const QUALITY_JOB = `  quality:
    name: Release Quality Gates
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js 22
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Run Release Quality Gates
        working-directory: .
        run: |
          npm run protocol:check
          npm --prefix product run docs:api-check
          npm --prefix product run changelog:check
          npm --prefix product run version:check
          node product/tools/verify/delivery-check.mjs
          npm --prefix product run test:scripts

`

// 独立字面量夹具：不能从当前工作流复制后再改，否则实现和测试会一起漂。
const GOOD_WORKFLOW = `name: Delivery contract fixture
on: [pull_request]
jobs:
${QUALITY_JOB}  build:
    needs: quality
    runs-on: ubuntu-latest
    steps:
      - run: true

  desktop:
    needs: build
    if: github.event_name != 'pull_request'
    runs-on: windows-latest
    steps:
      - run: true

  release:
    needs: [quality, build, desktop]
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - name: Publish
        uses: softprops/action-gh-release@v2
`
const GOOD_DOCKERFILE = 'FROM node:22-alpine\nCOPY core/ core/\n'

function readText(root, relativePath) {
  try {
    return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    return null
  }
}

function scalar(value) {
  const text = value.trim()
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if ((char === "'" || char === '"') && text[index - 1] !== '\\') {
      quote = quote === char ? null : quote ?? char
    } else if (char === '#' && quote === null && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trim()
    }
  }
  return text.replace(/^(['"])(.*)\1$/, '$2')
}

/** 窄解析器：只取顶层 jobs 及各 job 文本，避免用正则猜整份 YAML。 */
function parseJobs(workflow) {
  const lines = workflow.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => /^jobs:\s*(?:#.*)?$/.test(line) ? [index] : [])
  if (starts.length !== 1) return null
  const start = starts[0]
  const end = lines.findIndex((line, index) => index > start && /^[^\s#][^:]*:/.test(line))
  const body = lines.slice(start + 1, end < 0 ? undefined : end)
  const jobs = new Map()
  let current = null
  for (const line of body) {
    const header = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/.exec(line)
    if (header) {
      if (jobs.has(header[1])) return null
      current = []
      jobs.set(header[1], current)
    } else if (current && (!line.trim() || line.startsWith('    '))) {
      current.push(line)
    }
  }
  return jobs
}

function jobProperty(lines, name) {
  const pattern = new RegExp(`^ {4}${name}:\\s*(.*)$`)
  const index = lines.findIndex(line => pattern.test(line))
  if (index < 0) return null
  return { index, value: scalar(pattern.exec(lines[index])[1]) }
}

function parseNeeds(lines) {
  const property = jobProperty(lines, 'needs')
  if (!property) return []
  if (property.value) {
    if (property.value.startsWith('[')) {
      if (!property.value.endsWith(']')) return []
      return property.value.slice(1, -1).split(',').map(scalar).filter(Boolean)
    }
    return [property.value]
  }
  const needs = []
  for (let index = property.index + 1; index < lines.length; index += 1) {
    const item = /^ {6}-\s+(.+)$/.exec(lines[index])
    if (!item) break
    needs.push(scalar(item[1]))
  }
  return needs
}

function parseSteps(lines) {
  const steps = []
  let current = null
  for (const line of lines) {
    if (/^ {6}- /.test(line)) {
      current = [line]
      steps.push(current)
    } else if (current && /^ {4}\S/.test(line)) {
      current = null
    } else if (current && (!line.trim() || line.startsWith('        '))) {
      current.push(line)
    }
  }
  return steps
}

function stepUses(lines) {
  return lines.flatMap(line => {
    const match = /^\s*(?:-\s*)?uses:\s*(.+)$/.exec(line)
    return match ? [scalar(match[1])] : []
  })
}

function runCommands(lines) {
  const index = lines.findIndex(line => /^ {8}run:\s*(.*)$/.test(line))
  if (index < 0) return []
  const value = scalar(/^ {8}run:\s*(.*)$/.exec(lines[index])[1])
  if (!value) return []
  if (!/^[|>][+-]?\d?$/.test(value)) return [value]
  const commands = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.trim() && !line.startsWith('          ')) break
    const command = line.trim()
    if (command && !command.startsWith('#')) commands.push(command)
  }
  return commands
}

function inspectDelivery(root) {
  const errors = []
  const dockerfile = readText(root, DOCKERFILE_PATH)
  if (dockerfile === null) {
    errors.push(`无法读取 ${DOCKERFILE_PATH}`)
  } else if (!dockerfile.split(/\r?\n/).some(line => /^\s*COPY\s+core\/\s+core\/\s*(?:#.*)?$/i.test(line))) {
    errors.push(`${DOCKERFILE_PATH}: 必须包含 COPY core/ core/，确保 Gradle 多模块构建上下文完整`)
  }

  const workflow = readText(root, WORKFLOW_PATH)
  if (workflow === null) {
    errors.push(`无法读取 ${WORKFLOW_PATH}`)
    return errors
  }
  const jobs = parseJobs(workflow)
  if (!jobs) {
    errors.push(`${WORKFLOW_PATH}: 缺少唯一的顶层 jobs 映射或 job 结构无法识别`)
    return errors
  }

  for (const name of ['quality', 'build', 'desktop', 'release']) {
    if (!jobs.has(name)) errors.push(`${WORKFLOW_PATH}: 缺少 ${name} job`)
  }
  for (const [job, dependency] of [['build', 'quality'], ['desktop', 'build'], ['release', 'quality'], ['release', 'build'], ['release', 'desktop']]) {
    if (!parseNeeds(jobs.get(job) ?? []).includes(dependency)) {
      errors.push(`${WORKFLOW_PATH}: ${job}.needs 必须直接包含 ${dependency}，质量失败不得继续发布`)
    }
  }

  const qualityLines = jobs.get('quality') ?? []
  if (jobs.has('quality')) {
    if (jobProperty(qualityLines, 'if')) errors.push(`${WORKFLOW_PATH}: quality 不得按事件条件跳过`)
    if (qualityLines.some(line => {
      const match = /^\s*continue-on-error:\s*(.*)$/.exec(line)
      return match && scalar(match[1]).toLowerCase() !== 'false'
    })) errors.push(`${WORKFLOW_PATH}: quality 的 continue-on-error 只能显式为 false`)
    const steps = parseSteps(qualityLines)
    const nodeStep = steps.find(step => stepUses(step).some(action => /^actions\/setup-node@/.test(action)))
    const nodeVersion = nodeStep?.flatMap(line => {
      const match = /^\s+node-version:\s*(.*)$/.exec(line)
      return match ? [scalar(match[1])] : []
    })[0]
    if (nodeVersion !== '22') errors.push(`${WORKFLOW_PATH}: quality 必须用 actions/setup-node 固定 Node 22`)
    const commands = steps.flatMap(runCommands)
    if (commands.some(command => /^\s*set\s+\+e(?:\s|$)/.test(command) || /^\s*exit\s+0(?:\s|$)/.test(command))) {
      errors.push(`${WORKFLOW_PATH}: quality 不得关闭 shell 的失败退出或用 exit 0 吞错`)
    }
    for (const command of REQUIRED_QUALITY_COMMANDS) {
      if (!commands.includes(command)) errors.push(`${WORKFLOW_PATH}: quality 缺少命令 ${command}`)
    }
  }

  const releaseLines = jobs.get('release') ?? []
  const releaseCondition = jobProperty(releaseLines, 'if')?.value ?? ''
  const expression = releaseCondition.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
  if (!/^github\.event_name\s*!=\s*(['"])pull_request\1$/.test(expression) || /always\(\)/.test(releaseCondition)) {
    errors.push(`${WORKFLOW_PATH}: release.if 必须明确排除 pull_request，且不得用 always() 绕过失败`)
  }
  const usesReleaseAction = lines => lines.some(line => /^\s*(?:-\s*)?uses:\s*softprops\/action-gh-release@/.test(line))
  if (!usesReleaseAction(releaseLines)) errors.push(`${WORKFLOW_PATH}: release 缺少 softprops/action-gh-release 发布动作`)
  for (const [name, lines] of jobs) {
    if (name !== 'release' && usesReleaseAction(lines)) {
      errors.push(`${WORKFLOW_PATH}: ${name} 不得绕过 release DAG 直接发布`)
    }
  }
  return errors
}

function fixtureRun(workflow, dockerfile, args = []) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-delivery-check-'))
  try {
    const workflowFile = path.join(fixture, WORKFLOW_PATH)
    const dockerfileFile = path.join(fixture, DOCKERFILE_PATH)
    fs.mkdirSync(path.dirname(workflowFile), { recursive: true })
    fs.mkdirSync(path.dirname(dockerfileFile), { recursive: true })
    if (workflow !== null) fs.writeFileSync(workflowFile, workflow)
    if (dockerfile !== null) fs.writeFileSync(dockerfileFile, dockerfile)
    return spawnSync(process.execPath, [SCRIPT_PATH, '--root', fixture, ...args], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

function runSelfTest() {
  const results = []
  const expect = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`)
  }
  const expectStatus = (name, workflow, expected, dockerfile = GOOD_DOCKERFILE, args = []) => {
    const result = fixtureRun(workflow, dockerfile, args)
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    const marker = expected === 0 ? 'delivery-check: PASS' : expected === 1 ? 'delivery-check: FAIL' : '用法：'
    const ok = result.status === expected && output.includes(marker)
    expect(name, ok, `exit=${result.status}${result.error ? ` error=${result.error.message}` : ''}${!ok && output ? ` output=${output.replace(/\s+/g, ' ')}` : ''}`)
  }
  const replaceOnce = (text, from, to) => {
    if (!text.includes(from)) throw new Error(`SELF TEST 夹具字面量缺失：${from}`)
    return text.replace(from, to)
  }

  const releasePrefix = '  release:\n    needs: [quality, build, desktop]\n'
  expectStatus('合法夹具退出 0', GOOD_WORKFLOW, 0)
  const wrappedRelease = replaceOnce(GOOD_WORKFLOW,
    `${releasePrefix}    if: github.event_name != 'pull_request'`,
    `${releasePrefix}    if: ` + "${{ github.event_name != 'pull_request' }}")
  expectStatus('多行 needs 与 ${{ }} 条件同样通过', wrappedRelease
    .replace('    needs: [quality, build, desktop]', '    needs:\n      - quality\n      - build\n      - desktop'), 0)
  expectStatus('quality 缺失必须退出 1', replaceOnce(GOOD_WORKFLOW, QUALITY_JOB, ''), 1)
  expectStatus('build 绕过 quality 必须退出 1', replaceOnce(GOOD_WORKFLOW, '    needs: quality', '    needs: []'), 1)
  expectStatus('desktop 绕过 build 必须退出 1', replaceOnce(GOOD_WORKFLOW, '    needs: build', '    needs: []'), 1)
  expectStatus('release 直接依赖缺少 quality 必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '    needs: [quality, build, desktop]', '    needs: [build, desktop]'), 1)
  expectStatus('release 直接依赖缺少 build 必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '    needs: [quality, build, desktop]', '    needs: [quality, desktop]'), 1)
  expectStatus('release 直接依赖缺少 desktop 必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '    needs: [quality, build, desktop]', '    needs: [quality, build]'), 1)
  expectStatus('build 直接发布必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '    steps:\n      - run: true\n\n  desktop:',
    '    steps:\n      - uses: softprops/action-gh-release@v2\n\n  desktop:'), 1)
  expectStatus('release 去掉 PR 守卫必须退出 1', replaceOnce(GOOD_WORKFLOW,
    `${releasePrefix}    if: github.event_name != 'pull_request'`, `${releasePrefix}    if: true`), 1)
  expectStatus('release 使用 always() 绕过失败必须退出 1', replaceOnce(GOOD_WORKFLOW,
    `${releasePrefix}    if: github.event_name != 'pull_request'`,
    `${releasePrefix}    if: always() && github.event_name != 'pull_request'`), 1)
  expectStatus('release 没有发布动作必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '        uses: softprops/action-gh-release@v2\n', ''), 1)
  expectStatus('quality 不是 Node 22 必须退出 1', replaceOnce(GOOD_WORKFLOW,
    "          node-version: '22'", "          node-version: '20'"), 1)
  for (const command of REQUIRED_QUALITY_COMMANDS) {
    expectStatus(`quality 缺少 ${command} 必须退出 1`, replaceOnce(GOOD_WORKFLOW, `          ${command}\n`, ''), 1)
  }
  expectStatus('quality 被条件跳过必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '    name: Release Quality Gates\n', '    name: Release Quality Gates\n    if: false\n'), 1)
  expectStatus('quality 步骤吞掉失败必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '        run: |\n', '        continue-on-error: true\n        run: |\n'), 1)
  expectStatus('quality 表达式式 continue-on-error 必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '        run: |\n', '        continue-on-error: ${{ inputs.ignore }}\n        run: |\n'), 1)
  expectStatus('quality 关闭 shell 失败退出必须退出 1', replaceOnce(GOOD_WORKFLOW,
    '        run: |\n', '        run: |\n          set +e\n'), 1)
  expectStatus('Dockerfile 缺少 core 复制必须退出 1', GOOD_WORKFLOW, 1, 'FROM node:22-alpine\n')
  expectStatus('Dockerfile core 复制目标错误必须退出 1', GOOD_WORKFLOW, 1,
    'FROM node:22-alpine\nCOPY core/ /src/core/\n')
  expectStatus('Dockerfile 注释掉 core 复制必须退出 1', GOOD_WORKFLOW, 1,
    'FROM node:22-alpine\n# COPY core/ core/\n')
  expectStatus('Dockerfile 缺失必须退出 1', GOOD_WORKFLOW, 1, null)
  expectStatus('工作流文件缺失必须退出 1', null, 1)
  expectStatus('jobs 结构缺失必须退出 1', 'name: broken\non: [pull_request]\n', 1)
  expectStatus('未知参数退出 2', GOOD_WORKFLOW, 2, GOOD_DOCKERFILE, ['--unknown'])

  const failed = results.filter(result => !result.ok).length
  console.log(`\nSELF TEST: ${failed === 0 ? 'PASS' : 'FAIL'} ${results.length - failed}/${results.length}`)
  process.exitCode = failed === 0 ? 0 : 1
}

function parseArgs(args) {
  if (args.length === 2 && args[0] === 'SELF' && args[1] === 'TEST') return { selfTest: true, root: REPO_ROOT }
  if (args.length === 1 && args[0] === '--self-test') return { selfTest: true, root: REPO_ROOT }
  let root = REPO_ROOT
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root' && args[index + 1] && !args[index + 1].startsWith('--')) {
      root = path.resolve(args[index + 1])
      index += 1
    } else {
      return { usage: true }
    }
  }
  return { selfTest: false, root }
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.usage) {
    console.error('用法：node product/tools/verify/delivery-check.mjs [--root <仓库根> | SELF TEST | --self-test]')
    process.exitCode = 2
  } else if (options.selfTest) {
    runSelfTest()
  } else {
    const errors = inspectDelivery(options.root)
    if (errors.length > 0) {
      for (const error of errors) console.error(`FAIL  ${error}`)
      console.error(`\ndelivery-check: FAIL ${errors.length} 条契约`)
      process.exitCode = 1
    } else {
      console.log('delivery-check: PASS（Docker 上下文、quality 门禁与发布 DAG 均符合契约）')
    }
  }
} catch (error) {
  console.error(`delivery-check: ERROR ${error?.message ?? error}`)
  process.exitCode = 1
}
