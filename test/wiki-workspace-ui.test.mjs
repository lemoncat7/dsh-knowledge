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
  get textContent(){return this.children.map(text).join("")}
  set textContent(value){this.children=[];if(value!==""&&value!==undefined&&value!==null)this.append(String(value))}
}
const element=(...args)=>new Element(...args)
const actionButton=(label,click,variant='',attrs={})=>{const n=element('button',attrs,label);n.click=click;return n}
const badge=label=>element('span',{},label)
const all=node=>[node,...node.children.filter(c=>c instanceof Element).flatMap(all)]
const text=node=>typeof node==='string'?node:node.children.map(text).join(' ')
const pending=()=>new Promise(resolve=>setTimeout(resolve,25))

function fixture(t, {configured=true, confirm=false, gate, jobs, connection, scan, changes, storedChanges, jobError, dismissFinished, pages, otherJobs, processError, python, models}={}) {
 const calls=[], confirms=[]; let hash="old-hash";
 const previous=globalThis.window;globalThis.window={confirm:m=>{confirms.push(m);return confirm},setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)};
 t.after(()=>{globalThis.window=previous});
 const api=async(path,options={})=>{calls.push({path,...options}); if(gate)await gate(path,options);
 if(path.endsWith("/connection"))return connection??{state:configured?"ready":"unconfigured",layout:configured?{sourceDir:"s",workspaceRoot:"w",rawDir:"r",pageDir:"w/wiki"}:undefined,report:{registered:0,existing:2,rejected:0,items:[]}};
 if(path==="wiki")return configured?[{kbId:"A",layout:{sourceDir:"s",workspaceRoot:"w",rawDir:"r"}}]:[];
 if(path.endsWith("/changes"))return options.method==="POST"?(typeof changes==="function"?changes():changes??null):(storedChanges??null);
 if(path.endsWith("/job"))return {hidden: dismissFinished??0};
 if(path.endsWith("/pages"))return pages??[{pageId:"p",relPath:"wiki/notes/a.md",status:"active",version:1}];
 if(path.endsWith("/scan"))return scan??{connection:{state:"ready",layout:{pageDir:"w/wiki"},report:{registered:0,existing:0,rejected:0,items:[]}},files:[{name:"a.docx",size:2048,duplicate:false},{name:"done.docx",size:10,duplicate:true}]};
 if(path.endsWith("/process")){if(processError)throw Object.assign(new Error(processError.message??processError),{code:processError.code??""});return {id:"job-new",state:"running",items:[{id:"i",source:"a.docx",stage:"new"}],discovery:{found:2,duplicates:1},kbId:"A",settings:{},createdAt:"",updatedAt:""}};
 if(path.includes("/job/")){if(jobError)throw Object.assign(new Error(jobError),{code:jobError});return {ok:true}};
 if(path==="wiki/B/jobs")return typeof otherJobs==="function"?otherJobs():(otherJobs??[]);
 if(path.endsWith("/jobs"))return jobs?jobs():[{id:"job-1",state:"done",items:[]}];
 if(path.endsWith("/proposals")||path.endsWith("/raw"))return [];
 if(path.endsWith("/python"))return python??{candidates:[],hint:""};
 if(path.endsWith("/models"))return models??{providers:[]};
 if(path.endsWith("/page/p")){if(options.method==="PUT"){hash="new-hash";return{ok:true}}return{pageId:"p",relPath:"wiki/notes/a.md",content:"saved",sha256:hash}};
 if(path.includes("/page/")&&options.method!=="PUT")return {pageId:path.split("/page/")[1],relPath:"wiki/notes/read.md",content:"# 只读内容",sha256:"read-hash"};
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

test("setup has only three directory fields and no project controls",async t=>{const f=fixture(t,{configured:false});await pending();assert.equal(f.nodes().find(n=>n.attrs["aria-label"]==="范围"),undefined);assert.equal(f.nodes().find(n=>n.attrs["aria-label"]==="项目编号"),undefined);assert.ok(f.nodes().find(n=>n.attrs["aria-label"]==="Wiki 文件夹"));assert.equal(f.nodes().filter(n=>n.tag==="button"&&text(n)==="选择目录").length,3);});

test("scan only previews candidates and offers a separate confirmed processing action",async t=>{const f=fixture(t);await pending();await f.button("扫描更新").click();await pending();assert.ok(f.calls.some(c=>c.path.endsWith("/scan")));assert.ok(!f.calls.some(c=>c.path.endsWith("/process")),"scan must not start processing");assert.match(text(f.root),/发现 1 个待处理原件/);const start=f.button("开始处理");assert.ok(start);assert.equal(start.disabled,true,"needs model consent");const consent=f.nodes().filter(n=>n.tag==="input"&&n.attrs.type==="checkbox").at(-1);consent.checked=true;consent.listeners.change();assert.equal(start.disabled,false);});
test("a running job always exposes a stop control that cancels it",async t=>{const f=fixture(t,{jobs:()=>[{id:"running-1",state:"running",items:[{id:"i",source:"a.docx",stage:"new"}]}]});await pending();const stop=f.button("停止");const bar=f.nodes().find(n=>String(n.attrs.class||"").includes("wiki-runbar"));assert.equal(bar.hidden,false,"stop bar visible while running");assert.ok(stop);await stop.click();await pending();const cancel=f.calls.find(c=>c.path.includes("/job/running-1"));assert.deepEqual(cancel.body,{action:"cancel"});f.dispose();});

// A bare "异常 38 篇" told the operator nothing: the count must carry meaning, grouped reasons and real paths.
const rejectionReason = "front matter 解析失败，读不出标题与来源（YAML 解析错误 BLOCK_AS_IMPLICIT_KEY），因此未登记、不可检索；原文件未被改写";
function rejectedReport() {
  const items = Array.from({length:38},(_,i)=>({relPath:`${i<10?"howtos":"notes"}/旧页${i}.md`,title:"",sha256:"",chars:0,status:"invalid",errorCode:"INVALID_MARKDOWN",errorReason:rejectionReason}));
  return {registered:49,existing:0,rejected:38,repaired:0,items,
    issues:[{code:"INVALID_MARKDOWN",reason:rejectionReason,count:38,examples:["howtos/旧页0.md","howtos/旧页1.md","notes/旧页10.md"]}]};
}
test("a rejected page count is explained with meaning, grouped reasons and examples",async t=>{
 const f=fixture(t,{connection:{state:"partial",layout:{pageDir:"w/wiki"},report:rejectedReport()}});await pending();
 const view=text(f.root);
 assert.match(view,/异常 38 篇/,"the count stays visible");
 assert.match(view,/异常 38 篇（未登记、不可检索）/,"the count says what it means");
 assert.match(view,/front matter/,"explains that front matter cannot be parsed");
 assert.match(view,/读不出标题与来源/);
 assert.match(view,/页面文件本身没有被修改/);
 assert.match(view,/INVALID_MARKDOWN/,"grouped by reason code");
 assert.match(view,/BLOCK_AS_IMPLICIT_KEY/,"keeps the concrete YAML error");
 for (const example of ["howtos/旧页0.md","howtos/旧页1.md","notes/旧页10.md"]) assert.ok(view.includes(example),"example path "+example);
 assert.match(view,/重新接入/,"tells the operator how to get the pages registered");
 assert.ok(f.nodes().some(n=>n.tag==="summary"&&text(n)==="查看异常清单（38 条）"),"the listing is reachable");
 const listing=f.nodes().find(n=>String(n.attrs.class||"").includes("wiki-rejection-list"));
 assert.ok(listing,"the rejected listing exists");
 assert.equal(all(listing).filter(n=>n.tag==="div"&&String(n.attrs.class||"").includes("wiki-row-detail")).length,38,"every rejected page is listed");
});

test("a stored report without issue groups still explains and groups itself",async t=>{
 const reason="INVALID_MARKDOWN：front matter 解析失败，读不出标题与来源";
 const items=["howtos/0.md","notes/1.md","notes/2.md","notes/3.md"].map(relPath=>({relPath,title:"",sha256:"",chars:0,status:"invalid",error:reason}));
 const f=fixture(t,{connection:{state:"partial",layout:{pageDir:"w/wiki"},report:{registered:0,existing:49,rejected:4,items}}});await pending();
 const view=text(f.root);
 assert.match(view,/异常 4 篇/);
 assert.ok(view.includes("INVALID_MARKDOWN"),"the code is recovered from the stored message");
 assert.ok(view.includes("front matter 解析失败"),"the stored reason is shown");
 assert.ok(view.includes("howtos/0.md")&&view.includes("notes/2.md"),"three examples come from the stored items");
 assert.ok(view.includes("notes/3.md"),"the listing still reaches pages beyond the example cap");
});

test("pages read through the restricted rule say the files were not changed",async t=>{
 const f=fixture(t,{connection:{state:"ready",layout:{pageDir:"w/wiki"},report:{registered:87,existing:0,rejected:0,repaired:38,items:[{relPath:"howtos/a.md",title:"",sha256:"",chars:10,status:"new",metadataRepair:{kind:"quoted-scalars",fields:["source-note"],lines:[3]}}],issues:[]}}});await pending();
 const view=text(f.root);
 assert.match(view,/需修复元数据 38 篇/);
 assert.match(view,/已按受限规则读取/);
 assert.match(view,/文件未改动/);
 assert.equal(f.nodes().some(n=>String(n.attrs.class||"").includes("wiki-rejection-list")),false,"nothing rejected means no rejection block");
});

test("scan preview separates root-level files from folder deliveries",async t=>{
 const scan={connection:{state:"ready",layout:{pageDir:"w/wiki"},report:{registered:0,existing:0,rejected:0,repaired:0,items:[],issues:[]}},
  files:[{name:"根层.docx",size:2048,duplicate:false},
   {name:"甲.pdf",size:4096,duplicate:false,folder:"外部投递",relPath:"甲.pdf"},
   {name:"乙.pdf",size:1024,duplicate:false,folder:"外部投递",relPath:"子目录/乙.pdf"},
   {name:"旧.pdf",size:10,duplicate:true,folder:"外部投递",relPath:"旧.pdf"}],
  folders:[{name:"外部投递",count:3}]};
 const f=fixture(t,{scan});await pending();await f.button("扫描更新").click();await pending();
 const view=text(f.root);
 assert.match(view,/根层文件（1 个待处理）/);
 assert.ok(view.includes("根层.docx"),"root-level file is listed");
 assert.match(view,/文件夹投递（1 个文件夹，2 个待处理）/);
 assert.ok(view.includes("外部投递"),"the delivery folder name is visible");
 assert.match(view,/共 3 个文件/,"the folder total includes already-processed files");
 assert.ok(view.includes("子目录/乙.pdf"),"the path inside the folder is kept");
 assert.match(view,/发现 3 个待处理原件/);
 assert.match(view,/根层文件 1 个/);
 assert.match(view,/文件夹投递 2 个，来自 1 个文件夹/);
 assert.doesNotMatch(view,/分类子目录不会被扫描/,"the outdated promise is gone");
 assert.match(view,/已归档的分类目录不重复处理/,"the current scan semantics are stated");
 assert.ok(f.calls.some(c=>c.path.endsWith("/scan")));
 assert.ok(!f.calls.some(c=>c.path.endsWith("/process")),"scan still only previews");
 const start=f.button("开始处理");
 assert.ok(start,"the confirmed processing step is still offered");
 assert.equal(start.disabled,true,"needs model consent");
 assert.equal(start.hidden,false);
});

test("scan preview explains files that are too large instead of hiding them",async t=>{
 const scan={connection:{state:"ready",layout:{pageDir:"w/wiki"},report:{registered:0,existing:0,rejected:0,repaired:0,items:[],issues:[]}},
  files:[{name:"正常.docx",size:2048,duplicate:false}],
  folders:[],
  skipped:[{name:"超大扫描件.pdf",size:257*1024*1024,reason:"可抽取类型超过 256 MB 上限，未处理；请拆分或转换后再投递",folder:"外部投递",relPath:"超大扫描件.pdf"}]};
 const f=fixture(t,{scan});await pending();await f.button("扫描更新").click();await pending();
 const view=text(f.root);
 assert.match(view,/因过大未处理（1 个文件）/);
 assert.ok(view.includes("超大扫描件.pdf"),"the skipped file name is visible");
 assert.match(view,/可抽取类型超过 256 MB 上限/);
 assert.match(view,/另有 1 个文件因过大未处理/);
 assert.ok(!f.calls.some(c=>c.path.endsWith("/process")),"skipped files never start processing");
});

test("a registered-only item says it is registered in place without extraction",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"reg",state:"done",items:[{source:"video.mp4",stage:"done",registered:true,inPlace:true}]}]});await pending();
 assert.match(text(f.root),/已登记（原位，不搬运）：该类型不抽取/);
});

// Source changes: the host owns the periodic comparison, so this area only displays its latest result.
const changeReport = (overrides={}) => ({scannedAt:"2026-11-21T05:20:00.000Z",new:[],changed:[],missing:[],skipped:[],...overrides});
test("source changes show the last check, all three classes and examples",async t=>{
 const storedChanges=changeReport({
  new:[{name:"甲.pdf",relPath:"外部投递/甲.pdf",size:2048,folder:"外部投递"},
   {name:"乙.pdf",relPath:"外部投递/子目录/乙.pdf",size:1024,folder:"外部投递"},
   {name:"丙.pdf",relPath:"丙.pdf",size:10},{name:"丁.pdf",relPath:"丁.pdf",size:10}],
  changed:[{name:"手册.docx",relPath:"01_检测/手册.docx",size:4096}],
  missing:[{name:"旧图.png",relPath:"01_检测/旧图.png",size:0}]});
 const f=fixture(t,{storedChanges});await pending();
 const view=text(f.root);
 assert.ok(f.nodes().some(n=>n.tag==="span"&&text(n)==="5 项待处理 · 1 项缺失"),"the badge counts work found on page open");
 assert.match(view,/上次检查：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/,"the last check time is shown");
 assert.match(view,/新增 4 个/);
 assert.ok(view.includes("外部投递/甲.pdf")&&view.includes("外部投递/子目录/乙.pdf"),"new examples keep their relative paths");
 assert.ok(view.includes("文件夹投递 · 外部投递"),"folder deliveries are named");
 assert.match(view,/还有 1 个未列出/,"examples are capped and the remainder is stated");
 assert.match(view,/变更 1 个/);
 assert.ok(view.includes("01_检测/手册.docx"));
 assert.match(view,/缺失 1 个/);
 assert.match(view,/源文件已不存在，知识库内容不会自动删除/,"missing files explain that nothing is deleted");
 assert.ok(view.includes("01_检测/旧图.png"));
 const section=f.nodes().find(n=>String(n.attrs.class||"").includes("wiki-change-section"));
 assert.equal(all(section).filter(n=>n.tag==="button"&&/删除|移除|清理/.test(text(n))).length,0,"missing files never offer a delete action");
 assert.ok(f.calls.every(c=>!/delete|remove/i.test(c.path)),"the change area never calls a destructive endpoint");
 assert.equal(section.hidden,false,"a connected library shows the area");
 assert.equal(f.button("查看并处理").hidden,false);
});

test("立即检查 runs one comparison and never turns into local polling",async t=>{
 const f=fixture(t,{storedChanges:null,changes:changeReport({new:[{name:"新.pdf",relPath:"新.pdf",size:1024}]})});
 await pending();
 assert.match(text(f.root),/还没有检查记录/,"an unchecked library says so");
 const auto=f.calls.filter(c=>c.path.endsWith("/changes"));
 assert.equal(auto.length,1,"opening the page reads the stored result once");
 assert.notEqual(auto[0].method,"POST","opening the page never triggers a comparison");
 await f.button("立即检查").click();await pending();
 const calls=f.calls.filter(c=>c.path.endsWith("/changes"));
 assert.equal(calls.length,2);
 assert.equal(calls[1].method,"POST","the manual check asks the host to compare");
 assert.match(text(f.root),/新增 1 个/);
 assert.ok(text(f.root).includes("新.pdf"));
 assert.match(text(f.root),/1 项待处理/);
 await pending();
 assert.equal(f.calls.filter(c=>c.path.endsWith("/changes")).length,2,"no local timer keeps re-checking");
});

test("no changes shows an explicit empty state",async t=>{
 const f=fixture(t,{storedChanges:changeReport()});await pending();
 const view=text(f.root);
 assert.match(view,/未发现资料变化/);
 assert.ok(f.nodes().some(n=>n.tag==="span"&&text(n)==="无变化"));
 assert.equal(f.button("查看并处理").hidden,true,"nothing to process");
});

test("a skipped check says so instead of pretending it ran",async t=>{
 const f=fixture(t,{changes:changeReport({skippedRound:true,reason:"job-running"})});await pending();
 await f.button("立即检查").click();await pending();
 assert.match(text(f.root),/本次检查被跳过/);
});

test("files the scan cannot process are shown instead of a clean result",async t=>{
 const f=fixture(t,{storedChanges:changeReport({skipped:[{name:"超大扫描件.pdf",size:257*1024*1024,reason:"可抽取类型超过 256 MB 上限，未处理；请拆分或转换后再投递",relPath:"超大扫描件.pdf"}]})});
 await pending();
 const view=text(f.root);
 assert.ok(f.nodes().some(n=>n.tag==="span"&&text(n)==="另有 1 项因过大未处理"),"unprocessed files are counted in the badge");
 assert.match(view,/因过大未处理 1 个/);
 assert.ok(view.includes("超大扫描件.pdf"));
 assert.match(view,/可抽取类型超过 256 MB 上限/);
 assert.match(view,/不能算完全干净/);
 assert.doesNotMatch(view,/未发现资料变化/,"unprocessed material is not reported as clean");
});

test("查看并处理 opens the scan preview without ever starting processing",async t=>{
 const f=fixture(t,{storedChanges:changeReport({new:[{name:"a.docx",relPath:"a.docx",size:2048}]})});await pending();
 const review=f.button("查看并处理");
 assert.equal(review.hidden,false);
 await review.click();await pending();
 assert.ok(f.calls.some(c=>c.path.endsWith("/scan")),"the existing scan preview is reused");
 assert.ok(!f.calls.some(c=>c.path.endsWith("/process")),"the change area never starts the job");
 assert.match(text(f.root),/发现 1 个待处理原件/);
 assert.ok(text(f.root).includes("确认后再点「开始处理」"),"the operator is sent to the confirmed step");
 const start=f.button("开始处理");
 assert.ok(start);
 assert.equal(start.disabled,true,"processing still needs model consent");
});

// Stored reports kept `Error: CODE`/`CODE:`/`CODE：` forms; all of them must explain in Chinese.
test("a stored Error: CODE report still explains itself in Chinese",async t=>{
 const items=["howtos/0.md","notes/1.md","notes/2.md"].map(relPath=>({relPath,title:"",sha256:"",chars:0,status:"invalid",error:"Error: INVALID_MARKDOWN"}));
 const f=fixture(t,{connection:{state:"partial",layout:{pageDir:"w/wiki"},report:{registered:0,existing:49,rejected:3,items}}});
 await pending();
 const view=text(f.root);
 assert.match(view,/INVALID_MARKDOWN/,"the code is recovered from the Error: prefix");
 assert.match(view,/front matter 解析失败，读不出标题与来源/,"the Chinese reason is restored");
 assert.match(view,/因此未登记、不可检索；原文件未被改写/);
 assert.doesNotMatch(view,/WIKI_PAGE_UNREADABLE/,"no unknown-code fallback for a readable class");
 const listing=f.nodes().find(n=>String(n.attrs.class||"").includes("wiki-rejection-list"));
 assert.ok(listing,"the rejected listing is kept");
 const rows=all(listing).filter(n=>n.tag==="div"&&String(n.attrs.class||"").includes("wiki-row-detail"));
 assert.equal(rows.length,3,"every rejected page is still listed");
 assert.ok(rows.every(n=>/front matter 解析失败/.test(text(n))&&!/Error: INVALID_MARKDOWN/.test(text(n))),"listing rows speak Chinese too");
});

test("all three stored error shapes resolve to one code and one reason",async t=>{
 const forms=["Error: INVALID_MARKDOWN","INVALID_MARKDOWN: front matter 解析失败，读不出标题与来源","INVALID_MARKDOWN：front matter 解析失败，读不出标题与来源"];
 const items=forms.map((error,i)=>({relPath:`notes/${i}.md`,title:"",sha256:"",chars:0,status:"invalid",error}));
 const f=fixture(t,{connection:{state:"partial",layout:{pageDir:"w/wiki"},report:{registered:0,existing:0,rejected:3,items}}});
 await pending();
 const view=text(f.root);
 const groups=f.nodes().filter(n=>String(n.attrs.class||"")==="wiki-issue");
 assert.equal(groups.length,1,"the three shapes are grouped as one reason");
 assert.match(text(groups[0]),/^3 篇 INVALID_MARKDOWN front matter 解析失败/);
 assert.doesNotMatch(view,/WIKI_PAGE_UNREADABLE/);
});

// Big files the scan skips must stay visible next to the change counts, never behind a clean badge.
test("unprocessed files stay visible next to pending changes",async t=>{
 const storedChanges=changeReport({
  new:[{name:"新.pdf",relPath:"新.pdf",size:1024}],
  skipped:[{name:"大1.mp4",size:300*1024*1024,reason:"超过 256 MB 扫描上限，未处理",relPath:"大1.mp4"},
   {name:"大2.pdf",size:270*1024*1024,reason:"可抽取类型超过 256 MB 上限，未处理",relPath:"外部投递/大2.pdf",folder:"外部投递"},
   {name:"大3.zip",size:280*1024*1024,reason:"超过 256 MB 扫描上限，未处理",relPath:"大3.zip"},
   {name:"大4.pdf",size:290*1024*1024,reason:"超过 256 MB 扫描上限，未处理",relPath:"大4.pdf"}]});
 const f=fixture(t,{storedChanges});await pending();
 const view=text(f.root);
 assert.ok(f.nodes().some(n=>n.tag==="span"&&text(n)==="1 项待处理 · 另有 4 项因过大未处理"),"the badge keeps both counts");
 assert.match(view,/另有 4 项因过大未处理/,"the note names the unprocessed remainder");
 assert.match(view,/因过大未处理 4 个/);
 assert.ok(view.includes("大1.mp4")&&view.includes("外部投递/大2.pdf")&&view.includes("大3.zip"),"names are listed");
 assert.match(view,/超过 256 MB 扫描上限/);
 assert.match(view,/还有 1 个未列出/,"examples stay capped with a remainder count");
 assert.doesNotMatch(view,/未发现资料变化/);
});

test("立即检查 never reports a clean result while files were skipped",async t=>{
 const f=fixture(t,{changes:changeReport({skipped:[{name:"大.pdf",size:300*1024*1024,reason:"超过 256 MB 扫描上限，未处理",relPath:"大.pdf"}]})});
 await pending();
 await f.button("立即检查").click();await pending();
 const status=f.nodes().find(n=>String(n.attrs.class||"")==="wiki-status");
 assert.match(text(status),/另有 1 项因过大未处理/);
 assert.doesNotMatch(text(status),/未发现资料变化/);
});

// Job list: a cancelled job can never be resumed, finished records can be removed, running ones only stop.
test("a cancelled job offers removal and never resume",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"cancelled-1",state:"cancelled",items:[]}]});
 await pending();
 assert.match(text(f.root),/已取消/);
 assert.equal(f.button("续跑"),undefined,"a cancelled job cannot be resumed");
 assert.ok(f.button("移除"),"a cancelled job can be removed");
});

test("removing a finished job calls dismiss and drops the card in place",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"done-1",state:"done",items:[]}]});
 await pending();
 const listReads=f.calls.filter(c=>c.path.endsWith("/jobs")).length;
 await f.button("移除").click();await pending();
 const dismiss=f.calls.find(c=>c.path.includes("/job/done-1"));
 assert.deepEqual(dismiss.body,{action:"dismiss"});
 assert.ok(!f.nodes().some(n=>n.tag==="strong"&&text(n)==="任务 done-1"),"the card disappears");
 assert.equal(f.calls.filter(c=>c.path.endsWith("/jobs")).length,listReads,"no full list reload");
 assert.match(text(f.root),/已移除该任务记录/);
});

test("clearing finished jobs calls dismiss-finished and reports how many went",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"done-1",state:"done",items:[]},{id:"cancelled-1",state:"cancelled",items:[]},{id:"paused-1",state:"paused",items:[]}],dismissFinished:2});
 await pending();
 const clear=f.button("清除已结束任务");
 assert.ok(clear);
 assert.equal(clear.hidden,false);
 await clear.click();await pending();
 const bulk=f.calls.find(c=>c.path.endsWith("/job")&&c.body?.action==="dismiss-finished");
 assert.ok(bulk,"the bulk action reaches the host");
 assert.match(text(f.root),/已清除 2 条已结束任务记录/);
 const titles=f.nodes().filter(n=>n.tag==="strong"&&text(n).startsWith("任务 ")).map(n=>text(n));
 assert.deepEqual(titles,["任务 paused-1"],"only the unfinished job stays");
});

test("the clear action stays hidden when nothing has finished",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"running-1",state:"running",items:[]}]});
 await pending();
 assert.equal(f.button("清除已结束任务").hidden,true);
 f.dispose();
});

test("stopping a job updates the card in place and never resumes it",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"running-1",state:"running",items:[{id:"i",source:"a.docx",stage:"new",activity:"正在抽取"}]}]});
 await pending();
 await f.button("停止").click();await pending();
 const cancel=f.calls.find(c=>c.path.includes("/job/running-1"));
 assert.deepEqual(cancel.body,{action:"cancel"});
 assert.match(text(f.root),/任务已取消，可点移除清理/,"the outcome is stated");
 assert.match(text(f.root),/已取消/);
 assert.equal(f.button("续跑"),undefined,"a cancelled job is not offered a resume");
 assert.ok(f.button("移除"));
 assert.ok(!f.calls.some(c=>c.path.includes("/job/running-1")&&c.body?.action==="resume"),"nothing resumes automatically");
 assert.equal(f.nodes().find(n=>String(n.attrs.class||"").includes("wiki-runbar")).hidden,true,"the stop bar retires with the job");
 f.dispose();
});

test("a stale resume says the job was cancelled instead of failing silently",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"stale-1",state:"paused",items:[]}],jobError:"WIKI_JOB_CANCELLED"});
 await pending();
 await f.button("续跑").click();await pending();
 const status=f.nodes().find(n=>String(n.attrs.class||"")==="wiki-status");
 assert.match(text(status),/任务已取消，不能续跑；请重新扫描/);
 assert.ok(!/WIKI_JOB_CANCELLED/.test(text(status)),"the raw code is not the message");
 assert.equal(f.button("续跑"),undefined,"the stale card is closed");
 assert.ok(f.button("移除"));
});

// The distill update gate is gone: nothing to approve, results are auditable after the fact.
test("the workspace no longer loads or renders review proposals",async t=>{
 const f=fixture(t);await pending();
 assert.ok(!f.calls.some(c=>c.path.endsWith("/proposals")),"no proposals request on load");
 assert.ok(!text(f.root).includes("蒸馏更新审核"),"the review block is gone");
 assert.equal(f.button("刷新候选"),undefined);
 assert.equal(f.button("批准替换"),undefined);
 assert.equal(f.button("拒绝"),undefined);
});

// Real host shape: `pages` is every page the item touched, `updatedPages` is the subset that replaced
// an existing page, so a pure update appears in both lists and must not be counted as a new page.
test("a pure update counts one updated page and offers one button",async t=>{
 const f=fixture(t,{pages:[{pageId:"old",relPath:"wiki/notes/old.md",status:"active",version:2}],
  jobs:()=>[{id:"update",state:"done",items:[{id:"i1",source:"a.docx",stage:"done",pages:["wiki/notes/old.md"],updatedPages:["wiki/notes/old.md"]}]}]});
 await pending();
 const view=text(f.root);
 assert.match(view,/更新 1 篇页面/);
 assert.doesNotMatch(view,/新增 \d+ 篇页面/,"an updated page is not a new page");
 const updated=f.button("已更新：wiki/notes/old.md");
 assert.ok(updated,"the updated page gets its own label");
 assert.equal(f.button("查看关联页：wiki/notes/old.md"),undefined,"no duplicate button for the same page");
 await updated.click();await pending();
 assert.ok(f.calls.some(c=>c.path.includes("/page/old")),"reads the current page content");
 assert.ok(!f.calls.some(c=>c.method==="PUT"),"viewing a result never writes");
 const status=f.nodes().find(n=>String(n.attrs.class||"")==="wiki-status");
 assert.match(text(status),/已打开只读内容/);
});

test("a pure add still counts one new page",async t=>{
 const f=fixture(t,{pages:[{pageId:"new",relPath:"wiki/notes/new.md",status:"active",version:1}],
  jobs:()=>[{id:"create",state:"done",items:[{id:"i1",source:"b.docx",stage:"done",pages:["wiki/notes/new.md"]}]}]});
 await pending();
 const view=text(f.root);
 assert.match(view,/新增 1 篇页面/);
 assert.doesNotMatch(view,/更新 \d+ 篇页面/,"a new page is not an update");
 assert.ok(f.button("查看关联页：wiki/notes/new.md"));
 assert.equal(f.button("已更新：wiki/notes/new.md"),undefined);
});

test("a mixed result lists the added and the updated page apart",async t=>{
 const f=fixture(t,{pages:[{pageId:"new",relPath:"wiki/notes/new.md",status:"active",version:1},
  {pageId:"old",relPath:"wiki/notes/old.md",status:"active",version:2}],
  jobs:()=>[{id:"mixed",state:"done",items:[{id:"i1",source:"c.docx",stage:"done",
   pages:["wiki/notes/new.md","wiki/notes/old.md"],updatedPages:["wiki/notes/old.md"]}]}]});
 await pending();
 const view=text(f.root);
 assert.match(view,/新增 1 篇页面/);
 assert.match(view,/更新 1 篇页面/);
 assert.ok(f.button("已更新：wiki/notes/old.md"));
 assert.ok(f.button("查看关联页：wiki/notes/new.md"));
 assert.equal(f.button("查看关联页：wiki/notes/old.md"),undefined,"the updated page is never listed as new");
 assert.equal(f.nodes().filter(n=>n.tag==="button"&&text(n).includes("wiki/notes/old.md")).length,1,"one button per page");
});

test("an external edit conflict is explained and never implies a write",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"conflict",state:"done",items:[{id:"i",source:"manual.docx",stage:"failed",error:"WIKI_EXTERNAL_EDIT_CONFLICT:wiki/notes/old.md"}]}]});
 await pending();
 const view=text(f.root);
 assert.ok(view.includes("该页已被外部修改，未覆盖；请刷新索引后重试"),"the conflict explains itself in Chinese");
 assert.ok(!view.includes("WIKI_EXTERNAL_EDIT_CONFLICT"),"the raw code is not the message");
 assert.ok(!/已更新：|已写入/.test(view),"nothing claims the page was written");
});

// One library processes at a time across the whole host, so the console must name the busy one.
test("processing blocked by another library explains itself in Chinese",async t=>{
 const f=fixture(t,{confirm:true,python:{candidates:[{path:"python.exe",version:"3.12",ok:true}],hint:""},
  models:{providers:[{provider:"p",name:"本地",models:[{id:"m",name:"模型"}]}],default:{provider:"p",model:"m"}},
  processError:{code:"WIKI_JOB_RUNNING_ELSEWHERE",message:"库 B 的任务 job-xyz789 正在处理，请等待完成或取消后再开始"}});
 await pending();
 await f.button("扫描更新").click();await pending();
 const consent=f.nodes().filter(n=>n.tag==="input"&&n.attrs.type==="checkbox").at(-1);
 consent.checked=true;consent.listeners.change();
 await f.button("开始处理").click();await pending();
 assert.ok(f.calls.some(c=>c.path.endsWith("/process")),"the request reaches the host");
 const status=f.nodes().find(n=>String(n.attrs.class||"")==="wiki-status");
 assert.match(text(status),/另一个知识库正在处理，请先在那边完成或停止/);
 assert.match(text(status),/B · 任务 job-xyz7/,"the busy library and job are named");
 assert.doesNotMatch(text(status),/WIKI_JOB_RUNNING_ELSEWHERE/,"raw codes never reach the screen");
 const note=f.nodes().find(n=>String(n.attrs.class||"").includes("wiki-process-blocked"));
 assert.equal(note.hidden,false,"the reason stays visible");
 assert.match(text(note),/另一个知识库正在处理/);
 assert.equal(f.button("开始处理").disabled,true,"processing stays disabled until that library is free");
});

test("a busy other library disables processing before any click",async t=>{
 const running=[{id:"elsewhere-1",state:"running",items:[]}];
 const f=fixture(t,{otherJobs:()=>running});
 await pending();
 const note=f.nodes().find(n=>String(n.attrs.class||"").includes("wiki-process-blocked"));
 assert.ok(note);
 assert.equal(note.hidden,false,"the guard is visible without trying first");
 assert.match(text(note),/另一个知识库正在处理，请先在那边完成或停止/);
 assert.match(text(note),/任务 elsewher/);
 assert.match(text(note),/刷新任务/,"the way out is named");
 await f.button("扫描更新").click();await pending();
 const consent=f.nodes().filter(n=>n.tag==="input"&&n.attrs.type==="checkbox").at(-1);
 consent.checked=true;consent.listeners.change();
 assert.equal(f.button("开始处理").disabled,true,"the button is disabled even with consent and candidates");
 assert.ok(!f.calls.some(c=>c.path.endsWith("/process")),"no doomed process call");
 running.length=0;
 await f.button("刷新任务").click();await pending();
 assert.equal(note.hidden,true,"the guard clears once the other library is free");
 assert.equal(f.button("开始处理").disabled,false,"processing becomes available again");
});

test("a vanished job record is explained and its stale card disappears",async t=>{
 let reads=0;
 const f=fixture(t,{jobs:()=>{reads++;return reads<=1?[{id:"ghost-1",state:"done",items:[]}]:[]},jobError:"WIKI_JOB_NOT_FOUND"});
 await pending();
 assert.ok(f.nodes().some(n=>n.tag==="strong"&&text(n)==="任务 ghost-1"),"the stale card was rendered first");
 await f.button("移除").click();await pending();
 const status=f.nodes().find(n=>String(n.attrs.class||"")==="wiki-status");
 assert.match(text(status),/任务记录已不存在，请刷新任务列表/);
 assert.doesNotMatch(text(status),/WIKI_JOB_NOT_FOUND/);
 assert.ok(!f.nodes().some(n=>n.tag==="strong"&&text(n)==="任务 ghost-1"),"the vanished card is refreshed away");
});

test("removing a job that is still running explains itself in Chinese",async t=>{
 const f=fixture(t,{jobs:()=>[{id:"busy-1",state:"done",items:[]}],jobError:"WIKI_JOB_RUNNING"});
 await pending();
 await f.button("移除").click();await pending();
 const status=f.nodes().find(n=>String(n.attrs.class||"")==="wiki-status");
 assert.match(text(status),/任务仍在运行，请先停止再移除/);
 assert.doesNotMatch(text(status),/WIKI_JOB_RUNNING/);
});
