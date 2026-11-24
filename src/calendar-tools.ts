import type { ToolDefinitionLike } from './runtime.js'
import type { JournalRuntime } from './worklog-runtime.js'
const date = {type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}
const eventProperties = {
  carryMode:{type:'string',enum:['daily','workdays'],description:'未完成目标的结转方式：daily 为每天，workdays 遵循日历设置的工作日和日期例外。'},
  title:{type:'string',minLength:1,maxLength:160}, description:{type:'string',maxLength:8000},
  kind:{type:'string',enum:['goal','work'],description:'goal = 每日目标（默认）；work = 实际工作记录。'},
  status:{type:'string',enum:['planned','in_progress','done','cancelled']}, priority:{type:'string',enum:['low','normal','high']},
  day:{...date,description:'全天目标开始日期。'},endDay:{...date,description:'全天结束日期，不含当天；默认开始日期的下一天。'},
  allDay:{type:'boolean',description:'默认 true。不确定具体时段时用全天目标，不编造时间。'},
  startAt:{type:'string',description:'带明确 UTC 偏移的 ISO 时间，例如 2026-11-17T09:00:00+08:00；allDay=false 时必填。'},
  endAt:{type:'string',description:'结束时刻（不含），格式同 startAt，必须晚于开始。'},timeZone:{type:'string',maxLength:100,description:'IANA 时区，默认日历时区。'},
  tags:{type:'array',maxItems:12,items:{type:'string',minLength:1,maxLength:32}},project:{type:'string',maxLength:500},
}
export function calendarTools(calendar?: JournalRuntime['calendar']): ToolDefinitionLike[] {
  return [{
    name:'knowledge_calendar',
    description:'工作记录里的工作日历：记录每天目标，按需安排工作时段、标注标签/优先级/进度，支持查询、新增、修改、改期、可恢复删除及还原。先 info 获取时区和今天，再 list 按 [from,to) 查询、read 查看完整条目。仅记录用户要求或明确授权的安排；不把计划当成已完成，不从闲聊臆造日程。未指定时间可创建全天目标。create 用 event；update 用 id、revision、patch；delete/restore 用 id、revision；所有写入必填唯一 requestId，网络失败重试必须保持同一编号和相同参数。先读当前 revision，冲突时重新读取，不覆盖他人修改；删除仅移入回收站。与日报和原始会话分开，无需挂载知识库；沿用当前本地/远程连接，远程失败不写入本地。每日进度 progress-read 按 id、day 读取，progress-write 按 id、day、text 和读到的 revision 补写，结转前后的条目共用进度。只记录用户确认的进展或日报中已有的事实。export 导出所选范围 iCalendar；changes 是供后续外部日历适配器使用的增量接口，不代表已经连接 Google/iCloud，也不会自动执行目标或发送通知。',
    parameters:{type:'object',additionalProperties:false,required:['action'],properties:{
      action:{type:'string',enum:['info','list','read','create','update','delete','restore','changes','export','progress-read','progress-write']},
      from:date,to:{...date,description:'查询结束日期不含当天；例如只查今天，to 写明天。范围最多370天。'},
      timeZone:{type:'string',maxLength:100},query:{type:'string',maxLength:200},tag:{type:'string',maxLength:32},
      status:{type:'string',enum:['planned','in_progress','done','cancelled']},deleted:{type:'string',enum:['exclude','only','include']},
      limit:{type:'integer',minimum:1,maximum:500},offset:{type:'integer',minimum:0,maximum:100000},
      day:{...date,description:'每日进度所属日期，YYYY-MM-DD。'},text:{type:'string',maxLength:4000,description:'当天进度正文。显式传空字符串清空该日进度。'},
      id:{type:'string',minLength:1,maxLength:100},revision:{type:'integer',minimum:0,description:'读取到的修订号。首次记录每日进度时为 0，其他事件修改至少为 1。'},requestId:{type:'string',minLength:1,maxLength:128},
      event:{type:'object',additionalProperties:false,required:['title'],properties:eventProperties},patch:{type:'object',additionalProperties:false,minProperties:1,properties:eventProperties},
      after:{type:'integer',minimum:0},calendarId:{type:'string',maxLength:100,description:'写入时建议填写 info 返回的 calendarId，防止连接切换误写；changes 的 after>0 时必须填写。'},
    }},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},
    isConcurrencySafe:raw=>['info','list','read','changes','export','progress-read'].includes((raw as {action?:string})?.action??''),
    async execute(raw,exec) {
      if(!exec.agent)throw new Error('日历操作需要所属 DSH 会话')
      exec.signal.throwIfAborted()
      if(!calendar)throw new Error('工作日历服务尚未就绪')
      const args=raw as Record<string,unknown>,action=args.action as string
      const allowed:Record<string,string[]>={info:[],list:['from','to','timeZone','query','tag','status','deleted','limit','offset'],read:['id'],changes:['after','calendarId','limit'],export:['from','to','timeZone','query','tag','status'],create:['requestId','calendarId','event'],update:['requestId','calendarId','id','revision','patch'],delete:['requestId','calendarId','id','revision'],restore:['requestId','calendarId','id','revision'],'progress-read':['id','day'],'progress-write':['requestId','calendarId','id','day','revision','text']}
      if(!allowed[action]||Object.keys(args).some(k=>k!=='action'&&!allowed[action]!.includes(k)))throw new Error('参数与日历操作不匹配，请查看工具说明')
      const mutation=['create','update','delete','restore','progress-write'].includes(action)
      const suffix=({info:'calendar-info',list:'calendar',read:'calendar-event',changes:'calendar-changes',export:'calendar-export','progress-read':'calendar-progress'} as Record<string,string>)[action]??'calendar-'+action
      const query=new URLSearchParams(),data:Record<string,unknown>={}
      for(const [k,v] of Object.entries(args)){if(k==='action')continue;if(mutation)data[k]=v;else query.set(k,String(v))}
      return JSON.stringify(await calendar(mutation?'POST':'GET','/'+suffix,data,query,exec.signal))
    },
  }]
}
