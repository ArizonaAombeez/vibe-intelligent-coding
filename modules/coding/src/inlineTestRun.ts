import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import spawn from "cross-spawn";

// Runs an element's own freshly-written "*.test.<ext>" files as part of a
// Coding run, so the run can report whether the coding-level tests actually
// PASS — not just that they exist (Area F follow-up). Deliberately a small
// self-contained helper here rather than importing vic-testing: vic-testing
// already depends on vic-coding, so the reverse import would be circular.
// The execution model is identical to vic-testing/runExecution.ts's
// runTestFiles (extension -> interpreter, each file its own process, exit
// code is the verdict) so a test that passes here passes there too.

const INTERPRETER_BY_EXTENSION: Record<string, string> = {
  ".mjs": "node",
  ".cjs": "node",
  ".js": "node",
  ".py": "python",
};

const TEST_FILE_SUFFIX_PATTERN = /\.test\.[^./\\]+$/;
const PER_FILE_TIMEOUT_MS = 120_000;

async function findTestFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      files.push(...(await findTestFiles(full)));
    } else if (entry.isFile() && TEST_FILE_SUFFIX_PATTERN.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function runOne(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, PER_FILE_TIMEOUT_MS);
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\n${err.message}`, exitCode: null, timedOut });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

export interface InlineTestRunResult {
  passed: boolean;
  filesRun: number;
  files: Array<{ name: string; passed: boolean; output: string }>;
}

// scopeCwd: absolute path to the element's own subfolder inside the LOCAL
// working source tree (the same copy runCodingForElement just committed
// into). Returns undefined if no runnable test file was found — the caller
// keeps the existing "rejected-no-tests" behaviour for that case.
// T3.3: which of the given requirement ids are NOT referenced by a
// `// covers: <id>` (or `# covers: <id>`) comment in any test file under the
// element's folder. This is the mechanical "resolved against the
// requirements, not just green" check the coding loop converges on — a plain
// text scan, deterministic and free, no LLM judgement. An id is "covered" if
// it appears anywhere in a covers-tag line; the exact id string is matched
// (word-boundary) so IMP_REQ-1 doesn't spuriously satisfy IMP_REQ-12.
export async function uncoveredRequirementIds(
  scopeCwd: string,
  requirementIds: string[],
): Promise<string[]> {
  if (requirementIds.length === 0) return [];
  const testFiles = await findTestFiles(scopeCwd);
  const covered = new Set<string>();
  for (const filePath of testFiles) {
    let body: string;
    try {
      body = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!/(?:\/\/|#).*\bcovers:/i.test(line)) continue;
      for (const id of requirementIds) {
        // Escape regex metacharacters in the id, then require a boundary
        // after it so a prefix id can't match a longer one.
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`${escaped}(?![\\w-])`).test(line)) covered.add(id);
      }
    }
  }
  return requirementIds.filter((id) => !covered.has(id));
}

export async function runElementInlineTests(
  scopeCwd: string,
): Promise<InlineTestRunResult | undefined> {
  const testFiles = await findTestFiles(scopeCwd);
  if (testFiles.length === 0) return undefined;

  const files: InlineTestRunResult["files"] = [];
  for (const filePath of testFiles) {
    const ext = path.extname(filePath);
    const interpreter = INTERPRETER_BY_EXTENSION[ext];
    const name = path.basename(filePath);
    if (!interpreter) {
      files.push({ name, passed: false, output: `(no interpreter known for ${ext} — cannot run)` });
      continue;
    }
    const rel = path.relative(scopeCwd, filePath);
    const r = await runOne(interpreter, [rel], scopeCwd);
    const output =
      r.stdout + (r.stderr ? `\n${r.stderr}` : "") + (r.timedOut ? "\n(timed out)" : "");
    files.push({ name, passed: r.exitCode === 0 && !r.timedOut, output: output.trim() });
  }
  return {
    passed: files.length > 0 && files.every((f) => f.passed),
    filesRun: files.length,
    files,
  };
}
