/**
 * Admin event form: choosing "To Be Determined" as the circuit disables the inputs that depend on the venue
 * (layout, format, fuel limit, rules, iRacing URL and every session) and makes Race 1 optional. The server
 * clears the same fields on save (lib/eventTbd.ts), so this is only a guide for the admin.
 *
 * Owns Race 1's `required` flag on this page, since it depends on both the category and the circuit.
 */
import { TBD_CIRCUIT_VALUE } from '../lib/eventTbd';

const VENUE_INPUTS = ['layout', 'format', 'fuel_limit_pct', 'rules', 'results_url'];

function init() {
  const circuitSelect = document.getElementById('circuit_id') as HTMLSelectElement | null;
  const categorySelect = document.getElementById('category') as HTMLSelectElement | null;
  if (!circuitSelect || !categorySelect || circuitSelect.dataset.tbdInit === 'true') return;
  circuitSelect.dataset.tbdInit = 'true';
  const form = circuitSelect.form;
  if (!form) return;

  const apply = () => {
    const category = categorySelect.value;
    const circuitless = category === 'holiday' || category === 'iracing';
    const tbd = !circuitless && circuitSelect.value === TBD_CIRCUIT_VALUE;

    for (const name of VENUE_INPUTS) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.disabled = tbd;
    }
    document.querySelectorAll<HTMLFieldSetElement>('#session-fields fieldset').forEach((set) => {
      set.disabled = tbd;
    });
    const race1 = form.elements.namedItem('race1_start_time');
    if (race1 instanceof HTMLInputElement) race1.required = category !== 'test' && !circuitless && !tbd;
  };

  circuitSelect.addEventListener('change', apply);
  categorySelect.addEventListener('change', apply);
  apply();
}

document.addEventListener('astro:page-load', init);
