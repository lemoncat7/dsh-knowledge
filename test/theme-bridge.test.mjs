import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createKnowledgeHostTheme,
  KNOWLEDGE_THEME_MESSAGE,
  KNOWLEDGE_THEME_PROTOCOL_VERSION,
} from '../lib/theme-bridge.js'

function computed(values) {
  return { getPropertyValue: name => values[name] || '' }
}

test('uses an opaque stable dark workspace palette without depending on a theme id', () => {
  const message = createKnowledgeHostTheme(computed({
    '--dsw-alias-bg-layer-1': 'rgb(11 24 27 / 70%)',
    '--dsw-alias-bg-layer-2': '#102022',
    '--dsw-alias-label-primary': '#e7f3f0',
    '--dsw-alias-button-primary-fill': '#65d1be',
    '--dsw-alias-state-success-primary': '#82d29a',
  }), {
    active: { colorScheme: 'dark', tokens: {} },
  })

  assert.equal(message.type, KNOWLEDGE_THEME_MESSAGE)
  assert.equal(message.version, KNOWLEDGE_THEME_PROTOCOL_VERSION)
  assert.equal(message.colorScheme, 'dark')
  assert.equal(message.tokens['--bg'], '#1c1c1e')
  assert.equal(message.tokens['--surface'], '#2c2c2e')
  assert.equal(message.tokens['--surface-raised'], '#323235')
  assert.equal(message.tokens['--dialog-surface'], '#323235')
  assert.equal(message.tokens['--text'], '#f5f5f7')
  assert.equal(message.tokens['--accent'], '#e5e5ea')
  assert.equal(message.tokens['--success'], '#30d158')
  assert.equal('themeId' in message, false)
})

test('does not let host material levels fragment the workspace hierarchy', () => {
  const message = createKnowledgeHostTheme(computed({
    '--xiaohei-plugin-workspace-fill': 'rgb(20 27 29 / 62%)',
    '--xiaohei-plugin-pane-fill': 'rgb(27 35 37 / 46%)',
    '--xiaohei-plugin-raised-fill': 'rgb(29 37 39 / 72%)',
    '--xiaohei-plugin-control-fill': 'rgb(33 42 44 / 86%)',
  }), {
    active: { colorScheme: 'dark', tokens: {} },
  })

  assert.equal(message.tokens['--bg'], '#1c1c1e')
  assert.equal(message.tokens['--surface'], '#2c2c2e')
  assert.equal(message.tokens['--surface-raised'], '#323235')
  assert.equal(message.tokens['--surface-soft'], 'rgb(255 255 255 / 6%)')
})

test('uses the light workspace palette when the host is light', () => {
  const message = createKnowledgeHostTheme(computed({}), {
    active: {
      colorScheme: 'light',
      tokens: {
        '--dsw-alias-bg-layer-1': '#f6f7f8',
        '--dsw-alias-label-primary': '#18191b',
        '--dsw-alias-brand-primary': '#2468d8',
      },
    },
  })

  assert.equal(message.tokens['--bg'], '#ebebeb')
  assert.equal(message.tokens['--surface'], '#f4f4f4')
  assert.equal(message.tokens['--dialog-surface'], '#fafafa')
  assert.equal(message.tokens['--text'], '#1d1d1f')
  assert.equal(message.tokens['--accent'], '#3a3a3c')
  assert.equal(message.tokens['--accent-hover'], '#1d1d1f')
  assert.equal(message.tokens['--danger-soft'], '#ffebed')
  assert.equal(message.tokens['--shadow'], '0 24px 64px rgb(0 0 0 / 20%)')
})
