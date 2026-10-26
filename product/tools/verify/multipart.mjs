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
  parts.push(Buffer.from(head('file', `; filename="${filename}"`) + '\r\n', 'utf8'))
  parts.push(bytes)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}
