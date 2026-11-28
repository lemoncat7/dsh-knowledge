// User-run offline helper. Does not read the current profile or mutate source directories.
import { readdir, readFile, writeFile, mkdir, lstat } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
const [sourceArg, destinationArg] = process.argv.slice(2)
if (!sourceArg || !destinationArg) throw new Error('Usage: node scripts/wiki-export.mjs <copied-workspace-root> <new-backup-directory>')
const source=resolve(sourceArg),destination=resolve(destinationArg)
if(destination===source||destination.startsWith(source+'\\')||destination.startsWith(source+'/'))throw new Error('Backup must be outside source')
await mkdir(destination,{recursive:false})
const manifest=[]
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw new Error('Symlink/junction export requires explicit operator handling: '+entry.name)
  const path=join(dir,entry.name)
  if(entry.isDirectory())await walk(path)
  else if(entry.isFile()){
    const bytes=await readFile(path),rel=relative(source,path),out=join(destination,rel)
    await mkdir(resolve(out,'..'),{recursive:true});await writeFile(out,bytes,{flag:'wx'})
    manifest.push({path:rel,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
  }
}}
await walk(source)
await writeFile(join(destination,'knowledge-backup-manifest.json'),JSON.stringify({format:1,createdAt:new Date().toISOString(),source,files:manifest},null,2),{flag:'wx'})
console.log(JSON.stringify({destination,files:manifest.length}))
