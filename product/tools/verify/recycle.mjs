// 门禁自己的收尾动作也得守住一条线：探针写进**用户数据目录**（product/data/…）的文件，
// 不能 fs.rmSync 永久删。这里统一走 Windows 回收站，删完回读确认，失败就把门禁标红，
// 而不是留一句"应该删掉了"。
//
// 为什么单独一个模块：backup-upload-check / rss-check / toc-rule-check 都有
// 「探针造的条目探针自己收掉」这一段，各自 copy 一份迟早有人写成 rmSync。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 把文件送进回收站。返回 { deleted, error } —— deleted 只认"回读确实不存在"。 */
export function recycleFile(absPath) {
  if (!fs.existsSync(absPath)) return { deleted: false, missing: true, error: '' }
  const winPath = path.resolve(absPath)
  try {
    // 单引号里再出现单引号得按 PS 规则 doubled；路径来自我们自己拼的夹具名，仍然按最稳的写法处理
    const literal = winPath.replace(/'/g, "''")
    const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; '
      + `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${literal}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script],
      { windowsHide: true, stdio: 'ignore', timeout: 60000 })
  } catch (error) {
    return { deleted: fs.existsSync(winPath) === false, error: (error.message || String(error)).split('\n')[0] }
  }
  return { deleted: !fs.existsSync(winPath), error: '' }
}

/**
 * 只有内容逐字等于探针夹具时才回收 —— 用户对得上号的真实文件（同名但内容不同）绝不许被门禁动。
 * 返回一行给 ok() 用的说明文字，同时把"该不该继续红"交给调用方判断。
 */
export function recycleOwnFixture(absPath, ownFixtureText) {
  if (!fs.existsSync(absPath)) return { existed: false, deleted: false, detail: '数据目录里没有这个条目' }
  const text = fs.readFileSync(absPath, 'utf8')
  if (text !== ownFixtureText) return { existed: true, deleted: false, detail: '内容不是本探针的夹具，保留不动' }
  const result = recycleFile(absPath)
  if (result.deleted) return { existed: true, deleted: true, detail: '已送进回收站（内容逐字等于本探针夹具）' }
  // 回收站这条路走不通（比如没有 Shell 环境）——退而求其次也不能永久删，直接把门禁标红让人来看
  return { existed: true, deleted: false, detail: `送回收站失败：${result.error || '回读仍存在'}`, stale: true }
}
