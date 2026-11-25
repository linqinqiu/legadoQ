import { request } from '../client'

export const FEEDBACK_CATEGORIES = ['bug', 'feature', 'general', 'question'] as const
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number]

export type FeedbackItem = {
  id: number | string
  created_at: string
  category: FeedbackCategory
  content: string
}

export type FeedbackInput = {
  category: FeedbackCategory
  content: string
  contact?: string
  tokenHash: string
}

export const feedback = {
  submit: (input: FeedbackInput) =>
    request<{ ok: true }>('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({
        category: input.category,
        content: input.content,
        contact: input.contact,
        tokenHash: input.tokenHash,
      }),
    }, { timeoutMs: 15_000 }),

  mine: (tokenHash: string) =>
    request<FeedbackItem[]>('/api/feedback/mine', {
      headers: { 'x-feedback-token': tokenHash },
    }, { timeoutMs: 15_000 }),
}
