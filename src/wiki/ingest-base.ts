import type { DatabaseSync } from 'node:sqlite'
import type { WikiModel } from './model.js'
import type { WikiProviderBridge } from './provider-bridge.js'
import type { WikiDistiller, WikiIngestJob, WikiIngestSettings } from './ingest-types.js'

/** Shared mutable state and job-row storage for the ingest subsystems; one instance per database. */
export class IngestSupport {
  protected active = new Map<string, AbortController>()
  protected pending = new Set<Promise<void>>()
  /** The live object a run loop holds, so cancel/dismiss mutate the same instance instead of a DB copy. */
  protected readonly live = new Map<string, WikiIngestJob>()
  /** path+size+mtime fingerprints let periodic checks avoid re-reading unchanged files. */
  protected readonly hashCache = new Map<string, { size: number; mtimeMs: number; sha: string }>()
  protected readonly changeActive = new Set<string>()
  authorize: (() => void) | undefined
  modelFor: ((settings: WikiIngestSettings) => WikiModel) | undefined
  distill: WikiDistiller | undefined
  constructor(protected readonly db: DatabaseSync, protected readonly bridge: WikiProviderBridge) {
    db.exec('CREATE TABLE IF NOT EXISTS wiki_ingest_jobs(id TEXT PRIMARY KEY,kb_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS wiki_source_receipts(kb_id TEXT NOT NULL,sha TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kb_id,sha)); CREATE TABLE IF NOT EXISTS wiki_change_reports(kb_id TEXT PRIMARY KEY,body TEXT NOT NULL);')
  }
  /** Every persisted job row for one base; id lookups and maintenance never depend on the display window. */
  protected allJobs(kbId: string): WikiIngestJob[] {
    return (this.db.prepare('SELECT body FROM wiki_ingest_jobs WHERE kb_id=? ORDER BY rowid DESC').all(kbId) as {body: string}[]).map(r => JSON.parse(r.body) as WikiIngestJob)
  }
  protected allJobsAcrossBases(): WikiIngestJob[] {
    return (this.db.prepare('SELECT body FROM wiki_ingest_jobs').all() as {body: string}[]).map(r => JSON.parse(r.body) as WikiIngestJob)
  }
  protected save(job: WikiIngestJob): void { job.updatedAt = new Date().toISOString(); this.db.prepare('INSERT INTO wiki_ingest_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(job.id,job.kbId,JSON.stringify(job)) }
  protected job(kbId: string, id: string): WikiIngestJob {
    const row = this.db.prepare('SELECT body FROM wiki_ingest_jobs WHERE kb_id=? AND id=?').get(kbId,id) as {body: string} | undefined
    if (row === undefined) throw new Error('WIKI_JOB_NOT_FOUND')
    return JSON.parse(row.body) as WikiIngestJob
  }
  running(kbId: string): WikiIngestJob | undefined { return this.allJobs(kbId).find(job => this.active.has(job.id)) }
}
