/**
 * Admin > Seasons "Add Season" form (FR1.2): the read-only Name follows the Number as it is typed. The server
 * builds the name from the number again (parseNewSeasonForm), so this is display only.
 */
import { nameForNumberInput } from '../lib/seasonForm';

function onInput(e: Event): void {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || !input.matches('[data-season-number]')) return;
  const name = input.form?.querySelector<HTMLInputElement>('[data-season-name]');
  if (name) name.value = nameForNumberInput(input.value);
}

// Delegated and bound once: admin pages are swapped in by client-side navigation.
if (typeof document !== 'undefined' && document.documentElement.dataset.seasonNameSyncInit !== 'true') {
  document.documentElement.dataset.seasonNameSyncInit = 'true';
  document.addEventListener('input', onInput);
}
