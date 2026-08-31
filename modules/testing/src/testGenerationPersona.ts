import type { Project, TestCase } from 'vic-requirements-elicitation'
import { elementSubfolderName, RUNNABLE_TEST_EXTENSIONS } from 'vic-coding'
import type { TestSourceContext } from './testSourceContext.js'

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
// a real test file. This is the soft-signal half of the same two-layer
// (prompt + hard gate) design Coding uses; the hard gates are
// enforceWriteScope (after generation, reused from vic-coding — see
// writeTestFiles.ts) and, upstream, the requirement-traceability gate in
// createTestCase.
//
// NOTE the workspace shape differs from the coding prompt: test-file
// generation runs with cwd == the source-tree ROOT (writeTestFiles.ts
// passes `cwd: srcRoot`), so "under <prefix>/" IS the correct instruction
// here — unlike buildCodingPrompt, whose cwd is already the element folder.
// Do not "align" the two; they are deliberately different.
export function buildTestGenerationPrompt(
  project: Project,
  testCase: TestCase,
  allowedRelativePrefix: string,
  sourceContext?: TestSourceContext,
): string {
  const parts: string[] = []
  parts.push(
    `You may ONLY create or modify files under ${allowedRelativePrefix}/ relative to your working directory — do not touch any file outside that path.`,
  )
  // The contract this file will be judged by (T1.4). The runner discovers
  // test files purely by name and runs them purely by extension; a file
  // that misses either is silently invisible, which is exactly how Worm 2
  // ended up with 15 test cases that never produced an outcome.
  parts.push(
    [
      `Name the file "<something>.test.<ext>" — the runner discovers test files by that exact "*.test.*" suffix and will not find it otherwise.`,
      `Use one of these extensions ONLY: ${RUNNABLE_TEST_EXTENSIONS.join(', ')}. A .test.ts / .test.jsx file IS discovered but is then silently skipped — it will never run. If the code under test is TypeScript, write the test in .mjs against the plain-JS entry point.`,
      `It must be a single self-contained directly-runnable script — no framework runner, no package.json script, no external test dependency. Exit non-zero when any assertion fails, zero when all pass.`,
      `Write it directly under ${allowedRelativePrefix}/ — do not create a nested subfolder inside it.`,
    ].join('\n'),
  )

  // --- Tighten policy -------------------------------------------------
  // The single biggest driver of how long each test-file generation takes
  // is the agent running 4-6 discovery tool calls (list dir, glob for
  // tests, glob for sources, read sibling tests, read the implementation)
  // BEFORE it writes anything — each with a multi-second model reasoning
  // pass in front of it. When we've already gathered the code under test
  // and an example test below, the agent needs ZERO exploration: it can go
  // straight to `write`. These instructions make that explicit and bound
  // the fix loop so a bad first draft doesn't trigger 3-4 more slow cycles.
  const haveContext = !!sourceContext && sourceContext.targets.length > 0
  if (haveContext) {
    parts.push(
      [
        'WORK TIGHT — this is ONE small self-contained file. Everything you need is already given to you below.',
        '- Do NOT use glob, grep, or find. Do NOT list directories. Do NOT search the codebase.',
        `- Do NOT read any file other than (optionally) the exact target file(s) named below, and only if you genuinely need to double-check something — their full contents are already pasted in.`,
        '- Do NOT refactor, reformat, or modify any existing code. Write exactly one new test file.',
        '- Run the test file ONCE with the run command. If it fails, you get at most ONE fix attempt, then stop regardless of the result — a still-failing test is recorded and surfaced separately, it is not your job to make it pass at any cost here.',
      ].join('\n'),
    )
  } else {
    parts.push(
      `Work efficiently: this is a single, self-contained deliverable — ONE test file. Read only the specific source file(s) under ${allowedRelativePrefix}/ that this test needs to import and exercise; do NOT explore the wider codebase, run broad searches, or refactor any existing code. Run the test once; if it fails, make at most one fix attempt, then stop. Write the one test file and stop.`,
    )
  }

  // Inline the code under test + one example test so no discovery reads are
  // needed. Paths are pre-resolved relative to this test file's directory.
  if (sourceContext) {
    for (const t of sourceContext.targets) {
      parts.push(
        [
          `CODE UNDER TEST — import from "${t.importPath}" (relative to this test file; use exactly this path).`,
          t.exportNames.length > 0 ? `Named exports: ${t.exportNames.join(', ')}` : 'No named exports detected — check the pasted source.',
          '```',
          t.content,
          '```',
        ].join('\n'),
      )
    }
    if (sourceContext.exampleTest) {
      parts.push(
        [
          `EXAMPLE TEST in this same scope — follow this file's structure and harness/mock style (do NOT copy its assertions):`,
          `--- ${sourceContext.exampleTest.name} ---`,
          '```',
          sourceContext.exampleTest.content,
          '```',
        ].join('\n'),
      )
    }
  }

  parts.push(
    `The generated test file must live under ${allowedRelativePrefix}/, never in a separate or untracked location. Use Node's built-in "node:assert" / "node:test" (or Python's "assert" / "unittest") — nothing that needs installing.`,
  )
  parts.push(
    `Before you finish, ACTUALLY RUN the test file (e.g. \`node ${allowedRelativePrefix}/<file>\` from your working directory) and confirm it exits zero. If it fails, you get ONE fix attempt (fix the test, or the code under test if the test itself is right), then stop regardless — a still-failing test is recorded and surfaced separately. Do NOT append any non-code text (no "RUN:" line, no notes) to the file — it has to execute cleanly by itself.`,
  )
  if (testCase.type === 'functional') {
    parts.push('This is a functional test verifying the following requirement(s):')
    parts.push(formatRequirements(project, testCase.requirementIds))
  } else {
    parts.push('This is an integration test verifying one operation of an interface contract:')
    parts.push(formatContractOperation(project, testCase))
    // Tell the agent EXACTLY where each participant element's code lives and
    // what to import — without this it guesses a nested/renamed path (a real
    // observed failure: importing `../../game-engine/game-engine/game-engine.js`
    // when the actual entry is `../../game-engine/index.js`), and every such
    // test then fails at load with "Cannot find module" and shows as a
    // missing/failing SW test on the Execution screen.
    // Prefer the pre-resolved, verified-on-disk import paths from
    // sourceContext (pasted with the code above). Only fall back to the
    // folder-name guess when the context wasn't gathered (e.g. the element
    // isn't coded yet).
    if (!haveContext) {
      const participantIds = testCase.interfaceElementIds ?? []
      const elements = project.architecture?.elements ?? []
      const importLines = participantIds
        .map((id) => {
          const el = elements.find((e) => e.id === id)
          if (!el) return null
          const folder = elementSubfolderName(el)
          return `  - ${el.name} (${id}): import its public API from "../../${folder}/index.js". If that file does not exist, import from the single obvious entry file directly inside "../../${folder}/" — do NOT invent a deeper nested path.`
        })
        .filter(Boolean)
      if (importLines.length > 0) {
        parts.push(
          `This test file lives in "${allowedRelativePrefix}/". Import the two elements under test using these exact relative paths:\n${importLines.join(
            '\n',
          )}\nEvery import path must be relative and end in ".js".`,
        )
      }
    }
  }
  parts.push(`Test title: ${testCase.title}`)
  parts.push(
    'Do not invent behaviour or assertions beyond what the given requirement(s)/operation describe — this test must trace back to exactly what was given to you.',
  )
  return parts.join('\n\n')
}
