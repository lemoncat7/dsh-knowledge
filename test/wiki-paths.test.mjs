import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertPageTargetSafe,
  isPathInside,
  normalizePageRelPath,
  pageTargetPath,
  resolveWikiLayout,
} from '../lib/wiki/paths.js'

const roots = []
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-paths-'))
  roots.push(root)
  return root
}
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function makeLayout(root) {
  await mkdir(join(root, 'inbox'), { recursive: true })
  await mkdir(join(root, 'outside'), { recursive: true })
  const layout = resolveWikiLayout({
    kbId: 'kb-paths',
    sourceDir: join(root, 'inbox'),
    workspaceRoot: join(root, 'workspace'),
  })
  await mkdir(layout.pageDir, { recursive: true })
  await mkdir(layout.rawDir, { recursive: true })
  await mkdir(layout.metaDir, { recursive: true })
  return layout
}

function codeOf(error) {
  return error && typeof error === 'object' ? error.code : undefined
}

test('layout resolves normal wiki/raw siblings and an external raw directory', async () => {
  const root = await tempRoot()
  const layout = await makeLayout(root)
  assert.equal(layout.pageDir, join(root, 'workspace', 'wiki'))
  assert.equal(layout.rawDir, join(root, 'workspace', 'raw'))
  assert.equal(layout.metaDir, join(root, 'workspace', '_meta', 'knowledge'))

  const external = resolveWikiLayout({
    kbId: 'kb-paths',
    sourceDir: join(root, 'inbox'),
    workspaceRoot: join(root, 'workspace'),
    rawDir: join(root, 'outside', 'raw'),
  })
  assert.equal(external.rawDir, join(root, 'outside', 'raw'))
})

test('dangerous overlaps and reserved output roots are rejected', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'workspace'), { recursive: true })
  assert.throws(
    () => resolveWikiLayout({ kbId: 'kb', sourceDir: join(root, 'workspace'), workspaceRoot: join(root, 'workspace') }),
    error => codeOf(error) === 'OVERLAP',
  )
  assert.throws(
    () => resolveWikiLayout({
      kbId: 'kb',
      sourceDir: join(root, 'inbox'),
      workspaceRoot: join(root, 'workspace'),
      rawDir: join(root, 'inbox'),
    }),
    error => codeOf(error) === 'OVERLAP',
  )
  assert.throws(
    () => resolveWikiLayout({
      kbId: 'kb',
      sourceDir: join(root, 'inbox'),
      workspaceRoot: join(root, 'workspace'),
      pageDir: join(root, 'workspace', 'documents'),
    }),
    error => codeOf(error) === 'RESERVED_PATH',
  )
})

test('drive roots and user home are unsafe layout roots', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'workspace'), { recursive: true })
  assert.throws(
    () => resolveWikiLayout({ kbId: 'kb', sourceDir: resolve('/'), workspaceRoot: join(root, 'workspace') }),
    error => codeOf(error) === 'UNSAFE_ROOT',
  )
})

test('page paths reject traversal, reserved names and foreign extensions', async () => {
  assert.equal(normalizePageRelPath('notes/甲 笔记.md'), 'notes/甲 笔记.md')
  const rejected = [
    '../escape.md',
    '/absolute/page.md',
    'C:/absolute/page.md',
    'notes\\windows.md',
    'notes//double.md',
    './notes/page.md',
    'notes/../page.md',
    '_meta/manifest.json',
    'notes/_meta/page.md',
    'index.md',
    'log.md',
    'schema.md',
    'notes/page.txt',
    'notes/CON.md',
    'notes/page.md ',
  ]
  for (const relPath of rejected) {
    assert.throws(() => normalizePageRelPath(relPath), error => codeOf(error) === 'PATH_ESCAPE' || codeOf(error) === 'RESERVED_PATH', relPath)
  }
  const root = await tempRoot()
  const layout = await makeLayout(root)
  assert.throws(() => pageTargetPath(layout, '../escape.md'), error => codeOf(error) === 'PATH_ESCAPE')
  assert.deepEqual(await assertPageTargetSafe(layout, 'notes/safe.md'), pageTargetPath(layout, 'notes/safe.md'))
})

test('a junction inside the page tree cannot escape the page root', async t => {
  const root = await tempRoot()
  const layout = await makeLayout(root)
  try {
    await symlink(join(root, 'outside'), join(layout.pageDir, 'link'), 'junction')
  } catch (error) {
    t.skip(`junction creation is unavailable: ${error.code}`)
    return
  }
  await assert.rejects(
    assertPageTargetSafe(layout, 'link/escaped.md'),
    error => codeOf(error) === 'PATH_ESCAPE',
  )
})

test('isPathInside compares case-insensitively on Windows only', () => {
  assert.equal(isPathInside('C:/base', 'C:/base/wiki/a.md'), true)
  assert.equal(isPathInside('C:/base', 'C:/base-other/a.md'), false)
  if (process.platform === 'win32') assert.equal(isPathInside('C:\\BASE', 'c:\\base\\wiki\\a.md'), true)
})
