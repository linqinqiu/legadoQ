/**
 * 预设图标清单（用户 2026-11-21：「获取md3上游仓库图标…让咱们也可以切换自定义图标」）。
 *
 * 这 9 张是上游 legado（HapeLee/legado-with-MD3）自己的 9 套 adaptive-icon ——
 * 上游 `AndroidManifest.xml` 里正好有 9 个 `activity-alias` 分别引用它们，
 * 那是上游的「换图标」功能。我们照搬同一批素材。
 *
 * 图标字节由 `product/tools/verify/render-brand-presets.mjs` 从 vendored 的上游矢量渲染，
 * 输出 512×512 不透明 PNG（满幅正方形、**不烘焙圆角遮罩** —— 遮罩交给操作系统，
 * 否则系统再套一次就会出现「图标缺角」）。
 *
 * 切换的实现走「取字节 → 当作上传文件 → 复用现有的 POST /brand/icon」：
 * 服务端 `BrandStore` 只认字节（按魔数判 PNG/JPEG/WebP、拒 SVG），落盘到安装根 `brand/`，
 * 随目录搬盘/改名/重启仍在 —— 与手工上传一张图完全同一条路径、同一套纪律。
 */

export interface BrandPreset {
  /** 与上游 mipmap-anydpi-v26 里的文件名一致，便于回溯是哪一套。 */
  id: string
  /** 界面上给人看的名字。 */
  label: string
  /** 静态资源路径（相对站点根）。 */
  file: string
}

import { requestBlob } from './api/client'

/**
 * 图标 URL 上的版本号。
 *
 * 与 `vite.config.ts` 的 `ICON_VERSION` 必须一致 —— 那边给 manifest 与内置图标换指纹，
 * 这边给预设图标换指纹；两边不同步就会出现「图标换了但还是旧的」。
 * `index.html` 里那几个内置图标用的是 `?v=5`，与此对应。
 */
const PRESET_ICON_VERSION = '5'

export const BRAND_PRESETS: BrandPreset[] = [
  { id: 'ic_launcher', label: '经典猫头', file: '/brand-presets/ic_launcher.png' },
  { id: 'launcherw', label: '浅底猫头', file: '/brand-presets/launcherw.png' },
  { id: 'launcher0', label: '阅读 3.0', file: '/brand-presets/launcher0.png' },
  { id: 'launcher1', label: '卷轴', file: '/brand-presets/launcher1.png' },
  { id: 'launcher2', label: '书页', file: '/brand-presets/launcher2.png' },
  { id: 'launcher3', label: '朱砂书', file: '/brand-presets/launcher3.png' },
  { id: 'launcher4', label: '看书的人', file: '/brand-presets/launcher4.png' },
  { id: 'launcher5', label: 'Read', file: '/brand-presets/launcher5.png' },
  { id: 'launcher6', label: '阅读书签', file: '/brand-presets/launcher6.png' },
]

/** 带版本号的 URL —— 文件名不带内容 hash，靠这个查询参数破浏览器缓存。 */
export function presetUrl(preset: BrandPreset): string {
  return `${preset.file}?v=${PRESET_ICON_VERSION}`
}

/**
 * 取一张预设图标，当成「用户上传的文件」交给服务端。
 *
 * 走统一传输层 `requestBlob`（不让 src 里再冒出裸 fetch：统一超时、错误体口径、性能采集
 * 都在这层，且 BareFetch 测试不允许例外）。刻意不建 blob URL：File 直接进 FormData，
 * 不需要临时 URL，也就没什么要 revoke 的。
 */
export async function fetchPresetFile(preset: BrandPreset): Promise<File> {
  const blob = await requestBlob(presetUrl(preset))
  return new File([blob], `${preset.id}.png`, { type: 'image/png' })
}
