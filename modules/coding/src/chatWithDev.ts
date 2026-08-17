import type { LlmCallOptions, LlmClient, LlmUsage, Project } from 'vic-requirements-elicitation'
import { buildCodingChatMessages, type CodeContextFile } from './codingPersona.js'

export interface ChatWithDevResult {
  reply: string
  usage?: LlmUsage
}

// Dev-chat path (mirrors chatWithAnalyst/chatWithArchitect/chatWithPM) —
// conversational only, never proposes or applies a code change (see
// codingPersona.ts's DEFAULT_DEV_SYSTEM_PROMPT). Does not touch
// project/filesystem state at all beyond reading it for context. codeFiles
// is optional, caller-supplied (read server-side in index.ts, scoped to
// either the element's own folder or the whole src/ tree per the user's
// chosen codeScope) — kept out of this function so chatWithDev itself stays
// filesystem-free, same as every other chat* path in this codebase.
export async function chatWithDev(
  llmClient: LlmClient,
  project: Project | null,
  architectureElementId: string | null,
  userMessage: string,
  llmOptions?: LlmCallOptions,
  codeFiles?: CodeContextFile[],
): Promise<ChatWithDevResult> {
  const messages = buildCodingChatMessages(project, architectureElementId, userMessage, undefined, codeFiles)
  const result = await llmClient.chat(messages, llmOptions)
  return {
    reply: result.content,
    usage: result.usage,
  }
}
