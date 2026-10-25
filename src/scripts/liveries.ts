// The own profile's Liveries tab (profile-liveries FR5), imported by src/pages/drivers/[id].astro only. The
// browser reads the .tga, makes the thumbnail and preview, gzips the files and sends them straight to Storage
// through signed links the page hands out (NFR4); downloads come back the same way and are unzipped here.
// After each change the rows are re-read from the page, so the held profile fields are never touched.

import type { InPlaceResult } from '../lib/driverAccount';
import { decodeTga, fitWithin, TgaError, TGA_UNSUPPORTED_MESSAGE, type DecodedImage } from '../lib/tga';
import { inPlaceBody, postInPlace, NETWORK_ERROR_MESSAGE } from './profileEditing';

export const LIVERY_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const THUMB_SIZE = 320;
export const PREVIEW_SIZE = 1024;

/** The browser's check of a picked file (the server and database repeat it); null when it is fine. */
export function liveryFileProblem(file: { name: string; size: number }, ext: '.tga' | '.mip'): string | null {
  if (!file.name.toLowerCase().endsWith(ext)) {
    return ext === '.tga' ? 'Pick a .tga file as the base livery.' : 'Pick a .mip file as the spec map.';
  }
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > LIVERY_FILE_MAX_BYTES) {
    return `Files can be at most ${LIVERY_FILE_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

async function pipe(
  blob: Blob,
  stream: CompressionStream | DecompressionStream,
  type: string,
): Promise<Blob> {
  const piped = blob.stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const out = await new Response(piped).blob();
  return out.type === type ? out : new Blob([out], { type });
}

/** Gzips a file in the browser before upload (FR5.9). */
export function gzipBlob(blob: Blob): Promise<Blob> {
  return pipe(blob, new CompressionStream('gzip'), 'application/gzip');
}

/** Restores the original bytes of a downloaded file (FR5.9). */
export function gunzipBlob(blob: Blob): Promise<Blob> {
  return pipe(blob, new DecompressionStream('gzip'), 'application/octet-stream');
}

const isWebLink = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//i.test(value);

/** The three signed upload links of a prepare-livery answer, or null. */
export function uploadsOf(
  result: InPlaceResult,
): { id: string; base: string; thumb: string; preview: string } | null {
  const id = result.data?.id;
  const uploads = result.data?.uploads as Record<string, unknown> | undefined;
  if (!result.ok || typeof id !== 'string' || !uploads) return null;
  const { base, thumb, preview } = uploads;
  return isWebLink(base) && isWebLink(thumb) && isWebLink(preview) ? { id, base, thumb, preview } : null;
}

/** The original names and signed links of a livery-files answer, or null; only web links are followed. */
export function downloadFilesOf(result: InPlaceResult): { name: string; url: string }[] | null {
  const files = result.data?.files;
  if (!result.ok || !Array.isArray(files) || files.length === 0) return null;
  const valid = files.filter(
    (f): f is { name: string; url: string } =>
      typeof (f as { name?: unknown })?.name === 'string' && isWebLink((f as { url?: unknown })?.url),
  );
  return valid.length === files.length ? valid : null;
}

/** The signed link of a single-link answer (the preview or the spec map upload), or null. */
export function linkOf(result: InPlaceResult): string | null {
  const url = result.data?.url;
  return result.ok && isWebLink(url) ? url : null;
}

/** "car.tga" stays as it is; anything that could name a folder is reduced to its last part. */
export function saveName(name: string): string {
  return name.split(/[\\/]/).pop()?.trim() || 'livery';
}

// --- Browser-only: images, uploads and downloads --------------------------------------------------

/** Draws the decoded paint, opaque (iRacing uses the alpha channel as a mask), at most `max` px a side. */
async function renderImage(image: DecodedImage, max: number): Promise<Blob> {
  const full = document.createElement('canvas');
  full.width = image.width;
  full.height = image.height;
  const opaque = new Uint8ClampedArray(image.pixels);
  for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
  full.getContext('2d')?.putImageData(new ImageData(opaque, image.width, image.height), 0, 0);
  const size = fitWithin(image.width, image.height, max);
  const small = document.createElement('canvas');
  small.width = size.width;
  small.height = size.height;
  const ctx = small.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, size.width, size.height);
  const encode = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => small.toBlob(resolve, type, quality));
  // A browser that can't encode WebP returns PNG instead; JPEG is the fallback (NFR2).
  const webp = await encode('image/webp', 0.8);
  if (webp && webp.type === 'image/webp') return webp;
  const jpeg = await encode('image/jpeg', 0.85);
  if (!jpeg) throw new Error('image encoding failed');
  return jpeg;
}

async function put(url: string, body: Blob, contentType: string, upsert = false): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType, ...(upsert ? { 'x-upsert': 'true' } : {}) },
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = saveName(name);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// --- DOM wiring ----------------------------------------------------------------------------------

const panel = () => document.querySelector<HTMLElement>('[data-liveries-panel]');
const deleteDialog = () => document.querySelector<HTMLDialogElement>('dialog[data-livery-delete-dialog]');
const previewDialog = () => document.querySelector<HTMLDialogElement>('dialog[data-livery-preview-dialog]');

function setStatus(result: { ok: boolean; message: string }): void {
  const status = panel()?.querySelector<HTMLElement>('[data-liveries-status]');
  if (!status) return;
  status.textContent = result.message;
  status.classList.toggle('text-brand-pink', !result.ok);
  status.classList.toggle('text-white/70', result.ok);
}

const fail = (message: string) => setStatus({ ok: false, message });

const send = (intent: string, fields: [string, string][]) =>
  postInPlace(window.location.pathname, inPlaceBody(intent, fields));

/** Re-reads the rows from the page, so thumbnails, groups and the active badge match the database. */
async function refreshRows(): Promise<void> {
  try {
    const res = await fetch(`${window.location.pathname}?edit=1&tab=liveries`, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const fresh = new DOMParser()
      .parseFromString(await res.text(), 'text/html')
      .querySelector('[data-liveries-rows]');
    const current = panel()?.querySelector('[data-liveries-rows]');
    if (!fresh || !current) throw new Error('rows missing');
    current.replaceWith(document.importNode(fresh, true));
  } catch {
    fail('Saved, but the list could not be refreshed. Reload the page to see the change.');
  }
}

let busy = false;

/** Runs one action at a time with its button disabled; any thrown error ends as a message. */
async function run(button: HTMLButtonElement | null, action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;
  try {
    await action();
  } catch (err) {
    fail(err instanceof TgaError ? err.message : NETWORK_ERROR_MESSAGE);
  } finally {
    busy = false;
    if (button) button.disabled = false;
  }
}

async function finish(result: InPlaceResult): Promise<void> {
  setStatus(result);
  if (result.ok) await refreshRows();
}

async function uploadLivery(root: HTMLElement): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('input[data-livery-tga-input]');
  const season = root.querySelector<HTMLSelectElement>('select[data-livery-upload-season]')?.value ?? '';
  const file = input?.files?.[0];
  if (!file) return fail('Pick a .tga file first.');
  const problem = liveryFileProblem(file, '.tga');
  if (problem) return fail(problem);
  setStatus({ ok: true, message: 'Reading the livery…' });
  let image: DecodedImage;
  try {
    image = decodeTga(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return fail(TGA_UNSUPPORTED_MESSAGE);
  }
  const [thumb, preview, gz] = await Promise.all([
    renderImage(image, THUMB_SIZE),
    renderImage(image, PREVIEW_SIZE),
    gzipBlob(file),
  ]);
  const fields: [string, string][] = [
    ['season_id', season],
    ['tga_name', file.name],
    ['tga_size', String(file.size)],
  ];
  const prepared = await send('prepare-livery', [
    ...fields,
    ['thumb_type', thumb.type],
    ['preview_type', preview.type],
  ]);
  const uploads = uploadsOf(prepared);
  if (!uploads) return setStatus(prepared.ok ? { ok: false, message: NETWORK_ERROR_MESSAGE } : prepared);
  setStatus({ ok: true, message: 'Uploading…' });
  await Promise.all([
    put(uploads.base, gz, 'application/gzip'),
    put(uploads.thumb, thumb, thumb.type),
    put(uploads.preview, preview, preview.type),
  ]);
  const created = await send('create-livery', [['livery_id', uploads.id], ...fields]);
  if (created.ok && input) {
    input.value = '';
    onTgaPicked(root, input);
  }
  await finish(created);
}

let mipTarget = '';

async function uploadMip(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  const id = mipTarget;
  input.value = '';
  if (!file || !id) return;
  const problem = liveryFileProblem(file, '.mip');
  if (problem) return fail(problem);
  setStatus({ ok: true, message: 'Uploading the spec map…' });
  const fields: [string, string][] = [
    ['livery_id', id],
    ['mip_name', file.name],
    ['mip_size', String(file.size)],
  ];
  const prepared = await send('prepare-livery-mip', fields);
  const url = linkOf(prepared);
  if (!url) return setStatus(prepared.ok ? { ok: false, message: NETWORK_ERROR_MESSAGE } : prepared);
  await put(url, await gzipBlob(file), 'application/gzip', true);
  await finish(await send('set-livery-mip', fields));
}

async function download(id: string): Promise<void> {
  const result = await send('livery-files', [['livery_id', id]]);
  const files = downloadFilesOf(result);
  if (!files) return setStatus(result.ok ? { ok: false, message: NETWORK_ERROR_MESSAGE } : result);
  setStatus(result);
  for (const file of files) {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    saveBlob(await gunzipBlob(await res.blob()), file.name);
  }
}

async function preview(id: string): Promise<void> {
  const result = await send('livery-preview', [['livery_id', id]]);
  const url = linkOf(result);
  const popup = previewDialog();
  const img = popup?.querySelector<HTMLImageElement>('[data-livery-preview-image]');
  if (!url || !popup || !img)
    return setStatus(result.ok ? { ok: false, message: NETWORK_ERROR_MESSAGE } : result);
  img.src = url;
  img.alt = `Preview of ${typeof result.data?.name === 'string' ? result.data.name : 'the livery'}`;
  popup.showModal();
}

function openDelete(button: HTMLElement): void {
  const popup = deleteDialog();
  if (!popup) return;
  const text = popup.querySelector<HTMLElement>('[data-livery-delete-text]');
  if (text) {
    text.textContent = `Delete ${button.dataset.liveryName ?? 'this livery'} and its spec map? This can't be undone.`;
  }
  const error = popup.querySelector<HTMLElement>('[data-livery-delete-error]');
  error?.classList.add('hidden');
  popup.dataset.liveryId = button.dataset.liveryId ?? '';
  popup.showModal();
}

async function confirmDelete(): Promise<void> {
  const popup = deleteDialog();
  const id = popup?.dataset.liveryId ?? '';
  if (!popup || !id) return;
  const result = await send('delete-livery', [['livery_id', id]]);
  if (!result.ok) {
    const error = popup.querySelector<HTMLElement>('[data-livery-delete-error]');
    if (error) {
      error.textContent = result.message;
      error.classList.remove('hidden');
    }
    return;
  }
  popup.close();
  await finish(result);
}

async function moveSeason(select: HTMLSelectElement): Promise<void> {
  const result = await send('set-livery-season', [
    ['livery_id', select.dataset.liveryId ?? ''],
    ['season_id', select.value],
  ]);
  // A refused move puts the dropdown back, so it never shows a season the livery isn't in.
  if (!result.ok) select.value = select.dataset.current ?? select.value;
  await finish(result);
}

function onTgaPicked(root: HTMLElement, input: HTMLInputElement): void {
  const file = input.files?.[0];
  const name = root.querySelector<HTMLElement>('[data-livery-tga-name]');
  const upload = root.querySelector<HTMLButtonElement>('[data-livery-upload]');
  const problem = file ? liveryFileProblem(file, '.tga') : null;
  if (problem) {
    fail(problem);
    input.value = '';
  }
  const picked = input.files?.[0];
  if (name) name.textContent = picked ? picked.name : 'No file chosen';
  if (upload) upload.disabled = !picked;
}

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  const root = panel();
  if (!target || !root) return;
  const button = target.closest<HTMLButtonElement>('button');
  const id = button?.dataset.liveryId ?? '';
  if (button?.hasAttribute('data-livery-pick-tga')) {
    root.querySelector<HTMLInputElement>('input[data-livery-tga-input]')?.click();
  } else if (button?.hasAttribute('data-livery-upload')) {
    void run(button, () => uploadLivery(root));
  } else if (button?.hasAttribute('data-livery-add-mip')) {
    mipTarget = id;
    root.querySelector<HTMLInputElement>('input[data-livery-mip-input]')?.click();
  } else if (button?.hasAttribute('data-livery-preview')) {
    void run(button, () => preview(id));
  } else if (button?.hasAttribute('data-livery-download')) {
    void run(button, () => download(id));
  } else if (button?.hasAttribute('data-livery-set-active')) {
    void run(button, async () => finish(await send('set-livery-active', [['livery_id', id]])));
  } else if (button?.hasAttribute('data-livery-delete')) {
    openDelete(button);
  } else if (button?.hasAttribute('data-livery-delete-confirm')) {
    void run(button, confirmDelete);
  } else if (button?.hasAttribute('data-livery-delete-cancel')) {
    deleteDialog()?.close();
  } else if (button?.hasAttribute('data-livery-preview-close')) {
    previewDialog()?.close();
  } else if (target instanceof HTMLDialogElement && root.contains(target)) {
    // Clicking the backdrop (the <dialog> itself, outside its content) closes it.
    target.close();
  }
}

function onChange(e: Event): void {
  const target = e.target as HTMLElement | null;
  const root = panel();
  if (!target || !root || !root.contains(target)) return;
  if (target instanceof HTMLInputElement && target.hasAttribute('data-livery-tga-input')) {
    onTgaPicked(root, target);
  } else if (target instanceof HTMLInputElement && target.hasAttribute('data-livery-mip-input')) {
    void run(null, () => uploadMip(target));
  } else if (target instanceof HTMLSelectElement && target.hasAttribute('data-livery-season-select')) {
    if (busy) target.value = target.dataset.current ?? target.value;
    else void run(null, () => moveSeason(target));
  }
}

// Module-scoped rather than a flag on <body>: the client router swaps <body> on navigation.
let bound = false;
if (typeof document !== 'undefined' && !bound) {
  bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
}
