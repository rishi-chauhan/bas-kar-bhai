import {
  getSettings,
  saveSettings,
  todayKey,
  secondsForSite,
  siteMatches,
  formatDuration,
} from '../lib/common.js';
import { micPermission } from '../lib/loudness.js';
import { getCombinedUsage, listDevices } from '../lib/sync.js';
import { $, el } from '../lib/dom.js';

async function render() {
  // Ask the worker to credit the last few seconds before we read.
  await chrome.runtime.sendMessage({ type: 'BKB_REFRESH' }).catch(() => {});
  const [settings, usage, devices] = await Promise.all([getSettings(), getCombinedUsage(), listDevices()]);
  const today = usage[todayKey()] || {};

  $('enabled').checked = settings.enabled;
  $('speakerNotice').hidden = settings.outputMode === 'default' || (await micPermission()) === 'granted';
  $('totalLabel').textContent = devices.length > 1 ? `Tracked today, on ${devices.length} browsers` : 'Tracked today';
  $('total').textContent = formatDuration(Object.values(today).reduce((a, b) => a + b, 0));

  // Limits, worst offenders first.
  const limitRows = settings.limits
    .map((l) => ({ ...l, used: secondsForSite(today, l.site) }))
    .sort((a, b) => b.used / (b.minutes * 60) - a.used / (a.minutes * 60));

  $('limits').replaceChildren(
    ...limitRows.map(({ site, minutes, used }) => {
      const pct = Math.min(100, (used / (minutes * 60)) * 100);
      const li = el('li', pct >= 100 ? 'over' : '');
      const top = el('div', 'top');
      top.append(el('span', 'site', site), el('span', 'time', `${formatDuration(used)} / ${formatDuration(minutes * 60)}`));
      const bar = el('div', `bar ${pct >= 100 ? 'over' : pct >= 75 ? 'warn' : ''}`);
      const fill = el('span');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      li.append(top, bar);
      return li;
    })
  );
  $('noLimits').hidden = limitRows.length > 0;

  // Untracked-by-limit sites.
  const others = Object.entries(today)
    .filter(([host]) => !settings.limits.some((l) => siteMatches(host, l.site)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  $('others').replaceChildren(
    ...others.map(([host, secs]) => {
      const li = el('li');
      li.append(el('span', 'site', host), el('span', 'time', formatDuration(secs)));
      return li;
    })
  );
  $('noOthers').hidden = others.length > 0;
}

$('enabled').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('speakerNotice').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
