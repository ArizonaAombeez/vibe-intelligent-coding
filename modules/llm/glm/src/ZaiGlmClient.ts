import type { ChatOptions, ChatResult, GlmClient, LlmMessage } from './GlmClient.js'
import { glmModelCapabilities } from './settingsManifest.js'

// z.ai bills the pay-as-you-go API and the Coding Plan subscription
// separately, via different base URLs, even though a Coding Plan key looks
// like a normal API key and the request/response shape is identical. Using
// the wrong base URL for your key/plan produces a 401 or 429 even with a
// valid, funded account — see settingsManifest.ts's accessMethod field.
const PAYG_BASE_URL = 'https://api.z.ai/api/paas/v4'
const CODING_PLAN_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
const DEFAULT_MODEL = 'glm-5.2'

// Statuses worth retrying: these mean the request never reached a real
// answer from the model (edge/origin timeout or the origin temporarily
// down), not that the request itself was bad — retrying a 4xx would just
// fail the same way again. 524 in particular is Cloudflare's edge giving
// up on z.ai's own origin server, which is often transient load rather
// than a real outage.
const RETRYABLE_STATUSES = new Set([502, 503, 524])
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type GlmAccessMethod = 'payg' | 'coding-plan'

// Single source of truth for accessMethod -> base URL, so callers outside
// this client (e.g. the server's Coding-stage agent-client resolver, which
// needs GLM's base URL to hand to the aider CLI rather than to this chat
// client) don't duplicate the PAYG_BASE_URL/CODING_PLAN_BASE_URL mapping.
// Defaults to the Coding Plan endpoint for the same reason the constructor
// below does — see ZaiGlmClientOptions.accessMethod.
export function resolveGlmBaseUrl(accessMethod?: GlmAccessMethod): string {
  return accessMethod === 'payg' ? PAYG_BASE_URL : CODING_PLAN_BASE_URL
}

export interface ZaiGlmClientOptions {
  apiKey?: string
  model?: string
  // Explicit base URL always wins. Otherwise resolved from accessMethod.
  baseUrl?: string
  // Which z.ai product this key belongs to — defaults to 'coding-plan'
  // since that's the flat-rate subscription most users have and pay-as-you-go
  // silently fails with a balance error rather than an obviously-wrong-endpoint
  // error, making 'coding-plan' the safer default to assume.
  accessMethod?: GlmAccessMethod
}

interface ZaiChatCompletionResponse {
  choices: Array<{ message: { content: string } }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export class GlmApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'GlmApiError'
  }
}

export class ZaiGlmClient implements GlmClient {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string

  constructor(options: ZaiGlmClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GLM_API_KEY
    if (!apiKey) {
      throw new Error(
        'GLM_API_KEY is not set. Provide it via the GLM_API_KEY environment variable or the apiKey constructor option.',
      )
    }
    this.apiKey = apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.baseUrl = options.baseUrl ?? resolveGlmBaseUrl(options.accessMethod)
  }

  async chat(messages: LlmMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    let attempt = 0
    const model = options.model ?? this.model
    const capabilities = glmModelCapabilities(model)
    // Only send reasoning_effort when the caller supplied a value AND the
    // resolved model actually documents support for it — see
    // settingsManifest.ts's GLM_MODEL_CAPABILITIES. Sending it to a model
    // that doesn't document the parameter (e.g. GLM-4.7) risks it being
    // silently ignored or rejected; omitting it entirely leaves z.ai's own
    // per-model default in effect instead.
    const reasoningEffort =
      options.reasoningEffort && capabilities.reasoningEffortValues?.includes(options.reasoningEffort)
        ? options.reasoningEffort
        : undefined
    // Same rationale for thinking: GLM-5.3 cannot disable thinking at all
    // (capabilities.canDisableThinking is false for it) — sending
    // thinking:{type:'disabled'} there has no effect per z.ai's own docs, so
    // it's simply not sent rather than sent uselessly.
    const thinking = options.thinking && (options.thinking === 'enabled' || capabilities.canDisableThinking) ? options.thinking : undefined

    for (;;) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(thinking !== undefined ? { thinking: { type: thinking } } : {}),
          ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
        }),
      })

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          attempt += 1
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
          continue
        }
        const body = await response.text().catch(() => '')
        throw new GlmApiError(
          `GLM API request failed with status ${response.status}: ${body || response.statusText}`,
          response.status,
        )
      }

      const data = (await response.json()) as ZaiChatCompletionResponse
      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new GlmApiError('GLM API response did not contain a message content string')
      }
      return {
        content,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
      }
    }
  }
}
