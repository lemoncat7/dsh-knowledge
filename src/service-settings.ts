import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface KnowledgeServiceSettings {
  publicApiEnabled: boolean
  writebackProvider?: string
  writebackModel?: string
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
  const stored = value as { publicApiEnabled?: unknown; writebackProvider?: unknown; writebackModel?: unknown }
  const enabled = stored.publicApiEnabled
  if (typeof enabled !== 'boolean') throw new Error('stored public API setting must be a boolean')
  const provider = typeof stored.writebackProvider === 'string' ? stored.writebackProvider.trim() : undefined
  const model = typeof stored.writebackModel === 'string' ? stored.writebackModel.trim() : undefined
  if ((provider === undefined) !== (model === undefined)) throw new Error('stored client writeback provider and model must be configured together')
  return { publicApiEnabled: enabled, ...provider && model ? { writebackProvider: provider, writebackModel: model } : {} }
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
