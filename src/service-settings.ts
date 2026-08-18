import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface KnowledgeServiceSettings {
  publicApiEnabled: boolean
}

export function serviceSettingsPath(connectionPath: string | undefined): string | undefined {
  return connectionPath === undefined ? undefined : `${connectionPath}.service.json`
}

export function loadServiceSettings(path: string | undefined): KnowledgeServiceSettings | undefined {
  if (path === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`failed to read knowledge service settings: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stored knowledge service settings must be a JSON object')
  }
  const enabled = (value as { publicApiEnabled?: unknown }).publicApiEnabled
  if (typeof enabled !== 'boolean') throw new Error('stored public API setting must be a boolean')
  return { publicApiEnabled: enabled }
}

export async function storeServiceSettings(path: string, settings: KnowledgeServiceSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
