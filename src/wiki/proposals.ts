import type { DatabaseSync } from 'node:sqlite'
import type { WikiProviderBridge } from './provider-bridge.js'
import { wikiHash } from './commit.js'
import type { WikiProvenance } from './identity.js'
/**
 * @deprecated Distillation no longer stages updates for review: a suggested update to an existing page
 * is written directly behind a scope check and a hash compare-and-set, so nothing calls put/review.
 * The table, the type and the HTTP routes stay only so historical rows remain readable and the
 * management API keeps its shape.
 */
export interface WikiUpdateProposal { id: string; kbId: string; pageId: string; expectedHash: string; bytes: string; provenance: WikiProvenance; state: 'pending' | 'approved' | 'rejected'; sourceSha: string; createdAt: string }
/** @deprecated Kept for backward compatibility and audit of historical proposals; not part of the distill workflow. */
export class WikiProposals {
  constructor(private readonly db: DatabaseSync,private readonly bridge: WikiProviderBridge){db.exec('CREATE TABLE IF NOT EXISTS wiki_update_proposals(id TEXT PRIMARY KEY,kb_id TEXT NOT NULL,body TEXT NOT NULL)')}
  list(kbId:string):WikiUpdateProposal[]{return(this.db.prepare('SELECT body FROM wiki_update_proposals WHERE kb_id=? ORDER BY rowid DESC LIMIT 100').all(kbId) as {body:string}[]).map(r=>JSON.parse(r.body) as WikiUpdateProposal)}
  put(value:WikiUpdateProposal):void{this.db.prepare('INSERT INTO wiki_update_proposals VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(value.id,value.kbId,JSON.stringify(value))}
  async review(kbId:string,id:string,approve:boolean):Promise<void>{
    const proposal=this.list(kbId).find(p=>p.id===id);if(!proposal)throw new Error('WIKI_PROPOSAL_NOT_FOUND')
    await this.bridge.store(kbId).committer.recover()
    if(proposal.state==='approved'&&approve)return
    if(proposal.state!=='pending')throw new Error('WIKI_PROPOSAL_ALREADY_REVIEWED')
    if(approve){
      const store=this.bridge.store(kbId),page=await store.page(proposal.pageId)
      if(page.page.lastOperation===`proposal:${proposal.id}`){proposal.state='approved';this.db.prepare('UPDATE wiki_update_proposals SET body=? WHERE id=?').run(JSON.stringify(proposal),id);return}
      if(wikiHash(page.bytes)!==proposal.expectedHash)throw new Error('WIKI_PROPOSAL_STALE')
      await store.save(proposal.pageId,Buffer.from(proposal.bytes,'base64'),proposal.expectedHash,proposal.provenance,`proposal:${proposal.id}`)
    }
    proposal.state=approve?'approved':'rejected'
    this.db.prepare('UPDATE wiki_update_proposals SET body=? WHERE id=?').run(JSON.stringify(proposal),id)
  }
}
