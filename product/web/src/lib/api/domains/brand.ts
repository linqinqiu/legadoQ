/** 品牌（站点名/图标/主题色）：`/brand` 系列端点。
 *
 * 图标只收 PNG / JPEG / WebP（服务端按魔数判、拒 SVG），上限 5 MB，
 * 所以上传走 FormData 而不是 JSON —— 别在这里改成 JSON 序列化。
 */
import { request } from '../client'
import type { BrandInfo } from '../types'

export const brand = {
  get: () => request<BrandInfo>('/brand'),
  set: (payload: { name: string; shortName: string; themeColor: string }) =>
    request<BrandInfo>('/brand', { method: 'PUT', body: JSON.stringify(payload) }),
  reset: () => request<BrandInfo>('/brand', { method: 'DELETE' }),
  uploadIcon: (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return request<BrandInfo>('/brand/icon', { method: 'POST', body: form })
  },
  clearIcon: () => request<BrandInfo>('/brand/icon', { method: 'DELETE' }),
}