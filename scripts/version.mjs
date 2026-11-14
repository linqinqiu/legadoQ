#!/usr/bin/env node
/**
 * 版本读写工具（对外版本 + 内部构建号双轨）。
 *
 * 设计边界（务必先读）：
 * - **对外语义版本的唯一真源仍是 `product/app/build.gradle` 的 `version`**，由 Gradle 清单
 *   注入 `BuildInfo`，`/healthz`、About 页与界面读的是同一个数。本脚本只**读**它来展示，
 *   不在仓库里另立 `VERSION_EXTERNAL` 之类的第二真源 —— 那正是历史上反复栽的坑。
 * - **内部构建号 `BUILD_NUMBER`** 是一个独立的单调计数器：**仅在对外发布时**随 `RELEASES.md`
 *   记账 `bump-build` 加一（`release.mjs` 流程），日常开发提交不动它——`VersionTracks.test.ts`
 *   钉住「RELEASES 末行 build == 当前 BUILD_NUMBER」，平时 bump 必红。一个对外版本对应一个构建号。
 * - `RELEASES.md` 记录「对外版本 ← 构建号 ← commit」的映射，由 `scripts/release.mjs` 自动追加。
 *
 * 用法：
 *   node scripts/version.mjs show                 # 打印对外版本 + 内部构建号
 *   node scripts/version.mjs bump-build           # 构建号 +1
 *   node scripts/version.mjs set-external 0.3.0   # 设定对外版本并同步全部抄本
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(import.meta.dirname, "..");
export const BUILD = resolve(ROOT, "BUILD_NUMBER");
export const GRADLE = resolve(ROOT, "product/app/build.gradle");

const readText = (p) => readFileSync(p, "utf8");
const readTrim = (p) => readText(p).trim();

/** 对外版本的唯一真源：gradle 里的 project 级 `version = 'x.y.z'`（排除 toolVersion 之类）。 */
export function externalVersion() {
  const line = readText(GRADLE).split("\n").find((l) => /^\s*version\s*[:=]/.test(l));
  const found = line?.match(/\d+\.\d+\.\d+/)?.[0];
  if (!found) throw new Error("product/app/build.gradle 里找不到 project 级 version = 'x.y.z'");
  return found;
}

export function buildNumber() {
  if (!existsSync(BUILD)) throw new Error("缺 BUILD_NUMBER（应为非负整数）");
  const raw = readTrim(BUILD);
  if (!/^\d+$/.test(raw)) throw new Error(`BUILD_NUMBER 必须是非负整数，当前为 ${JSON.stringify(raw)}`);
  return Number(raw);
}

export function versionInfo() {
  return { external: externalVersion(), build: buildNumber(), buildFile: "BUILD_NUMBER" };
}

export function bumpBuild({ quiet = false } = {}) {
  const next = buildNumber() + 1;
  writeFileSync(BUILD, String(next) + "\n");
  if (!quiet) console.log(`build -> ${next}（对外版本仍是 ${externalVersion()}）`);
  return next;
}

/**
 * 设定对外版本并同步全部抄本。
 *
 * 只改「真源 + 由 version-check 钉住的 6 处抄本」，改完请再跑 `node product/scripts/version-check.mjs`
 * 确认全绿。package-lock.json 顶层的 version 一并尽力同步（npm 本身不校验它，但留着会漂）。
 */
export function setExternal(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value ?? "")) {
    throw new Error("格式必须是 X.Y.Z（如 0.3.0）；预发布后缀请手动处理");
  }
  const replaceFile = (path, from, to) => {
    const text = readText(path);
    if (!new RegExp(from).test(text)) throw new Error(`在 ${path} 里找不到预期写法：${from}`);
    writeFileSync(path, text.replace(new RegExp(from), to));
  };

  // 1) 真源
  replaceFile(GRADLE, "(\\n\\s*version\\s*=\\s*')[^']+(')", `$1${value}$2`);
  // 2) 三份 package.json
  for (const p of ["product/package.json", "product/web/package.json", "package.json"]) {
    replaceFile(resolve(ROOT, p), '("version"\\s*:\\s*")[^"]+(")', `$1${value}$2`);
  }
  // 3) 根 VERSION
  writeFileSync(resolve(ROOT, "VERSION"), value + "\n");
  // 4) agent-api.json 的顶层 version
  replaceFile(resolve(ROOT, "product/app/src/main/resources/agent-api.json"), '("version"\\s*:\\s*")[^"]+(")', `$1${value}$2`);
  // 5) README 顶部「当前版本 **x.y.z**」
  replaceFile(resolve(ROOT, "README.md"), "(当前版本\\s*\\*\\*)\\d+\\.\\d+\\.\\d+(\\*\\*)", `$1${value}$2`);
  // 6) package-lock.json 顶层 version（尽力而为，不存在就跳过）
  for (const p of ["package-lock.json", "product/package-lock.json", "product/web/package-lock.json"]) {
    const abs = resolve(ROOT, p);
    if (!existsSync(abs)) continue;
    writeFileSync(abs, readText(abs).replace(/("version"\s*:\s*")[^"]+(")/, `$1${value}$2`));
  }

  return value;
}

function show() {
  console.log(JSON.stringify(versionInfo(), null, 2));
}

function main(argv) {
  const [, , cmd, arg] = argv;
  switch (cmd) {
    case "show":
      show();
      break;
    case "bump-build":
      bumpBuild();
      break;
    case "set-external":
      setExternal(arg);
      console.log(`external -> ${arg}（已同步 gradle 真源与各抄本）`);
      console.log("下一步：node product/scripts/version-check.mjs 确认全绿，再按发布流程改 CHANGELOG 并 npm run release");
      break;
    default:
      console.error("用法: node scripts/version.mjs <show|bump-build|set-external X.Y.Z>");
      process.exit(1);
  }
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(`[version] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
