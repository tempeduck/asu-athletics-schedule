// Single source of truth for sport mappings. ESPN_SPORT_SLUGS and
// SPORT_CONFIG stay separate tables on purpose: SLUGS keys the summary
// endpoint by display sport name (and includes nulls for sports ESPN has
// no box score for), while SPORT_CONFIG drives team-schedule sync and
// needs ASU teamIds. Their key spaces and ESPN paths differ.

// Sport slug mapping for ESPN summary endpoint
const ESPN_SPORT_SLUGS = {
  'Baseball':             'baseball/college-baseball',
  'Softball':             'softball/college-softball',
  "Men's Basketball":     'basketball/mens-college-basketball',
  "Women's Basketball":   'basketball/womens-college-basketball',
  'Basketball':           'basketball/mens-college-basketball',
  'Football':             'football/college-football',
  "Women's Soccer":       'soccer/college-soccer-women',
  "Men's Soccer":         'soccer/college-soccer-men',
  'Soccer':               'soccer/college-soccer-men',
  "Women's Volleyball":   'volleyball/womens-college-volleyball',
  'Volleyball':           'volleyball/womens-college-volleyball',
  "Golf (Men's)":         'golf/college-golf-men',
  "Golf (Women's)":       'golf/college-golf-women',
  "Tennis (Men's)":       'tennis/college-tennis-men',
  "Tennis (Women's)":     'tennis/college-tennis-women',
  'Swimming':             'swimming-and-diving/college-swimming-diving',
  'Swimming & Diving':    'swimming-and-diving/college-swimming-diving',
  'Track and Field':      null,
  'Cross Country':        null,
};

// Sports for schedule sync (teamId required for team-schedule endpoint)
const SPORT_CONFIG = [
  { dbSport: 'Baseball',   espnPath: 'baseball/college-baseball',            teamId: '59',  fallSport: false },
  { dbSport: 'Softball',   espnPath: 'baseball/college-softball',            teamId: '471', fallSport: false },
  { dbSport: 'Football',   espnPath: 'football/college-football',            teamId: '9',   fallSport: true  },
  { dbSport: 'Ice Hockey', espnPath: 'hockey/mens-college-hockey',           teamId: '9',   fallSport: false },
  { dbSport: 'Volleyball', espnPath: 'volleyball/womens-college-volleyball', teamId: '9',   fallSport: true  },
];

// Additional sports polled for live data only (scoreboard doesn't need teamId)
const LIVE_EXTRA_SPORTS = [
  { dbSport: "Men's Basketball",   espnPath: 'basketball/mens-college-basketball',  fallSport: false },
  { dbSport: "Women's Basketball", espnPath: 'basketball/womens-college-basketball', fallSport: false },
  { dbSport: "Women's Soccer",     espnPath: 'soccer/womens-college-soccer',         fallSport: true  },
  { dbSport: "Men's Soccer",       espnPath: 'soccer/mens-college-soccer',           fallSport: true  },
];

const ALL_LIVE_CONFIGS = [...SPORT_CONFIG, ...LIVE_EXTRA_SPORTS];

const TOURNAMENT_RE = /regional|super\s*regional|tournament|playoff|championship|ncaa|bracket|semifinal|final\s*four|postseason/i;

// ── Standings & rankings (lib/standings.js) ──────────────────────────────────
// STANDINGS_CONFIG drives GET /api/standings. Without childId the group's
// standings endpoint returns the conference table directly; with childId the
// group is a division (e.g. D1) whose children are conferences — the table
// lives on the matching child (group IDs are per-league, verified 2026-06).
// null = ESPN has no usable standings for the sport.
// Note: ASU hockey plays in the NCHC, not the Big 12.
const STANDINGS_CONFIG = {
  'Football':           { espnPath: 'football/college-football',            groupId: '4',                 conference: 'Big 12' },
  "Men's Basketball":   { espnPath: 'basketball/mens-college-basketball',   groupId: '8',                 conference: 'Big 12' },
  "Women's Basketball": { espnPath: 'basketball/womens-college-basketball', groupId: '8',                 conference: 'Big 12' },
  'Baseball':           { espnPath: 'baseball/college-baseball',            groupId: '26', childId: '44', conference: 'Big 12' },
  'Ice Hockey':         { espnPath: 'hockey/mens-college-hockey',           groupId: '63',                conference: 'NCHC' },
  'Volleyball':         { espnPath: 'volleyball/womens-college-volleyball', groupId: '90', childId: '51', conference: 'Big 12' },
  'Softball':           null,
  'Soccer':             null,
};

// ── Team news & rosters (lib/team.js) ─────────────────────────────────────────
// ASU's teamId differs per ESPN league (verified 2026-06: 9 in most leagues,
// 59 in college baseball, 471 in softball). roster:false = ESPN has the
// endpoint but the data is junk for the sport (college baseball rosters are
// 100 flat entries with null jerseys/positions) or empty (volleyball).
const TEAM_CONFIG = {
  'Football':           { espnPath: 'football/college-football',            teamId: '9',   roster: true },
  "Men's Basketball":   { espnPath: 'basketball/mens-college-basketball',   teamId: '9',   roster: true },
  "Women's Basketball": { espnPath: 'basketball/womens-college-basketball', teamId: '9',   roster: true },
  'Ice Hockey':         { espnPath: 'hockey/mens-college-hockey',           teamId: '9',   roster: true },
  'Baseball':           { espnPath: 'baseball/college-baseball',            teamId: '59',  roster: false },
  'Softball':           { espnPath: 'softball/college-softball',            teamId: '471', roster: false },
  'Volleyball':         { espnPath: 'volleyball/womens-college-volleyball', teamId: '9',   roster: false },
};

// Rankings slugs are a separate table from ESPN_SPORT_SLUGS on purpose: the
// /rankings endpoint uses different league paths for some sports (verified
// 2026-06: women's soccer rankings live under usa.ncaa.w.1, not
// college-soccer-women; softball has no rankings endpoint at all).
const RANKINGS_SLUGS = {
  'Football':           'football/college-football',
  "Men's Basketball":   'basketball/mens-college-basketball',
  "Women's Basketball": 'basketball/womens-college-basketball',
  'Baseball':           'baseball/college-baseball',
  'Volleyball':         'volleyball/womens-college-volleyball',
  "Women's Volleyball": 'volleyball/womens-college-volleyball',
  "Women's Soccer":     'soccer/usa.ncaa.w.1',
  'Softball':           null,
};


const SPORT_EMOJI = {
  'Football':             '🏈',
  "Men's Basketball":     '🏀',
  "Women's Basketball":   '🏀',
  'Basketball':           '🏀',
  'Baseball':             '⚾',
  'Softball':             '🥎',
  "Women's Soccer":       '⚽',
  "Men's Soccer":         '⚽',
  'Soccer':               '⚽',
  "Women's Volleyball":   '🏐',
  'Volleyball':           '🏐',
  "Golf (Men's)":         '⛳',
  "Golf (Women's)":       '⛳',
  "Tennis (Men's)":       '🎾',
  "Tennis (Women's)":     '🎾',
  'Swimming':             '🏊',
  'Swimming & Diving':    '🏊',
  'Track and Field':      '🏃',
  'Cross Country':        '🏃',
  'Wrestling':            '🤼',
  'Gymnastics':           '🤸',
};

module.exports = {
  ESPN_SPORT_SLUGS,
  SPORT_CONFIG,
  LIVE_EXTRA_SPORTS,
  ALL_LIVE_CONFIGS,
  TOURNAMENT_RE,
  SPORT_EMOJI,
  STANDINGS_CONFIG,
  RANKINGS_SLUGS,
  TEAM_CONFIG,
};
