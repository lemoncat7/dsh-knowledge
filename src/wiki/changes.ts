import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isPathInside } from './paths.js'
import type { WikiChangeEntry, WikiChangeReport, WikiChangeSkipped } from './ingest-types.js'
import { archivePathHeader, inventoryLedgers, ScanSupport, shaHeader, sizeHeader } from './scan.js'

const changeHashBytes = 8*1024*1024
function archiveRecordPath(root: string, value: string): string | undefined {
  if (isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) return isPathInside(root, value) ? resolve(value) : undefined
  const parts = value.replace(/\\/g, '/').split('/').filter(part => part.length > 0)
  if (!parts.length || parts.some(part => part === '.' || part === '..' || /[\u0000-\u001f]/.test(part))) return undefined
  return join(root, ...parts)
}
function pathKey(path: string): string { return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path) }
/** Change lists survive batch rounds; a shifted cursor must not duplicate an entry. */
function appendChange(list: WikiChangeEntry[], entry: WikiChangeEntry): void {
  if (!list.some(existing => existing.relPath === entry.relPath)) list.push(entry)
}

/** Read-only comparison of the source folder against durable archive evidence. */
export class ChangeSupport extends ScanSupport {
  /**
   * Read-only comparison of the source folder against recorded archive evidence. It never moves,
   * deletes or rewrites source files, never calls the model and never writes Wiki pages.
   *
   * Only the source folder is expected to gain material, so `new` is the main signal. Archive
   * records are checked without touching the archive again: existence/size always, content only
   * for document-sized files. Hashes are memoised on size+mtime, so a 15-minute round mostly stats.
   */
  async changes(kbId: string): Promise<WikiChangeReport> {
    const scannedAt = new Date().toISOString()
    if (this.running(kbId)) return { new: [], changed: [], missing: [], skipped: [], scannedAt, skippedRound: true, reason: 'job-running' }
    if (this.changeActive.has(kbId)) {
      const previous = this.changeReport(kbId)
      return { new: previous?.new ?? [], changed: previous?.changed ?? [], missing: previous?.missing ?? [], skipped: previous?.skipped ?? [], scannedAt, skippedRound: true, reason: 'already-running' }
    }
    this.changeActive.add(kbId)
    try {
      const root = await realpath(this.bridge.store(kbId).layout.sourceDir)
      const entries = await readdir(root, { withFileTypes: true })
      const expected = await this.archiveRecords(kbId, root, entries)
      const changed: WikiChangeEntry[] = [], missing: WikiChangeEntry[] = []
      for (const record of expected.records) {
        const relPath = relative(root, record.path).split(sep).join('/'), name = basename(record.path)
        let stat
        try { stat = await lstat(record.path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          appendChange(missing, { name, relPath, size: record.size })
          continue
        }
        if (!stat.isFile()) { appendChange(missing, { name, relPath, size: record.size }); continue }
        // A size drift needs no read; only document-sized files are hashed for same-size edits.
        if (record.size > 0 && stat.size !== record.size) appendChange(changed, { name, relPath, size: stat.size })
        else if (stat.size <= changeHashBytes && (await this.hashedFile(kbId, record.path, stat)).sha !== record.sha) appendChange(changed, { name, relPath, size: stat.size })
      }
      // Anything processable that no archive record knows about is new work. Files the scan skips
      // keep their explanation so "nothing detected" never hides unprocessed material.
      const scan = await this.scanSources(kbId)
      const fresh: WikiChangeEntry[] = []
      for (const file of scan.files) {
        if (expected.knownShas.has(file.sha.toLowerCase())) continue
        appendChange(fresh, { name: basename(file.source), relPath: relative(root, file.source).split(sep).join('/'), size: file.size,
          ...(file.delivery ? { folder: file.delivery } : {}) })
      }
      const skipped: WikiChangeSkipped[] = scan.skipped.map(item => ({ name: item.name, size: item.size, reason: item.reason,
        ...(item.delivery ? { folder: item.delivery } : {}),
        relPath: item.delivery && item.relPath ? `${item.delivery}/${item.relPath}` : item.relPath ?? item.name }))
      const sorted = (list: WikiChangeEntry[]): WikiChangeEntry[] => list.sort((a, b) => a.relPath.localeCompare(b.relPath))
      const sortedSkipped = skipped.sort((a, b) => (a.relPath ?? a.name).localeCompare(b.relPath ?? b.name))
      const report: WikiChangeReport = { new: sorted(fresh), changed: sorted(changed), missing: sorted(missing), skipped: sortedSkipped, scannedAt }
      this.saveChangeReport(kbId, report)
      return report
    } finally { this.changeActive.delete(kbId) }
  }
  /**
   * Every path the archive records say was filed, with its recorded hash. Evidence only:
   * receipts (SQLite / _meta/knowledge/sources), knowledge-archive.csv and root inventory ledgers.
   */
  private async archiveRecords(kbId: string, root: string, entries: Dirent[]): Promise<{ records: { path: string; sha: string; size: number }[]; knownShas: Set<string> }> {
    const records = new Map<string, { path: string; sha: string; size: number }>()
    const knownShas = new Set<string>()
    const remember = (path: string | undefined, sha: string | undefined, size: number | undefined): void => {
      const digest = typeof sha === 'string' ? sha.trim().toLowerCase() : ''
      if (!/^[a-f0-9]{64}$/u.test(digest)) return
      knownShas.add(digest)
      if (path === undefined || !isPathInside(root, path)) return
      const absolute = resolve(path)
      if (!records.has(pathKey(absolute))) records.set(pathKey(absolute), { path: absolute, sha: digest, size: typeof size === 'number' && Number.isFinite(size) ? size : 0 })
    }
    for (const item of await this.receiptItems(kbId)) remember(item.archived ?? item.source, item.sha, item.size)
    for (const ledger of await inventoryLedgers(root, entries)) {
      const sha = ledger.header.findIndex(cell => shaHeader.test(cell))
      const archived = ledger.header.findIndex(cell => archivePathHeader.test(cell))
      if (sha < 0 || archived < 0) continue
      const size = ledger.header.findIndex(cell => sizeHeader.test(cell))
      for (const row of ledger.rows) {
        const value = row[archived]?.trim()
        remember(value ? archiveRecordPath(root, value) : undefined, row[sha], size >= 0 ? Number(row[size] ?? 0) : 0)
      }
    }
    return { records: [...records.values()].sort((a, b) => a.path.localeCompare(b.path)), knownShas }
  }
  /** Last persisted change report, for the management interface. */
  changeReport(kbId: string): WikiChangeReport | undefined {
    const row = this.db.prepare('SELECT body FROM wiki_change_reports WHERE kb_id=?').get(kbId) as { body: string } | undefined
    if (row === undefined) return undefined
    const parsed = JSON.parse(row.body) as WikiChangeReport
    // Reports persisted by an earlier version may predate the skipped list or carry the old boolean.
    return { ...parsed, skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [] }
  }
  private saveChangeReport(kbId: string, report: WikiChangeReport): void {
    this.db.prepare('INSERT INTO wiki_change_reports VALUES(?,?) ON CONFLICT(kb_id) DO UPDATE SET body=excluded.body').run(kbId, JSON.stringify(report))
  }
}
