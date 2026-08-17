import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MARKER_FILENAME } from 'vic-coding'

// Test command resolution (Area F, confirmed by Mark): per-element, not
// per-project — different elements in the same project can legitimately
// be different languages (Coding's CLI agent picks whatever fits each
// element), so a single project-wide command is the wrong shape. The
// command lives on the same per-element marker file vic-coding's
// scaffoldProjectSourceTree already writes
// (<element-subfolder>/.vic-element.json), extended with two optional
// fields.

export interface TestCommand {
  command: string
  args: string[]
}

const DEFAULT_TEST_COMMAND: TestCommand = { command: 'npm', args: ['test'] }

function markerPath(srcRoot: string, allowedRelativePrefix: string): string {
  return path.join(srcRoot, allowedRelativePrefix, MARKER_FILENAME)
}

// Resolution order: this element's own marker-file override (a genuine
// per-element deviation — see writeTestFiles.ts's reconciliation logic) ->
// the project-wide default declared by the first test-generation call (see
// Project.testCommand's doc comment) -> the hardcoded npm-test last resort,
// which now only applies to an element that predates this whole mechanism
// (e.g. coded before project.testCommand existed, or a project where test
// generation was never run to establish one). Never throws on a
// missing/malformed marker; a test command must always resolve to
// *something* runnable.
export async function readElementTestCommand(
  srcRoot: string,
  allowedRelativePrefix: string,
  projectDefault?: TestCommand,
): Promise<TestCommand> {
  try {
    const raw = JSON.parse(await readFile(markerPath(srcRoot, allowedRelativePrefix), 'utf-8'))
    const command = typeof raw.testCommand === 'string' ? raw.testCommand : undefined
    const args = Array.isArray(raw.testArgs) && raw.testArgs.every((a: unknown) => typeof a === 'string')
      ? (raw.testArgs as string[])
      : undefined
    if (command) return { command, args: args ?? [] }
  } catch {
    // No marker, or malformed — fall through to the project default/hard
    // fallback below rather than treating this as an error.
  }
  return projectDefault ?? DEFAULT_TEST_COMMAND
}

// Writes testCommand/testArgs onto the element's existing marker file,
// preserving every other field already there (architectureElementId/name,
// or fromId/toId for a shared-interface marker) — mirrors
// scaffold.ts's own read-before-write preservation logic for the inverse
// direction (preserving these fields across a re-scaffold).
export async function writeElementTestCommand(
  srcRoot: string,
  allowedRelativePrefix: string,
  testCommand: TestCommand,
): Promise<void> {
  const filePath = markerPath(srcRoot, allowedRelativePrefix)
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await readFile(filePath, 'utf-8'))
  } catch {
    // No marker yet (element not scaffolded) — write one with just the
    // test command; scaffoldProjectSourceTree's own read-before-write
    // preserves this on the next real scaffold pass.
  }
  await writeFile(
    filePath,
    JSON.stringify({ ...existing, testCommand: testCommand.command, testArgs: testCommand.args }, null, 2),
    'utf-8',
  )
}

export { DEFAULT_TEST_COMMAND }
