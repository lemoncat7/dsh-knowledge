/** Extension boundary for future CalDAV / Google Calendar connectors; no account is connected by this module. */
export const WORK_CALENDAR_PROTOCOL = 1 as const
export interface WorkCalendarEvent {
  id:string; uid:string; revision:number; title:string; description:string
  kind:'goal'|'work'; status:'planned'|'in_progress'|'done'|'cancelled'; priority:'low'|'normal'|'high'
  allDay:boolean; day:string; endDay:string; startAt:number|null; endAt:number|null; timeZone:string
  carriedFrom?: { id:string; day:string }
  carryMode?:'daily'|'workdays'
  progressSummary?: { count:number; day:string|null; text:string }
  tags:string[]; project:string; createdAt:number; updatedAt:number; completedAt:number|null; deletedAt:number|null
}
export interface CalendarGoalProgress {
  goalId:string; day:string; text:string; revision:number; updatedAt:number|null
}
export interface CalendarChange {cursor:number; event:WorkCalendarEvent}
export interface CalendarChangePage {protocol:1;calendarId:string;changes:CalendarChange[];nextCursor:number;hasMore:boolean}
export interface CalendarBinding {providerId:string;accountRef:string;calendarId:string;eventId:string;localId:string;uid:string;etag:string;lastLocalRevision:number}
export interface RemoteCalendarChange {remoteId:string;uid:string;etag:string;deleted:boolean;event?:WorkCalendarEvent}
/** Credentials are opaque references managed by the future connector, never calendar descriptions or model-visible tool parameters.
 * Pull cursors commit only after all imported changes commit. Push uses If-Match / etag and a durable operation ID.
 * A mismatch returns conflict; the connector must not silently choose the newest timestamp or replay an unknown-result create.
 */
export interface CalendarProviderAdapter {
  readonly id:string
  listCalendars(accountRef:string,signal:AbortSignal):Promise<Array<{id:string;name:string;timeZone:string;writable:boolean}>>
  pull(input:{accountRef:string;calendarId:string;cursor?:string;signal:AbortSignal}):Promise<{changes:RemoteCalendarChange[];nextCursor:string;hasMore:boolean;resetRequired?:boolean}>
  push(input:{accountRef:string;calendarId:string;operationId:string;event:WorkCalendarEvent;remoteId?:string;expectedEtag?:string;signal:AbortSignal}):Promise<{remoteId:string;etag:string}|{conflict:true;remote:RemoteCalendarChange}>
}
