/**
 * 内置设置分区的形状。定义在**这一侧**而不是页面那侧：
 * 这张表才是分区数据的权威源，`SettingsPage` 只是画它 —— 类型长在消费者身上，
 * 表就得反过来 import 页面（而本仓库的依赖方向纪律是「内容 → 框架」单向）。
 * 页面保留同名重导出，`pages.tsx` 等既有引用不受影响。
 */
import type { ReactNode } from 'react'

export type SettingsRow = {
  title: string
  hint: string
  action: string
  onClick: () => void
}

/**
 * `content` 是给"控件就在这一档里"的分区留的口子（目前只有「壁纸」用）。
 *
 * 普通行只能放一句说明 + 一颗按钮；壁纸要开关、选图、地址框和四根滑杆，
 * 塞进行模型只会逼出第二套控件。这里只放**渲染入口**，实现仍然只有一份
 * （`settings/WallpaperSection.tsx`、`settings/CookieSection.tsx`），所以不算开了第二套编辑器。
 */
export type SettingsSection = { title: string; rows: SettingsRow[]; content?: () => ReactNode }

/**
 * 「设置」这一页的分区表（PROPOSAL-021 P0.3）。
 *
 * 它从 `main.tsx` 里搬出来，是因为这张表原来内联在 `App` 组件里：一份要给人读的清单
 * 长在最大的那个组件中间，改一行文案要在 3,400 行里翻。搬出来之后 `App` 只负责
 * 把"点下去要做什么"交进来，这里只负责"有哪些项、怎么归类、每项说清管什么"。
 *
 * 一条纪律：**这里不建第二套编辑器**（AGENTS「设置要长在它服务的动作旁边」那条的延伸）。
 * 每一行的 `action` 都指回原来那个入口 —— 同一个实现、两个入口；两处都能改，迟早两处不一样。
 * 也只列"这里点得动"的项：阅读排版、朗读引擎这些的编辑面在阅读器里，
 * 摆到这一页来只能放一颗点了没反应的按钮。
 */
export type SettingsActions = {
  openShortcuts: () => void
  openOfflineCache: () => void
  openCustomize: () => void
  openReplaceRules: () => void
  openTocRules: () => void
  openBackup: () => void
  openLogs: () => void
  openServerPort: () => void
  /** 应用名称与图标（本机安装根的品牌；与端口同一族） */
  openBrand: () => void
  /** AI 接入 —— 独立一类 */
  openAiConnections: () => void
  /**
   * 「壁纸」分区的控件本体。只在宿主真的接了这一项时才生成那一档 ——
   * 没接的时候设置页不该多出一个空标题（判据喂假动作时也不会多出空档）。
   */
  renderWallpaper?: () => ReactNode
  /**
   * 「Cookie」管理：打开全局凭据弹窗（与应用里其它 `AppModal` 浮层同一套外壳）。
   * 凭据按注册域共享，删书源不清桶，所以必须有这一处能看见全部、能逐个撤掉。
   */
  openCookies: () => void
}

export function buildSettingsSections(actions: SettingsActions): SettingsSection[] {
  return [
    {
      title: '阅读',
      rows: [
        {
          title: '快捷键',
          hint: '阅读器与全局的按键表；读书时按 `?` 出的也是这张。',
          action: '看按键表',
          onClick: actions.openShortcuts,
        },
        {
          title: '离线缓存',
          hint: '下载到这台电脑浏览器里的正文：哪几本、多少章、占多大，能整本清掉。',
          action: '管理离线缓存',
          onClick: actions.openOfflineCache,
        },
      ],
    },
    {
      title: '界面',
      rows: [{
        title: '皮肤与配色',
        hint: '晓白 / 护眼 / 夜读三档，外加一份只存在本机浏览器的自定义 CSS。',
        action: '打开自定义',
        onClick: actions.openCustomize,
      }],
    },
    // 「壁纸」不是一行按钮：开关、选图、地址、滑杆、填充方式都在这一档里直接改，
    // 改动即时生效并自动保存（实现见 settings/WallpaperSection.tsx）。
    ...(actions.renderWallpaper ? [{
      title: '壁纸',
      rows: [],
      content: actions.renderWallpaper,
    }] : []),
    // 「Cookie」是一行入口：点开走全局弹窗，列表/搜索/批量删除/编辑都在弹窗里。
    {
      title: 'Cookie',
      rows: [{
        title: 'Cookie 管理',
        hint: '查看、搜索、批量删除与编辑已保存的登录凭据；凭据按域名共享，删书源不会连带清掉。',
        action: '打开',
        onClick: actions.openCookies,
      }],
    },
    {
      title: '规则',
      rows: [{
        title: '替换净化规则',
        hint: '正文与书名按正则删广告与杂乱内容；读书时在阅读器的设置抽屉里也能直接开。',
        action: '打开规则',
        onClick: actions.openReplaceRules,
      }],
    },
    {
      title: '本地书',
      rows: [{
        title: 'TXT 分章规则',
        hint: '下一本导入的 TXT 按哪条切目录，以及哪几条参与「自动」打分；书架上导书时那颗是同一张表。',
        action: '打开规则表',
        onClick: actions.openTocRules,
      }],
    },
    {
      title: '数据',
      rows: [{
        title: '备份包',
        hint: '导入手机 legadoQ 的备份包，或把这台机器上的书源 / 书架 / 规则导成一份。',
        action: '打开备份',
        onClick: actions.openBackup,
      }],
    },
    {
      title: '诊断',
      rows: [{
        title: '运行日志',
        hint: '这台服务写了什么：级别、失败原因、同类重复的计数，可以导出。',
        action: '看日志',
        onClick: actions.openLogs,
      }],
    },
    {
      title: '服务',
      rows: [
        {
          title: '服务端口',
          hint: 'legadoQ 跑在哪个端口；改完要重启 legadoQ 才生效。',
          action: '改端口',
          onClick: actions.openServerPort,
        },
        {
          // 与端口同一族：改的都是「这台机器上的 legadoQ 长什么样」，都写安装根、都本机生效。
          title: '应用名称与图标',
          hint: '把这台服务的名字与图标改成自己的（写安装根的 brand.json）；本机所有浏览器与装出去的桌面应用都跟着变。',
          action: '去改',
          onClick: actions.openBrand,
        },
      ],
    },
    {
      // AI 接入是独立一类：程序内部的 AI 网关，不是实验室条目。
      title: '接入与扩展',
      rows: [
        {
          title: 'AI 接入',
          hint: '程序内部的 AI 网关（/api/agent）。登记一个 openai-compatible 模型后才能对话；'
            + '没有连接时 AI 不可用，不做本地兜底。',
          action: '打开 AI 接入',
          onClick: actions.openAiConnections,
        },
      ],
    },
  ]
}

/**
 * 页内搜索：按"标题 + 那句说明"筛，命中的行留着、整档没命中就收起。
 *
 * 抽成纯函数是为了能被直接喂数据测 —— 这一页只有渲染，判据在组件上能做的很有限。
 */
export function filterSettingsSections(sections: SettingsSection[], query: string): SettingsSection[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return sections
  // 不设长度阈值：搜索就该按"输入什么、匹配什么"来。曾经在这里加过一条
  // 「超过 5 个字不算命中」，理由是要避开一行根本不存在的「登录」入口 ——
  // 结果是「替换净化规则」「TXT 分章规则」这类 6 字以上的真词一律搜不到。
  return sections
    .map(section => ({
      ...section,
      rows: section.rows.filter(row => `${row.title} ${row.hint}`.toLowerCase().includes(needle)),
    }))
    .filter(section => section.rows.length > 0)
}
