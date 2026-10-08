import assert from 'node:assert/strict'
import test from 'node:test'
import { compareNames, byName, foldName } from '../lib/collation.js'

/**
 * Regression tests for locale-independent collation.
 *
 * The plugin used to sort user-visible names with a hardcoded 'zh-CN' locale:
 *
 *   output.sort((left, right) => left.base.name.localeCompare(right.base.name, 'zh-CN'))
 *
 * That is only correct while every name is Chinese. The bug shows up when a
 * CJK name is sorted next to a name in another script — 'zh-CN' collation puts
 * Latin (and Cyrillic) before CJK, so a list that used to end with Chinese
 * entries suddenly starts with them:
 *
 *   input:  ['默认知识库', 'Dedicated base']
 *   zh-CN:  '默认知识库' | 'Dedicated base'
 *   fixed:  'Dedicated base' | '默认知识库'
 *
 * Note that a purely Cyrillic list does NOT expose the bug — Russian collation
 * and Chinese collation happen to agree there. The mixed test below is the one
 * that actually fails against the old code.
 */

test('a CJK name is not forced ahead of a Latin one', () => {
  const names = ['默认知识库', 'Dedicated base']
  const previous = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const fixed = [...names].sort(compareNames)

  assert.deepEqual(previous, ['默认知识库', 'Dedicated base'], 'sanity: old behaviour')
  assert.deepEqual(fixed, ['Dedicated base', '默认知识库'], 'fixed behaviour')
  assert.notDeepEqual(fixed, previous, 'this is the case the bug was about')
})

test('Chinese-only lists keep the previous zh-CN ordering', () => {
  const names = ['项目规范', '部署记录', '会议纪要', '知识库']
  const expected = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  assert.deepEqual([...names].sort(compareNames), expected)
})

test('Cyrillic names sort by Russian rules', () => {
  const names = ['Рабочие заметки', 'Архив', 'База знаний']
  assert.deepEqual([...names].sort(compareNames), ['Архив', 'База знаний', 'Рабочие заметки'])
})

test('ordering is stable across repeated sorts and mixed scripts', () => {
  const names = ['Dedicated model base', 'Архив', '默认知识库', '项目规范']
  const first = [...names].sort(compareNames)
  for (let i = 0; i < 5; i++) assert.deepEqual([...names].sort(compareNames), first)
  assert.equal(first.length, 4)
})

test('the result does not depend on the host locale', () => {
  // The old code pinned 'zh-CN'; an earlier attempt used no locale at all,
  // which made the order follow LANG. Both are wrong. compareNames classifies
  // by script, so the same input always yields the same order.
  const names = ['Dedicated model base', 'Архив', '默认知识库']
  const result = [...names].sort(compareNames)
  const zhOnly = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))

  assert.notDeepEqual(result, zhOnly, 'must not adopt a Chinese-only collation for mixed names')
  assert.equal(result[0], 'Dedicated model base')
})

test('byName builds a comparator over a selector', () => {
  const items = [{ base: { name: 'Рабочие заметки' } }, { base: { name: 'Архив' } }]
  assert.deepEqual(items.sort(byName(item => item.base.name)).map(i => i.base.name), ['Архив', 'Рабочие заметки'])
})

test('foldName lower-cases without pinning a foreign locale', () => {
  assert.equal(foldName('  АРХИВ  '), 'архив')
  assert.equal(foldName('项目规范'), '项目规范')
  assert.equal(foldName('Dedicated BASE'), 'dedicated base')
})

test('mixed names satisfy antisymmetry and transitivity, including the PR cycle', () => {
  const names = ['阿', 'a阿', 'Z', '波', '一', '丁', 'я', 'я中', 'A', '文档2', '文档10', '𠀀']
  for (const options of [undefined, { numeric: true }]) {
    for (const a of names) for (const b of names) {
      assert.equal(Math.sign(compareNames(a, b, options)) + Math.sign(compareNames(b, a, options)), 0)
      for (const c of names) if (compareNames(a, b, options) < 0 && compareNames(b, c, options) < 0)
        assert.ok(compareNames(a, c, options) < 0, JSON.stringify([a, b, c]))
    }
    const expected = [...names].sort((a,b) => compareNames(a,b,options))
    for (let i = 0; i < names.length; i++)
      assert.deepEqual([...names.slice(i), ...names.slice(0,i)].sort((a,b) => compareNames(a,b,options)), expected)
  }
})
