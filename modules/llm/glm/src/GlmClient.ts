export type LlmRole = 'system' | 'user' | 'assistant'

export interface LlmMessage {
  role: LlmRole
  content: string
}

export type ThinkingMode = 'enabled' | 'disabled'

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  // Overrides the client's configured model for this call only.
  model?: string
  // z.ai's "thinking" switch is on/off only — no graduated effort levels.
  thinking?: ThinkingMode
  // z.ai's separate reasoning_effort knob (sent via extra_body — not part
  // of the standard OpenAI-compatible request shape), only meaningful when
  // thinking is (or must be) on. Only documented for GLM-5.2 (high/max) and
  // GLM-5.3 (low/high/max) — see settingsManifest.ts's
  // GLM_MODEL_CAPABILITIES/glmModelCapabilities for which values a given
  // model actually accepts. A plain string, not a union, since the valid
  // set is genuinely per-model rather than fixed.
  reasoningEffort?: string
}

// z.ai's OpenAI-compatible usage block, echoed back to the caller so the
// application layer can accumulate a running session total. Optional
// because it's provider-reported — a client implementation without usage
// data (e.g. a future provider, or a test double) can omit it.
export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatResult {
  content: string
  usage?: ChatUsage
}

export interface GlmClient {
  chat(messages: LlmMessage[], options?: ChatOptions): Promise<ChatResult>
}
