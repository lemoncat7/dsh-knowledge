import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createKnowledgeHostTheme,
  KNOWLEDGE_THEME_MESSAGE,
  KNOWLEDGE_THEME_PROTOCOL_VERSION,
} from '../lib/theme-bridge.js'

test('uses an opaque stable dark workspace palette without depending on a theme id', () => {
  const message = createKnowledgeHostTheme({
    active: { colorScheme: 'dark', tokens: {} },
  })

  assert.equal(message.type, KNOWLEDGE_THEME_MESSAGE)
  assert.equal(message.version, KNOWLEDGE_THEME_PROTOCOL_VERSION)
  assert.equal(message.colorScheme, 'dark')
  assert.equal(message.tokens['--bg'], '#101719')
  assert.equal(message.tokens['--surface'], '#182022')
  assert.equal(message.tokens['--surface-raised'], '#20292b')
  assert.equal(message.tokens['--dialog-surface'], '#20292b')
  assert.equal(message.tokens['--text'], '#e3eaeb')
  assert.equal(message.tokens['--accent'], '#69b6ba')
  assert.equal(message.tokens['--accent-hover'], '#8aced0')
  assert.equal(message.tokens['--accent-soft'], 'rgb(105 182 186 / 13%)')
  assert.equal(message.tokens['--success'], '#30d158')
  assert.equal('themeId' in message, false)
})

test('does not let host material levels fragment the workspace hierarchy', () => {
  const message = createKnowledgeHostTheme({
    active: { colorScheme: 'dark', tokens: {} },
  })

  assert.equal(message.tokens['--bg'], '#101719')
  assert.equal(message.tokens['--surface'], '#182022')
  assert.equal(message.tokens['--surface-raised'], '#20292b')
  assert.equal(message.tokens['--surface-soft'], 'rgb(184 204 205 / 6%)')
})

test('uses the light workspace palette when the host is light', () => {
  const message = createKnowledgeHostTheme({
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
  assert.equal(message.tokens['--dialog-surface'], '#f4f4f4')
  assert.equal(message.tokens['--text'], '#1d1d1f')
  assert.equal(message.tokens['--accent'], '#3a3a3c')
  assert.equal(message.tokens['--accent-hover'], '#1d1d1f')
  assert.equal(message.tokens['--danger-soft'], '#ffebed')
  assert.equal(message.tokens['--shadow'], '0 24px 64px rgb(0 0 0 / 20%)')
})
