import { ClaudeCodeCliClient } from './ClaudeCodeCliClient.js'
import type { ClaudeCodeChatClient } from './ClaudeCodeClient.js'

// Generic factory the application layer calls without knowing this
// module's constructor shape — mirrors vic-llm-glm's createClient. No
// apiKey to validate here: auth is the CLI's own OAuth login, so any
// `values` (even empty) produce a usable client; a missing/unauthenticated
// CLI surfaces as a ClaudeCodeCliError at call time instead.
export function createClient(values: Record<string, string>): ClaudeCodeChatClient {
  return new ClaudeCodeCliClient({ model: values.model || undefined, effort: values.effort || undefined })
}
