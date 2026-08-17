import type { LlmMessage } from './LlmClient.js'

// Analyzes one legacy test file's raw source to produce a short human title
// and one-paragraph description — the QA persona reused for the normal
// Test Creation flow (testCreationPersona.ts), pointed at an existing file's
// content instead of a requirement. Deliberately asks for a summary only,
// never source code: the imported file is kept verbatim on disk exactly as
// found (see importTestCases.ts), so nothing here should regenerate or
// rewrite it.
export const IMPORTED_TEST_ANALYSIS_SYSTEM_PROMPT = `You are QA, reviewing a legacy automated test file being imported into a project.
Given the file's path and full source, produce a short human-readable title and a
one-paragraph description of what the test verifies.

Reply using exactly this format, nothing else:

TITLE: <short title, under 80 characters>
DESCRIPTION: <one paragraph describing what behaviour this test verifies>`

export function buildImportedTestAnalysisMessages(relativePath: string, content: string): LlmMessage[] {
  return [
    { role: 'system', content: IMPORTED_TEST_ANALYSIS_SYSTEM_PROMPT },
    { role: 'user', content: `File: ${relativePath}\n\n${content}` },
  ]
}
