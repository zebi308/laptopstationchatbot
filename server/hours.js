// Opening hours: SUPPORT_HOURS="Mon-Fri 09:00-17:30; Sat 10:00-14:00"  SUPPORT_TZ=Europe/London
import { str } from './config.js';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseHours(spec = '') {
  const rules = [];
  for (const part of String(spec).split(';')) {
    const m = part.trim().match(/^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/i);
    if (!m) continue;
    const a = DAYS.indexOf(m[1].toLowerCase()), b = m[2] ? DAYS.indexOf(m[2].toLowerCase()) : a;
    if (a < 0 || b < 0) continue;
    const start = +m[3] * 60 + +m[4], end = +m[5] * 60 + +m[6];
    for (let d = a; ; d = (d + 1) % 7) { rules.push({ day: d, start, end }); if (d === b) break; }
  }
  return rules;
}

// Minutes-of-week helpers in a named timezone
export function localParts(now, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t).value;
  return { day: DAYS.indexOf(get('weekday').slice(0, 3).toLowerCase()), minutes: (+get('hour') % 24) * 60 + +get('minute') };
}

export function hoursStatus(spec = str('SUPPORT_HOURS'), tz = str('SUPPORT_TZ', 'Europe/London'), now = new Date()) {
  const rules = parseHours(spec);
  if (!rules.length) return { open: true, configured: false };
  const { day, minutes } = localParts(now, tz);
  return { open: rules.some((r) => r.day === day && minutes >= r.start && minutes < r.end), configured: true };
}
