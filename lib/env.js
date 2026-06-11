const path = require('path');
const fs = require('fs');

// Secrets come from TWO files, both load-bearing:
//   1. ~/projects/secrets.env — loaded by systemd (EnvironmentFile= in
//      asu-cal.service); holds CF_API_TOKEN / CF_ACCOUNT_ID. Not read here.
//   2. ~/projects/unifi-scripts/secrets.env — holds the VAPID_* keys; loaded
//      here as a fallback when the process didn't inherit them (e.g. running
//      outside systemd). Never overwrites variables that are already set.
// Returns false if the fallback file couldn't be read while VAPID was missing.
function loadSecretsFallback() {
  if (process.env.VAPID_PUBLIC_KEY) return true;
  const secretsPath = path.join(process.env.HOME || '/root', 'projects/unifi-scripts/secrets.env');
  try {
    const lines = fs.readFileSync(secretsPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { loadSecretsFallback };
