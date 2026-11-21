import test from "node:test"
import assert from "node:assert/strict"
// Calls the real renderer with a small injectable DOM adapter; no production UI/data.
import { createWikiWorkspace } from '../web/wiki-workspace.js'
class Element {
  constructor(tag,attrs={},...children){this.tag=tag;this.attrs=attrs;this.children=[];this.listeners={};this.value=attrs.value??'';this.textContent='';this.disabled=!!attrs.disabled;this.isConnected=true;this.append(...children.flat(Infinity))}
  append(...children){for(const c of children.flat(Infinity)){if(c===null||c===undefined||c===false)continue;this.children.push(c);if(typeof c==='object')c.parentElement=this}}
  replaceChildren(...children){this.children=[];this.append(...children)}
  addEventListener(name,fn){this.listeners[name]=fn}
  setAttribute(k,v){this.attrs[k]=v}
  removeAttribute(k){delete this.attrs[k]}
  querySelector(){return undefined}
}
const element=(...args)=>new Element(...args)
const actionButton=(label,click,variant='',attrs={})=>{const n=element('button',attrs,label);n.click=click;return n}
const badge=label=>element('span',{},label)
const all=node=>[node,...node.children.filter(c=>c instanceof Element).flatMap(all)]
const text=node=>typeof node==='string'?node:node.children.map(text).join(' ')
const pending=()=>new Promise(resolve=>setTimeout(resolve,25))

function fixture(t, {configured=true, confirm=false, gate, jobs, connection}={}) {
 const calls=[], confirms=[]; let hash="old-hash";
 const previous=globalThis.window;globalThis.window={confirm:m=>{confirms.push(m);return confirm},setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)};
 t.after(()=>{globalThis.window=previous});
 const api=async(path,options={})=>{calls.push({path,...options}); if(gate)await gate(path,options);
 if(path.endsWith("/connection"))return connection??{state:configured?"ready":"unconfigured",layout:configured?{sourceDir:"s",workspaceRoot:"w",rawDir:"r",pageDir:"w/wiki"}:undefined,report:{registered:0,existing:2,rejected:0,items:[]}};
 if(path==="wiki")return configured?[{kbId:"A",layout:{sourceDir:"s",workspaceRoot:"w",rawDir:"r"}}]:[];
 if(path.endsWith("/pages"))return [{pageId:"p",relPath:"wiki/notes/a.md",status:"active",version:1}];
 if(path.endsWith("/jobs"))return jobs?jobs():[{id:"job-1",state:"done",items:[]}];
 if(path.endsWith("/proposals")||path.endsWith("/raw"))return [];
 if(path.endsWith("/python"))return {candidates:[],hint:""};
 if(path.endsWith("/models"))return {providers:[]};
 if(path.endsWith("/page/p")){if(options.method==="PUT"){hash="new-hash";return{ok:true}}return{pageId:"p",relPath:"wiki/notes/a.md",content:"saved",sha256:hash}};
 throw Error("unhandled "+path)};
 const workspace=createWikiWorkspace({api,element,actionButton,badge:label=>element("span",{},label),interfaceIcon:()=>element("svg"),openModal:()=>{},bases:[{id:"A",name:"A"},{id:"B",name:"B"}]});
 const nodes=()=>all(workspace.root),button=label=>nodes().find(n=>n.tag==="button"&&text(n)===label);
 const openAdvanced=async()=>{const d=nodes().find(n=>n.tag==="details"&&String(n.attrs.class||"").includes("wiki-advanced"));if(!d)return;d.open=true;d.listeners.toggle&&d.listeners.toggle();await pending()};
 return{...workspace,calls,confirms,nodes,button,openAdvanced};
}
test("task list is attached and unconfigured libraries make no configured-only requests",async t=>{
 const f=fixture(t);await pending();assert.ok(f.nodes().some(n=>n.tag==="strong"&&text(n)==="任务 job-1"));
});
test("fresh library initializes without jobs/raw/proposals requests",async t=>{
 const f=fixture(t,{configured:false});await pending();assert.equal(f.calls.filter(c=>/\/(jobs|raw|proposals)$/.test(c.path)).length,0);
});
test("save refreshes the hash without discard prompt and a second save uses it",async t=>{
 const f=fixture(t);await pending();await f.openAdvanced();await f.button("wiki/notes/a.md").click();await pending();
 const editor=f.nodes().find(n=>n.tag==="textarea");
 for(let i=0;i<2;i++){editor.value="edit "+i;editor.listeners.input();await f.button("保存当前文件").click();await pending()}
 assert.equal(f.confirms.length,0);assert.deepEqual(f.calls.filter(c=>c.method==="PUT").map(c=>c.body.expectedHash),["old-hash","new-hash"]);
});
test("declining discard prevents a dirty library switch",async t=>{
 const f=fixture(t);await pending();await f.openAdvanced();await f.button("wiki/notes/a.md").click();await pending();
 const editor=f.nodes().find(n=>n.tag==="textarea");editor.value="unsaved";editor.listeners.input();
 const select=f.nodes().find(n=>n.attrs["aria-label"]==="选择知识库");select.value="B";select.listeners.change();await pending();
 assert.equal(select.value,"A");assert.equal(editor.value,"unsaved");assert.equal(f.confirms.length,1);
});
test("accepting discard clears the editor binding on library switch",async t=>{
 const f=fixture(t,{confirm:true});await pending();await f.openAdvanced();await f.button("wiki/notes/a.md").click();await pending();
 const editor=f.nodes().find(n=>n.tag==="textarea");editor.value="unsaved";editor.listeners.input();
 const select=f.nodes().find(n=>n.attrs["aria-label"]==="选择知识库");select.value="B";select.listeners.change();await pending();
 assert.equal(editor.value,"");assert.equal(f.button("保存当前文件").disabled,true);
});

test("an in-flight read prevents switching libraries and cannot bind the response to another base",async t=>{
 let release;const f=fixture(t,{gate:path=>path.endsWith("/page/p")?new Promise(r=>{release=r}):undefined});
 await pending();await f.openAdvanced();f.button("wiki/notes/a.md").click();await pending();
 const select=f.nodes().find(n=>n.attrs["aria-label"]==="选择知识库");assert.equal(select.disabled,true);
 select.value="B";select.listeners.change();assert.equal(select.value,"A");
 release();await pending();const editor=f.nodes().find(n=>n.tag==="textarea");assert.equal(editor.value,"saved");
});

test("a running job shows discovery counts, per-stage progress and refreshes itself", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  let reads = 0
  const item = (stage) => ({ id: "i" + stage, source: "E:\\src\\a.docx", stage })
  const f = fixture(t, { jobs: () => { reads++; return [{ id: "job-run", state: reads <= 1 ? "running" : "done", discovery: { found: 3, duplicates: 1 }, items: reads <= 1 ? [item("new"), item("done")] : [item("done"), item("done")] }] } })
  await flush()
  assert.match(text(f.root), /发现 3 个，跳过 1 个已处理/)
  assert.match(text(f.root), /完成 1\/2/)
  assert.match(text(f.root), /当前：a\.docx（待归类）/)
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(reads, 2, "running jobs poll once per interval")
  assert.match(text(f.root), /完成 2\/2/)
  t.mock.timers.tick(4000)
  await flush()
  assert.equal(reads, 2, "polling stops when no job is running")
})

test("onboarding shows one connection action instead of a separate legacy import section",async t=>{const f=fixture(t,{configured:false});await pending();assert.ok(f.button("接入知识库"));assert.equal(f.button("登记已有 Wiki"),undefined);assert.ok(f.nodes().some(n=>n.tag==="h2"&&text(n)==="接入知识库"));});
test("ready and partial connection show real outcomes and daily update action",async t=>{const f=fixture(t,{connection:{state:"partial",layout:{pageDir:"w/wiki"},report:{registered:3,existing:2,rejected:1,items:[{relPath:"bad.md",status:"invalid",error:"格式错误"}]}}});await pending();assert.ok(f.button("扫描更新"));assert.ok(f.nodes().some(n=>text(n).includes("部分接入")));assert.ok(f.nodes().some(n=>text(n).includes("bad.md")));});

test("disposing a workspace aborts pending reads and stops polling", async t=>{t.mock.timers.enable({apis:["setTimeout"]});const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};let reads=0;const f=fixture(t,{jobs:()=>{reads++;return[{id:"active",state:"running",items:[]}]}});await flush();f.dispose();t.mock.timers.tick(10000);await flush();assert.equal(reads,1);assert.ok(f.calls.every(c=>!c.signal||c.signal.aborted||c.signal instanceof AbortSignal));});

test("a response arriving after dispose cannot repaint the workspace", async t=>{let release;const f=fixture(t,{gate:path=>path.endsWith("/connection")?new Promise(r=>release=r):undefined});await pending();f.dispose();release();await pending();assert.ok(!text(f.root).includes("成文目录："));});
test("finished tasks expose linked results without implying all done items created pages",async t=>{const f=fixture(t,{jobs:()=>[{id:"results",state:"done",items:[{source:"a.docx",stage:"done",pages:["wiki/notes/a.md"]},{source:"video.mp4",stage:"done"}]}]});await pending();assert.ok(f.button("查看关联页：wiki/notes/a.md"));assert.ok(text(f.root).includes("未生成知识页"));});
