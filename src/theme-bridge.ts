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
  '--bg': ['--xiaohei-plugin-workspace-fill', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-base'],
  '--surface': ['--xiaohei-plugin-pane-fill', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-1'],
  '--surface-raised': ['--xiaohei-plugin-raised-fill', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-overlay', '--dsw-alias-bg-layer-2'],
  '--surface-soft': ['--xiaohei-plugin-control-fill', '--dsw-alias-bg-module-platform', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-layer-2'],
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
    '--bg': '#eef1f3', '--surface': '#f7f9fa', '--surface-raised': '#ffffff',
    '--surface-soft': '#e8ecef', '--surface-hover': '#e3e8eb',
    '--text': '#202629', '--text-secondary': '#4f595e', '--text-tertiary': '#667178',
    '--border': '#d5dce0', '--border-strong': '#bcc6cb',
    '--accent': '#4f7773', '--accent-hover': '#3e6561', '--accent-soft': '#dfeae8', '--on-accent': '#f8fbfa',
    '--success': '#18794e', '--success-soft': '#e8f5ee', '--warning': '#986800', '--warning-soft': '#fff4cf',
    '--danger': '#c9343a', '--danger-soft': '#fdebec', '--shadow': '0 1px 2px rgb(25 35 40 / 5%), 0 14px 36px rgb(25 35 40 / 9%)',
  },
  dark: {
    '--bg': '#111719', '--surface': '#182022', '--surface-raised': '#20292c',
    '--surface-soft': '#283235', '--surface-hover': '#303b3e',
    '--text': '#edf2f1', '--text-secondary': '#bec9c7', '--text-tertiary': '#8e9b99',
    '--border': '#334044', '--border-strong': '#48585c',
    '--accent': '#78b5ad', '--accent-hover': '#91c8c1', '--accent-soft': '#213b39', '--on-accent': '#0d1e1b',
    '--success': '#62c596', '--success-soft': '#163a2a', '--warning': '#e7bc62', '--warning-soft': '#423414',
    '--danger': '#ff858a', '--danger-soft': '#4b2227', '--shadow': '0 2px 4px rgb(0 0 0 / 22%), 0 18px 46px rgb(0 0 0 / 32%)',
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
