const escape = text => String(text).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
const stamp = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
/** RFC 5545 folds by UTF-8 octets, never in the middle of a code point. */
function fold(text) {
  const lines = []; let line = '', bytes = 0
  for (const char of text) {
    const n = Buffer.byteLength(char)
    if (bytes + n > 75) { lines.push(line); line = ' '; bytes = 1 }
    line += char; bytes += n
  }
  lines.push(line); return lines.join('\r\n')
}
export function calendarIcs(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DSH Knowledge//Work Calendar 1.0//ZH', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:工作日历']
  for (const e of events) {
    if (e.deletedAt !== null) continue
    lines.push('BEGIN:VEVENT', 'UID:' + e.uid, 'DTSTAMP:' + stamp(e.updatedAt), 'CREATED:' + stamp(e.createdAt), 'LAST-MODIFIED:' + stamp(e.updatedAt), 'SEQUENCE:' + (e.revision - 1))
    if (e.allDay) lines.push('DTSTART;VALUE=DATE:' + e.day.replaceAll('-', ''), 'DTEND;VALUE=DATE:' + e.endDay.replaceAll('-', ''))
    else lines.push('DTSTART:' + stamp(e.startAt), 'DTEND:' + stamp(e.endAt))
    lines.push('SUMMARY:' + escape(e.title), 'DESCRIPTION:' + escape([e.description, e.project && '项目：' + e.project].filter(Boolean).join('\n')), 'STATUS:' + (e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'), 'TRANSP:TRANSPARENT', 'X-DSH-STATUS:' + e.status, 'X-DSH-KIND:' + e.kind, 'X-DSH-TIMEZONE:' + escape(e.timeZone), 'PRIORITY:' + ({ high: 1, normal: 5, low: 9 }[e.priority]))
    if (e.tags.length) lines.push('CATEGORIES:' + e.tags.map(escape).join(','))
    lines.push('END:VEVENT')
  }
  return lines.map(fold).join('\r\n') + '\r\n'
}
