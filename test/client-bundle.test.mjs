import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('browser bundle registers the sidebar knowledge panel', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/)
  assert.match(source, /sidebar\.footer\.action/)
  assert.match(source, /managementAvailable/)
  assert.match(source, /managementPath/)
  assert.match(source, /\\u8FD9\\u53F0 DSH \\u672A\\u542F\\u7528/)
  assert.match(source, /\\u91CD\\u8BD5/)
  assert.doesNotMatch(source, /return query\.length === 0 \? "\/knowledge"/)
  assert.match(source, /dsh-knowledge-panel-title/)
  assert.match(source, /dsh-knowledge-panel--maximized/)
  assert.match(source, /1040/)
  assert.match(source, /dsh-knowledge-resize-grip/)
  assert.match(source, /ResizeObserver/)
  assert.match(source, /settings\.plugin\.item/)
  assert.match(source, /dsh-knowledge-settings-card/)
  assert.match(source, /remoteToken/)
  assert.match(source, /\/knowledge-control\/v1\/connection/)
  assert.match(source, /CONNECTION_CONTROL_PATH/)
  assert.doesNotMatch(source, /settings\.mutate/)
  assert.doesNotMatch(source, /settingsScope/)
})
