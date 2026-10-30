/**
 * 备份包直传用的 multipart 组装。
 *
 * 三个门禁（rss-check / backup-cookie-import-check / backup-upload-check）都要把一份探针 zip
 * 交给 `POST /api/backup/import`，各自写过一份就迟早会漂，所以收在这里。
 */
export function multipartUpload(stamp, filename, bytes, password) {
  const boundary = `----legado${stamp}`
  const head = (name, extra = '') =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n`
  const parts = []
  if (password) parts.push(Buffer.from(head('password') + password + '\r\n', 'utf8'))
  // 注意别再往 body 前面补 `\r\n`：`head()` 结尾已经是 `\r\n\r\n`（头与体的分界），
  // 多出来的两个字节会落在文件内容最前面，zip 就不再是 `PK` 起头 ——
  // 导入按内容判别之后，服务端如实回 `invalid_backup`，三条备份门禁集体变红。
  parts.push(Buffer.from(head('file', `; filename="${filename}"`), 'utf8'))
  parts.push(bytes)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}
