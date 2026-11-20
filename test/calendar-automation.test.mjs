import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../worklog/store.js'
import { JournalService } from '../worklog/service.js'
import { AppleCalendarClient, appleURL, decodeEvent, encodeEvent } from '../worklog/calendar/caldav.js'
import { ICloudSync } from '../worklog/calendar/icloud-sync.js'
import { reportDecisions } from '../worklog/calendar/report-progress.js'
import { addDays } from '../worklog/calendar/time.js'

const q = x => new URLSearchParams(x)
const make = (store, title, day, more = {}) => store.calendar.mutate('create', {
  requestId: randomUUID(), event: { title, day, ...more },
}).event
const update = (store, id, patch) => store.calendar.mutate('update', { requestId: randomUUID(), id, revision: store.calendar.get(id).revision, patch }).event
const day = '2026-11-19', next = '2026-11-20'
const at = Date.parse(next+'T01:00:00+08:00')
function reportFixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const complete = make(store,'完成目标 A',day), partial = make(store,'完成目标 B',day)
  const user = '今天已经完成目标 A 的全部验收和交付。'
  const answer = '目标 B 的前两节已经写完，还需要第三节与校对。'
  store.insert({ id:'R1', day, user, answer, project:'', sessionId:'session', route:{provider:'p',model:'m'} })
  const expected = {
    items: [
      {id:complete.id,state:'done',text:'完成目标 A 的全部验收与交付。',source:1,field:'user',quote:user},
      {id:partial.id,state:'progress',text:'目标 B 前两节已完成，剩第三节和校对。',source:1,field:'answer',quote:answer},
    ],
  }
  const llm = { async *stream() { yield { type:'text-delta',text:JSON.stringify(expected) } } }
  return {store,complete,partial,llm,expected}
}

test('report tracking is opt-in, follows the report date, and completes only an untouched carry', async t => {
  const {store,complete,partial,llm} = reportFixture(t), c=store.calendar, tracker=store.reportProgress
  const route={provider:'p',model:'m'}
  assert.equal(tracker.status().enabled,false)
  store.save(day,'日报',0,['R1'],false,route)
  await tracker.tick(llm,new AbortController().signal)
  assert.equal(c.get(complete.id).status,'planned')
  assert.equal(c.carryGoals(at),2)
  const carry=c.dayGoals(next,'Asia/Shanghai').find(e=>e.carriedFrom.id===complete.id)
  tracker.configure(true)
  c.mutate('progress-write',{id:partial.id,day,revision:0,requestId:randomUUID(),text:'手工记录保留'})
  store.save(day,'日报补跑',1,['R1'],false,route)
  await tracker.tick(llm,new AbortController().signal)
  assert.equal(c.get(complete.id).status,'done')
  assert.equal(c.get(carry.id).status,'done')
  assert.match(c.goalProgress(complete.id,day).progress.text,/验收/)
  assert.equal(c.goalProgress(carry.id,next).progress.revision,0)
  assert.equal(c.get(partial.id).status,'planned')
  assert.equal(c.goalProgress(partial.id,day).progress.text,'手工记录保留')
  assert.equal(tracker.status().last.status,'done')
  const revision=c.goalProgress(complete.id,day).progress.revision
  await tracker.tick(llm,new AbortController().signal)
  assert.equal(c.goalProgress(complete.id,day).progress.revision,revision)
})

test('report progress follows prior automation but never overwrites revisions edited by a person', async t => {
  const {store,complete,partial,llm,expected}=reportFixture(t), c=store.calendar, tracker=store.reportProgress
  tracker.configure(true)
  c.carryGoals(at)
  const carry=c.dayGoals(next,'Asia/Shanghai').find(e=>e.carriedFrom.id===complete.id)
  update(store,carry.id,{title:'今天有新安排'})
  const route={provider:'p',model:'m'}
  store.save(day,'日报',0,['R1'],false,route)
  await tracker.tick(llm,new AbortController().signal)
  assert.equal(c.get(carry.id).status,'planned')
  assert.equal(c.goalProgress(partial.id,day).progress.revision,1)
  expected.items[1].text='当前重点是第三节'
  store.save(day,'日报补跑',1,['R1'],false,route)
  await tracker.tick(llm,new AbortController().signal)
  assert.equal(c.goalProgress(partial.id,day).progress.revision,2)
  c.mutate('progress-write',{id:partial.id,day,revision:2,requestId:randomUUID(),text:'我来校对剩余稿件'})
  expected.items[1].text='不应覆盖'
  store.save(day,'日报又补跑',2,['R1'],false,route)
  await tracker.tick(llm,new AbortController().signal)
  assert.equal(c.goalProgress(partial.id,day).progress.text,'我来校对剩余稿件')
  const fabricated=JSON.stringify({items:[{...expected.items[0],quote:'这是根本不存在的原始证据'}]})
  assert.deepEqual(reportDecisions(fabricated,[{id:complete.id}],[{user:'用户的回答',answer:''}]),[])
})

const calendar='https://p12-caldav.icloud.com/123/calendars/work/'
const plain='aaaa-bbbb-cccc-dddd', account='test@example.test'
const allDay=(title, start, description='')=>({title,allDay:true,day:start,endDay:addDays(start,1),description})
const signal=()=>new AbortController().signal

test('CalDAV performs authorized discovery and parses ETags, all-day and timed events', async () => {
  const wrap = rows => `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${rows}</D:multistatus>`
  const result=(href, props)=>`<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  const start=Date.parse('2026-11-20T02:30Z')
  const fields={title:'终稿',allDay:false,startAt:start,endAt:start+60_000,description:'进展 A; B, C\n第二行'}
  const body=encodeEvent('uid@icloud',fields,Date.now())
  let calls=0
  const client=new AppleCalendarClient(account,plain,async (url, req) => {
    calls++
    assert.equal(req.redirect,'manual')
    assert.match(req.headers.authorization,/^Basic /)
    if(calls===1) return new Response(wrap(result('/','<D:current-user-principal><D:href>https://p12-caldav.icloud.com/123/principal/</D:href></D:current-user-principal>')),{status:207})
    if(calls===2) return new Response(wrap(result('/123/principal/','<C:calendar-home-set><D:href>/123/calendars/</D:href></C:calendar-home-set>')),{status:207})
    if(calls===3) return new Response(wrap(result('/123/calendars/work/','<D:displayname>工作目标</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>')),{status:207})
    if(calls===4) {
      assert.equal(req.method,'REPORT')
      assert.match(req.body, /<c:calendar-query\b[^>]*xmlns:c="urn:ietf:params:xml:ns:caldav"/)
      assert.match(req.body, /<\/c:calendar-query>$/)
      assert.doesNotMatch(req.body, /<d:calendar-query\b/)
      return new Response(wrap(result('/123/calendars/work/event.ics',`<D:getetag>"v2"</D:getetag><C:calendar-data><![CDATA[${body}]]></C:calendar-data>`)),{status:207})
    }
    assert.equal(req.headers['if-match'],'"v2"')
    return new Response(null,{status:204})
  })
  assert.deepEqual(await client.discover(signal()),[{id:calendar,name:'工作目标'}])
  const event=(await client.list(calendar,signal())).entries[0]
  assert.deepEqual(decodeEvent(event,'Asia/Shanghai').fields,fields)
  assert.equal(event.etag,'"v2"')
  assert.deepEqual(decodeEvent({data:encodeEvent('x@test',allDay('全天',next),Date.now())},'Asia/Shanghai').fields,allDay('全天',next))
  await client.put(event.href,body,event.etag,signal())
  assert.throws(()=>appleURL('https://caldav.icloud.com.attacker.example/'))
  const redirect=new AppleCalendarClient(account,plain,async()=>new Response(null,{status:301,headers:{location:'https://example.test/'}}))
  await assert.rejects(redirect.discover(signal()),/无法验证/)
})

test('iCloud synchronization is opt-in, preserves non-synced fields, avoids duplicates, and surfaces conflicts', async t => {
  const dir=mkdtempSync(join(tmpdir(),'dsh-cal-sync-')), db=join(dir,'worklog.sqlite')
  const store=new Store(db);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  const nowDay=store.calendar.info().today
  const local=make(store,'本地目标',nowDay,{tags:['保留'],description:'已有备注',status:'in_progress'})
  store.calendar.mutate('progress-write',{id:local.id,day:nowDay,text:'本地进度',revision:0,requestId:randomUUID()})
  const entries=new Map(), remoteHref=calendar+'remote.ics'
  let rev=0, lists=0
  const put=(href,data)=>{entries.set(href,{href,etag:'"'+(++rev)+'"',data})}
  put(remoteHref,encodeEvent('remote@icloud',allDay('远程目标',nowDay),Date.now()))
  const mock={
    async discover(){return [{id:calendar,name:'工作目标'}]},
    async list(){lists++;return {calendar,entries:[...entries.values()]}},
    async put(href,data,etag){
      assert.equal(entries.get(href)?.etag??null,etag)
      put(href,data)
    },
  }
  const sync=new ICloudSync(store,db+'.icloud-key',()=>mock)
  const args={account,password:plain,calendar}
  await sync.connect(args,signal())
  assert.equal(sync.status().enabled,false)
  assert.equal(JSON.stringify(sync.status()).includes(plain),false)
  assert.equal(JSON.stringify(sync.config()).includes(plain),false)
  assert.equal(statSync(db+'.icloud-key').mode&0o777,0o600)
  await sync.begin(true)
  assert.equal(lists,0)
  sync.toggle(true)
  await sync.begin(true);await sync.begin(true)
  assert.equal(entries.size,2)
  const r=store.calendar.dayGoals(nowDay,'Asia/Shanghai').find(e=>e.title==='远程目标')
  assert.ok(r)
  assert.equal(store.calendar.dayGoals(nowDay,'Asia/Shanghai').length,2)
  const localHref=[...entries.keys()].find(href=>href!==remoteHref)
  const outbound=entries.get(localHref).data
  assert.match(outbound,/DESCRIPTION:已有备注/)
  assert.doesNotMatch(outbound,/保留|本地进度/)
  const uid=decodeEvent(entries.get(localHref),'Asia/Shanghai').uid
  put(localHref,encodeEvent(uid,allDay('iCloud 改名',nowDay,'iCloud 修改备注'),Date.now(),outbound))
  await sync.begin(true)
  assert.equal(store.calendar.get(local.id).title,'iCloud 改名')
  assert.equal(store.calendar.get(local.id).description,'iCloud 修改备注')
  assert.equal(store.calendar.get(local.id).status,'in_progress')
  assert.deepEqual(store.calendar.get(local.id).tags,['保留'])
  assert.equal(store.calendar.goalProgress(local.id,nowDay).progress.text,'本地进度')
  update(store,local.id,{title:'知识库改名'})
  put(localHref,encodeEvent(uid,allDay('iCloud 又改名',nowDay),Date.now(),entries.get(localHref).data))
  await sync.begin(true)
  const conflict=sync.status().issues[0]
  assert.equal(conflict.type,'conflict')
  assert.equal(store.calendar.get(local.id).title,'知识库改名')
  sync.resolve({uid:conflict.uid,key:conflict.key,choice:'knowledge'})
  await sync.begin(true)
  assert.equal(decodeEvent(entries.get(localHref),'Asia/Shanghai').fields.title,'知识库改名')
  entries.delete(remoteHref)
  await sync.begin(true)
  assert.equal(store.calendar.get(r.id).deletedAt,null)
  assert.ok(sync.status().issues.some(issue=>issue.type==='remote-missing'))
  sync.disconnect()
  assert.equal(sync.status().connected,false)
  assert.equal(sync.status().enabled,false)
  assert.equal(entries.size,1)
})

test('calendar settings go through the authoritative calendar and default to disabled', async t => {
  const store=new Store(':memory:');t.after(()=>store.close())
  const service=new JournalService(store,{},async()=>[])
  const start=await service.browser('GET','/calendar-settings')
  assert.equal(start.report.enabled,false)
  assert.equal(start.icloud.connected,false)
  assert.equal(start.icloud.enabled,false)
  await assert.rejects(service.browser('POST','/calendar-icloud-toggle',{enabled:true}),/请先连接/)
  await service.browser('POST','/calendar-report-settings',{enabled:true})
  assert.equal((await service.browser('GET','/calendar-settings')).report.enabled,true)
  assert.equal(store.calendar.list(q({from:day,to:next})).total,0)
})

test('CalDAV discovery accepts trusted Apple regional redirects and keeps usable calendars when one href is unsupported', async () => {
  const wrap = rows => `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${rows}</D:multistatus>`
  const response = (href, props) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  const prop = '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>'
  const regional = 'https://p12-caldav.icloud.com.cn'
  let calls = 0
  const client = new AppleCalendarClient(account, plain, async (url, req) => {
    calls++
    assert.equal(url.protocol, 'https:')
    assert.match(req.headers.authorization, /^Basic /)
    if (calls === 1) return new Response(null, { status: 302, headers: { location: regional + '/?route=calendar' } })
    if (calls === 2) {
      assert.equal(url.href, regional + '/?route=calendar')
      const first = response('/', '<D:displayname>iCloud</D:displayname>')
      const account = response('/123/', '<D:current-user-principal><D:href>http://p12-caldav.icloud.com.cn/123/principal/</D:href></D:current-user-principal>')
      return new Response(wrap(first + account), { status: 207 })
    }
    if (calls === 3) {
      assert.equal(url.href, regional + '/123/principal/')
      return new Response(wrap(response('/123/principal/', '<C:calendar-home-set><D:href>/123/calendars/</D:href></C:calendar-home-set>')), { status: 207 })
    }
    assert.equal(url.href, regional + '/123/calendars/')
    const own = response('/123/calendars/work/', prop + '<D:displayname>目标</D:displayname>')
    const old = response('https://legacy.example.invalid/shared/', prop)
    return new Response(wrap(old + own + own), { status: 207 })
  })
  assert.deepEqual(await client.discover(signal()), [{ id: regional + '/123/calendars/work/', name: '目标' }])
  assert.throws(() => appleURL('https://p12-caldav.icloud.com.cn.example.test/'), /无法验证/)
  assert.throws(() => appleURL('https://caldav.icloud.com:4000/'), /无法验证/)
  assert.throws(() => appleURL('http://user:password@caldav.icloud.com/'), /无法验证/)
  assert.throws(() => appleURL('ftp://caldav.icloud.com/'), /无法验证/)
})

test('CalDAV rejection distinguishes invalid credentials, untrusted addresses and TLS verification', async () => {
  const unauthorized = new AppleCalendarClient(account, plain, async () => new Response(null, { status: 401 }))
  await assert.rejects(unauthorized.discover(signal()), e => e.status === 401 && /认证/.test(e.message))
  let requests = 0
  const unexpected = new AppleCalendarClient(account, plain, async () => {
    requests++
    return new Response(null, { status: 302, headers: { location: 'https://outside.example.test/path' } })
  })
  await assert.rejects(unexpected.discover(signal()), /无法验证的日历地址（登录入口）/)
  assert.equal(requests, 1)
  const tls = new AppleCalendarClient(account, plain, async () => {
    throw new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } })
  })
  await assert.rejects(tls.discover(signal()), /HTTPS 证书/)
})

test('CalDAV read-only discovery retries HTTP 400 with standard paths and minimal collection properties', async () => {
  const wrap=(href,props)=>new Response(`<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,{status:207})
  const bad=()=>new Response('Bad Request',{status:400})
  const calls=[]
  const client=new AppleCalendarClient(account,plain,async(url,req)=>{
    calls.push(url.href)
    assert.equal(req.method,'PROPFIND')
    assert.match(req.headers['content-type'],/^text\/xml/)
    if(calls.length===1 || calls.length===2) return bad()
    if(calls.length===3) return wrap('/','<current-user-principal><href>/123/principal</href></current-user-principal>')
    if(calls.length===4) return bad()
    if(calls.length===5) return wrap('/123/principal/','<C:calendar-home-set><href>/123/calendars/</href></C:calendar-home-set>')
    if(calls.length===6) { assert.match(req.body,/supported-calendar-component-set/);return bad() }
    assert.doesNotMatch(req.body,/supported-calendar-component-set/)
    return wrap('/123/calendars/work/','<resourcetype><C:calendar/></resourcetype><displayname>工作</displayname>')
  })
  assert.deepEqual(await client.discover(signal()),[{name:'工作',id:'https://caldav.icloud.com.cn/123/calendars/work/'}])
  assert.deepEqual(calls.slice(0,5), [
    'https://caldav.icloud.com/', 'https://caldav.icloud.com/.well-known/caldav', 'https://caldav.icloud.com.cn/',
    'https://caldav.icloud.com.cn/123/principal','https://caldav.icloud.com.cn/123/principal/',
  ])
  const incompatible = new AppleCalendarClient(account,plain,async()=>bad())
  await assert.rejects(incompatible.discover(signal()), /HTTP 400.+登录入口/)
})

test('legacy iCloud bindings migrate existing notes without overwriting either side', async t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  const nowDay = store.calendar.info().today
  const remoteNotes = new Map()
  const entries = new Map()
  const writes = []
  let etag = 0
  function put(href, data) { entries.set(href, { href, data, etag: '"' + (++etag) + '"' }) }
  const client = {
    async discover() { return [{ id: calendar, name: '工作目标' }] },
    async list() { return { calendar, entries: [...entries.values()] } },
    async put(href, data, expected) {
      assert.equal(entries.get(href)?.etag, expected)
      writes.push(href); put(href, data)
    },
  }
  const sync = new ICloudSync(store, undefined, () => client)
  await sync.connect({ account, password: plain, calendar }, signal())
  sync.toggle(true)
  const samples = [
    ['只在知识库', '知识库原备注', ''],
    ['只在 iCloud', '', 'iCloud 原备注'],
    ['两边都有', '保留左边', '保留右边'],
    ['两边都空', '', ''],
  ]
  const goals = samples.map(([title, description, note]) => {
    const local = make(store, title, nowDay, { description, tags: ['仅本地'] })
    const href = calendar + encodeURIComponent(local.uid) + '.ics'
    put(href, encodeEvent(local.uid, allDay(title, nowDay, note), Date.now()))
    remoteNotes.set(local.id, href)
    const { description: _, ...base } = allDay(title, nowDay)
    sync.saveBinding(sync.config().connection, { uid: local.uid, localId: local.id, href, etag: entries.get(href).etag, base })
    return local
  })
  const remote = goal => decodeEvent(entries.get(remoteNotes.get(goal.id)), 'Asia/Shanghai').fields.description
  await sync.begin(true)
  assert.equal(writes.length, 1)
  assert.equal(remote(goals[0]), '知识库原备注')
  assert.equal(store.calendar.get(goals[1].id).description, 'iCloud 原备注')
  assert.deepEqual(store.calendar.get(goals[1].id).tags, ['仅本地'])
  assert.equal(store.calendar.get(goals[2].id).description, '保留左边')
  assert.equal(remote(goals[2]), '保留右边')
  assert.equal(sync.status().issues.length, 1)
  const issue = sync.status().issues[0]
  assert.equal(issue.local.description, '保留左边')
  assert.equal(issue.icloud.description, '保留右边')
  assert.equal(sync.bindings(sync.config().connection).get(goals[3].uid).base.description, '')
  await sync.begin(true)
  assert.equal(writes.length, 1)
  update(store, goals[0].id, { description: '' })
  await sync.begin(true)
  assert.equal(remote(goals[0]), '')
  assert.equal(writes.length, 2)
  sync.resolve({ uid: issue.uid, key: issue.key, choice: 'icloud' })
  await sync.begin(true)
  assert.equal(store.calendar.get(goals[2].id).description, '保留右边')
})
