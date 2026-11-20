import { readdir, readFile, realpath, lstat, open, rename, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WikiLayout } from './paths.js'
import { isPathInside } from './paths.js'
import { wikiHash } from './commit.js'
export async function listRaw(layout:WikiLayout):Promise<{path:string;bytes:number}[]>{
  const root=await realpath(layout.rawDir),result:{path:string;bytes:number}[]=[]
  async function walk(dir:string,prefix:string):Promise<void>{
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue
      const path=join(dir,entry.name),rel=prefix+entry.name
      if(entry.isDirectory())await walk(path,rel+'/')
      else if(entry.isFile()&&entry.name.endsWith('.md'))result.push({path:rel,bytes:(await lstat(path)).size})
      if(result.length>10000)throw new Error('WIKI_RAW_LIST_LIMIT')
    }
  }
  await walk(root,'');return result
}
export async function readRaw(layout:WikiLayout,rel:string,offset:number):Promise<{text:string;offset:number;nextOffset?:number;sha256:string}>{
  if(!rel||rel.includes('\\')||rel.includes(':')||rel.split('/').some(p=>!p||p==='.'||p==='..')||!rel.endsWith('.md'))throw new Error('WIKI_RAW_PATH_INVALID')
  const root=await realpath(layout.rawDir),target=await realpath(join(root,rel))
  if(!isPathInside(root,target))throw new Error('WIKI_RAW_ESCAPE')
  const bytes=await readFile(target);if(bytes.length>16_000_000)throw new Error('WIKI_RAW_TOO_LARGE')
  const text=bytes.toString('utf8'),start=Math.max(0,Math.trunc(offset)),end=Math.min(text.length,start+20000)
  return{text:text.slice(start,end),offset:start,...(end<text.length?{nextOffset:end}:{}),sha256:wikiHash(bytes)}
}
/** Versioned supplemental CSV; never rewrite an unknown legacy archive schema. */
export async function recordArchiveCsv(sourceRoot:string,item:{id:string;sha:string;size:number;category?:string;archived?:string}):Promise<void>{
  const target=join(sourceRoot,'knowledge-archive.csv')
  let old='operation_id,sha256,size_bytes,category_dir,archive_path\r\n'
  try{old=await readFile(target,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  if(old.split(/\r?\n/).some(line=>line.startsWith('"'+item.id+'",')))return
  const escape=(s:unknown)=>'"'+String(s??'').replaceAll('"','""')+'"'
  const bytes=Buffer.from(old+[item.id,item.sha,item.size,item.category,item.archived].map(escape).join(',')+'\r\n')
  const temp=join(dirname(target),`.knowledge-csv-${randomUUID()}.tmp`),h=await open(temp,'wx')
  try{await h.writeFile(bytes);await h.sync()}finally{await h.close()}
  try{await rename(temp,target)}catch(e){await unlink(temp).catch(()=>{});throw e}
}
