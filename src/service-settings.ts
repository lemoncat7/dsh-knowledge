import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from './atomic-file.js'

export interface KnowledgeServiceSettings {
  publicApiEnabled: boolean
  writebackProvider?: string
  writebackModel?: string
  extractionEveryTurns?: number
  extractionIdleSeconds?: number
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
  const frequency = normalizeWritebackFrequency(value as Record<string,unknown>)
  const enabled = stored.publicApiEnabled
  if (typeof enabled !== 'boolean') throw new Error('stored public API setting must be a boolean')
  const provider = typeof stored.writebackProvider === 'string' ? stored.writebackProvider.trim() : undefined
  const model = typeof stored.writebackModel === 'string' ? stored.writebackModel.trim() : undefined
  if ((provider === undefined) !== (model === undefined)) throw new Error('stored client writeback provider and model must be configured together')
  return { publicApiEnabled: enabled, ...frequency, ...provider && model ? { writebackProvider: provider, writebackModel: model } : {} }
}

export async function storeServiceSettings(path: string, settings: KnowledgeServiceSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await atomicWriteFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}

/** Shared validation for local settings, remote-client settings and persisted state. */
export function normalizeWritebackFrequency(value: Record<string,unknown>): {extractionEveryTurns?:number;extractionIdleSeconds?:number} {
  const out: {extractionEveryTurns?:number;extractionIdleSeconds?:number}={}
  for(const [key,min,max] of [['extractionEveryTurns',1,20],['extractionIdleSeconds',30,3600]] as const){
    const n=value[key];if(n===undefined)continue
    if(typeof n!=='number'||!Number.isInteger(n)||n<min||n>max)throw Object.assign(Error(`${key} 必须是 ${min}～${max} 的整数`),{status:400})
    out[key]=n
  }
  return out
}
