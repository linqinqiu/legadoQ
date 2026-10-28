// 顶层导航的共享类型（0.8.2 结构重排从 main.tsx 挪出）

export type Page = 'sources' | 'subscriptions' | 'library' | 'shelf' | 'explore' | 'reader' | 'settings'
/** 不占导航栏、也不占整页的目的地。0.8.3 起只剩「替换净化规则」。 */
export type PageDialogKind = 'rules'
/**
 * 同一时刻只开一个的单例弹窗。加新弹窗往这里加一个字面量，不必再加一个 useState。
 *
 * 这里是**成熟功能**的浮层：低频、已定型、不属于任何一级导航。
 * （从前另有一层「实验室」放待定功能，那套 `lab/` 已整体移除 —— 别再往回加。）
 */
export type AppModal =
  | 'offline-cache'
  | 'logs'
  | 'shortcuts'
  | 'customize'
  | 'server-port'
  /** 应用名称与图标：改的都是本机安装根，与端口同一族 */
  | 'brand'
  /** 更新日志：一版看一次的低频信息页 */
  | 'changelog'
  /** 备份与恢复：换机器/重装才用 */
  | 'backup'
  /** 关于：版本、许可、免责声明 */
  | 'about'
  /** 功能说明：一整份使用文档，从「关于」进，自己占一层 */
  | 'guide'
  /** 阅读记录：这周读了多少 */
  | 'reading-log'
  /** 书源体检：批量检查书源还能不能用 */
  | 'source-health'
  /** AI 接入：程序内部的 AI 网关（**独立一类**，不是实验室） */
  | 'ai'
  /** 全局登录凭据：按域查看 / 批量删除 / 编辑 */
  | 'cookies'
