import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openLocalSourceTree, syncTreeInPlace } from '../src/localSourceTree.js'
import { sourceTreeRoot } from '../src/scaffold.js'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function tempProjectDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-localsrc-test-'))
}

test('openLocalSourceTree starts with an empty local copy when the real srcRoot does not exist yet', async () => {
  const projectDir = await tempProjectDir()
  try {
    const srcRoot = sourceTreeRoot(projectDir)
    const session = await openLocalSourceTree(srcRoot)
    try {
      assert.equal(await exists(session.localSrcRoot), false, 'local copy should not pre-create the src dir itself — nothing existed to copy')
    } finally {
      await session.syncBackAndDispose()
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('openLocalSourceTree copies existing real content down, and syncBackAndDispose copies it back up unchanged if nothing was modified', async () => {
  const projectDir = await tempProjectDir()
  try {
    const srcRoot = sourceTreeRoot(projectDir)
    await mkdir(path.join(srcRoot, 'my-element'), { recursive: true })
    await writeFile(path.join(srcRoot, 'my-element', 'existing.txt'), 'original content', 'utf8')

    const session = await openLocalSourceTree(srcRoot)
    assert.equal(
      await readFile(path.join(session.localSrcRoot, 'my-element', 'existing.txt'), 'utf8'),
      'original content',
      'local copy must contain the real content that existed before the session opened',
    )
    await session.syncBackAndDispose()

    assert.equal(
      await readFile(path.join(srcRoot, 'my-element', 'existing.txt'), 'utf8'),
      'original content',
      'real srcRoot must still have the same content after a no-op session',
    )
    assert.equal(await exists(session.localSrcRoot), false, 'the local temp copy must be disposed of after syncBackAndDispose')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('syncBackAndDispose propagates changes made to the local copy back to the real srcRoot', async () => {
  const projectDir = await tempProjectDir()
  try {
    const srcRoot = sourceTreeRoot(projectDir)
    await mkdir(path.join(srcRoot, 'my-element'), { recursive: true })
    await writeFile(path.join(srcRoot, 'my-element', 'existing.txt'), 'original content', 'utf8')

    const session = await openLocalSourceTree(srcRoot)
    // Simulate what a Coding run does inside the local copy: modify an
    // existing file and add a new one.
    await writeFile(path.join(session.localSrcRoot, 'my-element', 'existing.txt'), 'modified content', 'utf8')
    await writeFile(path.join(session.localSrcRoot, 'my-element', 'new-file.txt'), 'brand new', 'utf8')
    await session.syncBackAndDispose()

    assert.equal(await readFile(path.join(srcRoot, 'my-element', 'existing.txt'), 'utf8'), 'modified content')
    assert.equal(await readFile(path.join(srcRoot, 'my-element', 'new-file.txt'), 'utf8'), 'brand new')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('syncBackAndDispose on a project with no prior srcRoot creates it fresh from the local copy', async () => {
  const projectDir = await tempProjectDir()
  try {
    const srcRoot = sourceTreeRoot(projectDir)
    const session = await openLocalSourceTree(srcRoot)
    await mkdir(path.join(session.localSrcRoot, 'first-element'), { recursive: true })
    await writeFile(path.join(session.localSrcRoot, 'first-element', 'index.html'), '<html></html>', 'utf8')
    await session.syncBackAndDispose()

    assert.equal(await readFile(path.join(srcRoot, 'first-element', 'index.html'), 'utf8'), '<html></html>')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('syncTreeInPlace reconciles dest to match source without renaming dest itself (rename-swap fallback)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vic-synctree-test-'))
  try {
    const source = path.join(root, 'source')
    const dest = path.join(root, 'dest')
    // dest starts with: an unchanged file, a file whose content changes, a
    // file that gets deleted, a whole folder that gets deleted, and a .git
    // dir that must survive untouched.
    await mkdir(path.join(dest, 'el', 'sub'), { recursive: true })
    await mkdir(path.join(dest, 'gone-dir'), { recursive: true })
    await mkdir(path.join(dest, '.git'), { recursive: true })
    await writeFile(path.join(dest, 'el', 'unchanged.txt'), 'same', 'utf8')
    await writeFile(path.join(dest, 'el', 'changes.txt'), 'old', 'utf8')
    await writeFile(path.join(dest, 'el', 'removed.txt'), 'bye', 'utf8')
    await writeFile(path.join(dest, 'gone-dir', 'x.txt'), 'bye', 'utf8')
    await writeFile(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8')

    await mkdir(path.join(source, 'el', 'sub'), { recursive: true })
    await writeFile(path.join(source, 'el', 'unchanged.txt'), 'same', 'utf8')
    await writeFile(path.join(source, 'el', 'changes.txt'), 'new', 'utf8')
    await writeFile(path.join(source, 'el', 'sub', 'added.txt'), 'hello', 'utf8')

    await syncTreeInPlace(source, dest)

    assert.equal(await readFile(path.join(dest, 'el', 'unchanged.txt'), 'utf8'), 'same')
    assert.equal(await readFile(path.join(dest, 'el', 'changes.txt'), 'utf8'), 'new')
    assert.equal(await readFile(path.join(dest, 'el', 'sub', 'added.txt'), 'utf8'), 'hello')
    assert.equal(await exists(path.join(dest, 'el', 'removed.txt')), false, 'removed file should be gone')
    assert.equal(await exists(path.join(dest, 'gone-dir')), false, 'removed folder should be gone')
    assert.equal(await readFile(path.join(dest, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main', '.git must be left untouched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('syncBackAndDispose does not leak the .git directory created inside the local copy into the real srcRoot', async () => {
  const projectDir = await tempProjectDir()
  try {
    const srcRoot = sourceTreeRoot(projectDir)
    const session = await openLocalSourceTree(srcRoot)
    await mkdir(path.join(session.localSrcRoot, '.git'), { recursive: true })
    await writeFile(path.join(session.localSrcRoot, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8')
    await mkdir(path.join(session.localSrcRoot, 'my-element'), { recursive: true })
    await writeFile(path.join(session.localSrcRoot, 'my-element', 'file.txt'), 'content', 'utf8')
    await session.syncBackAndDispose()

    assert.equal(await exists(path.join(srcRoot, '.git')), false, '.git must not be synced back to the real srcRoot')
    assert.equal(await readFile(path.join(srcRoot, 'my-element', 'file.txt'), 'utf8'), 'content')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})
