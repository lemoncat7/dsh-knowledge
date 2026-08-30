import Schema from '@deepseek-ai/schemastery'
import { dirname, join } from 'node:path'
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
  exportsDir?: string
  extractionEnabled: boolean
  extractionMode: 'detached' | 'inline'
  extractionProvider?: string
  extractionModel?: string
  extractionMaxTokens: number
  extractionTimeoutMs: number
  extractionRetryDelaysMs: number[]
  extractionFinalRetryDelayMs: number
  extractionFinalTimeoutMs: number
  extractionMaxInputChars: number
  defaultScope: 'project' | 'global'
  autoRecallLimit: number
  autoRecallMinScore: number
  recallMaxChars: number
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
  exportsDir: Schema.string(),
  extractionEnabled: Schema.boolean().default(true),
  extractionMode: Schema.union(['detached', 'inline']).default('detached'),
  extractionProvider: Schema.string(),
  extractionModel: Schema.string(),
  extractionMaxTokens: Schema.number().min(128).max(8192).default(4096),
  extractionTimeoutMs: Schema.number().min(0).max(300_000).default(300_000),
  extractionRetryDelaysMs: Schema.array(Schema.number().min(0)).default([20_000, 60_000]),
  extractionFinalRetryDelayMs: Schema.number().min(0).max(600_000).default(60_000),
  extractionFinalTimeoutMs: Schema.number().min(1000).max(3_600_000).default(1_800_000),
  extractionMaxInputChars: Schema.number().min(1000).max(200_000).default(30_000),
  defaultScope: Schema.union(['project', 'global']).default('project'),
  autoRecallLimit: Schema.number().min(0).max(10).default(3),
  autoRecallMinScore: Schema.number().min(0).max(1).default(0.2),
  recallMaxChars: Schema.number().min(500).max(20_000).default(5000),
})

export interface ResolvedConfig extends Config {
  remoteTimeoutMs: number
  apiPrefix: string
  exposeWeb: boolean
  webPath: string
  exportsDir?: string
  extractionMode: 'detached' | 'inline'
  extractionMaxTokens: number
  extractionTimeoutMs: number
  extractionRetryDelaysMs: number[]
  extractionFinalRetryDelayMs: number
  extractionFinalTimeoutMs: number
  extractionMaxInputChars: number
  defaultScope: 'project' | 'global'
  autoRecallLimit: number
  autoRecallMinScore: number
  recallMaxChars: number
}

export function resolveConfig(config: Config): ResolvedConfig {
  const connectionPath = config.connectionPath ?? deriveConnectionPath(config.databasePath)
  const exportsDir = resolveExportsDir(config.exportsDir, config.backend, config.databasePath)
  const resolved: ResolvedConfig = {
    ...config,
    remoteTimeoutMs: config.remoteTimeoutMs ?? 10_000,
    ...connectionPath === undefined ? {} : { connectionPath },
    apiPrefix: normalizePrefix(config.apiPrefix ?? '/knowledge-api/v1'),
    exposeWeb: config.exposeWeb ?? true,
    webPath: normalizePrefix(config.webPath ?? '/knowledge'),
    ...exportsDir === undefined ? {} : { exportsDir },
    extractionMode: config.extractionMode === 'inline' ? 'inline' : 'detached',
    extractionMaxTokens: config.extractionMaxTokens ?? 4096,
    extractionTimeoutMs: config.extractionTimeoutMs ?? 300_000,
    extractionRetryDelaysMs: normalizeRetryDelays(config.extractionRetryDelaysMs),
    extractionFinalRetryDelayMs: config.extractionFinalRetryDelayMs ?? 60_000,
    extractionFinalTimeoutMs: config.extractionFinalTimeoutMs ?? 1_800_000,
    extractionMaxInputChars: config.extractionMaxInputChars ?? 30_000,
    defaultScope: config.defaultScope ?? 'project',
    autoRecallLimit: config.autoRecallLimit ?? 3,
    autoRecallMinScore: config.autoRecallMinScore ?? 0.2,
    recallMaxChars: config.recallMaxChars ?? 5000,
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

function deriveConnectionPath(databasePath: string | undefined): string | undefined {
  return databasePath === undefined || databasePath.trim().length === 0 ? undefined : `${databasePath}.connection.json`
}

function resolveExportsDir(value: string | undefined, backend: Config['backend'], databasePath: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed !== undefined && trimmed.length > 0) return trimmed
  if (backend === 'local' && databasePath !== undefined && databasePath.trim().length > 0) {
    return join(dirname(databasePath), 'exports')
  }
  return undefined
}

function normalizeRetryDelays(value: unknown): number[] {
  const delays = (Array.isArray(value) ? value : [])
    .map(item => typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : -1)
    .filter(delay => delay >= 0)
    .slice(0, 2)
  const fallbacks = [20_000, 60_000]
  while (delays.length < 2) delays.push(fallbacks[delays.length] ?? 60_000)
  return delays
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim()
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const prefix = withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(prefix)) throw new Error('apiPrefix must be an absolute URL path')
  return prefix
}
