// shared.js — single source for utilities and constants used across
// filters.js / calendar.js / map.js / live.js / pwa.js. Must be the first
// app script loaded in index.html: later scripts reference these globals.

// ── Safe localStorage wrapper ─────────────────────────────────────────────────
// localStorage throws in some private-browsing modes; every caller used to
// wrap access in its own try/catch (or forget to).

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, val) {
    try { localStorage.setItem(key, val); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch {}
  },
  getJSON(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null || raw === '' ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  setJSON(key, val) {
    return store.set(key, JSON.stringify(val));
  },
};

// ── Text helpers ──────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shortTitle(title) {
  if (!title) return 'Event';
  return title
    .replace(/^Sun Devil [^:]+:\s*/i, '')
    .replace(/^Arizona State\s+/i, '');
}

function shortOppName(name) {
  if (!name) return '';
  return name.replace(/^(University of |The )/i, '');
}

// Poll rank badge ("#7") — single render path for list/calendar/live/modal.
// Returns '' for unranked so callers can prefix unconditionally.
function rankBadgeHTML(rank) {
  return rank ? `<span class="rank-badge">#${esc(rank)}</span> ` : '';
}

function seasonLabel(val) {
  if (val === '2025')    return '2024–25';
  if (val === '2026')    return '2025–26';
  if (val === '2025_26') return '2024–25 (Full)';
  if (val === '2026_27') return '2025–26 (Full)';
  return val;
}

function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  // Midnight Phoenix = feed placeholder for "time unknown" — show date only (no time).
  // Keep the Phoenix check here since it's a feed artifact, not a display concern.
  const phoenixTime = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' });
  if (phoenixTime === '12:00 AM') {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' });
  }
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix', timeZoneName: 'short' });
}

// ── Sport colors ──────────────────────────────────────────────────────────────

// Sport color palette — cycles through these
const SPORT_COLORS = [
  '#8C1D40', '#C0392B', '#27AE60', '#2980B9', '#8E44AD',
  '#D35400', '#16A085', '#2C3E50', '#E74C3C', '#1ABC9C',
  '#F39C12', '#6C3483', '#1F618D', '#117A65', '#7D6608',
];
const sportColorMap = {};
let colorIdx = 0;

function sportColor(sport) {
  if (!sport) return '#8C1D40';
  if (!sportColorMap[sport]) {
    sportColorMap[sport] = SPORT_COLORS[colorIdx % SPORT_COLORS.length];
    colorIdx++;
  }
  return sportColorMap[sport];
}

// ── Logo / opponent identity helpers ─────────────────────────────────────────

function isUA(title, opponentLogo) {
  // Extract the opponent from "[prefix] at/vs. [Opponent]" — take everything
  // after the last occurrence of "at " or "vs. " in the title.
  const vsMatch = (title || '').match(/\b(?:at|vs\.?)\s+(.+)$/i);
  const opponent = (vsMatch ? vsMatch[1] : title || '').trim();

  // Opponent is specifically UA when it starts with bare "Arizona",
  // "Arizona Wildcats", or "University of Arizona".
  // This correctly rejects "Northern Arizona", "Arizona Christian", etc.
  if (/^arizona\s*$/i.test(opponent)) return true;
  if (/^arizona\s+wildcats?/i.test(opponent)) return true;
  if (/^university\s+of\s+arizona/i.test(opponent)) return true;

  // ESPN logo URL contains "arizona-wildcat"
  if (opponentLogo && /arizona-wildcat/i.test(opponentLogo)) return true;

  return false;
}

// ESPN CDN logo lookup: opponent name → ESPN team ID
// URL pattern: https://a.espncdn.com/i/teamlogos/ncaa/500/{id}.png
const ESPN_LOGO_MAP = {
  // Big 12
  'arizona wildcats': 12, 'utah utes': 254, 'byu cougars': 252, 'byu': 252,
  'oklahoma sooners': 201, 'oklahoma state cowboys': 197, 'oklahoma state cowgirls': 197,
  'oklahoma st.': 197, 'kansas state wildcats': 2306, 'kansas st.': 2306,
  'kansas jayhawks': 2305, 'kansas': 2305, 'west virginia mountaineers': 277,
  'texas tech red raiders': 2641, 'tcu horned frogs': 2628,
  'baylor bears': 239, 'baylor': 239, 'houston cougars': 248, 'houston': 248,
  'ucf knights': 2116, 'ucf': 2116, 'cincinnati bearcats': 2132, 'cincinnati': 2132,
  'iowa state cyclones': 66, 'colorado buffaloes': 38, 'colorado': 38,
  // Other major conferences
  'stanford cardinal': 24, 'stanford': 24, 'utah': 254, 'cal': 25,
  'california golden bears': 25, 'north carolina tar heels': 153, 'nc state wolfpack': 152,
  'tennessee volunteers': 2633, 'tennessee': 2633, 'texas a&m aggies': 245, 'texas a&m': 245,
  'mississippi state bulldogs': 344, 'ole miss rebels': 145, 'ole miss': 145,
  'michigan wolverines': 130, 'michigan': 130, 'wisconsin badgers': 275,
  'indiana hoosiers': 84, 'northwestern wildcats': 77, 'northwestern': 77,
  // Mountain West / WAC
  'unlv rebels': 2439, 'unlv': 2439, 'san diego state aztecs': 21,
  'nevada wolf pack': 2440, 'nevada': 2440, 'air force falcons': 2005, 'air force': 2005,
  'new mexico state aggies': 166, 'new mexico st.': 166, 'utep miners': 2638,
  // Big Sky / Summit / other D1
  'grand canyon lopes': 2253, 'grand canyon': 2253, 'omaha mavericks': 2437, 'omaha': 2437,
  'south dakota state jackrabbits': 2571, 'south dakota state': 2571, 'south dakota st.': 2571,
  'north dakota fighting hawks': 2446, 'north dakota': 2446,
  'st. cloud state huskies': 720, 'denver pioneers': 2172, 'denver': 2172,
  'colorado college tigers': 2098, 'colorado college': 2098,
  'uconn huskies': 41, 'uconn': 41, "st. john's red storm": 2599, "st. john's": 2599,
  'loyola marymount lions': 2350, 'loyola marymount': 2350, 'lmu': 2350,
  'memphis tigers': 235, 'memphis': 235, 'miami (oh) redhawks': 193, 'miami oh': 193,
  'western michigan broncos': 2711, 'western michigan': 2711,
  'toledo rockets': 2649, 'toledo': 2649, 'buffalo bulls': 2084, 'buffalo': 2084,
  'texas state bobcats': 326, 'texas state': 326,
  'cal baptist': 2856, 'california baptist lancers': 2856,
  'uc riverside highlanders': 2427, 'uc riverside': 2427,
  'eastern illinois panthers': 2178, 'eastern illinois': 2178,
  'southern utah thunderbirds': 2561, 'southern utah': 2561,
  'portland state vikings': 304, 'portland state': 304,
  'grambling state': 2755, 'grambling': 2755,
  'pacific tigers': 279, 'pacific': 279,
  'colgate raiders': 2111, 'colgate': 2111,
  'dartmouth big green': 2155, 'dartmouth': 2155,
  'princeton tigers': 163, 'princeton': 163,
  'marist red foxes': 2373, 'marist': 2373,
  'nebraska cornhuskers': 158, 'nebraska': 158,
  'texas longhorns': 251, 'texas': 251,
  'lsu tigers': 99, 'lsu': 99,
  'minnesota golden gophers': 135, 'minnesota': 135,
  'oklahoma state': 197,
};

function espnLogoUrl(title) {
  const vsMatch = (title || '').match(/\b(?:at|vs\.?)\s+(.+)$/i);
  if (!vsMatch) return null;
  const raw = vsMatch[1].replace(/^sun devil [^:]+:\s*/i, '').trim();
  const norm = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (ESPN_LOGO_MAP[norm] != null) {
    return `https://a.espncdn.com/i/teamlogos/ncaa/500/${ESPN_LOGO_MAP[norm]}.png`;
  }
  const words = norm.split(' ');
  for (let i = words.length - 1; i >= 1; i--) {
    const shorter = words.slice(0, i).join(' ');
    if (ESPN_LOGO_MAP[shorter] != null) {
      return `https://a.espncdn.com/i/teamlogos/ncaa/500/${ESPN_LOGO_MAP[shorter]}.png`;
    }
  }
  return null;
}

function opponentInitial(title) {
  if (!title) return '?';
  const cleaned = title
    .replace(/^sun devil [^:]+:\s*/i, '')
    .replace(/^arizona state\s+/i, '')
    .replace(/^(vs\.?|at)\s+/i, '');
  return cleaned.charAt(0).toUpperCase() || '?';
}

window.makeLogoPlaceholder = function(title, color) {
  const el = document.createElement('div');
  el.className = 'list-event-logo-placeholder';
  el.style.borderColor = color + '20';
  el.style.color = color;
  el.textContent = opponentInitial(title);
  return el;
};
