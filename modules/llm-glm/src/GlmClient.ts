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
