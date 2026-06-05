// whats-new.js — Version-gated release notes popup.
// Self-contained: no dependencies on pwa.js or calendar.js.

function _wnIsNewer(a, b) {
  const parse = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

function _wnFormatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function _wnDismiss(overlay, currentVersion) {
  overlay.classList.remove('wn-open');
  localStorage.setItem('lastSeenVersion', currentVersion);
  setTimeout(() => overlay.remove(), 300);
}

function _wnBuild(releases, currentVersion) {
  const overlay = document.createElement('div');
  overlay.className = 'wn-overlay';

  const modal = document.createElement('div');
  modal.className = 'wn-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', "What's New");

  const header = document.createElement('div');
  header.className = 'wn-header';
  header.innerHTML = `
    <img src="/icons/apple-touch-icon.png" alt="" class="wn-sparky" />
    <span class="wn-heading">What&#x27;s New</span>
  `;
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'wn-body';

  releases.forEach((release, i) => {
    if (i > 0) {
      const hr = document.createElement('hr');
      hr.className = 'wn-divider';
      body.appendChild(hr);
    }
    const section = document.createElement('div');
    section.className = 'wn-section';
    const bullets = (release.features || [])
      .map(f => `<li>${f}</li>`)
      .join('');
    section.innerHTML = `
      <div class="wn-release-title">${release.title}</div>
      <div class="wn-release-date">${_wnFormatDate(release.date)}</div>
      <ul class="wn-features">${bullets}</ul>
    `;
    body.appendChild(section);
  });

  modal.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'wn-footer';
  const btn = document.createElement('button');
  btn.className = 'wn-got-it';
  btn.textContent = 'Got it';
  btn.addEventListener('click', () => _wnDismiss(overlay, currentVersion));
  footer.appendChild(btn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  return overlay;
}

document.addEventListener('DOMContentLoaded', async () => {
  let data;
  try {
    const res = await fetch('/api/releases');
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }

  const releases = (data.releases || []).slice().sort((a, b) =>
    _wnIsNewer(a.version, b.version) ? -1 : 1,
  );
  if (!releases.length) return;

  const currentVersion = releases[0].version;
  const lastSeen = localStorage.getItem('lastSeenVersion');

  if (!lastSeen) {
    localStorage.setItem('lastSeenVersion', currentVersion);
    return;
  }

  const unseen = releases.filter(r => _wnIsNewer(r.version, lastSeen));
  if (!unseen.length) return;

  const overlay = _wnBuild(unseen, currentVersion);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('wn-open')));
});
