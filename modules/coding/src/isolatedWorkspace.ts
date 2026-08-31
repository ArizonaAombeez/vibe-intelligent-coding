import { cp, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gitCommitAll,
  gitDiffText,
  gitInitIfNeeded,
  gitRevertPaths,
  gitStatusPorcelain,
} from "./gitDiff.js";
import { withFsRetry } from "./fsRetry.js";

// Paths a Coding agent may create inside its isolated workspace that must
// NEVER be staged, diffed, or merged back into the real project tree — an
// agent that runs `npm install` (some do, trying to set up a test runner)
// drops a huge node_modules/ that (a) makes `git add -A` choke on locked
// .bin files -> the "Permission denied … failed to insert into database"
// cli-error, and (b) would be catastrophic to sync back onto an SMB share.
// Written to .git/info/exclude (repo-local, never itself committed or
// copied) so every git operation in the throwaway repo ignores them.
const ISOLATE_GIT_EXCLUDES = [
  "node_modules/",
  ".npm/",
  "*.log",
  ".DS_Store",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
].join("\n");

async function writeIsolateGitExcludes(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, ".git", "info"), { recursive: true });
  await writeFile(
    path.join(repoRoot, ".git", "info", "exclude"),
    ISOLATE_GIT_EXCLUDES + "\n",
    "utf8",
  );
}

// A copy filter for merge-back that also drops the excluded paths — belt to
// the .git/info/exclude braces, since `cp` of the isolated root doesn't
// consult git at all. Keeps agent `npm install` fallout (node_modules + any
// package manifest/lockfile it wrote) out of the real project tree.
const MERGE_BACK_EXCLUDED_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".npm",
  ".DS_Store",
]);
function mergeBackCopyFilter(src: string): boolean {
  const parts = src.split(path.sep);
  if (parts.includes(".git")) return false;
  if (parts.includes("node_modules")) return false;
  if (MERGE_BACK_EXCLUDED_BASENAMES.has(parts[parts.length - 1])) return false;
  return true;
}

// Physical write-scope isolation (Area D follow-up: an instruction ("only
// touch files under X/") is not a guard — an agent can still read or write
// anywhere the CLI process's cwd gives it access to before any after-the-
// fact check runs. This replaces scopeGate.ts's detect-and-revert-after
// enforceWriteScope for the Coding path with a physical one: the CLI never
// runs anywhere near the other elements' files in the first place, on any
// platform, using nothing but plain Node fs — no OS ACLs, no containers.
//
// Runs entirely on local disk (os.tmpdir()), not the project's own
// (frequently network-shared) directory — deliberately sidesteps the same
// "dubious ownership"/SID-resolution git quirk gitDiff.ts's
// markSafeDirectory works around for the real srcRoot, and keeps the
// isolated copy fast regardless of where the project itself lives.

export interface IsolatedWorkspaceResult<T> {
  result: T;
  // Diff of everything the callback wrote, captured from the isolated
  // repo's own git history — by construction (nothing but the allowed
  // element folder was ever copied in) this is already fully in-scope, so
  // there is nothing left to reject or revert here.
  diff: string;
  changedPaths: string[];
}

// Copies allowedRelativePrefix out of srcRoot into a throwaway temp
// directory, runs fn with that directory as its only visible filesystem
// root, then copies whatever fn left behind back over the real
// srcRoot/allowedRelativePrefix and commits it there — mirroring the
// existing "one git repo per Coding run" shape (gitInitIfNeeded +
// gitStatusPorcelain + gitCommitAll) but scoped to the isolated copy
// instead of the shared tree. On any failure (fn throws, or the caller
// decides not to keep the result — see keep()), the temp directory is
// discarded and the real srcRoot is never touched, so no reset-hard/
// revert step is needed on that path either.
export async function withIsolatedElementWorkspace<T>(
  srcRoot: string,
  allowedRelativePrefix: string,
  fn: (isolatedCwd: string) => Promise<T>,
): Promise<IsolatedWorkspaceResult<T>> {
  const sourceDir = path.join(srcRoot, allowedRelativePrefix);
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), "vic-coding-"));
  try {
    await cp(sourceDir, isolatedRoot, {
      recursive: true,
      filter: mergeBackCopyFilter,
    });
    await gitInitIfNeeded(isolatedRoot);
    // Make git ignore node_modules/ etc. BEFORE any add/status/commit, so an
    // agent that runs `npm install` doesn't break the baseline commit below
    // or the post-run diff.
    await writeIsolateGitExcludes(isolatedRoot);
    // Commit the copied-in state so the working tree is genuinely CLEAN
    // before fn runs. Without this, every copied file shows as staged-new in
    // `git status`, so a later diff of afterStatus against beforeStatus only
    // ever catches BRAND-NEW paths — a file whose CONTENT fn changed (the
    // normal case on iteration 2+ of the coding loop, where the folder is
    // already populated from the previous iteration's merge-back) would be
    // invisible, producing a spurious "wrote nothing" result.
    await gitCommitAll(isolatedRoot, "isolate: baseline before agent run");
    const beforeStatus = await gitStatusPorcelain(isolatedRoot);

    const result = await fn(isolatedRoot);

    const afterStatus = await gitStatusPorcelain(isolatedRoot);
    const beforeSet = new Set(beforeStatus);
    const changedPaths = afterStatus.filter((p) => !beforeSet.has(p));
    const diff = await gitDiffText(isolatedRoot);

    if (changedPaths.length === 0) {
      return { result, diff: "", changedPaths: [] };
    }

    // Merge back: the isolated copy is authoritative for this element's own
    // folder once fn succeeds — replace the real folder wholesale rather
    // than patching, same "whole subfolder" granularity scopeGate.ts always
    // used.
    //
    // Build the replacement at a staging path on the SAME share/volume as
    // sourceDir, then swap it in with a single rename — NOT a delete-then-
    // copy. rename() within one filesystem/share is a metadata-only
    // operation (no data movement), so it's effectively atomic even over
    // SMB, unlike a separate rm+cp pair which has a real window where
    // sourceDir is either half-deleted or briefly absent — the exact race
    // that produced the ENOTEMPTY this replaced. The old contents are moved
    // aside (also a same-share rename, same atomicity) rather than deleted
    // outright, so if anything below still fails, nothing is ever lost: at
    // worst the caller sees an error pointing at the staged/backup paths for
    // manual recovery.
    //
    // rename() can still throw ENOTEMPTY/EPERM/EBUSY on a network share
    // (e.g. the destination briefly still appears non-empty per the SMB
    // client's own cache, or an AV/indexer holds a transient handle) —
    // withFsRetry covers that residual flakiness, the same belt
    // scaffold.ts already needed for this project's share (see fsRetry.ts).
    const stagingDir = `${sourceDir}.vic-staging-${Date.now()}`;
    const backupDir = `${sourceDir}.vic-backup-${Date.now()}`;
    await withFsRetry(() =>
      cp(isolatedRoot, stagingDir, {
        recursive: true,
        // Drop .git AND node_modules — an agent's `npm install` output must
        // not be synced onto the (often SMB) project folder.
        filter: mergeBackCopyFilter,
      }),
    );
    try {
      await withFsRetry(() => rename(sourceDir, backupDir));
    } catch (err) {
      // sourceDir itself is untouched (this rename never took effect) — the
      // only cleanup needed is the staged copy, which was never consumed.
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `Failed to merge Coding output back into ${sourceDir} — the original folder is untouched, and the run's new output was safely discarded. The run can be retried. Underlying error: ${(err as Error).message}`,
      );
    }
    try {
      await withFsRetry(() => rename(stagingDir, sourceDir));
    } catch (err) {
      // The old content was already moved aside (backupDir) before this
      // step failed — restore it so sourceDir is never left missing.
      await rename(backupDir, sourceDir).catch(() => {});
      throw new Error(
        `Failed to merge Coding output back into ${sourceDir} — the original folder was restored, and the run's new output is preserved at ${stagingDir} for manual recovery if the restore above also failed. Underlying error: ${(err as Error).message}`,
      );
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});

    return { result, diff, changedPaths };
  } finally {
    // Best-effort cleanup of the throwaway local temp copy — deliberately
    // swallowed, not retried or rethrown. This is disposable scratch space
    // (os.tmpdir(), never the real project), so a transient EBUSY/ENOTEMPTY
    // here (an AV/indexer briefly holding a handle, the same class of
    // flakiness withFsRetry works around elsewhere) has zero bearing on
    // whether the run itself succeeded. Before this guard, a `finally` that
    // throws silently replaces whatever the `try` block was about to
    // return — including a fully successful run — which surfaced as a
    // genuinely completed Coding run being reported as 'cli-error' purely
    // because leftover temp-folder cleanup hit a transient error on the way
    // out. A stray vic-coding-* folder left behind under os.tmpdir() is a
    // trivial, self-cleaning-on-reboot cost next to silently discarding a
    // real result.
    await rm(isolatedRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export interface HarnessWorkspaceResult<T> {
  result: T;
  diff: string;
  changedPaths: string[];
  // Paths the harness run wrote INSIDE a non-harness element's folder.
  // These were reverted in the isolated copy and never merged back — the
  // run still succeeds, but the caller surfaces one warning per path (it
  // may signal a missing requirement or interface). Empty on a clean run.
  outOfScopeReverted: string[];
}

// The harness element's counterpart to withIsolatedElementWorkspace
// (project harness feature). The harness is the composition root: it must
// READ every element's code to wire it, and WRITE the entry point + its own
// _harness/ folder — so, unlike a normal element run, the ENTIRE src tree
// is copied into the isolated workspace, not one subfolder.
//
// Element folders are protected by a portable, two-part mechanism rather
// than an OS-level wall: (1) buildCodingPrompt tells the harness in plain
// words it may only write the src root + _harness/, and must stop and
// report if it thinks an element needs changing; (2) here, after the run,
// any change inside a non-harness element folder is reverted in the
// isolated copy and reported back as outOfScopeReverted — the run still
// succeeds, the caller attaches a warning. Merge-back keeps only _harness/
// and files written at the src-tree root (the entry point).
export async function withHarnessWorkspace<T>(
  srcRoot: string,
  harnessSlug: string,
  elementSlugs: string[],
  fn: (isolatedCwd: string) => Promise<T>,
): Promise<HarnessWorkspaceResult<T>> {
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), "vic-harness-"));
  const protectedSlugs = elementSlugs.filter((s) => s !== harnessSlug);
  try {
    // Copy the whole src tree, excluding any per-folder .git the normal
    // per-element flow may have left behind (we init one repo at the root)
    // and any node_modules an earlier element run's agent may have created.
    await withFsRetry(() =>
      cp(srcRoot, isolatedRoot, {
        recursive: true,
        filter: mergeBackCopyFilter,
      }),
    );
    await gitInitIfNeeded(isolatedRoot);
    await writeIsolateGitExcludes(isolatedRoot);
    // Baseline-commit the copied state so a CONTENT change fn makes (e.g. a
    // harness re-run that edits an existing index.html rather than creating
    // it) is detected, not just brand-new files — same rationale as
    // withIsolatedElementWorkspace above.
    await gitCommitAll(isolatedRoot, "harness-isolate: baseline before agent run");
    const beforeStatus = await gitStatusPorcelain(isolatedRoot);

    const result = await fn(isolatedRoot);

    const afterStatus = await gitStatusPorcelain(isolatedRoot);
    const beforeSet = new Set(beforeStatus);
    let changedPaths = afterStatus.filter((p) => !beforeSet.has(p));

    // Revert anything the harness wrote inside a protected element folder.
    const isInProtectedElement = (p: string) => {
      const norm = p.split("/").join(path.sep);
      return protectedSlugs.some(
        (slug) => norm === slug || norm.startsWith(slug + path.sep),
      );
    };
    const outOfScopeReverted = changedPaths.filter(isInProtectedElement);
    if (outOfScopeReverted.length > 0) {
      await gitRevertPaths(isolatedRoot, outOfScopeReverted);
      changedPaths = changedPaths.filter((p) => !isInProtectedElement(p));
    }

    const diff = await gitDiffText(isolatedRoot);

    if (changedPaths.length === 0) {
      return { result, diff: "", changedPaths: [], outOfScopeReverted };
    }

    // Merge back file-by-file: every kept change is either under
    // <harnessSlug>/ or at the src-tree root (the entry point). Copying the
    // whole isolated tree back would also re-write untouched element
    // folders — so copy only the individual changed paths.
    for (const rel of changedPaths) {
      const relNative = rel.split("/").join(path.sep);
      const from = path.join(isolatedRoot, relNative);
      const to = path.join(srcRoot, relNative);
      const exists = await stat(from).then(
        () => true,
        () => false,
      );
      if (!exists) continue; // a delete — leave the real tree's copy in place
      await mkdir(path.dirname(to), { recursive: true });
      await withFsRetry(() => cp(from, to, { recursive: true }));
    }

    return { result, diff, changedPaths, outOfScopeReverted };
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true }).catch(() => {});
  }
}
