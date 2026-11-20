import { SaxesParser } from 'saxes'
import ICAL from 'ical.js'
import { fail } from '../domain.js'
import { normalizeEvent } from './domain.js'
import { addDays, wallTime, zoneName } from './time.js'

const dav = 'DAV:', cal = 'urn:ietf:params:xml:ns:caldav'
const initial = 'https://caldav.icloud.com/'
const xml = (body, root = 'd:propfind') => `<?xml version="1.0" encoding="utf-8"?><${root} xmlns:d="DAV:" xmlns:c="${cal}">${body}</${root}>`
const children = (node, uri, local) => node?.children.filter(child => child.uri === uri && child.local === local) ?? []
const child = (node, uri, local) => children(node, uri, local)[0]
const value = (node, uri, local) => child(node, uri, local)?.value
const statusCode = status => Number(status?.match(/^HTTP\/\S+ (\d{3})/)?.[1])
const MAX_BODY = 5 * 1024 * 1024

const appleHost = /^(?:p\d+-)?caldav\.icloud\.com(?:\.cn)?$/i

export function appleURL(reference, base = initial) {
  let url
  try { url = new URL(reference, base) } catch { throw invalidAddress() }
  if (!['http:', 'https:'].includes(url.protocol) || !appleHost.test(url.hostname) ||
      url.port || url.username || url.password || url.hash) throw invalidAddress()
  // Some DAV hrefs use a legacy http scheme. Always authenticate over HTTPS.
  url.protocol = 'https:'
  return url
}

function invalidAddress() {
  return Object.assign(fail('iCloud 返回了无法验证的日历地址', 502), { calendarAddressInvalid: true })
}

async function discoveryStep(label, run) {
  try { return await run() }
  catch (e) {
    if (e.status) throw fail(`${e.message}（${label}）`, e.status)
    throw e
  }
}

function discoveryHref(entries, uri, name) {
  for (const entry of entries) {
    const href = value(child(entry.prop, uri, name), dav, 'href')?.trim()
    if (href) return href
  }
}

function parseXML(body) {
  let root
  const stack = []
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => { throw Error('Unexpected DTD') })
  parser.on('opentag', ({ uri, local, attributes }) => {
    if (stack.length > 48) throw Error('XML too deep')
    const node = { uri, local, attributes, children: [], value: '' }
    if (stack.length) stack.at(-1).children.push(node)
    else root = node
    stack.push(node)
  })
  parser.on('closetag', () => stack.pop())
  const append = text => { if (stack.length) stack.at(-1).value += text }
  parser.on('text', append)
  parser.on('cdata', append)
  try { parser.write(body).close() } catch { throw fail('iCloud 的日历响应无法读取', 502) }
  return root
}

function responses(body) {
  const root = parseXML(body)
  if (root?.uri !== dav || root.local !== 'multistatus') throw fail('iCloud 未返回日历资源清单', 502)
  return children(root, dav, 'response').map(row => ({
    href: value(row, dav, 'href')?.trim(),
    status: statusCode(value(row, dav, 'status')),
    props: children(row, dav, 'propstat').filter(p => statusCode(value(p, dav, 'status')) === 200)
      .flatMap(p => children(p, dav, 'prop').flatMap(prop => prop.children)),
  })).map(entry => ({ ...entry, prop: { children: entry.props } }))
}

async function boundedText(response) {
  const parts = [], decoder = new TextDecoder()
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_BODY) throw fail('iCloud 日历响应过大，请使用较小的专用日历', 502)
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  return parts.join('') + decoder.decode()
}

export class AppleCalendarClient {
  constructor(account, password, request = fetch) {
    this.authorization = 'Basic ' + Buffer.from(account + ':' + password).toString('base64')
    this.request = request
  }
  async send(method, reference, signal, options = {}) {
    let url = appleURL(reference)
    for (let redirect = 0; redirect < 4; redirect++) {
      signal?.throwIfAborted()
      const timeout = AbortSignal.timeout(20_000)
      let response
      try {
        response = await this.request(url, { method, redirect: 'manual', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
          headers: { authorization: this.authorization, 'user-agent': 'DSH-WorkCalendar/1.0', ...options.headers }, body: options.body })
      } catch (e) {
        const code = e?.cause?.code ?? e?.code
        if (typeof code === 'string' && /CERT|ISSUER|SELF_SIGNED|VERIFY_LEAF/.test(code)) {
          throw fail('无法验证 iCloud 的 HTTPS 证书，请检查服务端网络或证书信任链', 502)
        }
        throw fail('连接 iCloud 超时或网络不可达', 502)
      }
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        // A write is never replayed automatically against a redirected resource.
        if (!location || !['PROPFIND', 'REPORT'].includes(method)) throw fail('iCloud 日历地址发生变化，请重新连接', 409)
        url = appleURL(location, url); continue
      }
      if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw fail('iCloud 认证或日历权限失效，请检查应用专用密码', 401) }
      return { response, url }
    }
    throw fail('iCloud 日历地址重定向次数过多', 502)
  }
  async dav(method, url, depth, body, signal) {
    const result = await this.send(method, url, signal, { headers: { depth, 'content-type': 'text/xml; charset=utf-8', accept: 'application/xml, text/xml' }, body })
    if (result.response.status !== 207) {
      await result.response.body?.cancel()
      throw Object.assign(fail(`iCloud 日历请求未完成（HTTP ${result.response.status}）`, 502), { upstreamStatus: result.response.status })
    }
    return { url: result.url, entries: responses(await boundedText(result.response)) }
  }
  async discoverPrincipal(signal) {
    const body = xml('<d:prop><d:current-user-principal/></d:prop>')
    try { return await this.dav('PROPFIND', initial, '0', body, signal) }
    catch (error) {
      if (![400, 404, 405].includes(error.upstreamStatus)) throw error
      try { return await this.dav('PROPFIND', new URL('/.well-known/caldav', initial), '0', body, signal) }
      catch (fallback) {
        if (error.upstreamStatus !== 400 || ![400, 404, 405].includes(fallback.upstreamStatus)) throw fallback
      }
      // An initial request rejected as bad format can be routed to the regional CalDAV service.
      return await this.dav('PROPFIND', 'https://caldav.icloud.com.cn/', '0', body, signal)
    }
  }
  async readCalendarHome(home, signal) {
    const properties = '<d:displayname/><d:resourcetype/><d:current-user-privilege-set/>'
    const read = props => this.dav('PROPFIND', home, '1', xml('<d:prop>' + props + '</d:prop>'), signal)
    try { return await read(properties + '<c:supported-calendar-component-set/>') }
    catch (error) {
      if (error.upstreamStatus !== 400) throw error
      return await read(properties)
    }
  }
  async discover(signal) {
    const principal = await discoveryStep('登录入口', () => this.discoverPrincipal(signal))
    const href = discoveryHref(principal.entries, dav, 'current-user-principal')
    if (!href) throw fail('iCloud 未提供账号的日历入口', 502)
    const owner = await discoveryStep('账号入口', async () => {
      const url = appleURL(href, principal.url), body = xml('<d:prop><c:calendar-home-set/></d:prop>')
      try { return await this.dav('PROPFIND', url, '0', body, signal) }
      catch (error) {
        if (error.upstreamStatus !== 400 || url.pathname.endsWith('/')) throw error
        url.pathname += '/'
        return await this.dav('PROPFIND', url, '0', body, signal)
      }
    })
    const home = discoveryHref(owner.entries, cal, 'calendar-home-set')
    if (!home) throw fail('iCloud 未提供日历集合', 502)
    const set = await discoveryStep('日历目录', () => this.readCalendarHome(appleURL(home, owner.url), signal))
    const calendars = new Map()
    let skipped = false
    for (const entry of set.entries) {
      if (!entry.href || !child(child(entry.prop, dav, 'resourcetype'), cal, 'calendar')) continue
      const types = child(entry.prop, cal, 'supported-calendar-component-set')
      if (types && !children(types, cal, 'comp').some(item => item.attributes.name?.value === 'VEVENT')) continue
      const permissions = child(entry.prop, dav, 'current-user-privilege-set')
      if (permissions && !children(permissions, dav, 'privilege').some(p => ['all', 'write', 'write-content'].some(name => child(p, dav, name)))) continue
      let url
      try { url = appleURL(entry.href, set.url) }
      catch (e) {
        if (!e.calendarAddressInvalid) throw e
        // A subscribed or legacy calendar must not hide the account's other calendars.
        skipped = true
        continue
      }
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      calendars.set(url.href, { id: url.href, name: (value(entry.prop, dav, 'displayname')?.trim() || 'iCloud 日历').slice(0, 160) })
    }
    if (!calendars.size && skipped) throw fail('iCloud 已认证，但返回的可写日历里没有可验证的地址（已跳过订阅或旧地址）', 502)
    return [...calendars.values()]
  }
  async list(calendar, signal) {
    const current = appleURL(calendar)
    const result = await this.dav('REPORT', current, '1', xml(
      '<d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter>',
      'c:calendar-query'), signal)
    if (result.entries.length > 1500) throw fail('所选日历事件过多，请使用专用日历', 409)
    const entries = []
    for (const row of result.entries) {
      if (!row.href || (row.status && row.status !== 200)) throw fail('iCloud 返回了不完整的事件清单', 502)
      const href = appleURL(row.href, result.url)
      if (href.href === result.url.href) continue
      if (href.origin !== result.url.origin || !href.pathname.startsWith(result.url.pathname) || href.pathname.slice(result.url.pathname.length).includes('/')) throw fail('iCloud 事件超出所选日历', 502)
      const etag = value(row.prop, dav, 'getetag')?.trim(), data = value(row.prop, cal, 'calendar-data')
      if (!etag || !data) throw fail('iCloud 返回了缺少版本或正文的事件', 502)
      entries.push({ href: href.href, etag, data })
    }
    return { calendar: result.url.href, entries }
  }
  async put(href, data, etag, signal) {
    const { response } = await this.send('PUT', href, signal, {
      headers: { 'content-type': 'text/calendar; charset=utf-8', [etag ? 'if-match' : 'if-none-match']: etag ?? '*' }, body: data,
    })
    await response.body?.cancel()
    if ([409, 412].includes(response.status)) throw fail('iCloud 事件已变化，将在下次同步重新核对', 409)
    if (!response.ok) throw fail(`iCloud 未保存事件（HTTP ${response.status}）`, 502)
  }
}

export function projection(event) {
  const description = event.description ?? ''
  return event.allDay ? { title: event.title, allDay: true, day: event.day, endDay: event.endDay, description }
    : { title: event.title, allDay: false, startAt: event.startAt, endAt: event.endAt, description }
}
export function calendarPatch(fields, timezone) {
  if (fields.allDay) return { ...fields, timeZone: timezone }
  return { ...fields, startAt: new Date(fields.startAt).toISOString(), endAt: new Date(fields.endAt).toISOString(), timeZone: timezone }
}
function instant(time, property, timezone) {
  const tzid = property?.getParameter('tzid')
  if (tzid) {
    try {
      return wallTime(time.toString().slice(0, 10), time.toString().slice(11, 16), zoneName(tzid), 'earlier') + time.second * 1000
    } catch {
      if (time.zone && !['floating', 'UTC'].includes(time.zone.tzid)) return time.toUnixTime() * 1000
      throw Error('Unsupported timezone')
    }
  }
  return time.zone?.tzid === 'UTC' ? time.toUnixTime() * 1000
    : wallTime(time.toString().slice(0, 10), time.toString().slice(11, 16), timezone, 'earlier') + time.second * 1000
}

export function decodeEvent(entry, timezone) {
  let uid
  try {
    const component = new ICAL.Component(ICAL.parse(entry.data))
    const events = component.getAllSubcomponents('vevent'), part = events[0]
    uid = part?.getFirstPropertyValue('uid')
    if (typeof uid !== 'string' || !uid || uid.length > 512) throw Error('Missing UID')
    if (events.length !== 1 || ['rrule', 'rdate', 'exdate', 'recurrence-id', 'organizer', 'attendee'].some(name => part.hasProperty(name)) ||
        part.getFirstPropertyValue('status') === 'CANCELLED') return { ...entry, uid, fields: null }
    const title = part.getFirstPropertyValue('summary'), description = part.getFirstPropertyValue('description') ?? ''
    const start = part.getFirstPropertyValue('dtstart'), end = new ICAL.Event(part).endDate
    if (!start || !end || start.isDate !== end.isDate) return { ...entry, uid, fields: null }
    const fields = start.isDate
      ? { title, allDay: true, day: start.toString(), endDay: part.hasProperty('dtend') || part.hasProperty('duration') ? end.toString() : addDays(start.toString(), 1) }
      : { title, allDay: false, startAt: instant(start, part.getFirstProperty('dtstart'), timezone), endAt: instant(end, part.getFirstProperty('dtend') ?? part.getFirstProperty('dtstart'), timezone) }
    return { ...entry, uid, fields: projection(normalizeEvent(calendarPatch({ ...fields, description }, timezone), timezone)) }
  } catch { return { ...entry, uid, fields: null } }
}

export function encodeEvent(uid, fields, now, original) {
  const component = original ? new ICAL.Component(ICAL.parse(original)) : new ICAL.Component('vcalendar')
  const part = original ? component.getFirstSubcomponent('vevent') : new ICAL.Component('vevent')
  if (!original) {
    component.addPropertyWithValue('version', '2.0')
    component.addPropertyWithValue('prodid', '-//DSH Knowledge//Work Calendar//EN')
    component.addSubcomponent(part)
    part.addPropertyWithValue('uid', uid)
  }
  const utc = timestamp => ICAL.Time.fromJSDate(new Date(timestamp), true)
  part.updatePropertyWithValue('dtstamp', utc(now))
  part.updatePropertyWithValue('last-modified', utc(now))
  part.updatePropertyWithValue('sequence', Number(part.getFirstPropertyValue('sequence') ?? -1) + 1)
  part.updatePropertyWithValue('summary', fields.title)
  if (fields.description !== undefined && fields.description !== (part.getFirstPropertyValue('description') ?? '')) {
    part.removeAllProperties('description')
    part.removeAllProperties('x-alt-desc')
    if (fields.description) part.addPropertyWithValue('description', fields.description)
  }
  part.removeAllProperties('duration')
  part.removeAllProperties('dtstart')
  part.removeAllProperties('dtend')
  part.addPropertyWithValue('dtstart', fields.allDay ? ICAL.Time.fromDateString(fields.day) : utc(fields.startAt))
  part.addPropertyWithValue('dtend', fields.allDay ? ICAL.Time.fromDateString(fields.endDay) : utc(fields.endAt))
  return component.toString().trimEnd() + '\r\n'
}
