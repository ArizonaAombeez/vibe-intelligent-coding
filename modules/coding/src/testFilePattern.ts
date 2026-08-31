// The single definition of "this is a runnable test file" (T1.2). Before
// this, the same regex was copied in five places — runExecution.ts,
// runCoding.ts, inlineTestRun.ts, writeTestFiles.ts, and the repair script —
// and the last two only ever compared the raw filename, so a diff path like
// "_harness/index.html" was never recognised as a non-test file and could
// leak into a TestCase.filePath.
//
// Lives in vic-coding (not vic-testing) because vic-testing already depends
// on vic-coding; the reverse import would be circular. vic-testing re-exports
// it from its own index so its callers don't need to reach across.
//
// The interpreter map is here for the same reason: the test-generation
// prompt (vic-testing) and the coding prompt (vic-coding) both need to tell
// the agent which extensions are actually runnable, and prompt/runner drift
// on exactly this point is what caused ".test.ts is silently skipped".

export const TEST_FILE_SUFFIX_PATTERN = /\.test\.[^./\\]+$/;

// A path or bare filename that names a discoverable, runnable test file.
// Accepts both separators so it works on a git-porcelain path (forward
// slash) and a native path (back slash on Windows).
export function isTestFilePath(pathOrName: string): boolean {
  const base = pathOrName.split("\\").join("/").split("/").pop() ?? "";
  return TEST_FILE_SUFFIX_PATTERN.test(base);
}

// Extension -> interpreter for a standalone test script. A file whose
// extension is not a key here is discovered (its name matches the suffix
// pattern) but cannot be run — it is skipped, never counted as a failure.
export const INTERPRETER_BY_EXTENSION: Record<string, string> = {
  ".mjs": "node",
  ".cjs": "node",
  ".js": "node",
  ".py": "python",
};

// The runnable extensions, as a human-readable list for prompt text
// ("Use one of these extensions ONLY: .mjs, .cjs, .js, .py").
export const RUNNABLE_TEST_EXTENSIONS = Object.keys(INTERPRETER_BY_EXTENSION);
