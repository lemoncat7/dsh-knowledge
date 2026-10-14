import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('note @ source is registered through the optional host service with lifecycle cleanup', async () => {
  const client = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-input-trigger'))
  assert.match(client, /ctx\.inject\(\['inputTriggers'\]/)
  assert.match(client, /scoped\.effect\(\(\) => scoped\.inputTriggers\.registerSource\(createNoteMentionSource/)
  assert.match(client, /workspace\.openDocument\(\{ view: 'notes', noteId \}\)/)
  assert.doesNotMatch(client, /MutationObserver|querySelector.*contenteditable/)
})
