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

/**
 * The management console lives in its own iframe and therefore owns its
 * component palette.  Only the host colour scheme crosses that boundary.
 * Keeping these tokens stable prevents a branded host accent from changing
 * editor selection, navigation and dialog hierarchy independently.
 */
const WORKSPACE_TOKENS: Record<KnowledgeColorScheme, Readonly<Record<string, string>>> = {
  light: {
    '--bg': '#ebebeb', '--surface': '#f4f4f4', '--surface-raised': '#fafafa',
    '--surface-soft': '#eeeeef', '--surface-hover': 'rgb(118 118 128 / 9%)', '--dialog-surface': '#f4f4f4',
    '--text': '#1d1d1f', '--text-secondary': '#515154', '--text-tertiary': '#6e6e73',
    '--border': 'rgb(60 60 67 / 14%)', '--border-strong': 'rgb(60 60 67 / 24%)',
    '--accent': '#3a3a3c', '--accent-hover': '#1d1d1f', '--accent-soft': '#e2e2e5', '--on-accent': '#ffffff',
    '--success': '#248a3d', '--success-soft': '#e8f5eb', '--warning': '#c93400', '--warning-soft': '#fff1e8',
    '--danger': '#d70015', '--danger-soft': '#ffebed', '--shadow': '0 24px 64px rgb(0 0 0 / 20%)',
  },
  dark: {
    '--bg': '#1c1c1e', '--surface': '#2c2c2e', '--surface-raised': '#323235',
    '--surface-soft': 'rgb(255 255 255 / 6%)', '--surface-hover': 'rgb(255 255 255 / 7.5%)', '--dialog-surface': '#2c2c2e',
    '--text': '#f5f5f7', '--text-secondary': '#d1d1d6', '--text-tertiary': '#98989d',
    '--border': 'rgb(255 255 255 / 10%)', '--border-strong': 'rgb(255 255 255 / 18%)',
    '--accent': '#e5e5ea', '--accent-hover': '#ffffff', '--accent-soft': 'rgb(255 255 255 / 9%)', '--on-accent': '#1d1d1f',
    '--success': '#30d158', '--success-soft': 'rgb(48 209 88 / 13%)', '--warning': '#ff9f0a', '--warning-soft': 'rgb(255 159 10 / 13%)',
    '--danger': '#ff453a', '--danger-soft': 'rgb(255 69 58 / 14%)', '--shadow': '0 28px 72px rgb(0 0 0 / 42%)',
  },
}

/** Synchronise host light/dark mode while preserving one coherent workspace palette. */
export function createKnowledgeHostTheme(
  _computed: ComputedStyleLike,
  snapshot: ThemeSnapshotLike,
): KnowledgeHostThemeMessage {
  return {
    type: KNOWLEDGE_THEME_MESSAGE,
    version: KNOWLEDGE_THEME_PROTOCOL_VERSION,
    colorScheme: snapshot.active.colorScheme,
    tokens: { ...WORKSPACE_TOKENS[snapshot.active.colorScheme] },
  }
}
