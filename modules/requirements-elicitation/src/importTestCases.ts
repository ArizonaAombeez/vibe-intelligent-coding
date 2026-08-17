import { buildImportedTestAnalysisMessages } from './importTestCasesPersona.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type { ImportedTestCase, ImportedTestCaseSet, Project } from './types.js'

function requireImportedTestCaseSet(project: Project): ImportedTestCaseSet {
  if (!project.importedTestCases) {
    project.importedTestCases = { tests: [], nextImportedTestSeq: 1 }
  }
  return project.importedTestCases
}

export interface LegacyTestFile {
  // Path relative to the scanned folder, e.g. "auth/login.test.ts".
  relativePath: string
  content: string
}

const TITLE_LINE = /^TITLE:\s*(.+)$/m
const DESCRIPTION_LINE = /^DESCRIPTION:\s*([\s\S]+)$/m

// Falls back to the filename itself when the LLM reply doesn't parse — an
// imported test case must always land with *some* title (this is a display/
// inventory feature, not something that should reject on a malformed LLM
// reply the way the traceability gate rejects an untraceable TestCase).
function parseAnalysis(relativePath: string, replyContent: string): { title: string; description: string } {
  const titleMatch = replyContent.match(TITLE_LINE)
  const descriptionMatch = replyContent.match(DESCRIPTION_LINE)
  return {
    title: titleMatch ? titleMatch[1].trim() : relativePath,
    description: descriptionMatch ? descriptionMatch[1].trim() : '',
  }
}

export interface ImportLegacyTestCasesResult {
  imported: ImportedTestCase[]
  usage?: LlmUsage
}

// Analyzes each already-read legacy test file (one LLM call per file, QA
// persona) and appends one ImportedTestCase record per file to the
// project's untraced set (see types.ts's ImportedTestCase for why these
// never enter the gated TestSuite). Skips a file whose sourceRelativePath +
// filePath combination already exists, so re-running import against the
// same folder/destination doesn't create duplicate records — the caller
// (server route) is responsible for actually writing each file's content to
// disk at destinationPath and passing that same path back in here.
export async function importLegacyTestCases(
  project: Project,
  llmClient: LlmClient,
  files: Array<LegacyTestFile & { destinationPath: string }>,
  llmOptions?: LlmCallOptions,
): Promise<ImportLegacyTestCasesResult> {
  const set = requireImportedTestCaseSet(project)
  const alreadyImported = new Set(set.tests.map((t) => t.sourceRelativePath))

  const imported: ImportedTestCase[] = []
  let totalTokens = 0
  let promptTokens = 0
  let completionTokens = 0
  let sawUsage = false

  for (const file of files) {
    if (alreadyImported.has(file.relativePath)) continue

    const messages = buildImportedTestAnalysisMessages(file.relativePath, file.content)
    const result = await llmClient.chat(messages, llmOptions)
    const { title, description } = parseAnalysis(file.relativePath, result.content)

    if (result.usage) {
      sawUsage = true
      totalTokens += result.usage.totalTokens
      promptTokens += result.usage.promptTokens
      completionTokens += result.usage.completionTokens
    }

    const seq = set.nextImportedTestSeq
    const testCase: ImportedTestCase = {
      id: `IMPTEST-${String(seq).padStart(3, '0')}`,
      sourceRelativePath: file.relativePath,
      title,
      description,
      filePath: file.destinationPath,
      importedAt: new Date().toISOString(),
    }
    set.nextImportedTestSeq = seq + 1
    set.tests.push(testCase)
    imported.push(testCase)
  }

  return {
    imported,
    usage: sawUsage ? { totalTokens, promptTokens, completionTokens } : undefined,
  }
}

export function deleteImportedTestCase(project: Project, id: string): void {
  const set = requireImportedTestCaseSet(project)
  const index = set.tests.findIndex((t) => t.id === id)
  if (index === -1) {
    throw new Error(`Imported test case ${id} not found`)
  }
  set.tests.splice(index, 1)
}
