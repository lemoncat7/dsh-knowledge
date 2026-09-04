import Schema from '@deepseek-ai/schemastery'
import { isIP } from 'node:net'
import { normalizeRemoteKnowledgeUrl } from './remote-url.js'

export interface Config {
  backend: 'local' | 'remote'
  databasePath?: string
  remoteUrl?: string
  remoteToken?: string
  remoteTimeoutMs: number
  connectionPath?: string
  exposeApi: boolean
  apiToken?: string
  apiPrefix: string
  exposeWeb: boolean
  webPath: string
  extractionEnabled: boolean
  extractionProvider?: string
  extractionModel?: string
  extractionMaxTokens: number
  extractionTimeoutMs: number
  extractionMaxInputChars: number
  defaultScope: 'project' | 'global'
  autoRecallLimit: number
  autoRecallMinScore: number
  recallMaxChars: number
  trustedShareOrigins: string[]
}

export const Config: Schema<Config> = Schema.object({
  backend: Schema.union(['local', 'remote']).default('local'),
  databasePath: Schema.string(),
  remoteUrl: Schema.string(),
  remoteToken: Schema.string().role('secret'),
  remoteTimeoutMs: Schema.number().min(100).max(120_000).default(10_000),
  connectionPath: Schema.string(),
  exposeApi: Schema.boolean().default(false),
  apiToken: Schema.string().role('secret'),
  apiPrefix: Schema.string().default('/knowledge-api/v1'),
  exposeWeb: Schema.boolean().default(true),
  webPath: Schema.string().default('/knowledge'),
  extractionEnabled: Schema.boolean().default(true),
  extractionProvider: Schema.string(),
  extractionModel: Schema.string(),
  extractionMaxTokens: Schema.number().min(128).max(8192).default(4096),
  extractionTimeoutMs: Schema.number().min(1000).max(300_000).default(90_000),
  extractionMaxInputChars: Schema.number().min(1000).max(200_000).default(30_000),
  defaultScope: Schema.union(['project', 'global']).default('project'),
  autoRecallLimit: Schema.number().min(0).max(10).default(3),
  autoRecallMinScore: Schema.number().min(0).max(1).default(0.2),
  recallMaxChars: Schema.number().min(500).max(20_000).default(5000),
  trustedShareOrigins: Schema.array(Schema.string()).default([]).description('允许分享导入在指定的精确 Origin 上使用内网 DNS 回流。不支持通配符；已安装远程访问插件时会自动合并其可信 Origin。'),
})

export interface ResolvedConfig extends Config {
  remoteTimeoutMs: number
  apiPrefix: string
  exposeWeb: boolean
  webPath: string
  extractionMaxTokens: number
  extractionTimeoutMs: number
  extractionMaxInputChars: number
  defaultScope: 'project' | 'global'
  autoRecallLimit: number
  autoRecallMinScore: number
  recallMaxChars: number
}

export function resolveConfig(config: Config): ResolvedConfig {
  const connectionPath = config.connectionPath ?? deriveConnectionPath(config.databasePath)
  const resolved: ResolvedConfig = {
    ...config,
    remoteTimeoutMs: config.remoteTimeoutMs ?? 10_000,
    ...connectionPath === undefined ? {} : { connectionPath },
    apiPrefix: normalizePrefix(config.apiPrefix ?? '/knowledge-api/v1'),
    exposeWeb: config.exposeWeb ?? true,
    webPath: normalizePrefix(config.webPath ?? '/knowledge'),
    extractionMaxTokens: config.extractionMaxTokens ?? 4096,
    extractionTimeoutMs: config.extractionTimeoutMs ?? 90_000,
    extractionMaxInputChars: config.extractionMaxInputChars ?? 30_000,
    defaultScope: config.defaultScope ?? 'project',
    autoRecallLimit: config.autoRecallLimit ?? 3,
    autoRecallMinScore: config.autoRecallMinScore ?? 0.2,
    recallMaxChars: config.recallMaxChars ?? 5000,
    trustedShareOrigins: normalizeTrustedShareOrigins(config.trustedShareOrigins ?? []),
  }
  if (resolved.backend === 'local' && (resolved.databasePath === undefined || resolved.databasePath.trim().length === 0)) {
    throw new Error('local knowledge backend requires databasePath')
  }
  if (resolved.backend === 'remote') {
    if (resolved.remoteUrl === undefined || resolved.remoteToken === undefined) {
      throw new Error('remote knowledge backend requires remoteUrl and remoteToken')
    }
    normalizeRemoteKnowledgeUrl(resolved.remoteUrl)
    if (resolved.remoteToken.trim().length < 24) throw new Error('remoteToken must contain at least 24 characters')
    if (resolved.exposeApi) throw new Error('remote knowledge backend cannot expose the local API')
  }
  const hasExtractionProvider = resolved.extractionProvider !== undefined
  const hasExtractionModel = resolved.extractionModel !== undefined
  if (hasExtractionProvider !== hasExtractionModel) {
    throw new Error('extractionProvider and extractionModel must be configured together')
  }
  if (resolved.exposeApi && (resolved.apiToken === undefined || resolved.apiToken.trim().length < 24)) {
    throw new Error('exposeApi requires apiToken with at least 24 characters')
  }
  if (resolved.webPath === resolved.apiPrefix || resolved.webPath.startsWith(`${resolved.apiPrefix}/`) || resolved.apiPrefix.startsWith(`${resolved.webPath}/`)) {
    throw new Error('webPath and apiPrefix must not overlap')
  }
  return resolved
}

export function normalizeTrustedShareOrigins(values: readonly string[]): string[] {
  const normalized = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    if (value === '') continue
    let url: URL
    try { url = new URL(value) } catch { throw new Error(`invalid trusted share origin: ${value}`) }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`trusted share origin must be an exact HTTP(S) origin: ${value}`)
    }
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || isIP(url.hostname.replace(/^\[|\]$/gu, '')) !== 0) {
      throw new Error(`trusted share origin must use a DNS hostname: ${value}`)
    }
    normalized.add(url.origin)
  }
  return [...normalized]
}

function deriveConnectionPath(databasePath: string | undefined): string | undefined {
  return databasePath === undefined || databasePath.trim().length === 0 ? undefined : `${databasePath}.connection.json`
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim()
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const prefix = withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(prefix)) throw new Error('apiPrefix must be an absolute URL path')
  return prefix
}
