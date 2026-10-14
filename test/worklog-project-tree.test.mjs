import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectTree, directoryChain, projectAncestors, visibleProjectRows } from '../worklog/project-tree.js'
import { projectInScope } from '../worklog/project-scope.js'

test('directory tree supplies selectable ancestors without requiring parent sessions', () => {
  const { roots, nodes } = buildProjectTree(['/work/apps/site', '/work/apps/api', '/work/packages/ui', '/workshop'])
  assert.deepEqual(roots.map(n => n.path), ['/'])
  const work = [...nodes.values()].find(n => n.path === '/work')
  assert.deepEqual(work.paths, [])
  assert.deepEqual(work.children.map(n => n.label), ['apps', 'packages'])
  assert.equal(nodes.size, 8)
  assert.equal([...nodes.values()].find(n => n.path === '/workshop').parent, roots[0].key)
})

test('tree preserves raw selected paths while grouping equivalent display paths', () => {
  const paths = ['/work/', '/work', '/work/./app', '/work/app', '/work/a/../app']
  const snapshot = [...paths]
  const { nodes } = buildProjectTree(paths)
  assert.deepEqual([...nodes.values()].find(n => n.path === '/work').paths, ['/work/', '/work'])
  assert.deepEqual([...nodes.values()].find(n => n.path === '/work/app').paths, paths.slice(2))
  assert.deepEqual(paths, snapshot)
  assert.equal(projectInScope('/work', { projects: ['/work/'], recursiveProjects: false }), false)
})

test('POSIX casing is distinct; Windows drives and UNC have separate stable roots', () => {
  const { roots, nodes } = buildProjectTree(['D:\\Work\\App', 'd:/work/app', 'E:/work/app', '\\\\host\\share\\app', '//HOST/SHARE/app', '//host/other/app', '/work', '/WORK'])
  assert.equal(roots.length, 5)
  const app = nodes.get(directoryChain('D:/Work/App').at(-1).key)
  assert.deepEqual(app.paths, ['D:\\Work\\App', 'd:/work/app'])
  assert.notEqual(directoryChain('/work').at(-1).key, directoryChain('/WORK').at(-1).key)
  assert.deepEqual(nodes.get(directoryChain('//host/share/app').at(-1).key).paths, ['\\\\host\\share\\app', '//HOST/SHARE/app'])
})

test('relative and unsupported paths remain standalone, not resolved against server cwd', () => {
  for (const path of ['work/app', '~/work', 'D:work', '\\work', '\\\\?\\D:\\work']) {
    const chain = directoryChain(path)
    assert.equal(chain.length, 1); assert.equal(chain[0].path, path)
  }
  assert.deepEqual(directoryChain(''), []); assert.deepEqual(directoryChain(null), [])
  assert.deepEqual(directoryChain('/work\0private'), [])
})

test('display ancestry agrees with recursive capture on dot segments and roots', () => {
  for (const path of ['/work/../private/app', '/work/a/../b', '/', 'D:/work/../private/app', '//host/share/a/../b']) {
    const chain = directoryChain(path)
    for (const ancestor of chain) assert.equal(projectInScope(path, { projects: [ancestor.path], recursiveProjects: true }), true)
  }
  assert.ok(!directoryChain('/work/../private').some(n => n.path === '/work'))
})

test('expansion is independent from selection, rows preserve depth and sibling metadata', () => {
  const { roots } = buildProjectTree(['/work/a', '/work/b', '/other'])
  assert.deepEqual(visibleProjectRows(roots, new Set()).map(r => r.node.path), ['/'])
  const expanded = projectAncestors(['/work/a'])
  const rows = visibleProjectRows(roots, expanded)
  assert.deepEqual(rows.map(r => r.node.path), ['/', '/other', '/work', '/work/a', '/work/b'])
  assert.deepEqual(rows.map(r => r.depth), [0, 1, 1, 2, 2])
  assert.equal(rows.at(-1).position, 2); assert.equal(rows.at(-1).size, 2)
})

test('duplicate paths and special names do not collide; large forests remain collapsed', () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `/work/project-${i}`)
  const { roots, nodes } = buildProjectTree([...paths, paths[0], '/work/__proto__', '/work/constructor', '/work/含 空格'])
  assert.equal(nodes.size, 1005)
  assert.equal(visibleProjectRows(roots, new Set()).length, 1)
  assert.equal(nodes.get(directoryChain(paths[0]).at(-1).key).paths.length, 1)
})

test('default reveal opens only its ancestors across POSIX, Windows and UNC roots', () => {
  for (const root of ['/home/work', 'D:/Work', '//host/share/work']) {
    const { roots } = buildProjectTree([root, `${root}/child/deep`, '/other/project', 'E:/other/project'])
    const expanded = projectAncestors([root])
    const rows = visibleProjectRows(roots, expanded)
    const key = directoryChain(root).at(-1).key
    assert.ok(rows.some(row => row.node.key === key), 'default itself is visible')
    assert.ok(!expanded.has(key), 'default itself remains collapsed')
    assert.ok(!rows.some(row => row.node.path === `${root}/child`), 'default children stay hidden')
    assert.ok(!rows.some(row => row.node.path === '/other/project'), 'other branches stay collapsed')
    assert.ok(!rows.some(row => row.node.path === 'E:/other'), 'other roots stay collapsed')
  }
  assert.deepEqual([...projectAncestors(['', undefined, '/', 'D:/', '//host/share'])], [], 'missing defaults and filesystem roots need no ancestor expansion')
})
