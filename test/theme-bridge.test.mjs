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

test('maps arbitrary DSH semantic tokens without depending on a theme id', () => {
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
  assert.equal(message.tokens['--bg'], 'rgb(11 24 27 / 70%)')
  assert.equal(message.tokens['--surface'], '#102022')
  assert.equal(message.tokens['--text'], '#e7f3f0')
  assert.equal(message.tokens['--accent'], '#65d1be')
  assert.equal(message.tokens['--success'], '#82d29a')
  assert.equal('themeId' in message, false)
})

test('inherits every Xiaohei plugin material level when the active theme provides it', () => {
  const message = createKnowledgeHostTheme(computed({
    '--xiaohei-plugin-workspace-fill': 'rgb(20 27 29 / 62%)',
    '--xiaohei-plugin-pane-fill': 'rgb(27 35 37 / 46%)',
    '--xiaohei-plugin-raised-fill': 'rgb(29 37 39 / 72%)',
    '--xiaohei-plugin-control-fill': 'rgb(33 42 44 / 86%)',
  }), {
    active: { colorScheme: 'dark', tokens: {} },
  })

  assert.equal(message.tokens['--bg'], 'rgb(20 27 29 / 62%)')
  assert.equal(message.tokens['--surface'], 'rgb(27 35 37 / 46%)')
  assert.equal(message.tokens['--surface-raised'], 'rgb(29 37 39 / 72%)')
  assert.equal(message.tokens['--surface-soft'], 'rgb(33 42 44 / 86%)')
})

test('uses snapshot overrides when the presenter has not painted them yet', () => {
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

  assert.equal(message.tokens['--bg'], '#f6f7f8')
  assert.equal(message.tokens['--surface'], '#f6f7f8')
  assert.equal(message.tokens['--text'], '#18191b')
  assert.equal(message.tokens['--accent'], '#2468d8')
  assert.equal(message.tokens['--accent-hover'], '#2468d8')
  assert.equal(message.tokens['--danger-soft'], '#fdebec')
  assert.equal(message.tokens['--shadow'], '0 18px 48px rgb(30 45 70 / 10%)')
})
