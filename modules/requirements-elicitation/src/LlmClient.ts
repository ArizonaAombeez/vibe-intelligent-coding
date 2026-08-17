// This module's own minimal LLM dependency, declared independently so
// requirements-elicitation has zero import dependency on vic-llm-glm (or
// any other LLM provider). Structurally identical to vic-llm-glm's
// GlmClient — that module's ZaiGlmClient satisfies this interface without
// either module importing the other. Wiring a concrete implementation in
// happens only at the application layer.

export type LlmRole = 'system' | 'user' | 'assistant'

export interface LlmMessage {
  role: LlmRole
  content: string
}

// Generic per-call overrides this module can pass through without knowing
// which provider is wired in — e.g. GLM's model/thinking choice. This
// module never interprets these values, just forwards whatever the
// application layer supplied (e.g. a persona-level override) to the
// concrete LlmClient implementation.
export type LlmCallOptions = Record<string, string | undefined>

// Optional provider-reported usage, mirrored from vic-llm-glm's ChatUsage
// without importing that module (kept a structural, not nominal, match so
// this module still has zero dependency on any concrete provider).
export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LlmChatResult {
  content: string
  usage?: LlmUsage
}

export interface LlmClient {
  chat(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmChatResult>
}
