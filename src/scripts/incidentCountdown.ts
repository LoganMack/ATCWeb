// Live "reporting period ends in X" hover text for the results page's incident button, imported by the shell
// because the button renders in a fetched fragment where scripts don't run. The page may be a cached copy, so
// it recomputes on load, swaps and hover, and every 30 s while visible.
function countdownText(closesAt: number): string {
  const ms = closesAt - Date.now();
  if (ms <= 0) return 'The incident reporting period has ended.';
  const minutes = Math.ceil(ms / 60000);
  if (minutes <= 120)
    return `Incident reporting period ends in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  return `Incident reporting period ends in ${Math.floor(ms / 3600000)} hours.`;
}
function refreshIncidentCountdowns() {
  document.querySelectorAll<HTMLElement>('[data-incident-countdown][data-closes-at]').forEach((el) => {
    const closesAt = Date.parse(el.dataset.closesAt ?? '');
    if (!Number.isNaN(closesAt)) el.textContent = countdownText(closesAt);
  });
}
function initIncidentCountdown() {
  refreshIncidentCountdowns();
  if (document.body.dataset.incidentCountdownInit === 'true') return;
  document.body.dataset.incidentCountdownInit = 'true';
  document.addEventListener('mouseover', refreshIncidentCountdowns);
  document.addEventListener('focusin', refreshIncidentCountdowns);
  window.setInterval(refreshIncidentCountdowns, 30000);
}
initIncidentCountdown();
document.addEventListener('astro:page-load', initIncidentCountdown);
