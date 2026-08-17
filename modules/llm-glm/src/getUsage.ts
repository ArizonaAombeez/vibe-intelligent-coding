import type { PluginUsage, UsageWindow } from './PluginUsage.js'

// Undocumented endpoint (no official z.ai API docs cover it) reverse
// engineered from the opencode-glm-quota plugin
// (github.com/guyinwonder168/opencode-glm-quota) — the same one ZCode's
// own CLI usage display reads from. Can change without notice; a failure
// here should degrade to "usage unavailable", never break the chat path.
// Only meaningful for Coding Plan keys — the pay-as-you-go product is
// metered credit, not a quota window, and has no equivalent endpoint.
const QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'

// Window-type discriminators as used by the quota endpoint's `limits[]`
// entries. A token-window limit is identified by (unit, number): (3, 5)
// for the 5-hour window, (6, 1) for the weekly window — 'unit' is a
// granularity code (hours=3, weeks=6) and 'number' is the count in that
// unit, not a limit type string.
const TOKEN_LIMIT_TYPE = 'TOKENS_LIMIT'
const FIVE_HOUR_UNIT = 3
const FIVE_HOUR_NUMBER = 5
const WEEKLY_UNIT = 6
const WEEKLY_NUMBER = 1

interface QuotaLimit {
  type?: string
  unit?: number
  number?: number
  percentage?: number
  nextResetTime?: number
}

interface QuotaLimitResponse {
  data?: {
    limits?: QuotaLimit[]
  }
}

export class GlmUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlmUsageError'
  }
}

function isFiveHourWindow(limit: QuotaLimit): boolean {
  return limit.type === TOKEN_LIMIT_TYPE && limit.unit === FIVE_HOUR_UNIT && limit.number === FIVE_HOUR_NUMBER
}

function isWeeklyWindow(limit: QuotaLimit): boolean {
  return limit.type === TOKEN_LIMIT_TYPE && limit.unit === WEEKLY_UNIT && limit.number === WEEKLY_NUMBER
}

function toUsageWindow(limit: QuotaLimit | undefined): UsageWindow | undefined {
  if (!limit || typeof limit.percentage !== 'number') return undefined
  return {
    percentUsed: limit.percentage,
    resetsAt: typeof limit.nextResetTime === 'number' ? new Date(limit.nextResetTime).toISOString() : undefined,
  }
}

// Fetches the current GLM Coding Plan quota usage (5-hour and weekly token
// windows). Requires a Coding Plan API key — the request auth header is
// the raw key with no "Bearer" prefix, unlike the chat/completions API.
// Takes the same `values` bag createClient() does, so the server registry
// can call this generically without a plugin-specific adapter.
export async function getUsage(values: Record<string, string> = {}): Promise<PluginUsage> {
  const apiKey = values.apiKey || process.env.GLM_API_KEY
  if (!apiKey) {
    throw new GlmUsageError('vic-llm-glm: no apiKey configured')
  }

  let response: Response
  try {
    response = await fetch(QUOTA_URL, {
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
    })
  } catch (err) {
    throw new GlmUsageError(`Failed to reach ${QUOTA_URL}: ${(err as Error).message}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new GlmUsageError(
      `GLM usage request failed with status ${response.status}: ${body || response.statusText}`,
    )
  }

  const data = (await response.json()) as QuotaLimitResponse
  const limits = data.data?.limits ?? []
  return {
    currentWindow: toUsageWindow(limits.find(isFiveHourWindow)),
    weekly: toUsageWindow(limits.find(isWeeklyWindow)),
  }
}
