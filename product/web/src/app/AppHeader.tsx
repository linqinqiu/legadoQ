import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '../icons'
import { PRIMARY_PAGES } from '../lib/pageMeta'
import type { Page } from '../lib/nav'
import { getBrand, subscribeBrand } from '../lib/brandStore'
import { Logo } from '../components/Logo'
import { promptPwaInstall, subscribePwaInstall } from '../components/PwaManager'
import { availableSkins, BUILTIN_SKINS, resolveTheme, type ReaderSettings } from '../features/reader/settingsPanel/readerSettings'

export interface AppHeaderProps {
  page: Page
  settings: ReaderSettings
  searching?: boolean
  onSettingsChange: (next: ReaderSettings) => void
  onNavigate: (page: Page) => void
  /** 顶栏那颗版本号芯片点开的「更新日志」页（菜单里不再重复列一条）。 */
  onOpenChangelog?: () => void
  /** 「我的」菜单里的「关于」：0.6.27 起是悬浮层，不再走整页导航。 */
  onOpenAbout?: () => void
  /** 「我的」菜单里的「阅读记录」：同样是悬浮层（PROPOSAL-019 D）。 */
  onOpenReadingLog?: () => void
  /** 「皮肤」分组的「管理」：打开皮肤浮层（内置配色 + 自定义皮肤库）。 */
  onOpenSkins?: () => void
  /** 服务端 /healthz 报回来的版本号；空串表示还没问到（离线或启动中）。 */
  version?: string
  /** 发版计数（`BUILD_NUMBER`）：只在发版时递增，日常改动看 `revision`。 */
  build?: string
  /**
   * 服务端 /healthz 报回来的代码修订（`rev-<提交数>`）。
   *
   * 未发版、只在本地改的时候，版本号是不动的 —— 光看 `0.2.35` 分不清"跑的是推上去那版
   * 还是我刚编的这版"。修订号由构建脚本从 `git rev-list --count HEAD` 写进包，界面直接显示。
   */
  revision?: string
  /** 修订号对应的短 sha：只进 tooltip，界面不占位。 */
  revisionSha?: string
}

/** 皮肤名单一来源在 readerSettings（顶栏菜单与「皮肤」浮层共用，各自定义一份迟早漂移）。 */
export const APP_THEMES = BUILTIN_SKINS

export function AppHeader({
  page,
  settings,
  searching,
  onSettingsChange,
  onNavigate,
  onOpenChangelog,
  onOpenAbout,
  onOpenReadingLog,
  onOpenSkins,
  version = '',
  build = '',
  revision = '',
  revisionSha = '',
}: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [canInstall, setCanInstall] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // 品牌名单一来源（lib/brandStore）：此前这里硬编码「legadoQ」，
  // 用户改了名（设置 → 应用名称与图标）之后顶栏照旧，等于"改了个寂寞"。
  const brand = useSyncExternalStore(subscribeBrand, getBrand, getBrand)
  // 选中态以**实际生效**的那套为准：内置皮肤被删掉或 theme 里存了脏值时，settings.theme
  // 和界面上亮着的那张卡会不是同一个。
  const activeTheme = resolveTheme(settings)

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleFullscreen = () => {
    setMenuOpen(false)
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void document.documentElement.requestFullscreen().catch(() => undefined)
  }

  useEffect(() => {
    return subscribePwaInstall(setCanInstall)
  }, [])

  const handlePwaInstall = async () => {
    setMenuOpen(false)
    await promptPwaInstall()
  }
  const menuContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [menuOpen])


  /** 顶栏这一项是不是"当前所在"。规则 / 备份 / 关于 / 更新日志 0.6.27 起改为悬浮层，不再参与导航高亮。 */
  const navActive = (navPage: string) => page === navPage

  /*
    窄屏（≤720px）六个入口一屏放不下：这一排是可横滑的，但滚动条被藏掉了，
    于是被裁掉的那半个字看起来就是"顶栏坏了"（390px 实测：「设置」只露出一个「设」）。
    所以做两件事 —— 选中项变化时把它滚进视野中心；真溢出时给右侧一道渐隐，提示"后面还有"。
    渐隐只在 scrollWidth 真的超过可视宽度时加，放得下的时候不该平白压掉最后一个字的边。
  */
  const navRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const active = nav.querySelector<HTMLElement>('button.active')
    active?.scrollIntoView({ block: 'nearest', inline: 'center' })
    const syncOverflow = () => {
      nav.classList.toggle('is-overflowing', nav.scrollWidth - nav.clientWidth > 1)
    }
    syncOverflow()
    window.addEventListener('resize', syncOverflow)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncOverflow)
    observer?.observe(nav)
    return () => {
      window.removeEventListener('resize', syncOverflow)
      observer?.disconnect()
    }
  }, [page])

  const handleThemeChange = (theme: ReaderSettings['theme']) => {
    onSettingsChange({ ...settings, theme })
  }

  return (
    <header className="app-page-header">
      <div className="app-brand-group">
        <button
          type="button"
          className="app-brand"
          onClick={() => onNavigate('library')}
          aria-label={brand.displayName}
        >
          <Logo size={22} />
          <strong>{brand.displayName}</strong>
        </button>
        {/*
          版本号常驻顶栏，且本身就是「更新日志」的入口。
          它此前只挂在「我的」下拉里 —— 不点菜单就读不到"这是哪一版"，
          于是这个功能对用户等于不存在（用户 2026-10-02：「更新日志和版本号还没有做呢」）。
          取不到版本时整档不渲染：顶栏上不留一个写着"未取到"的控件。
        */}
        {version && (
          <button
            type="button"
            className="brand-version"
            onClick={() => onOpenChangelog?.()}
            title={`当前版本 ${version}${revision ? `（${revision}）` : ''} · 看这一版改了什么`}
            aria-label={`当前版本 ${version}${revision ? `，修订 ${revision}` : ''}，打开更新日志`}
          >
            {version}
          </button>
        )}
      </div>

      <nav aria-label="主导航" ref={navRef}>
        {/*
          入口不再一个个手写：顶栏、数字键 1–6、Alt + ←/→ 的循环顺序全部取自
          shortcuts.ts 里的 PRIMARY_PAGES。手写一排 <button> 的代价已经付过一次：
          三份表各自漏过不同的页面。
          归属判据写在 shortcuts.ts 表头；规则 / 备份 收在「设置」页下，
          打开它们时这里高亮「设置」，用户才看得出"我还在设置这一层里"。
        */}
        {PRIMARY_PAGES.map(item => (
          <button
            key={item.page}
            type="button"
            className={navActive(item.page) ? 'active' : ''}
            aria-current={navActive(item.page) ? 'page' : undefined}
            onClick={() => onNavigate(item.page)}
          >
            {item.nav}
            {item.page === 'library' && searching && (
              <span
                className="nav-search-indicator"
                title="后台正在搜索…"
                aria-label="后台正在搜索"
              />
            )}
          </button>
        ))}
      </nav>


      <div className="header-actions" ref={menuContainerRef}>
        <button
          type="button"
          className={`header-menu-btn ${menuOpen ? 'active' : ''}`}
          aria-label={menuOpen ? '关闭我的菜单' : '打开我的菜单'}
          aria-expanded={menuOpen}
          aria-haspopup="true"
          onClick={() => setMenuOpen(prev => !prev)}
        >
          <Icon name="menu" />
        </button>

        {menuOpen && (
          <>
            <div
              className="overlay-backdrop is-menu"
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />
            <div className="header-menu-dropdown" role="menu" aria-label="功能菜单">
              {/*
                  「已登录服务」是认证那套删掉之后留下的谎话：这台服务不设身份，没有登录这回事。
                  换成真正有用的两件事：这是哪个版本、连的是哪台。
                */}
              <div className="menu-header">
                <div className="menu-status-badge">
                  <span className="menu-status-dot" />
                  <span className="menu-header-title">本机服务在线</span>
                </div>
                <div className="menu-version">
                  <span>版本</span>
                  <code>{version || '未取到'}</code>
                </div>
                {build && (
                  <div className="menu-version">
                    <span>构建</span>
                    <code title="构建号只在发版时递增；日常改动看下面的修订号">{build}</code>
                  </div>
                )}
                {revision && (
                  <div className="menu-version">
                    <span>修订</span>
                    <code title={revisionSha ? `提交 ${revisionSha}` : undefined}>{revision}</code>
                  </div>
                )}
              </div>

              <div className="menu-section">
                <div className="menu-section-label">
                  皮肤
                  {onOpenSkins && (
                    <button
                      type="button"
                      className="menu-section-action"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onOpenSkins()
                      }}
                    >
                      管理
                    </button>
                  )}
                </div>
                {/* 列表来自 availableSkins：没被删掉的内置七套 + 皮肤库里填过 CSS 的那些（同源，不会两处不一样） */}
                <div className="menu-theme-grid" role="radiogroup" aria-label="皮肤选择">
                  {availableSkins(settings).map(skin => {
                    const isSelected = activeTheme === skin.id
                    return (
                      <button
                        key={skin.id}
                        type="button"
                        className={`menu-theme-btn ${isSelected ? 'selected' : ''}`}
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => handleThemeChange(skin.id)}
                      >
                        <span className={`theme-swatch theme-swatch-${skin.builtin ? skin.id : 'custom'}`} />
                        <span className="theme-name">{skin.name}</span>
                        {isSelected && <Icon name="check" className="theme-check-icon" />}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="menu-divider" />

              <div className="menu-section">
                {canInstall && (
                  <button
                    type="button"
                    className="menu-logout-btn"
                    style={{ color: 'var(--ink)' }}
                    role="menuitem"
                    onClick={() => void handlePwaInstall()}
                  >
                    <Icon name="download" />
                    <span>安装到桌面</span>
                  </button>
                )}
                {/*
                  「本地离线缓存管理」「替换净化规则」「运行日志」「备份包」这四条收进「设置」
                  （用户 2026-10-03：「在我的里面新加一个设置，把一些 txt 目录规则、备份、替换净化
                  之类的放进去」+「顶栏『我的』菜单堆太多」；2026-10-04 又把「设置」提到顶栏一级）。
                  这一栏只剩 阅读记录 / 关于（+ 装了 PWA 时才出现的"安装到桌面"）：凡是一级目的地都走顶栏，
                  菜单只放"不算一个页面"的动作。书签功能已在 0.6.12 整体删掉。
                */}
                <button
                  type="button"
                  className="menu-logout-btn"
                  style={{ color: 'var(--ink)' }}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onOpenReadingLog?.()
                  }}
                >
                  <Icon name="clock" />
                  <span>阅读记录</span>
                </button>
                <button
                  type="button"
                  className="menu-logout-btn"
                  style={{ color: 'var(--ink)' }}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onOpenAbout?.()
                  }}
                >
                  <Icon name="info" />
                  <span>关于</span>
                </button>
                <button
                  type="button"
                  className="menu-logout-btn"
                  style={{ color: 'var(--ink)' }}
                  role="menuitem"
                  aria-pressed={isFullscreen}
                  onClick={toggleFullscreen}
                >
                  <Icon name="expand" />
                  <span>{isFullscreen ? '退出全屏' : '全屏显示'}</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </header>
  )
}
