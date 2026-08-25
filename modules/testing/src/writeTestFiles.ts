import path from 'node:path'
import type { CodingAgentClient } from 'vic-coding'
import {
  elementSubfolderName,
  enforceWriteScope,
  gitCommitAll,
  gitDiffText,
  gitInitIfNeeded,
  gitStatusPorcelain,
  resolveAllowedScope,
  scaffoldProjectSourceTree,
  sourceTreeRoot,
} from 'vic-coding'
import type { Project, TestCase } from 'vic-requirements-elicitation'
import { buildTestGenerationPrompt, RUN_COMMAND_MARKER } from './testGenerationPersona.js'
import { writeElementTestCommand, type TestCommand } from './testCommandResolution.js'

// Pulls the agent's declared "RUN: <command> <args...>" line (see
// buildTestGenerationPrompt) out of its raw output — the LAST such match, in
// case the model echoes the instruction text itself earlier in its response
// (a real, observed LLM habit: repeating part of the prompt back before
// answering it). Returns undefined if the agent never declared one (e.g. a
// CLI-error run, or a model that ignored the instruction) — callers treat
// that as "no change," not an error, since a test run can still fall back
// to whatever readElementTestCommand resolves at execution time.
//
// Matches on a real line break OR a literal backslash-n, not just '\n' —
// rawLog's shape differs by backend: OpenCode's is genuinely
// newline-delimited JSON events, but ClaudeCodeAgentClient's is `stdout` of
// ONE JSON document (see ClaudeCodeAgentClient.ts's `JSON.parse(stdout)`),
// so a "line break" inside the model's own text response survives only as
// the two characters \ and n inside that JSON string, never an actual
// newline byte in rawLog. Stops the captured command+args at whichever
// comes first: end of string, a real newline, a literal \n, or an
// unescaped closing quote (the end of the JSON string it's embedded in).
function parseDeclaredRunCommand(rawLog: string): TestCommand | undefined {
  const pattern = new RegExp(`${RUN_COMMAND_MARKER}\\s*(.+?)(?:\\\\n|\\n|"|$)`, 'g')
  let match: RegExpExecArray | null
  let last: string | undefined
  while ((match = pattern.exec(rawLog))) {
    last = match[1]
  }
  if (!last) return undefined
  const tokens = last.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return undefined
  return { command: tokens[0], args: tokens.slice(1) }
}

function sameCommand(a: TestCommand, b: TestCommand): boolean {
  return a.command === b.command && a.args.length === b.args.length && a.args.every((v, i) => v === b.args[i])
}

function elementSubfolderById(project: Project): Map<string, string> {
  const map = new Map<string, string>()
  for (const element of project.architecture?.elements ?? []) {
    map.set(element.id, elementSubfolderName(element))
  }
  return map
}

export type GenerateTestFileStatus = 'success' | 'rejected-scope' | 'rejected-multi-element' | 'cli-error'

export interface GenerateTestFileResult {
  status: GenerateTestFileStatus
  testCase: TestCase
  diff: string
  rawLog: string
  exitCode: number | null
  rejectedFiles?: string[]
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

  await scaffoldProjectSourceTree(project, projectDir)
  const srcRoot = sourceTreeRoot(projectDir)
  await gitInitIfNeeded(srcRoot)
  const beforeStatus = await gitStatusPorcelain(srcRoot)

  const prompt = buildTestGenerationPrompt(project, testCase, scope.allowedRelativePrefix)

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
    return { status: 'cli-error', testCase, diff: '', rawLog, exitCode }
  }

  const gateResult = await enforceWriteScope(srcRoot, scope.allowedRelativePrefix, beforeStatus)
  if (!gateResult.ok) {
    const remainingDiff = await gitDiffText(srcRoot)
    return {
      status: 'rejected-scope',
      testCase,
      diff: remainingDiff,
      rawLog: runResult.rawLog,
      exitCode: runResult.exitCode,
      rejectedFiles: gateResult.rejectedFiles,
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

  await gitCommitAll(srcRoot, `Test: ${testCase.id} ${testCase.title}`)

  // Establish/reconcile the run-command manifest (Area F, resolved) — see
  // buildTestGenerationPrompt's RUN: instruction and project.testCommand's
  // own doc comment for the full rationale. Silently no-ops if the agent
  // never declared one; a later execution attempt still has
  // readElementTestCommand's npm-test last-resort fallback.
  const declared = parseDeclaredRunCommand(runResult.rawLog)
  if (declared) {
    if (!project.testCommand) {
      // First test ever generated for this project — this call's
      // declaration becomes the shared project-wide default that every
      // later generation call is told to reuse instead of redeciding.
      project.testCommand = declared
    } else if (!sameCommand(declared, project.testCommand)) {
      // Agent explicitly deviated from the established convention (per the
      // prompt, only expected for a genuine cross-language/runtime need) —
      // record it as this element's own override, not a change to the
      // shared default other elements still follow.
      await writeElementTestCommand(srcRoot, scope.allowedRelativePrefix, declared)
    }
  }

  return {
    status: 'success',
    testCase: { ...testCase, filePath: changedInScope[0] ?? testCase.filePath },
    diff,
    rawLog: runResult.rawLog,
    exitCode: runResult.exitCode,
  }
}
