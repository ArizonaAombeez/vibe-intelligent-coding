import type { Project, TestCase } from 'vic-requirements-elicitation'

// Marker line the agent is asked to emit as the LAST line of its final text
// response, only on the first-ever test-generation call for a project (see
// buildTestGenerationPrompt's runCommandInstruction) — parsed back out by
// writeTestFiles.ts's parseDeclaredRunCommand to establish
// project.testCommand. Deliberately plain (no JSON/quoting) since it only
// ever needs to carry an interpreter/command plus flat string args, and a
// plain line is far more reliably produced verbatim by an LLM than a JSON
// blob buried in prose.
export const RUN_COMMAND_MARKER = 'RUN:'

function formatRequirements(project: Project, requirementIds: string[]): string {
  const byId = new Map(project.requirements.map((r) => [r.id, r]))
  return requirementIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => `${r.id}: ${r.text}`)
    .join('\n')
}

function formatContractOperation(project: Project, testCase: TestCase): string {
  const definitionId = testCase.interfaceDefinitionId
  if (!definitionId) return '(no contract reference)'
  const definition = (project.architecture?.interfaceDefinitions ?? []).find((d) => d.id === definitionId)
  if (!definition) return '(contract not found)'
  return definition.operations
    .map((op) => `- ${op.name}: ${op.description} (request: ${op.request}; response: ${op.response}; errors: ${op.errors || 'none'})`)
    .join('\n')
}

// The prompt-construction function that directs the coding agent to write
// a real test file — mirrors vic-coding's runCoding.ts buildCodingPrompt
// phrasing pattern exactly (the "may ONLY create... under X/" sentence is
// intentionally identical wording), since this is the soft signal half of
// the same two-layer (prompt + hard gate) design Coding already uses. The
// hard gates are enforceWriteScope (after generation, reused from
// vic-coding — see writeTestFiles.ts) and, upstream of this function ever
// being called, the requirement-traceability gate in
// requirements-elicitation's createTestCase (this prompt is only ever
// built for a TestCase that has already survived that gate).
export function buildTestGenerationPrompt(
  project: Project,
  testCase: TestCase,
  allowedRelativePrefix: string,
): string {
  const parts: string[] = []
  parts.push(
    `You may ONLY create or modify files under ${allowedRelativePrefix}/ relative to your working directory — do not touch any file outside that path.`,
  )
  parts.push(
    `Write this test using whatever test framework is already in use under ${allowedRelativePrefix}/ (or the project's established convention if none exists yet) — the generated test file must live under ${allowedRelativePrefix}/, never in a separate or untracked location.`,
  )
  // The project-wide run command is decided ONCE (on the first-ever
  // test-generation call) and reused for every test after that — asking
  // again on every call would waste tokens re-deciding something that
  // (outside a genuine per-element deviation) doesn't change. Do NOT write
  // to package.json/npm scripts or any other project-level config to
  // declare this — the RUN: line is VIC's own record of it, not something
  // the target codebase itself needs to carry.
  if (project.testCommand) {
    parts.push(
      `This project's established test-run command is: ${project.testCommand.command} ${project.testCommand.args.join(' ')} — write this test so it is runnable that same way (from ${allowedRelativePrefix}/ as the working directory, passed the path to the code under test as needed). Only declare a different run command (see below) if this element genuinely cannot use that convention (e.g. a different language/runtime than the rest of the project) — do not deviate for any other reason.`,
    )
  }
  parts.push(
    `On the LAST line of your final response TEXT (never inside the test file itself, and never as a comment in any file) output exactly one line starting with "${RUN_COMMAND_MARKER}" followed by the command and args needed to run THIS test file on its own from ${allowedRelativePrefix}/ as the working directory (e.g. "${RUN_COMMAND_MARKER} node test.mjs ./index.html", or "${RUN_COMMAND_MARKER} npx vitest run wall-collision.test.ts" if that convention already fits). This must be a plain, directly-runnable command — no shell operators, no package.json script indirection. Include it every time, even when reusing the existing convention. The test file you write must be valid, directly-runnable source code on its own and must NOT contain this "${RUN_COMMAND_MARKER}" line or any other non-code text appended to it — the file has to execute cleanly by itself.`,
  )
  if (testCase.type === 'functional') {
    parts.push('This is a functional test verifying the following requirement(s):')
    parts.push(formatRequirements(project, testCase.requirementIds))
  } else {
    parts.push('This is an integration test verifying one operation of an interface contract:')
    parts.push(formatContractOperation(project, testCase))
  }
  parts.push(`Test title: ${testCase.title}`)
  parts.push(
    'Do not invent behaviour or assertions beyond what the given requirement(s)/operation describe — this test must trace back to exactly what was given to you.',
  )
  return parts.join('\n\n')
}
