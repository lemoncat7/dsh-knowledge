import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('knowledge advertises host compatibility to plugin installers, not only its README', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  for (const name of ['dsh-agent', 'dsh-client-ui-renderer', 'dsh-settings', 'dsh-tools']) {
    assert.equal(pkg.peerDependencies[`@deepseek-ai/${name}`], '^0.2.0-rc.2')
    assert.equal(lock.packages[''].peerDependencies[`@deepseek-ai/${name}`], '^0.2.0-rc.2')
  }
})
