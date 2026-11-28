import { sqliteRevision } from '../storage/sqlite-revision.js'
import { hash, noteFingerprint, treeFingerprint, syncError, type NoteSyncChange, type NoteManifest } from './sync-protocol.js'
import { isEditableNoteNode, isNoteId, type NoteNode } from './domain.js'
import {
  MAX_NOTE_BYTES,
  NOTE_COLUMNS,
  mapNoteNode,
  normalizeMediaType,
  normalizeNoteName,
  normalizeParentId,
  parentKey,
  type NoteStoreHost,
  type NoteStoreTreeAccess,
  type SqlRow,
} from './note-store-internal.js'

export interface NoteStoreSyncDeps extends NoteStoreHost { readonly tree: NoteStoreTreeAccess }

/** Offline-workspace manifest and idempotent sync application. */
export class NoteStoreSync {
  constructor(private readonly deps: NoteStoreSyncDeps) {}

  syncManifest(): NoteManifest {
    this.deps.assertOpen()
    const revision = sqliteRevision(this.deps.db)
    const cached = this.deps.manifestCache.value
    if (!this.deps.db.isTransaction && cached !== undefined && cached.revision === revision) return structuredClone(cached.manifest)
    const nodes = (this.deps.db.prepare(`SELECT ${NOTE_COLUMNS} FROM note_nodes ORDER BY id LIMIT 10001`).all() as SqlRow[]).map(mapNoteNode)
    if(nodes.length>10000) throw syncError(413,'第一版离线工作区最多支持 10000 个笔记节点；未截断或删除任何内容')
    const manifest: NoteManifest = {protocol:1,instance:String((this.deps.db.prepare("SELECT value FROM note_sync_meta WHERE key='instance'").get() as SqlRow).value),revision:treeFingerprint(nodes),nodes}
    // A manifest read inside a transaction may observe changes later rolled
    // back. total_changes() itself is not rolled back, so never cache that view.
    this.deps.manifestCache.value = this.deps.db.isTransaction ? undefined : { revision, manifest }
    return structuredClone(manifest)
  }
  /** Content, metadata and deduplication receipt commit in one SQLite transaction. */
  applySyncChange(actor:string, change:NoteSyncChange): NoteNode|null {
    if(!change || typeof change.operationId!=='string' || !/^[a-f0-9-]{36}$/.test(change.operationId) || !isNoteId(change.id)
      || !(change.base===null || typeof change.base==='string' && /^[a-f0-9]{64}$/.test(change.base))) throw syncError(400,'invalid note sync operation')
    if(change.instance!==this.syncManifest().instance)throw syncError(409,'远程数据库身份不匹配，已停止同步')
    const digest=hash(JSON.stringify(change))
    const receipt=this.deps.db.prepare('SELECT digest,result FROM note_sync_receipts WHERE actor=? AND operation_id=?').get(actor,change.operationId) as SqlRow|undefined
    if(receipt){if(receipt.digest!==digest)throw syncError(409,'operation ID was reused with different content');return JSON.parse(String(receipt.result)) as NoteNode|null}
    if(this.deps.contentMutationTails.size)throw syncError(423,'笔记正在保存，请稍后重试同步')
    const current=this.deps.tree.get(change.id)
    if(noteFingerprint(current)!==change.base)throw syncError(409,'远程笔记已变化，本地内容保留，请处理冲突')
    const value=change.value
    let result:NoteNode|null=null, bytes:Buffer|undefined
    if(value!==null){
      if(!value || !['folder','document','file'].includes(value.kind) || typeof value.content!=='string')throw syncError(400,'invalid note sync value')
      const name=normalizeNoteName(value.name),parentId=normalizeParentId(value.parentId)
      if(parentId!==null){this.deps.tree.assertFolder(parentId);if(parentId===change.id || this.deps.tree.isDescendant(parentId,change.id))throw syncError(409,'目录不能移动到自身内部')}
      this.deps.tree.assertNameAvailable(parentId,name,change.id)
      if(current && (current.kind!==value.kind || current.mediaType!==value.mediaType))throw syncError(409,'同步不能改变笔记类型')
      bytes=Buffer.from(value.content,'base64')
      if(bytes.toString('base64')!==value.content || bytes.length>MAX_NOTE_BYTES)throw syncError(413,'invalid or oversized note content')
      if(value.kind==='folder'&&bytes.length)throw syncError(400,'folder cannot have content')
      const mediaType=value.kind==='folder'?null:normalizeMediaType(value.mediaType??'application/octet-stream')
      const sha256=value.kind==='folder'?null:hash(bytes)
      const changed=!current||current.sha256!==sha256
      const now=new Date().toISOString()
      result={id:change.id,kind:value.kind,name,parentId,mediaType,sha256,size:bytes.length,version:current ? current.version+(changed?1:0):1,createdAt:current?.createdAt??now,updatedAt:now,editable:isEditableNoteNode({kind:value.kind,name,mediaType})}
    }else if(current && change.subtree!==treeFingerprint(this.deps.tree.subtree(change.id)))throw syncError(409,'待删除目录内容已变化')
    this.deps.db.exec('BEGIN IMMEDIATE')
    try{
      if(result){
        this.deps.db.prepare(`INSERT INTO note_nodes(id,parent_id,parent_key,kind,name,media_type,size,sha256,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,parent_key=excluded.parent_key,name=excluded.name,size=excluded.size,sha256=excluded.sha256,version=excluded.version,updated_at=excluded.updated_at`)
          .run(result.id,result.parentId,parentKey(result.parentId),result.kind,result.name,result.mediaType,result.size,result.sha256,result.version,result.createdAt,result.updatedAt)
        if(result.kind!=='folder'){
          this.deps.db.prepare('INSERT OR REPLACE INTO note_sync_content VALUES(?,?,?)').run(result.id,result.version,bytes!)
          if(result.editable)this.deps.db.prepare('INSERT OR REPLACE INTO note_versions VALUES(?,?,?,?,?,?,?)').run(result.id,result.version,result.name,result.mediaType,result.size,result.sha256,result.updatedAt)
        }
      }else if(current){
        this.deps.db.prepare(`WITH RECURSIVE children(id) AS (SELECT id FROM note_nodes WHERE id=? UNION ALL SELECT n.id FROM note_nodes n JOIN children c ON n.parent_id=c.id) DELETE FROM note_nodes WHERE id IN (SELECT id FROM children)`).run(change.id)
      }
      this.deps.db.prepare('INSERT INTO note_sync_receipts VALUES(?,?,?,?)').run(actor,change.operationId,digest,JSON.stringify(result))
      this.deps.db.exec('COMMIT');return result
    }catch(error){this.deps.db.exec('ROLLBACK');throw error}
  }
}
