import { mkdir, open, readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isPathInside } from './paths.js'
import type { Item, WikiIngestJob } from './ingest-types.js'
import { IngestSupport } from './ingest-base.js'

/** Durable source receipts: the database is authoritative, meta files are the fallback. */
export class ReceiptSupport extends IngestSupport {
  protected async receiptExists(kbId:string,sha:string):Promise<boolean>{
    if(this.db.prepare('SELECT 1 FROM wiki_source_receipts WHERE kb_id=? AND sha=?').get(kbId,sha))return true
    const file=join(this.bridge.store(kbId).layout.metaDir,'sources',sha+'.json')
    try{const value=JSON.parse(await readFile(file,'utf8')) as Item;if(value.sha!==sha||value.stage!=='done')return false;return true}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e}
  }
  /** Durable source receipts; the database is authoritative, meta files are the fallback after a rebuild. */
  protected async receiptItems(kbId: string): Promise<Item[]> {
    const items: Item[] = []
    for (const row of this.db.prepare('SELECT body FROM wiki_source_receipts WHERE kb_id=?').all(kbId) as { body: string }[]) {
      try { items.push(JSON.parse(row.body) as Item) } catch { /* a damaged receipt carries no usable evidence */ }
    }
    if (items.length) return items
    const dir = join(this.bridge.store(kbId).layout.metaDir, 'sources')
    const files = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as Dirent[]; throw error })
    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.json')) continue
      try { items.push(JSON.parse(await readFile(join(dir, file.name), 'utf8')) as Item) } catch { /* same as above */ }
    }
    return items
  }
  /**
   * Archive categories already established for this library. They are read from durable archive
   * evidence (receipts, jobs, the archive ledger and root inventory ledgers) so that an existing
   * archive subtree is never mistaken for a delivery folder and reorganized.
   */
  protected async receiptCategories(kbId: string, root: string): Promise<Set<string>> {
    const names = new Set<string>()
    const add = (item: Partial<Item>): void => {
      if (typeof item.category === 'string' && item.category) names.add(item.category)
      if (typeof item.archived === 'string' && isPathInside(root, item.archived)) {
        const first = relative(root, item.archived).split(sep)[0]
        if (first && first !== '..') names.add(first)
      }
    }
    for (const item of await this.receiptItems(kbId)) add(item)
    for (const job of this.allJobs(kbId)) for (const item of job.items) add(item)
    return names
  }
  protected async receipt(job: WikiIngestJob,item: Item): Promise<void> {
    const dir=join(this.bridge.store(job.kbId).layout.metaDir,'sources');await mkdir(dir,{recursive:true})
    const path=join(dir,item.sha+'.json')
    try{const h=await open(path,'wx');try{await h.writeFile(JSON.stringify(item,null,2));await h.sync()}finally{await h.close()}}
    catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=JSON.parse(await readFile(path,'utf8')) as Item;if(old.sha!==item.sha||old.stage!=='done')throw new Error('WIKI_RECEIPT_CONFLICT')}
    this.db.prepare('INSERT INTO wiki_source_receipts VALUES(?,?,?) ON CONFLICT(kb_id,sha) DO UPDATE SET body=excluded.body').run(job.kbId,item.sha,JSON.stringify(item))
  }
}
