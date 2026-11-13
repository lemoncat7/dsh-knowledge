import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('knowledge does not gate host versions through engines or fallback DSH peers', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  assert.equal(Object.hasOwn(pkg.engines, 'dsh'), false)
  assert.deepEqual(lock.packages[''].engines, pkg.engines)
  assert.deepEqual(lock.packages[''].peerDependencies, pkg.peerDependencies)
  for (const name of ['dsh-agent', 'dsh-client-ui-renderer', 'dsh-settings', 'dsh-tools']) {
    assert.equal(pkg.peerDependencies[`@deepseek-ai/${name}`], '*')
  }
})
