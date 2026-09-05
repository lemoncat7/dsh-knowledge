import { KNOWLEDGE_PALETTE, type KnowledgeColorScheme } from './design-tokens.js'
export const KNOWLEDGE_THEME_MESSAGE = '@lemoncat7/dsh-knowledge/host-theme'
export const KNOWLEDGE_THEME_READY_MESSAGE = '@lemoncat7/dsh-knowledge/host-theme-ready'
export const KNOWLEDGE_THEME_PROTOCOL_VERSION = 1

export type { KnowledgeColorScheme } from './design-tokens.js'

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


/**
 * The management console lives in its own iframe and therefore owns its
 * component palette.  Only the host colour scheme crosses that boundary.
 * Keeping these tokens stable prevents a branded host accent from changing
 * editor selection, navigation and dialog hierarchy independently.
 */
export function createKnowledgeHostTheme(
  snapshot: ThemeSnapshotLike,
): KnowledgeHostThemeMessage {
  return {
    type: KNOWLEDGE_THEME_MESSAGE,
    version: KNOWLEDGE_THEME_PROTOCOL_VERSION,
    colorScheme: snapshot.active.colorScheme,
    tokens: { ...KNOWLEDGE_PALETTE[snapshot.active.colorScheme] },
  }
}
