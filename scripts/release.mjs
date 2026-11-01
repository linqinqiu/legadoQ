#!/usr/bin/env node
/**
 * 发布：把「当前对外版本 + 内部构建号」落成一条记录、一个提交与一个 tag。
 *
 * 它**不**改对外版本，也不生成 CHANGELOG —— 这两件事分别由
 * `node scripts/version.mjs set-external X.Y.Z` 与手写
 * `product/CHANGELOG.md` 完成。发布脚本只做最后一步：校验、记账、打点、推送。
 * 这样版本真源仍然只有 `product/app/build.gradle` 一处，脚本不复制它。
 *
 * 流程（任一步失败即中止，不继续往下走）：
 *   1. 校验 7 处版本一致（复用 product/scripts/version-check.mjs）
 *   2. 校验 CHANGELOG 已有当前版本的小节
 *   3. 校验 tag 尚未存在、RELEASES.md 没有记过这一版
 *   4. 向 RELEASES.md 追加「版本 | 构建号 | 代码提交」
 *   5. 提交这条记录，并在该提交上打 `vX.Y.Z` 注释 tag
 *   6. 推送分支与 tag（CI 会据此创建 GitHub Release）
 *
 * 用法：
 *   npm run release                 # 真正发布
 *   npm run release:dry             # 只打印将要做什么，不改任何文件
 *   npm run release -- --no-push    # 本地生成提交与 tag，不推送
 *
 * 前置：工作区必须干净（发布 tag 不能盖着未提交改动）；先提交代码，再跑本脚本。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, buildNumber, externalVersion } from "./version.mjs";

const RELEASES = resolve(ROOT, "RELEASES.md");
const CHANGELOG = resolve(ROOT, "product/CHANGELOG.md");
const VERSION_CHECK = resolve(ROOT, "product/scripts/version-check.mjs");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const noPush = argv.includes("--no-push");
const help = argv.includes("--help") || argv.includes("-h");

if (help) {
  console.log("用法：node scripts/release.mjs [--dry-run] [--no-push]");
  console.log("  --dry-run  只检查并打印，不写 RELEASES.md、不提交、不打 tag");
  console.log("  --no-push  生成提交与 tag，但不推送到 origin");
  process.exit(0);
}

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function git(args, { inherit = false } = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function read(path) {
  return readFileSync(path, "utf8");
}

function assertCleanWorktree() {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    console.error("[release] 工作区不干净，发布 tag 不能盖在未提交改动上：");
    console.error(dirty.split("\n").slice(0, 20).map((line) => `  ${line}`).join("\n"));
    console.error("先提交或撤回这些改动，再重跑；只想看流程用 npm run release:dry。");
    process.exit(1);
  }
}

function checkVersionCopies() {
  try {
    execFileSync(process.execPath, [VERSION_CHECK], { cwd: ROOT, stdio: "inherit" });
  } catch {
    fail("版本抄本不一致，先按 version-check 的提示改齐。");
  }
}

function checkChangelog(version) {
  if (!existsSync(CHANGELOG)) fail(`缺 ${CHANGELOG}`);
  const heading = new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m");
  if (!heading.test(read(CHANGELOG))) {
    fail(`product/CHANGELOG.md 里没有 ## [${version}] 小节。发布前先把这一版用户可见的变化写进去。`);
  }
}

function checkNotReleased(version, tag) {
  if (tryGit(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`])) {
    fail(`tag ${tag} 已存在。对外版本只能用一次；要再发一版，先用 version.mjs set-external 改版本号。`);
  }
  if (existsSync(RELEASES)) {
    const recorded = new RegExp(`^\\|\\s*${version.replaceAll(".", "\\.")}\\s*\\|`, "m");
    if (recorded.test(read(RELEASES))) {
      fail(`RELEASES.md 已经记过 ${version}。同一版本不重复发布。`);
    }
  }
}

function shortSha(sha) {
  return sha.slice(0, 12);
}

const version = externalVersion();
const build = buildNumber();
const tag = `v${version}`;
const branch = tryGit(["symbolic-ref", "--short", "HEAD"]) || "(detached HEAD)";
const head = git(["rev-parse", "HEAD"]);
const subject = git(["log", "-1", "--pretty=%s"]);

console.log(`[release] 对外版本 ${version} · 构建号 ${build} · tag ${tag}`);
console.log(`[release] 当前分支 ${branch} · 代码提交 ${shortSha(head)} ${subject}`);

if (branch !== "main") {
  console.warn(`[release] 注意：当前不在 main（${branch}）。正式发行应从 main 打 tag。`);
}

checkVersionCopies();
checkChangelog(version);
checkNotReleased(version, tag);
if (!dryRun) assertCleanWorktree();
else console.log("[release] dry-run：跳过工作区清洁检查");

const row = `| ${version} | ${build} | ${shortSha(head)} |`;
if (!dryRun) {
  const previous = existsSync(RELEASES) ? read(RELEASES) : "";
  const next = `${previous}${previous.endsWith("\n") ? "" : "\n"}${row}\n`;
  writeFileSync(RELEASES, next);
  console.log(`[release] 已记入 RELEASES.md：${row}`);
  git(["add", "RELEASES.md"]);
  git(["commit", "-m", `docs(release): record ${version} (build ${build})`], { inherit: true });
  git(["tag", "-a", tag, "-m", `legadoQ ${version} (build ${build})`], { inherit: true });
  console.log(`[release] 已提交并打 tag ${tag}`);
} else {
  console.log(`[release] dry-run：将向 RELEASES.md 追加 ${row}`);
  console.log(`[release] dry-run：将提交「docs(release): record ${version} (build ${build})」并打 tag ${tag}`);
}

if (!noPush) {
  if (dryRun) {
    console.log("[release] dry-run：将推送当前分支与 tag");
  } else {
    // 先推提交再推 tag：tag 推失败时提交还在，重试只补 tag；不会出现远端有 tag 没有记录提交。
    git(["push", "origin", "HEAD"], { inherit: true });
    git(["push", "origin", tag], { inherit: true });
    console.log(`[release] 已推送 ${branch} 与 ${tag}`);
  }
} else {
  console.log("[release] --no-push：未推送。确认无误后手动 git push origin HEAD && git push origin " + tag);
}

console.log("");
console.log("[release] 后续：");
console.log("  1. 等 CI 的 version-gate 与 build-jar 在 tag 上跑完，确认 GitHub Release 已生成");
console.log("  2. 按 RELEASING.md 打包桌面版，并把 legadoq-desktop-<版本>.zip 上传到该 Release");
console.log("  3. curl http://127.0.0.1:1234/healthz，确认 version 与 build 都和这一条记录一致");
