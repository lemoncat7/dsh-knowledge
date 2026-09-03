const HOST_THEME_MESSAGE = '@lemoncat7/dsh-knowledge/host-theme'
const HOST_THEME_READY_MESSAGE = '@lemoncat7/dsh-knowledge/host-theme-ready'
const HOST_THEME_PROTOCOL_VERSION = 1
const COLOR_TOKENS = new Set([
  '--bg', '--surface', '--surface-raised', '--surface-soft', '--surface-hover', '--dialog-surface',
  '--text', '--text-secondary', '--text-tertiary', '--border', '--border-strong',
  '--accent', '--accent-hover', '--accent-soft', '--on-accent',
  '--success', '--success-soft', '--warning', '--warning-soft', '--danger', '--danger-soft',
])
const STYLE_TOKENS = new Set(['--shadow'])

function referrerOrigin() {
  if (!document.referrer) return ''
  try {
    const origin = new URL(document.referrer).origin
    return origin === 'null' ? '' : origin
  } catch {
    return ''
  }
}

/** Synchronise only the host colour scheme and the explicitly allowed tokens. */
export function installHostThemeBridge() {
  if (window.parent === window) return Promise.resolve()
  const parentOrigin = referrerOrigin()
  return new Promise(resolve => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      window.clearTimeout(fallback)
      resolve()
    }
    const fallback = window.setTimeout(settle, 160)
    window.addEventListener('message', event => {
      if (event.source !== window.parent || (parentOrigin && event.origin !== parentOrigin)) return
      const message = event.data
      if (!message || message.type !== HOST_THEME_MESSAGE || message.version !== HOST_THEME_PROTOCOL_VERSION) return
      if (message.colorScheme !== 'light' && message.colorScheme !== 'dark') return
      if (!message.tokens || typeof message.tokens !== 'object' || Array.isArray(message.tokens)) return

      const root = document.documentElement
      for (const name of [...COLOR_TOKENS, ...STYLE_TOKENS]) root.style.removeProperty(name)
      for (const [name, value] of Object.entries(message.tokens)) {
        if (typeof value !== 'string' || value.length === 0 || value.length > 512) continue
        if (COLOR_TOKENS.has(name) && CSS.supports('color', value)) root.style.setProperty(name, value)
        else if (STYLE_TOKENS.has(name) && CSS.supports('box-shadow', value)) root.style.setProperty(name, value)
      }
      root.dataset.dshHostTheme = 'true'
      root.dataset.colorScheme = message.colorScheme
      root.style.colorScheme = message.colorScheme
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', message.colorScheme)
      const background = root.style.getPropertyValue('--bg')
      if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background)
      settle()
    })
    window.parent.postMessage({
      type: HOST_THEME_READY_MESSAGE,
      version: HOST_THEME_PROTOCOL_VERSION,
    }, parentOrigin || '*')
  })
}

