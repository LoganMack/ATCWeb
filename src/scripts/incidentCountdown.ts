// Live "reporting period ends in X" hover text for the results page's incident button.
// Imported by src/pages/results/[subsessionId].astro (the shell), because IncidentButton
// itself now renders inside a fetched fragment where <script> tags never execute.
// Keeps the "ends in X hours/minutes" hover text live (the page itself may
// be a minute-old cached copy). Runs on load, page swaps, and every time
// the button is hovered/focused, and re-ticks each 30s while visible.
function countdownText(closesAt: number): string {
  const ms = closesAt - Date.now();
  if (ms <= 0) return 'The incident reporting period has ended.';
  const minutes = Math.ceil(ms / 60000);
  if (minutes <= 120) return `Incident reporting period ends in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
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
