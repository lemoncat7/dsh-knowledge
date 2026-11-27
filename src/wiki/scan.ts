import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { isPathInside } from './paths.js'
import type { Item, WikiScanResult, WikiSourceCandidate, WikiSkippedSource } from './ingest-types.js'
import { ReceiptSupport } from './receipts.js'

const inventoryName = /^(?:readme|read_me|index|log|schema|knowledge-archive|license|changelog|归档清单|归档目录树|资料索引|资料目录|目录树|索引|清单)(?:[._-]|$)/i
const inventoryStem = /\b(?:index|catalog|contents|inventory)\b/i
function isInventory(name: string): boolean {
  const base = name.replace(/\.[^.]+$/, '')
  return inventoryName.test(name) || inventoryStem.test(base)
}
// Register-only formats: classified and archived with a receipt, but never extracted or distilled,
// so the extractor's 256 MiB guard does not apply to them. Every other type keeps that guard.
export const registration = new Set(['.mp4','.exe','.rar','.zip','.msi','.7z','.doc'])
const maxExtractBytes = 256*1024*1024
/** Archived files above this size are only checked for existence/size, never re-read (videos, installers). */
function reservedName(name: string): boolean { return name.startsWith('.') || name.startsWith('_') || /^(?:documents|node_modules)$/i.test(name) }
const categoryHeader = /^(?:category_dir|category|分类目录|分类|类别)$/i
export const archivePathHeader = /^archive_(?:rel_)?path$/i
const maxDeliveryDepth = 32
/** Split a path below a delivery folder; absolute or escaping segments are rejected before any write. */
export function archiveSegments(value: string): string[] {
  const parts = value.split(/[\\/]/)
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(part) || /[. ]$/.test(part))) throw new Error('WIKI_DELIVERY_PATH_INVALID')
  return parts
}
/** Streamed SHA-256: register-only sources can be many gigabytes and must never sit in one buffer. */
export async function hashSource(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
/** Copy into a fresh temp file while hashing the copy, so the published bytes are verified without buffering. */
export async function copySource(source: string, temp: string, sha: string): Promise<void> {
  const hash = createHash('sha256')
  const handle = await open(temp, 'wx') // EEXIST from an earlier attempt is left for the caller to resolve.
  try {
    for await (const chunk of createReadStream(source)) {
      const bytes = chunk as Buffer
      hash.update(bytes)
      for (let offset = 0; offset < bytes.length;) {
        const written = (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten
        if (written <= 0) throw new Error('WIKI_ARCHIVE_WRITE_FAILED')
        offset += written
      }
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
  await handle.close()
  if (hash.digest('hex') !== sha) { await unlink(temp).catch(() => {}); throw new Error('WIKI_SOURCE_CHANGED') }
}
/** Minimal RFC 4180 reader: inventory ledgers quote fields that contain commas. */
function csvRecords(text: string): string[][] {
  const rows: string[][] = [], source = text.replace(/^\uFEFF/, '')
  let row: string[] = [], field = '', quoted = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (quoted) {
      if (character !== '"') field += character
      else if (source[index + 1] === '"') { field += '"'; index++ }
      else quoted = false
    } else if (character === '"') quoted = true
    else if (character === ',') { row.push(field); field = '' }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += character
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}
function archiveFirstSegment(root: string, value: string): string | undefined {
  if (!isAbsolute(value) && !/^[a-z]:[\\/]/i.test(value)) return value.replace(/\\/g, '/').split('/')[0]
  if (!isPathInside(root, value)) return undefined
  return relative(root, value).split(sep)[0]
}
/** One ledger/receipt archive path, normalised to an absolute path inside the source root. */
interface InventoryLedger { header: string[]; rows: string[][] }
export const shaHeader = /^sha(?:256)?$/i
export const sizeHeader = /^(?:size_bytes|size)$/i
/** Root inventory ledgers (CSV) written by the archiving workflow; they are evidence, never source material. */
export async function inventoryLedgers(root: string, entries: Dirent[]): Promise<InventoryLedger[]> {
  const ledgers: InventoryLedger[] = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/\.csv$/i.test(entry.name) || !isInventory(entry.name)) continue
    const path = join(root, entry.name)
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!stat || stat.size > 8*1024*1024) continue
    const rows = csvRecords(await readFile(path, 'utf8'))
    if (rows.length < 2) continue // header-only ledgers carry no records yet
    ledgers.push({ header: rows[0]!.map(cell => cell.trim()), rows: rows.slice(1) })
  }
  return ledgers
}
async function ledgerCategories(root: string, entries: Dirent[]): Promise<Set<string>> {
  const names = new Set<string>()
  for (const ledger of await inventoryLedgers(root, entries)) {
    const category = ledger.header.findIndex(cell => categoryHeader.test(cell))
    const archived = category < 0 ? ledger.header.findIndex(cell => archivePathHeader.test(cell)) : -1
    if (category < 0 && archived < 0) continue
    for (const row of ledger.rows) {
      const value = (category >= 0 ? row[category] : row[archived])?.trim()
      if (!value) continue
      const first = category >= 0 ? value : archiveFirstSegment(root, value)
      if (first && first !== '.' && first !== '..' && !/[\\/:*?"<>|]/.test(first)) names.add(first)
    }
  }
  return names
}
/** Directory entries of an archive tree written by the archiving workflow. */
const treeEntry = /^(?:├─|└─)\s*(.+?)[\\/]\s*(?:\(.*\))?$/
async function treeCategories(root: string, entries: Dirent[]): Promise<Set<string>> {
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/\.md$/i.test(entry.name) || !isInventory(entry.name)) continue
    const path = join(root, entry.name)
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!stat || stat.size > 8*1024*1024) continue
    for (const line of (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = treeEntry.exec(line)
      const name = match?.[1]?.trim()
      if (name && !/[\\/:*?"<>|]/.test(name)) names.add(name)
    }
  }
  return names
}

/** Source scanning and delivery-folder classification. */
export class ScanSupport extends ReceiptSupport {
  /** Cached hash for an unchanged file; undefined means the file must be read again. */
  private cachedHash(kbId: string, path: string, stat: { size: number; mtimeMs: number }): string | undefined {
    const cached = this.hashCache.get(`${kbId}\u0000${path}`)
    return cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached.sha : undefined
  }
  /** Streamed hash memoised on size+mtime; any touch of the file forces a re-read. */
  protected async hashedFile(kbId: string, path: string, stat: { size: number; mtimeMs: number }): Promise<{ sha: string; cached: boolean }> {
    const cached = this.cachedHash(kbId, path, stat)
    if (cached !== undefined) return { sha: cached, cached: true }
    const sha = await hashSource(path)
    if (this.hashCache.size >= 50_000) this.hashCache.clear()
    this.hashCache.set(`${kbId}\u0000${path}`, { size: stat.size, mtimeMs: stat.mtimeMs, sha })
    return { sha, cached: false }
  }
  /** Split root entries into established archive categories and delivery folders. */
  protected async sourceRoot(kbId: string): Promise<{ root: string; entries: Dirent[]; categories: string[]; deliveries: string[] }> {
    const layout = this.bridge.store(kbId).layout, root = await realpath(layout.sourceDir), entries = await readdir(root, { withFileTypes: true })
    const known = await this.receiptCategories(kbId, root)
    for (const name of await ledgerCategories(root, entries)) known.add(name)
    for (const name of await treeCategories(root, entries)) known.add(name)
    const folders = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !reservedName(entry.name))
      .map(entry => entry.name).sort()
    return { root, entries, categories: folders.filter(name => known.has(name)), deliveries: folders.filter(name => !known.has(name)) }
  }
  /** Recursively collect a delivery folder; links and reserved directories never leave the source root. */
  private async deliveryFiles(root: string, delivery: string): Promise<{ source: string; delivery: string; relPath: string }[]> {
    const result: { source: string; delivery: string; relPath: string }[] = []
    const walk = async (dir: string, prefix: string[]): Promise<void> => {
      if (prefix.length > maxDeliveryDepth) return
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (reservedName(entry.name)) continue
          const actual = await realpath(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
          if (!actual || !isPathInside(root, actual)) continue
          await walk(path, [...prefix, entry.name])
        } else if (entry.isFile() && !isInventory(entry.name)) {
          result.push({ source: path, delivery, relPath: [...prefix, entry.name].join('/') })
        }
      }
    }
    await walk(join(root, delivery), [])
    return result
  }
  /** Destination below the category: a folder delivery keeps its name and relative hierarchy. */
  private async sourceCandidates(kbId: string): Promise<{ root: string; candidates: { source: string; delivery?: string; relPath?: string }[] }> {
    const { root, entries, deliveries } = await this.sourceRoot(kbId)
    const candidates: { source: string; delivery?: string; relPath?: string }[] = []
    // Root-level files are one-file deliveries; unrelated folders are scanned recursively below.
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name.startsWith('.') || isInventory(entry.name)) continue
      candidates.push({ source: join(root, entry.name) })
    }
    for (const delivery of deliveries) candidates.push(...await this.deliveryFiles(root, delivery))
    return { root, candidates: candidates.sort((a, b) => a.source.localeCompare(b.source)) }
  }
  async scanSources(kbId: string): Promise<WikiScanResult> {
    const { candidates } = await this.sourceCandidates(kbId)
    const files: WikiSourceCandidate[] = [], skipped: WikiSkippedSource[] = []
    for (const candidate of candidates) {
      const stat = await lstat(candidate.source)
      const context = { ...(candidate.delivery ? { delivery: candidate.delivery } : {}), ...(candidate.relPath ? { relPath: candidate.relPath } : {}) }
      if (stat.size > maxExtractBytes && !registration.has(extname(candidate.source).toLowerCase())) {
        skipped.push({ name: basename(candidate.source), size: stat.size, reason: '可抽取类型超过 256 MB 上限，未处理；请拆分或转换后再投递', ...context })
        continue
      }
      const sha = (await this.hashedFile(kbId, candidate.source, stat)).sha
      files.push({ ...candidate, sha, size: stat.size, duplicate: await this.receiptExists(kbId, sha) })
    }
    return { files, skipped }
  }
  /** Candidate files only; `scanSources` additionally explains what was skipped. */
  async discover(kbId: string): Promise<WikiSourceCandidate[]> { return (await this.scanSources(kbId)).files }
}
