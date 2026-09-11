import assert from 'node:assert/strict'
import test from 'node:test'
import { createDockedPanel, supportsDockedPanels } from '../lib/docked-panel-compat.js'

function harness() {
  const previous = globalThis.window
  const frames = new Map()
  let sequence = 0
  globalThis.window = {
    requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence },
    cancelAnimationFrame(id) { frames.delete(id) },
  }
  const effects = []
  const opened = []
  let current = 'a'
  let ready = true
  let disposed = false
  const child = {
    get(name) {
      return name === 'sidebarRight' ? { openTab(id) { if (!ready) throw new Error('seat not mounted'); opened.push(id) } }
        : { register() { return () => {} } }
    },
    slots: { inject(name, fn) { assert.equal(name, 'sidebar.right.pane.tab'); return fn() }, register() { return () => {} } },
    effect(fn) { effects.push(fn()) },
  }
  const ctx = {
    layout: { selectPanel() {} },
    get: () => ({ list: { getSnapshot: () => ({ current }) } }),
    inject(deps, fn) {
      assert.deepEqual(deps, ['sidebarRight', 'sidebarRightTabs'])
      fn(child)
      return { async dispose() { disposed = true; for (const effect of effects.reverse()) effect?.() } }
    },
  }
  const panel = createDockedPanel(ctx, 'test-panel', 'Test', () => null, () => {})
  return {
    panel, opened,
    switchSession(value) { current = value },
    ready(value) { ready = value },
    flush() { const entries = [...frames.entries()]; for (const [id, fn] of entries) { frames.delete(id); fn() } },
    frames,
    disposed: () => disposed,
    cleanup() { panel.dispose(); globalThis.window = previous },
  }
}

test('capability detection leaves legacy hosts on their existing path', () => {
  assert.equal(supportsDockedPanels({ layout: {} }), false)
  assert.equal(supportsDockedPanels({ layout: { selectPanel() {} } }), true)
})
test('open waits for conversation commit, then uses official page-tab navigation', () => {
  const h = harness()
  try {
    h.panel.open('a')
    assert.equal(h.panel.isOpen('a'), true)
    assert.deepEqual(h.opened, [])
    h.flush()
    assert.deepEqual(h.opened, ['test-panel'])
  } finally { h.cleanup() }
})
test('closing a pending open cancels it', () => {
  const h = harness()
  try { h.panel.open('a'); h.panel.close('a'); h.flush(); assert.deepEqual(h.opened, []) }
  finally { h.cleanup() }
})
test('session switch cannot open pending content in another session', () => {
  const h = harness()
  try {
    h.panel.open('a'); h.switchSession('b'); h.flush()
    assert.deepEqual(h.opened, [])
    assert.equal(h.panel.isOpen('a'), false)
  } finally { h.cleanup() }
})
test('temporarily unmounted seat retries and dispose cancels queued work', () => {
  const h = harness()
  try {
    h.ready(false); h.panel.open('a'); h.flush()
    assert.equal(h.frames.size, 1)
    h.ready(true); h.flush()
    assert.deepEqual(h.opened, ['test-panel'])
    h.panel.open('a'); h.panel.dispose(); h.flush()
    assert.deepEqual(h.opened, ['test-panel'])
    assert.equal(h.disposed(), true)
  } finally { h.cleanup() }
})

