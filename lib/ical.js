const { SITE_HOST } = require('./constants');

const escIcs = s => (s || '').replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');

// RFC 5545 line folding: lines over 75 octets continue on the next line
// prefixed with a single space.
const foldLine = line => {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let pos = 75;
  while (pos < line.length) {
    parts.push(' ' + line.slice(pos, pos + 74));
    pos += 74;
  }
  return parts.join('\r\n');
};

// Builds the full VCALENDAR body (CRLF line endings, trailing CRLF) for a
// list of event rows from the DB.
function buildIcsCalendar(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ASU Sun Devil Athletics//Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:ASU Sun Devil Athletics',
    'X-WR-TIMEZONE:America/Phoenix',
    'X-WR-CALDESC:Arizona State University athletics schedule',
  ];

  for (const e of events) {
    if (!e.start_date) continue;

    const dtStart = new Date(e.start_date * 1000);
    const dtEnd   = e.end_date
      ? new Date(e.end_date * 1000)
      : new Date(e.start_date * 1000 + 3 * 60 * 60 * 1000);

    const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const uid = `${e.id}@${SITE_HOST}`;
    const summary = e.title || 'ASU Athletics';
    const location = [e.location_name, e.venue_address, e.city, e.state]
      .filter(Boolean).join(', ');
    const description = [
      e.sport      ? `Sport: ${e.sport}`                    : null,
      e.game_type  ? `Type: ${e.game_type}`                  : null,
      e.tv_network ? `TV: ${e.tv_network}`                   : null,
      e.result     ? `Result: ${e.result} ${e.asu_score}-${e.opp_score}` : null,
      e.ticket_url ? `Tickets: ${e.ticket_url}`              : null,
    ].filter(Boolean).join('\n');

    lines.push('BEGIN:VEVENT');
    lines.push(foldLine(`UID:${uid}`));
    lines.push(foldLine(`DTSTART:${fmt(dtStart)}`));
    lines.push(foldLine(`DTEND:${fmt(dtEnd)}`));
    lines.push(foldLine(`SUMMARY:${escIcs(summary)}`));
    if (location)    lines.push(foldLine(`LOCATION:${escIcs(location)}`));
    if (description) lines.push(foldLine(`DESCRIPTION:${escIcs(description)}`));
    if (e.sport)     lines.push(foldLine(`CATEGORIES:${escIcs(e.sport)}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildIcsCalendar };
