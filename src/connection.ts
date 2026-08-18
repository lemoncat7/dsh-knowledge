import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ResolvedConfig } from './config.js'
import { LocalKnowledgeProvider } from './local-provider.js'
import type { KnowledgeProvider } from './provider.js'
import { RemoteKnowledgeProvider } from './remote-provider.js'

export interface KnowledgeConnectionSettings {
  backend: 'local' | 'remote'
  remoteUrl?: string
  remoteToken?: string
  remoteTimeoutMs: number
}

export function connectionSettingsBase(config: ResolvedConfig): KnowledgeConnectionSettings {
  return {
    backend: config.backend,
    remoteTimeoutMs: config.remoteTimeoutMs,
    ...config.remoteUrl === undefined ? {} : { remoteUrl: config.remoteUrl },
    ...config.remoteToken === undefined ? {} : { remoteToken: config.remoteToken },
  }
}

export function validateConnectionSettings(
  settings: KnowledgeConnectionSettings,
  exposeApi: boolean,
  localDatabaseAvailable = true,
): void {
  if (!Number.isInteger(settings.remoteTimeoutMs) || settings.remoteTimeoutMs < 100 || settings.remoteTimeoutMs > 120_000) {
    throw new Error('remote timeout must be an integer from 100 to 120000 milliseconds')
  }
  if (settings.backend === 'local') {
    if (!localDatabaseAvailable) throw new Error('local knowledge backend is unavailable because databasePath is not configured')
    return
  }
  if (exposeApi) throw new Error('a central knowledge server cannot switch its own provider to remote mode')
  if (settings.remoteUrl === undefined || settings.remoteToken === undefined) {
    throw new Error('remote knowledge backend requires a server URL and client token')
  }
  const url = new URL(settings.remoteUrl)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('remote knowledge backend requires HTTPS (HTTP is allowed only for loopback testing)')
  }
  if (settings.remoteToken.trim().length < 24) throw new Error('remote client token must contain at least 24 characters')
}

export function createConnectionProvider(
  config: ResolvedConfig,
  settings: KnowledgeConnectionSettings,
  publicApiEnabled = config.exposeApi,
): KnowledgeProvider {
  validateConnectionSettings(settings, publicApiEnabled, config.databasePath !== undefined && config.databasePath.trim().length > 0)
  return settings.backend === 'local'
    ? new LocalKnowledgeProvider(config.databasePath as string)
    : new RemoteKnowledgeProvider({
      url: settings.remoteUrl as string,
      token: settings.remoteToken as string,
      timeoutMs: settings.remoteTimeoutMs,
    })
}

export function sameConnection(left: KnowledgeConnectionSettings, right: KnowledgeConnectionSettings): boolean {
  return left.backend === right.backend
    && left.remoteUrl === right.remoteUrl
    && left.remoteToken === right.remoteToken
    && left.remoteTimeoutMs === right.remoteTimeoutMs
}

export function loadStoredConnection(path: string | undefined): KnowledgeConnectionSettings | undefined {
  if (path === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`failed to read knowledge connection settings: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error('stored knowledge connection settings must be a JSON object')
  if (parsed.backend !== 'local' && parsed.backend !== 'remote') {
    throw new Error('stored knowledge connection backend must be local or remote')
  }
  if (!Number.isInteger(parsed.remoteTimeoutMs)) {
    throw new Error('stored knowledge connection timeout must be an integer')
  }
  const settings: KnowledgeConnectionSettings = {
    backend: parsed.backend,
    remoteTimeoutMs: parsed.remoteTimeoutMs as number,
    ...typeof parsed.remoteUrl === 'string' ? { remoteUrl: parsed.remoteUrl } : {},
    ...typeof parsed.remoteToken === 'string' ? { remoteToken: parsed.remoteToken } : {},
  }
  return settings
}

export async function storeConnection(path: string, settings: KnowledgeConnectionSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
