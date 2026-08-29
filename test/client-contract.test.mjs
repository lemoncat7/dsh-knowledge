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
  assert.match(css, /\.dsh-knowledge-trigger \{[\s\S]*?position: relative;[\s\S]*?max-width: 100%;[\s\S]*?width: 100%;/)
  assert.doesNotMatch(css, /width: calc\(100% \+ 8px\)|margin: 4px -4px/)
  assert.match(css, /\.dsh-knowledge-trigger::before \{[\s\S]*?transform 720ms cubic-bezier\(\.2, \.72, \.2, 1\);/)
  assert.match(css, /\.dsh-knowledge-trigger:hover::before \{[\s\S]*?translate3d\(320%, 0, 0\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dsh-knowledge-trigger::before \{ display: none; \}/)
  assert.match(css, /--knowledge-pane: rgb\(242 243 247 \/ 78%\)/)
  assert.match(css, /body\[data-ds-dark-theme\][\s\S]*--knowledge-pane: rgb\(44 44 46 \/ 78%\)/)
  assert.doesNotMatch(source, /interface\s+(?:ClientContext|SlotService)\b/)
})
