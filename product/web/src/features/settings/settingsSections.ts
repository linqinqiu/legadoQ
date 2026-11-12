/**
 * 内置设置分区的形状。定义在**这一侧**而不是页面那侧：
 * 这张表才是分区数据的权威源，`SettingsPage` 只是画它 —— 类型长在消费者身上，
 * 表就得反过来 import 页面（而本仓库的依赖方向纪律是「内容 → 框架」单向）。
 * 页面保留同名重导出，`pages.tsx` 等既有引用不受影响。
 */
export type SettingsRow = {
  title: string
  hint: string
  action: string
  onClick: () => void
}

/**
 * 一档设置只有一张行表。控件不内联在这一页：点开那一行回到原来的编辑器，
 * 实现仍然只有一份（`features/reader/settingsPanel/SkinModal.tsx`、`features/settings/WallpaperModal.tsx` 等）。
 */
export type SettingsSection = { title: string; rows: SettingsRow[] }

/**
 * 「设置」这一页的分区表（PROPOSAL-021 P0.3）。
 *
 * 它从 `main.tsx` 里搬出来，是因为这张表原来内联在 `App` 组件里：一份要给人读的清单
 * 长在最大的那个组件中间，改一行文案要在 3,400 行里翻。搬出来之后 `App` 只负责
 * 把"点下去要做什么"交进来，这里只负责"有哪些项、怎么归类、每项说清管什么"。
 *
 * 2026-10-28 收成四档：原来九档里有五档只有一行，「替换净化规则」和「TXT 分章规则」
 * 还被分成「规则 / 本地书」两处。分组过碎时用户扫不到"这一类还有什么"，两栏版式也
 * 一半格子空着。四条标题按"管什么"分：阅读（读的时候用）、外观（长什么样）、
 * 数据与凭据（存了什么）、服务与接入（这台机器怎么跑）。
 *
 * 2026-11-12 拆出第五档「AI」：用户原话"ai是ai，服务是服务，不能混放在服务与接入一起"。
 * 判断依据是这一档**管什么**：AI 管"谁替我读/查/改"，服务与接入管"这台机器怎么跑"。
 * 顺带纠正一处命名——「AI 书源校验」既不调模型也不管服务，它是书源数据的合法性检查，
 * 改叫「书源 JSON 校验」并归「数据与凭据」。
 *
 * 一条纪律：**这里不建第二套编辑器**（AGENTS「设置要长在它服务的动作旁边」那条的延伸）。
 * 每一行的 `action` 都指回原来那个入口 —— 同一个实现、两个入口；两处都能改，迟早两处不一样。
 * 也只列"这里点得动"的项：阅读排版、朗读引擎这些的编辑面在阅读器里，
 * 摆到这一页来只能放一颗点了没反应的按钮。
 */
export type SettingsActions = {
  openShortcuts: () => void
  openOfflineCache: () => void
  /** 皮肤：内置七套与自定义皮肤库 */
  openSkins: () => void
  /** 壁纸：整站背景图与阅读区跟随 */
  openWallpaper: () => void
  openReplaceRules: () => void
  openTocRules: () => void
  openBackup: () => void
  openLogs: () => void
  openServerPort: () => void
  /** 应用名称与图标（本机安装根的品牌；与端口同一族） */
  openBrand: () => void
  /** AI 对话助手：说话的地方（配置都收在下面几档） */
  openAiChat: () => void
  /** AI · 模型连接：登记外部模型、设为默认、实测可达 */
  openAiConnections: () => void
  /** AI · 工具：勾选模型能调用哪一组能力 */
  openAiTools: () => void
  /** AI · 外部工具：接本机跑的 MCP 服务，把它的工具变成 AI 的能力 */
  openAiMcp: () => void
  /** AI · 技能：命中关键词才注入的方法说明 */
  openAiSkills: () => void
  /** AI · 提示词：每次对话都生效的"怎么说话" */
  openAiPrompts: () => void
  /** AI · 书源校验：只读检查一份书源 JSON 的结构 */
  openAiSourceCheck: () => void
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
          hint: '阅读器与全局的按键表；读书时按 `?` 看的也是这张。',
          action: '看按键表',
          onClick: actions.openShortcuts,
        },
        {
          title: '离线缓存',
          hint: '下载到这台电脑浏览器里的正文，可以整本清掉。',
          action: '管理缓存',
          onClick: actions.openOfflineCache,
        },
        {
          title: '替换净化规则',
          hint: '正文与书名按正则删广告；阅读器的设置抽屉里也能开。',
          action: '打开规则',
          onClick: actions.openReplaceRules,
        },
        {
          title: 'TXT 分章规则',
          hint: '导入 TXT 时按哪条切目录，书架上导书用的是同一张表。',
          action: '打开规则表',
          onClick: actions.openTocRules,
        },
      ],
    },
    {
      title: '外观',
      rows: [
        {
          title: '皮肤',
          hint: '预设配色可以改名、换样式、隐藏或恢复，也可以新建自己的皮肤。开了封面/壁纸取色时配色由图片自动算，皮肤是没开时的兜底。',
          action: '管理皮肤',
          onClick: actions.openSkins,
        },
        {
          title: '壁纸',
          hint: '整站背景图与阅读区跟随；图片只存本机浏览器，不进备份包。',
          action: '管理壁纸',
          onClick: actions.openWallpaper,
        },
        {
          // 与端口同一族：改的都是「这台机器上的 legadoQ 长什么样」；归到「外观」是因为
          // 用户要改的就是名字和图标，不必先理解 brand.json 是哪一层文件。
          title: '应用名称与图标',
          hint: '把这台服务的名字与图标改成自己的，写安装根的 brand.json。',
          action: '去改',
          onClick: actions.openBrand,
        },
      ],
    },
    {
      title: '数据与凭据',
      rows: [
        {
          title: 'Cookie 管理',
          hint: '查看、搜索、批量删除登录凭据；按域名共享，删书源不会清掉。',
          action: '管理 Cookie',
          onClick: actions.openCookies,
        },
        {
          title: '备份包',
          hint: '导入手机 legadoQ 的备份包，或把书源、书架与规则导出成备份包。',
          action: '打开备份',
          onClick: actions.openBackup,
        },
        {
          // 2026-11-12：这一项原先挂在「服务与接入」的 AI 堆里叫「AI 书源校验」——
          // 它既不是 AI 能力（不调模型、不花钱），也不属于"服务怎么跑"。
          // 它是**书源数据的合法性检查**，归「数据与凭据」才名实相符。
          title: '书源 JSON 校验',
          hint: '粘贴一份书源 JSON 看结构合不合法，只检查、不写入。',
          action: '去校验',
          onClick: actions.openAiSourceCheck,
        },
      ],
    },
    {
      // AI 是自己的一个分区：它管的既不是"数据存了什么"，也不是"这台服务怎么跑"。
      // 混在「服务与接入」里时，用户找一个端口要越过六个 AI 入口，找一个 AI 入口要先读端口。
      title: 'AI',
      rows: [
        {
          title: '对话助手',
          hint: '跟模型说话；它会自己调用下面几项里开启的工具去查、去改。',
          action: '开始对话',
          onClick: actions.openAiChat,
        },
        {
          title: '模型连接',
          hint: '登记可用的模型、设为默认，并实测此刻通不通。',
          action: '管理连接',
          onClick: actions.openAiConnections,
        },
        {
          title: '工具开关',
          hint: '勾选模型能调用哪几组能力；关掉的组它连看都看不到。',
          action: '选择工具',
          onClick: actions.openAiTools,
        },
        {
          title: '外部工具（MCP）',
          hint: '接上本机跑的 MCP 服务，它的工具就会进「工具开关」的「外部工具」一档。',
          action: '管理 MCP',
          onClick: actions.openAiMcp,
        },
        {
          title: '技能',
          hint: '「这类任务怎么做」的方法说明，命中关键词才注入，一次最多 3 条。',
          action: '管理技能',
          onClick: actions.openAiSkills,
        },
        {
          title: '提示词',
          hint: '「怎么说话」的要求，启用的每次对话都带上，可排序可停用。',
          action: '管理提示词',
          onClick: actions.openAiPrompts,
        },
      ],
    },
    {
      title: '服务与接入',
      rows: [
        {
          title: '服务端口',
          hint: 'legadoQ 跑在哪个端口；改完要重启才生效。',
          action: '改端口',
          onClick: actions.openServerPort,
        },
        {
          title: '运行日志',
          hint: '这台服务写了什么：级别、失败原因，可以导出。',
          action: '看日志',
          onClick: actions.openLogs,
        },
      ],
    },
  ]
}

/**
 * 页内搜索：按"标题 + 那句说明"筛，命中的行留着、整档没命中就收起。
 *
 * 命中**分组名**时整档都给出来：用户搜「外观」是想看这一类有什么，
 * 只回一行「皮肤」会让他以为只有这一项。行内命中仍然只留那一行 ——
 * 搜「端口」时不把「AI 接入」「运行日志」一起倒出来。
 *
 * 抽成纯函数是为了能被直接喂数据测 —— 这一页只有渲染，判据在组件上能做的很有限。
 */
export function filterSettingsSections(sections: SettingsSection[], query: string): SettingsSection[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return sections
  const matches = (text: string) => text.toLowerCase().includes(needle)
  return sections
    .map(section => ({
      ...section,
      rows: matches(section.title)
        ? section.rows
        : section.rows.filter(row => matches(`${row.title} ${row.hint}`)),
    }))
    .filter(section => section.rows.length > 0)
}
