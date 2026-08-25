import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('browser integration is type-checked against the official DSH client contract', async () => {
  const [source, css, tsconfigText] = await Promise.all([
    readFile(new URL('../src/client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client.css', import.meta.url), 'utf8'),
    readFile(new URL('../tsconfig.json', import.meta.url), 'utf8'),
  ])
  const tsconfig = JSON.parse(tsconfigText)

  assert.ok(tsconfig.include.includes('src/**/*.tsx'))
  assert.equal(tsconfig.compilerOptions.jsx, 'react-jsx')
  assert.match(source, /ClientContext.*@deepseek-ai\/dsh-client-runtime\/client/)
  assert.match(source, /PropsRuntime.*@deepseek-ai\/dsh-client-ui-slots/)
  assert.match(source, /type ConversationSlotProps = PropsRuntime<'conversation'>/)
  assert.doesNotMatch(source, /dsh-knowledge-workspace-close/)
  assert.match(css, /\.dsh-knowledge-workspace-header \[data-xiaohei-workspace-close\]/)
  assert.match(css, /--knowledge-pane: var\(--xiaohei-plugin-pane-fill, var\(--dsw-alias-bg-base/)
  assert.doesNotMatch(source, /interface\s+(?:ClientContext|SlotService)\b/)
})
