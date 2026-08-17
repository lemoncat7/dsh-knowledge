import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('browser bundle registers the sidebar knowledge panel', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/)
  assert.match(source, /sidebar\.footer\.action/)
  assert.match(source, /\/knowledge/)
  assert.match(source, /dsh-knowledge-panel-title/)
})
