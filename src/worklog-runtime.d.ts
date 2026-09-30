import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgeConnectionSettings } from './connection.js'
export interface JournalRuntime {
  dispatch(method: string, path: string, data: Record<string, unknown>, query: URLSearchParams): Promise<unknown>
  isRunning(): boolean
}
export function apply(ctx: Context, config: { databasePath: string; current(): KnowledgeConnectionSettings; onDispose(): void }): JournalRuntime
