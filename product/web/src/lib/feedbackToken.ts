const TOKEN_KEY = 'legado-feedback-token-v1'
const COOLDOWN_KEY = 'legado-feedback-cooldown-v1'
const COOLDOWN_MS = 30_000

type FeedbackStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): FeedbackStorage {
  return window.localStorage
}

export async function getFeedbackTokenHash(storage: FeedbackStorage = browserStorage()): Promise<string> {
  let token = storage.getItem(TOKEN_KEY)
  if (!token) {
    token = crypto.randomUUID()
    storage.setItem(TOKEN_KEY, token)
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function feedbackCooldownRemaining(storage: FeedbackStorage = browserStorage(), now = Date.now()): number {
  try {
    return Math.max(0, Number(storage.getItem(COOLDOWN_KEY) ?? 0) - now)
  } catch {
    return 0
  }
}

export function markFeedbackCooldown(storage: FeedbackStorage = browserStorage(), now = Date.now()): number {
  const until = now + COOLDOWN_MS
  try {
    storage.setItem(COOLDOWN_KEY, String(until))
  } catch {
    // 隐私模式禁止持久化时仍限制当前页面的重复提交。
  }
  return until
}
