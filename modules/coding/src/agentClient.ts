import type { AgentRunOptions, AgentRunResult } from 'vic-llm-claude-code'

// Structural interface both ClaudeCodeAgentClient (vic-llm-claude-code) and
// AiderAgentClient (vic-llm-aider) satisfy — lets runCodingForStory accept
// either concrete agent client without depending on both provider packages
// itself. AgentRunOptions/AgentRunResult are declared once in
// vic-llm-claude-code (vic-coding already depends on it) and reused here
// rather than redeclared, since both agent clients already import those
// same types.
export interface CodingAgentClient {
  runAgentTask(prompt: string, options: AgentRunOptions): Promise<AgentRunResult>
}
