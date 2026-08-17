import spawn from 'cross-spawn'
import { existsSync } from 'node:fs'
import path from 'node:path'

// Each project's generated source tree is its own local git repository —
// gives real `git diff`/`git status --porcelain` for free (rather than a
// bespoke file-snapshot diff format), a natural place to auto-commit each
// accepted Coding run, and reuses the exact same pre/post snapshot the
// write-scope gate (scopeGate.ts) needs. Much simpler than
// ClaudeCodeCliClient's runCli — git takes args, not a piped prompt.
function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { shell: false, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      reject(new Error(`Failed to run git: ${err.message}. Is git installed and on PATH?`))
    })
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode })
    })
  })
}

// Every project's src root lives on VIC's shared network drive (see
// PROJECTS_ROOT in packages/server/src/index.ts), which Windows often can't
// resolve a SID for ("inconvertible" owner) — git's safe.directory check
// then refuses to touch the repo at all ("detected dubious ownership"),
// even for a repo VIC itself created. Registering it globally trusted is
// safe here since VIC already treats the whole shared drive as trusted (no
// auth, shared users.json, etc — see usersStore.ts). Runs on every call,
// not just first-init, since a repo created by VIC on a previous run (or by
// a different machine sharing this same drive) can still hit this the
// first time *this* machine's git touches it.
async function markSafeDirectory(srcRoot: string): Promise<void> {
  await runGit(['config', '--global', '--add', 'safe.directory', srcRoot], srcRoot)
}

// Idempotent: does nothing beyond markSafeDirectory + the HEAD check below
// if srcRoot is already a git repo *with* a commit. Makes one empty initial
// commit so gitDiffText's `git diff HEAD` always has a baseline to diff
// against, avoiding a separate no-commits-yet code path.
//
// Checks for an actual HEAD, not just a .git folder's existence — a repo
// can have a .git folder with files staged but never committed (e.g. an
// interrupted run: `git init` succeeded, files got `git add`ed by
// gitStatusPorcelain/gitDiffText, but this function's own commit step below
// never ran for that repo, or a since-fixed bug skipped it). Repeating
// `git init` on an existing repo is itself a safe no-op, so this always
// re-checks and repairs a HEAD-less repo rather than trusting a prior
// partial run left it in the state this function is meant to guarantee.
export async function gitInitIfNeeded(srcRoot: string): Promise<void> {
  await markSafeDirectory(srcRoot)
  if (existsSync(path.join(srcRoot, '.git'))) {
    const headCheck = await runGit(['rev-parse', '--verify', 'HEAD'], srcRoot)
    if (headCheck.exitCode === 0) return
  } else {
    const init = await runGit(['init'], srcRoot)
    if (init.exitCode !== 0) {
      throw new Error(`git init failed in ${srcRoot}: ${init.stderr}`)
    }
  }
  await runGit(['config', 'user.email', 'vic@localhost'], srcRoot)
  await runGit(['config', 'user.name', 'VIC'], srcRoot)
  const commit = await runGit(['commit', '--allow-empty', '-m', 'Initial commit (VIC source tree scaffold)'], srcRoot)
  if (commit.exitCode !== 0) {
    throw new Error(`git commit (initial) failed in ${srcRoot}: ${commit.stderr}`)
  }
}

// Parsed `git status --porcelain` output: relative paths of every
// changed/untracked file, regardless of status character — the write-scope
// gate only needs "did this path change," not the specific status.
//
// Stages everything first (git add -A) so git reports individual file
// paths rather than collapsing a wholly-untracked directory into a single
// "dirname/" entry — without this, a second new file added to an
// already-untracked subfolder (e.g. auth-service/) would be masked behind
// the same collapsed "auth-service/" entry the pre-run snapshot already
// recorded, making the write-scope gate blind to it. Staging is
// side-effect-free for callers: gitCommitAll/gitDiffText both stage again
// immediately before their own operation regardless.
export async function gitStatusPorcelain(srcRoot: string): Promise<string[]> {
  const add = await runGit(['add', '-A'], srcRoot)
  if (add.exitCode !== 0) {
    throw new Error(`git add failed in ${srcRoot}: ${add.stderr}`)
  }
  const result = await runGit(['status', '--porcelain'], srcRoot)
  if (result.exitCode !== 0) {
    throw new Error(`git status failed in ${srcRoot}: ${result.stderr}`)
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // Porcelain lines are "XY <path>" (or "XY <path> -> <path>" for
      // renames, not expected here since nothing renames files mid-run) —
      // strip the two status chars and the following space.
      const relativePath = line.slice(3).trim()
      return relativePath.startsWith('"') && relativePath.endsWith('"') ? relativePath.slice(1, -1) : relativePath
    })
}

// `git diff HEAD` alone never shows untracked (new) files, only modified
// tracked ones — so this stages everything first (git add -A is itself
// idempotent/side-effect-free for the caller, since gitCommitAll stages
// again immediately before committing) to get a complete diff including
// new files.
export async function gitDiffText(srcRoot: string): Promise<string> {
  const add = await runGit(['add', '-A'], srcRoot)
  if (add.exitCode !== 0) {
    throw new Error(`git add failed in ${srcRoot}: ${add.stderr}`)
  }
  const result = await runGit(['diff', '--cached', 'HEAD'], srcRoot)
  if (result.exitCode !== 0) {
    throw new Error(`git diff failed in ${srcRoot}: ${result.stderr}`)
  }
  return result.stdout
}

// Restores the working tree to HEAD, discarding all uncommitted changes —
// used when a run must be rejected after the fact (e.g. a "recode from
// scratch" wipe that the agent never actually replaced with new content):
// the wipe itself was never committed, so this simply undoes it, leaving
// the element's folder exactly as it was before the run started.
export async function gitResetHardToHead(srcRoot: string): Promise<void> {
  const reset = await runGit(['reset', '--hard', 'HEAD'], srcRoot)
  if (reset.exitCode !== 0) {
    throw new Error(`git reset --hard failed in ${srcRoot}: ${reset.stderr}`)
  }
  const clean = await runGit(['clean', '-fd'], srcRoot)
  if (clean.exitCode !== 0) {
    throw new Error(`git clean failed in ${srcRoot}: ${clean.stderr}`)
  }
}

export async function gitCommitAll(srcRoot: string, message: string): Promise<void> {
  const add = await runGit(['add', '-A'], srcRoot)
  if (add.exitCode !== 0) {
    throw new Error(`git add failed in ${srcRoot}: ${add.stderr}`)
  }
  const commit = await runGit(['commit', '-m', message, '--allow-empty'], srcRoot)
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed in ${srcRoot}: ${commit.stderr}`)
  }
}

// Reverts exactly the given relative paths — used by the write-scope gate
// on violation, leaving in-scope changes from the same run intact. Status
// is re-checked per path rather than assumed, since a path might be new
// (never existed in HEAD -> unstage + delete) or pre-existing/modified
// (-> checkout-restore from HEAD). "New" is determined by whether HEAD has
// a blob for the path (git cat-file -e), not by the porcelain status
// letter — the write-scope gate's own gitStatusPorcelain snapshot stages
// everything first (git add -A), so a brand-new file already shows as
// staged ("A ") rather than untracked ("??") by the time this runs, and
// `git checkout HEAD -- <path>` fails on a path HEAD has never seen.
export async function gitRevertPaths(srcRoot: string, relativePaths: string[]): Promise<void> {
  if (relativePaths.length === 0) return

  const newPaths: string[] = []
  const existingPaths: string[] = []
  for (const relativePath of relativePaths) {
    const check = await runGit(['cat-file', '-e', `HEAD:${relativePath.split(path.sep).join('/')}`], srcRoot)
    if (check.exitCode === 0) {
      existingPaths.push(relativePath)
    } else {
      newPaths.push(relativePath)
    }
  }

  if (newPaths.length > 0) {
    const reset = await runGit(['reset', '--', ...newPaths], srcRoot)
    if (reset.exitCode !== 0) {
      throw new Error(`git reset failed reverting out-of-scope files in ${srcRoot}: ${reset.stderr}`)
    }
    const clean = await runGit(['clean', '-fd', '--', ...newPaths], srcRoot)
    if (clean.exitCode !== 0) {
      throw new Error(`git clean failed reverting out-of-scope files in ${srcRoot}: ${clean.stderr}`)
    }
  }
  if (existingPaths.length > 0) {
    const checkout = await runGit(['checkout', 'HEAD', '--', ...existingPaths], srcRoot)
    if (checkout.exitCode !== 0) {
      throw new Error(`git checkout failed reverting out-of-scope files in ${srcRoot}: ${checkout.stderr}`)
    }
  }
}
