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
  assert.match(source, /Context as ClientContext.*@deepseek-ai\/cordis/)
  assert.match(source, /@deepseek-ai\/dsh-client-ui-session\/client/)
  assert.match(source, /@deepseek-ai\/dsh-client-ui-chat\/client/)
  assert.match(source, /PropsRuntime.*@deepseek-ai\/dsh-client-ui-slots/)
  assert.match(source, /type ConversationSlotProps = PropsRuntime<'conversation'>/)
  assert.doesNotMatch(source, /dsh-knowledge-workspace-close/)
  assert.match(css, /\.dsh-knowledge-workspace-header \[data-xiaohei-workspace-close\]/)
  assert.match(css, /\.dsh-knowledge-frame \{[\s\S]*?width: 100%;[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/)
  assert.match(css, /\.dsh-knowledge-trigger \{[\s\S]*?width: calc\(100% \+ 4px\);[\s\S]*?height: 42px;[\s\S]*?margin: 4px -2px;[\s\S]*?padding: 0 10px 0 8px;/)
  assert.doesNotMatch(css, /\.dsh-knowledge-trigger::before/)
  assert.match(css, /--knowledge-canvas: #ebebeb/)
  assert.match(css, /--knowledge-pane: #f4f4f4/)
  assert.match(css, /body\[data-ds-dark-theme\][\s\S]*--knowledge-canvas: #101719/)
  assert.match(css, /body\[data-ds-dark-theme\][\s\S]*--knowledge-pane: #182022/)
  assert.match(css, /body\[data-ds-dark-theme\][\s\S]*--knowledge-accent: #69b6ba/)
  assert.match(css, /\.dsh-knowledge-workspace \{[\s\S]*?background: transparent;/)
  assert.doesNotMatch(css, /--dsw-|--xiaohei-plugin-/)
  assert.doesNotMatch(source, /interface\s+(?:ClientContext|SlotService)\b/)
  assert.match(css, /\.dsh-knowledge-writeback-destinations/)
  assert.match(css, /\.dsh-knowledge-writeback-status \.dsh-knowledge-writeback-document/)
  assert.match(css, /\.dsh-knowledge-writeback-document:hover[\s\S]*?background: var\(--knowledge-hover\)/)
  assert.doesNotMatch(css, /\.dsh-knowledge-writeback-destinations li \{[^}]*background: var\(--knowledge-control\)/)
  assert.match(css, /overflow: hidden;[\s\S]*?text-overflow: ellipsis;/)
})
