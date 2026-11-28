import type { KnowledgeScope } from '../domain.js'

export interface WikiIngestSettings { python: string; provider: string; model: string; allowModel: boolean; scope: KnowledgeScope }
export interface Item { id: string; source: string; sha: string; size: number; category?: string; archived?: string; raw?: string; rawHash?: string; stage: 'new' | 'classified' | 'archived' | 'extracted' | 'done' | 'review' | 'failed'; error?: string; pages?: string[]; /** Subset of pages that replaced an existing page instead of creating a new one. */ updatedPages?: string[]; activity?: string; delivery?: string; relPath?: string; registered?: boolean; inPlace?: boolean; discoveredAt?: string; /** A delivery folder declared "no archive": extract and distill in place, never file into a category. */ standalone?: true; standaloneReason?: string }
export interface WikiIngestJob { id: string; kbId: string; state: 'running' | 'paused' | 'done' | 'cancelled'; settings: WikiIngestSettings; items: Item[]; createdAt: string; updatedAt: string; discovery?: { found: number; duplicates: number }; /** Dismissed from the default list; the record stays for audit via includeHidden. */ hidden?: boolean }
/** One source file waiting to be processed; folder deliveries keep their path below the delivery folder. */
export interface WikiSourceCandidate { source: string; sha: string; size: number; duplicate: boolean; delivery?: string; relPath?: string; standalone?: true; standaloneReason?: string }
/** A source file that is deliberately not queued; the reason is operator-facing and never silent. */
export interface WikiSkippedSource { name: string; size: number; reason: string; delivery?: string; relPath?: string }
/** One delivery folder that declared itself "no archive"; its files stay where they are and are still extracted. */
export interface WikiStandaloneFolder { folder: string; reason: string }
export interface WikiScanResult { files: WikiSourceCandidate[]; skipped: WikiSkippedSource[]; standaloneFolders: WikiStandaloneFolder[] }
/** One differing source record; relPath is always relative to the source root. */
export interface WikiChangeEntry { name: string; relPath: string; size: number; folder?: string }
/** A file the scan deliberately left unprocessed; the same rule as the scan preview, never a silent drop. */
export interface WikiChangeSkipped { name: string; size: number; reason: string; folder?: string; relPath?: string }
export interface WikiChangeReport {
  new: WikiChangeEntry[]; changed: WikiChangeEntry[]; missing: WikiChangeEntry[]
  /** Non-empty means there is still unprocessed material, so the library is not "clean" even without new/changed/missing. */
  skipped: WikiChangeSkipped[]
  scannedAt: string
  /** The round did not look at the source tree at all (running ingest job or another check). */
  skippedRound?: boolean
  reason?: 'job-running' | 'already-running'
}
/** Pages touched by one distillation; `updated` is the subset that replaced an existing page. */
export interface WikiDistillResult { pages: string[]; updated: string[] }
/** A distiller may still return a plain page list; the ingest normalizes both shapes. */
export type WikiDistiller = (kbId: string, item: Item, settings: WikiIngestSettings, operationId: string, signal: AbortSignal) => Promise<WikiDistillResult | string[]>

/** Stable error code for operators and the management API. */
export function jobError(code: string, message = code): Error { return Object.assign(new Error(message), { code }) }
