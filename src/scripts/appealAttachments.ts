/**
 * The appeal popups' attachment list: each chosen file is listed with a remove button, a second choice adds to
 * the list, and files over the size limit or past the file limit are refused by name. Used by the incident
 * page and the profile's Incidents tab. The server checks the same limits again (submitAppeal.ts).
 */

export interface AttachmentLike {
  name: string;
  size: number;
  lastModified?: number;
}

const sameFile = (a: AttachmentLike, b: AttachmentLike) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

export interface AttachmentLimits {
  maxFiles: number;
  maxBytes: number;
}

export const APPEAL_ATTACHMENT_LIMITS: AttachmentLimits = { maxFiles: 3, maxBytes: 5 * 1024 * 1024 };

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** Adds `chosen` to `current` in order, refusing each file that is too big or past the file limit. */
export function addFiles<T extends AttachmentLike>(
  current: readonly T[],
  chosen: readonly T[],
  limits: AttachmentLimits = APPEAL_ATTACHMENT_LIMITS,
): { files: T[]; messages: string[] } {
  const files = [...current];
  const messages: string[] = [];
  for (const file of chosen) {
    // Picking the same file again would only use up a slot.
    if (files.some((f) => sameFile(f, file))) continue;
    if (file.size > limits.maxBytes) {
      messages.push(`"${file.name}" is over ${megabytes(limits.maxBytes)} MB and wasn't added.`);
    } else if (files.length >= limits.maxFiles) {
      messages.push(`Only ${limits.maxFiles} files can be attached; "${file.name}" wasn't added.`);
    } else {
      files.push(file);
    }
  }
  return { files, messages };
}

/** The list without the file at `index`; an index outside the list changes nothing. */
export function removeAt<T>(files: readonly T[], index: number): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= files.length) return [...files];
  return files.filter((_, i) => i !== index);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AppealAttachmentsHandle {
  /** Empties the list and the message, for when the popup opens again. */
  reset(): void;
}

/**
 * Wires one popup's file picker to its list. The picker's own `files` is rebuilt from the list after every
 * change, so the form submits exactly the listed files.
 */
export function attachAppealFiles({
  input,
  list,
  message,
  limits = APPEAL_ATTACHMENT_LIMITS,
}: {
  input: HTMLInputElement;
  list: HTMLElement;
  message: HTMLElement;
  limits?: AttachmentLimits;
}): AppealAttachmentsHandle {
  let files: File[] = [];

  const showMessage = (text: string) => {
    message.textContent = text;
    message.classList.toggle('hidden', text === '');
  };

  const syncInput = () => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
  };

  const render = () => {
    list.replaceChildren(
      ...files.map((file, index) => {
        const row = document.createElement('li');
        row.className = 'flex items-center justify-between gap-2 rounded-md bg-white/5 px-3 py-1.5 text-sm';
        const name = document.createElement('span');
        name.className = 'min-w-0 truncate text-white/80';
        name.textContent = file.name;
        const size = document.createElement('span');
        size.className = 'ml-auto flex-none text-xs text-white/50';
        size.textContent = formatSize(file.size);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-neutral btn-sm flex-none';
        remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.dataset.appealFileRemove = String(index);
        remove.textContent = '×';
        row.append(name, size, remove);
        return row;
      }),
    );
    list.classList.toggle('hidden', files.length === 0);
  };

  input.addEventListener('change', () => {
    const chosen = Array.from(input.files ?? []);
    const result = addFiles(files, chosen, limits);
    files = result.files;
    syncInput();
    render();
    showMessage(result.messages.join(' '));
  });

  list.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-appeal-file-remove]');
    if (!target) return;
    const index = Number(target.dataset.appealFileRemove);
    files = removeAt(files, index);
    syncInput();
    render();
    const buttons = list.querySelectorAll<HTMLButtonElement>('[data-appeal-file-remove]');
    (buttons[index] ?? buttons[index - 1] ?? input).focus();
  });

  return {
    reset() {
      files = [];
      syncInput();
      render();
      showMessage('');
    },
  };
}
