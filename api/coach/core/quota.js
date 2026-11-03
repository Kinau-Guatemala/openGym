/* When a spent usage limit lifts (T24), from what the provider said: a Retry-After (seconds or
 * an HTTP date) or Claude's "resets 10:50pm (UTC)". The next such time after `now`, as ISO, or
 * null when nothing usable was printed. Pure: the caller brings the clock, so the phone can too.
 *
 * Only UTC is read as a zone, and no zone at all is taken as UTC (what the setup token prints).
 * A time in any other zone is null rather than a guess an hour or a day out.
 */
export function quotaResetsAt(text, now, retryAfter) {
  if (retryAfter != null && String(retryAfter).trim()) {
    const secs = Number(retryAfter);
    const at = Number.isFinite(secs) ? now + secs * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(at) && at > now) return new Date(at).toISOString();
  }
  const m = /\bresets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(\s*([^)]*?)\s*\)|\s+(utc|gmt)\b)?/i.exec(String(text || ''));
  if (!m || (!m[2] && !m[3])) return null;
  const zone = m[4] ?? m[5];
  if (zone != null && !/^(utc|gmt|z)$/i.test(zone)) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/^p/i.test(m[3]) ? 12 : 0);
  } else if (h > 23) return null;
  const d = new Date(now);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min);
  if (at <= now) at += 86400000;
  return new Date(at).toISOString();
}
