import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Logo } from './Logo'
import { registerServiceWorkerOnce } from '../lib/swRegistration'

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt(): Promise<void>
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent
    appinstalled: Event
  }
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null
const installPromptListeners = new Set<(canInstall: boolean) => void>()

export function isPwaStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true ||
    document.referrer.includes('android-app://')
  )
}

export function subscribePwaInstall(callback: (canInstall: boolean) => void): () => void {
  installPromptListeners.add(callback)
  callback(deferredInstallPrompt !== null && !isPwaStandalone())
  return () => installPromptListeners.delete(callback)
}

export async function promptPwaInstall(): Promise<boolean> {
  if (!deferredInstallPrompt) return false
  try {
    await deferredInstallPrompt.prompt()
    const choice = await deferredInstallPrompt.userChoice
    deferredInstallPrompt = null
    installPromptListeners.forEach(cb => cb(false))
    return choice.outcome === 'accepted'
  } catch {
    return false
  }
}

export function PwaManager() {
  const [canInstall, setCanInstall] = useState(false)
  const [dismissedBanner, setDismissedBanner] = useState(() => {
    try {
      return localStorage.getItem('legado_pwa_banner_dismissed') === 'true'
    } catch {
      return false
    }
  })
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)

  useEffect(() => {
    let cancelled = false
    let onControllerChange: (() => void) | null = null

    // 1. Listen for install prompt
    const handleBeforeInstallPrompt = (e: BeforeInstallPromptEvent) => {
      e.preventDefault()
      deferredInstallPrompt = e
      setCanInstall(true)
      installPromptListeners.forEach(cb => cb(true))
    }

    const handleAppInstalled = () => {
      deferredInstallPrompt = null
      setCanInstall(false)
      installPromptListeners.forEach(cb => cb(false))
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    // 2. Service Worker registration and update detection
    let checkForUpdate: (() => void) | null = null
    let updateTimer = 0
    if ('serviceWorker' in navigator && process.env.NODE_ENV !== 'test') {
      registerServiceWorkerOnce((url, options) => navigator.serviceWorker.register(url, options)).then(reg => {
        if (cancelled) return
        registrationRef.current = reg

        // 浏览器默认只在导航时检查更新，这里补一次立即检查
        void reg.update().catch(() => undefined)
      }).catch(() => {
        // SW register failed or disabled
      })

      // 页面长期打开 / 从后台切回时主动检查更新，避免「服务端已更新但页面仍是旧版」
      checkForUpdate = () => { void registrationRef.current?.update().catch(() => undefined) }
      window.addEventListener('focus', checkForUpdate)
      document.addEventListener('visibilitychange', checkForUpdate)
      updateTimer = window.setInterval(checkForUpdate, 5 * 60 * 1000)

      let refreshing = false
      // `registerType: 'autoUpdate'` 生成的 SW 会 skipWaiting + clientsClaim，
      // 所以更新是"新 SW 直接接管"，没有 waiting 态、也没有"点一下才更新"的提示：
      // 接管后等页面空闲（不在输入、不在搜索）再刷新一次。
      // 于是**第一次访问**（页面本来没有 controller）装好 SW 的那一刻也会报 controllerchange。
      // 原来这里无条件 reload，表现是"用户刚点搜索/正在翻页，页面自己刷了一下"：
      // 搜索请求被丢掉，界面上什么都没发生（书库指定书源搜索打不开就是这个），
      // 门禁侧则表现为随机的 Execution context was destroyed。
      // 只有"本来就被旧 SW 控制着、又被新 SW 接管"才是真更新，才需要刷新。
      let hadController = !!navigator.serviceWorker.controller
      const busy = () => {
        const el = document.activeElement
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return true
        // 搜索进行中：那条「停止搜索」按钮就是唯一的在飞标志
        return [...document.querySelectorAll('button')].some(node => (node.textContent ?? '').trim() === '停止搜索')
      }
      const reloadWhenIdle = () => {
        if (refreshing) return
        if (busy()) {
          window.setTimeout(reloadWhenIdle, 1500)
          return
        }
        refreshing = true
        window.location.reload()
      }
      onControllerChange = () => {
        if (!hadController) {
          hadController = !!navigator.serviceWorker.controller
          return
        }
        reloadWhenIdle()
      }
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    }

    return () => {
      cancelled = true
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
      if (checkForUpdate) {
        window.removeEventListener('focus', checkForUpdate)
        document.removeEventListener('visibilitychange', checkForUpdate)
      }
      if (updateTimer) window.clearInterval(updateTimer)
      if (onControllerChange) navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  const handleInstallClick = async () => {
    const accepted = await promptPwaInstall()
    if (accepted) {
      setCanInstall(false)
    }
  }

  const handleDismissBanner = () => {
    setDismissedBanner(true)
    try {
      localStorage.setItem('legado_pwa_banner_dismissed', 'true')
    } catch {
      // ignore
    }
  }

  const showBanner = canInstall && !dismissedBanner && !isPwaStandalone()

  return (
    <>
      {/* PWA Install Bottom Banner */}
      {showBanner && (
        <div className="pwa-install-banner" role="region" aria-label="安装应用提示">
          <div className="pwa-banner-left">
            <div>
              <Logo size={28} />
            </div>
            <div className="pwa-banner-info">
              <strong>安装到桌面</strong>
              <p>独立窗口打开，不占浏览器标签栏；应用本体离线也能打开（书要读哪本仍需联网）</p>
            </div>
          </div>
          <div className="pwa-banner-actions">
            <button type="button" className="primary-button pwa-install-btn" onClick={() => void handleInstallClick()}>
              <Icon name="download" />
              <span>立即安装</span>
            </button>
            <button type="button" className="subtle-button pwa-dismiss-btn" onClick={handleDismissBanner} aria-label="稍后提醒">
              <Icon name="close" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
