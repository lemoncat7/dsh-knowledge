import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
const path='/knowledge-control/v1/activity/wiki-mentions'
interface Ref { id:string; title:string; sessionId:string; sourceKey:string }
function parse(raw:string|undefined):Ref|undefined{try{if(!raw||raw.length>4096)return;const v=JSON.parse(raw) as Ref;if(typeof v.id==='string'&&typeof v.title==='string'&&typeof v.sessionId==='string'&&typeof v.sourceKey==='string')return v}catch{}return undefined}
export function createWikiMentionSource(request:typeof fetch=fetch):InputTriggerSource{
  async function read(url:string,signal:AbortSignal):Promise<Record<string,unknown>>{const r=await request(url,{signal,headers:{'x-dsh-knowledge-client':'conversation-web'}});const b=await r.json() as Record<string,unknown>;if(!r.ok)throw new Error(String(b.error??'Wiki 引用不可用'));return b}
  return{trigger:'@',name:'knowledge-wiki',order:21,showGroupTitle:true,
    async candidates(session,{query,quoted,drilled,signal}){
      if(quoted||drilled||query.length>255)return[]
      const b=await read(`${path}?${new URLSearchParams({sessionId:session.sessionId,q:query})}`,signal)
      if(!Array.isArray(b.items)||typeof b.sourceKey!=='string')throw new Error('WIKI_MENTION_INVALID')
      return b.items.map(item=>{const p=item as {id:string;title:string;base:string};return{name:p.title,icon:'file' as const,section:'Wiki 知识页',description:p.base,value:JSON.stringify({id:p.id,title:p.title,sessionId:session.sessionId,sourceKey:b.sourceKey})}})
    },
    onPick({candidate,session,action}){const p=parse(candidate.value);if(action!=='pick'||!p||p.sessionId!==session.sessionId)return;return{insert:{source:'knowledge-wiki',ref:candidate.value!,label:p.title,appearance:'file',clipboardText:p.title}}},
    codec:{clipboardText(ref){const p=parse(ref);if(!p)throw new Error('WIKI_REFERENCE_INVALID');return p.title},async serialize(ref,signal){const p=parse(ref);if(!p)throw new Error('WIKI_REFERENCE_INVALID');const b=await read(`${path}/${encodeURIComponent(p.id)}?${new URLSearchParams({sessionId:p.sessionId,sourceKey:p.sourceKey})}`,signal);if(typeof b.text!=='string')throw new Error('WIKI_REFERENCE_INVALID');return b.text}}
  }
}
