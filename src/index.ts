import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** User-configurable knowledge provider settings. */
export interface Config {
  /** Select a local SQLite database or a remotely hosted knowledge provider. */
  backend: 'local' | 'remote'
  /** SQLite file used by the local provider. */
  databasePath?: string
  /** HTTPS endpoint used by the remote provider. */
  remoteUrl?: string
  /** Client credential used by the remote provider. */
  remoteToken?: string
  /** Expose the local provider to authenticated remote clients. */
  exposeApi: boolean
  /** Credential required by clients of the exposed local provider. */
  apiToken?: string
  /** Extract a knowledge candidate after each completed assistant response. */
  extractionEnabled: boolean
  /** Maximum number of automatically recalled entries per model request. */
  autoRecallLimit: number
}

/** Cordis configuration schema for the knowledge plugin. */
export const Config: Schema<Config> = Schema.object({
  backend: Schema.union(['local', 'remote']).default('local'),
  databasePath: Schema.string(),
  remoteUrl: Schema.string(),
  remoteToken: Schema.string().role('secret'),
  exposeApi: Schema.boolean().default(false),
  apiToken: Schema.string().role('secret'),
  extractionEnabled: Schema.boolean().default(true),
  autoRecallLimit: Schema.number().min(0).max(20).default(5),
})

/** Human-readable Cordis plugin name. */
export const name = 'dsh-knowledge'

/**
 * Mount the knowledge plugin.
 *
 * The repository currently establishes the installable DSH bundle and its
 * validated configuration. Durable storage, extraction, recall, API, and UI
 * providers will be added as independently testable Cordis contributions.
 *
 * @param ctx - Cordis context that owns plugin registrations.
 * @param config - Validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  void ctx
  void config
}
