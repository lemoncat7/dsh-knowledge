export type KnowledgeColorScheme = 'light' | 'dark'

/** Canonical palette and typography for workspace, activity and shared documents. */
export const KNOWLEDGE_PALETTE: Record<KnowledgeColorScheme, Readonly<Record<string, string>>> = {
  light: {
    '--bg': '#ebebeb', '--surface': '#f4f4f4', '--surface-raised': '#fafafa',
    '--surface-soft': '#eeeeef', '--surface-hover': 'rgb(118 118 128 / 9%)', '--dialog-surface': '#f4f4f4',
    '--menu-surface': 'rgb(232 234 236 / 98%)', '--menu-surface-solid': '#e8eaec',
    '--document-surface': 'rgb(218 222 226 / 32%)',
    '--text': '#1d1d1f', '--text-secondary': '#515154', '--text-tertiary': '#6e6e73',
    '--border': 'rgb(60 60 67 / 14%)', '--border-strong': 'rgb(60 60 67 / 24%)',
    '--accent': '#3a3a3c', '--accent-hover': '#1d1d1f', '--accent-soft': '#e2e2e5', '--on-accent': '#ffffff',
    '--success': '#248a3d', '--success-soft': '#e8f5eb', '--warning': '#c93400', '--warning-soft': '#fff1e8',
    '--danger': '#d70015', '--danger-soft': '#ffebed', '--shadow': '0 24px 64px rgb(0 0 0 / 20%)',
  },
  dark: {
    '--bg': '#101719', '--surface': '#182022', '--surface-raised': '#20292b',
    '--surface-soft': 'rgb(184 204 205 / 6%)', '--surface-hover': 'rgb(105 182 186 / 9%)', '--dialog-surface': '#20292b',
    '--menu-surface': 'rgb(29 38 40 / 98%)', '--menu-surface-solid': '#1d2628',
    '--document-surface': 'rgb(130 138 146 / 6%)',
    '--text': '#e3eaeb', '--text-secondary': '#bbc9cc', '--text-tertiary': '#95a7ab',
    '--border': 'rgb(184 204 205 / 10%)', '--border-strong': 'rgb(184 204 205 / 18%)',
    '--accent': '#69b6ba', '--accent-hover': '#8aced0', '--accent-soft': 'rgb(105 182 186 / 13%)', '--on-accent': '#101819',
    '--success': '#30d158', '--success-soft': 'rgb(48 209 88 / 13%)', '--warning': '#ff9f0a', '--warning-soft': 'rgb(255 159 10 / 13%)',
    '--danger': '#ff453a', '--danger-soft': 'rgb(255 69 58 / 14%)', '--shadow': '0 28px 72px rgb(0 0 0 / 42%)',
  },
}

export const KNOWLEDGE_FONTS = {
  '--font-ui': 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei UI", Arial, sans-serif',
  '--font-reading': 'var(--font-ui)',
  '--font-mono': '"SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace',
}

/** One material for host-side activity and the embedded workspace panes. */
export const KNOWLEDGE_EMBEDDED_MATERIAL: Record<KnowledgeColorScheme, Readonly<Record<string, string>>> = {
  light: {
    '--knowledge-embedded-surface': 'rgba(255, 255, 255, 0.08)',
    '--knowledge-embedded-filter': 'saturate(.65) contrast(1.015) blur(24px)',
    '--knowledge-embedded-control': 'rgba(255, 255, 255, 0.27)',
  },
  dark: {
    '--knowledge-embedded-surface': 'rgb(16 23 25 / 18%)',
    '--knowledge-embedded-filter': 'saturate(.55) contrast(1.02) blur(24px)',
    '--knowledge-embedded-control': 'rgb(39 50 53 / 72%)',
  },
}

function declarations(tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens).map(([name, value]) => name + ':' + value + ';').join('')
}

export function knowledgeDesignCss(scope = ':root', dark = ':root[data-color-scheme="dark"]', systemMode = true): string {
  const themeTokens = (scheme: KnowledgeColorScheme): string => declarations(KNOWLEDGE_PALETTE[scheme]) + declarations(KNOWLEDGE_EMBEDDED_MATERIAL[scheme])
  const base = scope + '{' + declarations(KNOWLEDGE_FONTS) + themeTokens('light') + '}'
  const darkRule = dark + '{' + themeTokens('dark') + '}'
  const automatic = systemMode ? '@media(prefers-color-scheme:dark){' + scope + ':not([data-color-scheme]){' + themeTokens('dark') + '}}' : ''
  return base + automatic + darkRule
}
