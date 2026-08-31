import path from 'node:path'
import type { CodingAgentClient } from 'vic-coding'
import {
  elementSubfolderName,
  enforceWriteScope,
  gitCommitAll,
  gitDiffText,
  gitInitIfNeeded,
  gitStatusPorcelain,
  isTestFilePath,
  resolveAllowedScope,
  scaffoldProjectSourceTree,
  sourceTreeRoot,
} from 'vic-coding'
import type { Project, TestCase } from 'vic-requirements-elicitation'
import { buildTestGenerationPrompt } from './testGenerationPersona.js'
import { gatherTestSourceContext } from './testSourceContext.js'

function elementSubfolderById(project: Project): Map<string, string> {
  const map = new Map<string, string>()
  for (const element of project.architecture?.elements ?? []) {
    map.set(element.id, elementSubfolderName(element))
  }
  return map
}

export type GenerateTestFileStatus = 'success' | 'rejected-scope' | 'rejected-multi-element' | 'cli-error'

// Per-phase wall-clock breakdown of one generate-test-file call — added to
// diagnose why "QA is writing the test file for TEST-xxx..." takes so long.
// The agent CLI invocation (msAgentCli) is expected to dominate; the rest
// (scaffold / git / scope-gate / commit) being non-trivial would be the
// surprise worth acting on. msToFirstAgentOutput mirrors AgentRunTiming's
// msToFirstOutput — a large value there means the provider was slow to
// start, not that the test itself was hard to write.
export interface GenerateTestFileTiming {
  msTotal: number
  msScaffold: number
  msGitInit: number
  msAgentCli: number
  msToFirstAgentOutput?: number
  msScopeGate: number
  msCommit: number
}

export interface GenerateTestFileResult {
  status: GenerateTestFileStatus
  testCase: TestCase
  diff: string
  rawLog: string
  exitCode: number | null
  rejectedFiles?: string[]
  timing?: GenerateTestFileTiming
}

// The agentic test-file-writing step (Area E) — invoked only AFTER
// createTestCase (requirements-elicitation) has already accepted the test
// through the mechanical requirement-traceability gate; never generates
// code for a test that didn't pass that gate. Mirrors vic-coding's
// runCodingForStory pipeline exactly: resolve scope -> scaffold -> snapshot
// -> invoke agent -> enforce write-scope -> commit or revert. Reuses
// vic-coding's enforceWriteScope directly (not reimplemented) — the same
// write-scope gate that protects Coding protects test-file generation,
// since writing a test file has the identical out-of-scope-write risk as
// writing implementation code.
export async function generateTestFileForTestCase(
  project: Project,
  projectDir: string,
  testCase: TestCase,
  agentClient: CodingAgentClient,
  options: {
    model?: string
    effort?: string
    binary?: string
    binaryArgs?: string[]
    apiKey?: string
    baseUrl?: string
    thinking?: string
    reasoningEffort?: string
    onChunk?: (chunk: string) => void
    signal?: AbortSignal
  } = {},
): Promise<GenerateTestFileResult> {
  const scope = resolveAllowedScope(testCase, elementSubfolderById(project))
  if ('rejected' in scope) {
    return {
      status: 'rejected-multi-element',
      testCase,
      diff: '',
      rawLog: 'Test case resolves to more than one architecture element/interface pair — this should not happen for a test that already passed the traceability gate.',
      exitCode: null,
    }
  }

  const t0 = Date.now()
  await scaffoldProjectSourceTree(project, projectDir)
  const tScaffold = Date.now()
  const srcRoot = sourceTreeRoot(projectDir)
  await gitInitIfNeeded(srcRoot)
  const beforeStatus = await gitStatusPorcelain(srcRoot)
  const tGitInit = Date.now()

  // Pre-flight: gather the code under test + an example test from disk NOW,
  // with no LLM round-trip, so the agent can skip the 4-6 slow discovery
  // tool calls it would otherwise make before writing anything. Best-effort
  // — if nothing resolves (element not coded yet), the prompt falls back to
  // its previous "read the target file(s) yourself" wording.
  const sourceContext = await gatherTestSourceContext(project, testCase, srcRoot, scope.allowedRelativePrefix).catch(
    () => undefined,
  )
  const prompt = buildTestGenerationPrompt(project, testCase, scope.allowedRelativePrefix, sourceContext)

  let runResult
  try {
    runResult = await agentClient.runAgentTask(prompt, {
      cwd: srcRoot,
      permissionMode: 'acceptEdits',
      model: options.model,
      effort: options.effort,
      binary: options.binary,
      binaryArgs: options.binaryArgs,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      thinking: options.thinking,
      reasoningEffort: options.reasoningEffort,
      onChunk: options.onChunk,
      signal: options.signal,
    })
  } catch (err) {
    const rawLog = (err as { rawLog?: string }).rawLog ?? (err as Error).message
    const exitCode = (err as { exitCode?: number | null }).exitCode ?? null
    const tErr = Date.now()
    return {
      status: 'cli-error',
      testCase,
      diff: '',
      rawLog,
      exitCode,
      timing: {
        msTotal: tErr - t0,
        msScaffold: tScaffold - t0,
        msGitInit: tGitInit - tScaffold,
        msAgentCli: tErr - tGitInit,
        msToFirstAgentOutput: (err as { timing?: { msToFirstOutput?: number } }).timing?.msToFirstOutput,
        msScopeGate: 0,
        msCommit: 0,
      },
    }
  }
  const tAgent = Date.now()

  const gateResult = await enforceWriteScope(srcRoot, scope.allowedRelativePrefix, beforeStatus)
  const tScopeGate = Date.now()
  if (!gateResult.ok) {
    const remainingDiff = await gitDiffText(srcRoot)
    return {
      status: 'rejected-scope',
      testCase,
      diff: remainingDiff,
      rawLog: runResult.rawLog,
      exitCode: runResult.exitCode,
      rejectedFiles: gateResult.rejectedFiles,
      timing: {
        msTotal: tScopeGate - t0,
        msScaffold: tScaffold - t0,
        msGitInit: tGitInit - tScaffold,
        msAgentCli: tAgent - tGitInit,
        msToFirstAgentOutput: runResult.timing?.msToFirstOutput,
        msScopeGate: tScopeGate - tAgent,
        msCommit: 0,
      },
    }
  }

  // Captured before committing — HEAD still points at the pre-run commit
  // here, so gitStatusPorcelain still shows this run's changes as
  // uncommitted, and the diff reflects what this run actually introduced
  // (same ordering fix as vic-coding's runCoding.ts uses for the same
  // reason: git diff/status after a commit sees a clean tree).
  const diff = await gitDiffText(srcRoot)
  const afterStatus = await gitStatusPorcelain(srcRoot)
  const beforeSet = new Set(beforeStatus)
  const changedInScope = afterStatus.filter(
    (p) => !beforeSet.has(p) && p.split('/').join(path.sep).startsWith(scope.allowedRelativePrefix),
  )
  // T1.2: pick the TEST file the agent wrote, not git's alphabetically-first
  // changed path. Without this filter, an agent that also writes a support
  // file (e.g. `_harness/index.html`, which sorts before `nav.test.mjs`)
  // leaves that non-test path in testCase.filePath, where it can never be
  // discovered, run, or healed. If the agent wrote no test file at all,
  // filePath stays undefined (honest) rather than becoming a bogus pointer.
  const testFilesWritten = changedInScope.filter(isTestFilePath)

  await gitCommitAll(srcRoot, `Test: ${testCase.id} ${testCase.title}`)
  const tCommit = Date.now()

  return {
    status: 'success',
    testCase: { ...testCase, filePath: testFilesWritten[0] ?? testCase.filePath },
    diff,
    rawLog: runResult.rawLog,
    exitCode: runResult.exitCode,
    timing: {
      msTotal: Date.now() - t0,
      msScaffold: tScaffold - t0,
      msGitInit: tGitInit - tScaffold,
      msAgentCli: tAgent - tGitInit,
      msToFirstAgentOutput: runResult.timing?.msToFirstOutput,
      msScopeGate: tScopeGate - tAgent,
      msCommit: tCommit - tScopeGate,
    },
  }
}
