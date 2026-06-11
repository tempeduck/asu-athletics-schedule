// Parses the opponent out of an event title like
// "Baseball: Arizona State vs. Texas" or "Oregon at Arizona State".
// Callers differ only in casing and no-match fallback:
//   DB matching uses { lowercase: true } (null fallback),
//   notification/display copy uses { fallback: 'Opponent' }.
function opponentFromTitle(title, { lowercase = false, fallback = null } = {}) {
  const clean = (title || '').replace(/^[^:]+:\s*/i, '');
  const m = clean.match(/arizona\s+state\s+vs\.?\s+(.+)/i)
    || clean.match(/arizona\s+state\s+at\s+(.+)/i)
    || clean.match(/^(.+?)\s+at\s+arizona\s+state/i);
  if (!m) return fallback;
  const name = m[1].trim();
  return lowercase ? name.toLowerCase() : name;
}

module.exports = { opponentFromTitle };
