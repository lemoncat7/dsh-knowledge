export const KNOWLEDGE_THEME_MESSAGE = '@lemoncat7/dsh-knowledge/host-theme'
export const KNOWLEDGE_THEME_READY_MESSAGE = '@lemoncat7/dsh-knowledge/host-theme-ready'
export const KNOWLEDGE_THEME_PROTOCOL_VERSION = 1

export type KnowledgeColorScheme = 'light' | 'dark'

export interface KnowledgeHostThemeMessage {
  type: typeof KNOWLEDGE_THEME_MESSAGE
  version: typeof KNOWLEDGE_THEME_PROTOCOL_VERSION
  colorScheme: KnowledgeColorScheme
  tokens: Record<string, string>
}

export interface ThemeSnapshotLike {
  active: {
    colorScheme: KnowledgeColorScheme
    tokens: Readonly<Record<string, string>>
  }
}

interface ComputedStyleLike {
  getPropertyValue(name: string): string
}

const TOKEN_SOURCES = {
  '--bg': ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-base'],
  '--surface': ['--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-1'],
  '--surface-raised': ['--dsw-alias-bg-layer-3', '--dsw-alias-bg-overlay', '--dsw-alias-bg-layer-2'],
  '--surface-soft': ['--dsw-alias-bg-module-platform', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-layer-2'],
  '--surface-hover': ['--dsw-alias-interactive-bg-hover', '--dsw-alias-bg-layer-3'],
  '--text': ['--dsw-alias-label-primary'],
  '--text-secondary': ['--dsw-alias-label-secondary', '--dsw-alias-label-primary-dimmed'],
  '--text-tertiary': ['--dsw-alias-label-tertiary', '--dsw-alias-label-caption'],
  '--border': ['--dsw-alias-border-l2', '--dsw-alias-divider-primary', '--dsw-alias-border-l1'],
  '--border-strong': ['--dsw-alias-border-l3', '--dsw-alias-border-l2'],
  '--accent': ['--dsw-alias-button-primary-fill', '--dsw-alias-brand-primary'],
  '--accent-hover': ['--dsw-alias-button-primary-hover', '--dsw-alias-brand-primary'],
  '--accent-soft': ['--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover-accent'],
  '--on-accent': ['--dsw-alias-label-primary-foreground', '--dsw-alias-brand-primary-invert'],
  '--success': ['--dsw-alias-state-success-primary'],
  '--success-soft': ['--dsw-alias-state-success-tertiary'],
  '--warning': ['--dsw-alias-state-warn-primary', '--dsw-alias-state-warn-label'],
  '--warning-soft': ['--dsw-alias-state-warn-tertiary'],
  '--danger': ['--dsw-alias-state-error-primary'],
  '--danger-soft': ['--dsw-alias-state-error-tertiary'],
  '--shadow': ['--dsw-shadow-lv3', '--dsw-shadow-lv2'],
} as const

const FALLBACK_TOKENS: Record<KnowledgeColorScheme, Readonly<Record<string, string>>> = {
  light: {
    '--bg': '#f5f5f7', '--surface': '#ffffff', '--surface-raised': '#ffffff',
    '--surface-soft': '#f0f0f3', '--surface-hover': '#f5f5f8',
    '--text': '#1d1d1f', '--text-secondary': '#4c4c50', '--text-tertiary': '#6e6e73',
    '--border': '#dedee3', '--border-strong': '#c7c7cc',
    '--accent': '#086bd8', '--accent-hover': '#005ab8', '--accent-soft': '#e8f2ff', '--on-accent': '#ffffff',
    '--success': '#18794e', '--success-soft': '#e8f5ee', '--warning': '#986800', '--warning-soft': '#fff4cf',
    '--danger': '#c9343a', '--danger-soft': '#fdebec', '--shadow': '0 18px 48px rgb(30 45 70 / 10%)',
  },
  dark: {
    '--bg': '#101012', '--surface': '#1c1c1e', '--surface-raised': '#242426',
    '--surface-soft': '#2c2c2e', '--surface-hover': '#303033',
    '--text': '#f5f5f7', '--text-secondary': '#c7c7cc', '--text-tertiary': '#98989d',
    '--border': '#353538', '--border-strong': '#4a4a4f',
    '--accent': '#64a8ff', '--accent-hover': '#82b8ff', '--accent-soft': '#17365d', '--on-accent': '#0c1b2c',
    '--success': '#62c596', '--success-soft': '#163a2a', '--warning': '#e7bc62', '--warning-soft': '#423414',
    '--danger': '#ff858a', '--danger-soft': '#4b2227', '--shadow': '0 16px 40px rgb(0 0 0 / 28%)',
  },
}

/** Translate DSH's public semantic palette into the knowledge console's tokens. */
export function createKnowledgeHostTheme(
  computed: ComputedStyleLike,
  snapshot: ThemeSnapshotLike,
): KnowledgeHostThemeMessage {
  const tokens: Record<string, string> = {}
  for (const [target, sources] of Object.entries(TOKEN_SOURCES)) {
    const value = firstDefinedToken(computed, snapshot.active.tokens, sources)
    tokens[target] = value ?? FALLBACK_TOKENS[snapshot.active.colorScheme][target]!
  }
  return {
    type: KNOWLEDGE_THEME_MESSAGE,
    version: KNOWLEDGE_THEME_PROTOCOL_VERSION,
    colorScheme: snapshot.active.colorScheme,
    tokens,
  }
}

function firstDefinedToken(
  computed: ComputedStyleLike,
  snapshotTokens: Readonly<Record<string, string>>,
  sources: readonly string[],
): string | undefined {
  for (const source of sources) {
    const computedValue = computed.getPropertyValue(source).trim()
    if (computedValue.length > 0) return computedValue
    const snapshotValue = snapshotTokens[source]?.trim()
    if (snapshotValue !== undefined && snapshotValue.length > 0) return snapshotValue
  }
  return undefined
}
