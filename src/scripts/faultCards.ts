/**
 * "Cars at fault" picker with one penalty card per car — used by the incident
 * dialog (Log/Add/Edit incident) and the steward review dialog, where several
 * cars can be at fault for one incident, each with its own penalty.
 *
 *   <div data-fault-root>
 *     <div data-fault-picker data-driver-picker>        (data-driver-picker = driverPickerSearch.ts search)
 *       <input type="search" data-driver-search />
 *       <label><input type="checkbox" data-fault-racing-incident /> Racing Incident</label>
 *       <label data-driver-option data-search="#14 jane doe" data-fault-label="#14 Jane Doe">
 *         <input type="checkbox" name="fault_driver_ids" value="<driver id>" />…
 *       </label>
 *     </div>
 *     <div data-fault-cards></div>
 *     <template data-fault-card-template>
 *       <div data-fault-card>
 *         <span data-fault-card-label></span>
 *         <select name="pp_choice:__ID__">…</select>       (every `name` with __ID__ gets the car's driver id)
 *       </div>
 *     </template>
 *   </div>
 *
 * Ticking a car adds its card (in car-number order, i.e. the picker's order),
 * unticking removes it. Racing Incident and cars at fault are mutually
 * exclusive. In single mode (editing one existing penalty row) ticking a car
 * unticks any other. Every change dispatches `fault-change` on the root.
 */

export interface FaultPicker {
  /** The ticked cars' driver ids, in picker order. */
  selected(): string[];
  isRacingIncident(): boolean;
  /** Untick everything and remove every card. */
  clear(): void;
  setRacingIncident(on: boolean): void;
  /** Tick a car and return its card (existing or new) so the caller can fill it in. */
  addDriver(driverId: string): HTMLElement | null;
  setSingle(single: boolean): void;
}

export function initFaultPicker(root: HTMLElement): FaultPicker {
  const picker = root.querySelector<HTMLElement>('[data-fault-picker]')!;
  const cards = root.querySelector<HTMLElement>('[data-fault-cards]')!;
  const template = root.querySelector<HTMLTemplateElement>('[data-fault-card-template]')!;
  const racingIncident = picker.querySelector<HTMLInputElement>('[data-fault-racing-incident]')!;
  const driverBoxes = () => [...picker.querySelectorAll<HTMLInputElement>('input[name="fault_driver_ids"]')];
  let single = false;

  const notify = () => root.dispatchEvent(new CustomEvent('fault-change'));
  const cardFor = (id: string) => cards.querySelector<HTMLElement>(`[data-fault-card="${CSS.escape(id)}"]`);

  function buildCard(box: HTMLInputElement): HTMLElement {
    const card = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    card.dataset.faultCard = box.value;
    card.querySelectorAll<HTMLElement>('[name*="__ID__"]').forEach((el) => {
      el.setAttribute('name', el.getAttribute('name')!.replace('__ID__', box.value));
    });
    const label = card.querySelector<HTMLElement>('[data-fault-card-label]');
    if (label) label.textContent = box.closest<HTMLElement>('[data-fault-label]')?.dataset.faultLabel ?? '';
    return card;
  }

  // Cards are kept in the picker's own (car number) order.
  function syncCards() {
    const ticked = driverBoxes().filter((b) => b.checked);
    const wanted = new Set(ticked.map((b) => b.value));
    cards.querySelectorAll<HTMLElement>('[data-fault-card]').forEach((card) => {
      if (!wanted.has(card.dataset.faultCard!)) card.remove();
    });
    for (const box of ticked) cards.appendChild(cardFor(box.value) ?? buildCard(box));
  }

  picker.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    if (target === racingIncident) {
      if (racingIncident.checked) driverBoxes().forEach((b) => (b.checked = false));
    } else if (target.name === 'fault_driver_ids' && target.checked) {
      racingIncident.checked = false;
      if (single) driverBoxes().forEach((b) => b !== target && (b.checked = false));
    }
    syncCards();
    notify();
  });

  return {
    selected: () => driverBoxes().filter((b) => b.checked).map((b) => b.value),
    isRacingIncident: () => racingIncident.checked,
    clear() {
      racingIncident.checked = false;
      driverBoxes().forEach((b) => (b.checked = false));
      cards.replaceChildren();
      notify();
    },
    setRacingIncident(on) {
      racingIncident.checked = on;
      if (on) driverBoxes().forEach((b) => (b.checked = false));
      syncCards();
      notify();
    },
    addDriver(driverId) {
      const box = driverBoxes().find((b) => b.value === driverId);
      if (!box) return null;
      racingIncident.checked = false;
      if (single) driverBoxes().forEach((b) => b !== box && (b.checked = false));
      box.checked = true;
      syncCards();
      notify();
      return cardFor(driverId);
    },
    setSingle(value) {
      single = value;
    },
  };
}

/** Sets a card field by its name prefix (the part before `:<driver id>`). Checkbox groups take an array. */
export function setCardField(card: HTMLElement, prefix: string, value: string | string[]) {
  card.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name^="${prefix}:"]`).forEach((el) => {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Array.isArray(value) && value.includes(el.value);
    else el.value = Array.isArray(value) ? (value[0] ?? '') : value;
  });
}
