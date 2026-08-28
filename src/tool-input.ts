import type { AgentLike, ToolRunContextLike } from './runtime.js'

export function requireToolAgent(exec: ToolRunContextLike, family = 'knowledge tools'): AgentLike {
  if (exec.agent === undefined) throw new Error(`${family} require a calling DSH agent`)
  return exec.agent
}

export function toolRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('tool arguments must be an object')
  return value as Record<string, unknown>
}

export function requiredToolString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${name} must contain at most ${maxLength} characters`)
  return result
}

export function optionalToolInteger(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return Number(value)
}
