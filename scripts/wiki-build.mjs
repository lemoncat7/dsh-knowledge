// Build/package only; deliberately does not execute tests or install into a profile.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
function run(args){const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1)}
run(['node_modules/typescript/bin/tsc','-p','tsconfig.json'])
run(['scripts/build-client.mjs'])
console.log('Build finished. Tests NOT RUN. Use your package manager pack --ignore-scripts to create the archive; do not publish or install into production before acceptance.')
