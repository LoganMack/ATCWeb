// Record Interview dialog behavior — delegated, register-once listeners.
// Imported by src/pages/results/[subsessionId].astro (the shell): the dialog
// markup (components/InterviewDialog.astro) renders inside a fetched fragment,
// where <script> tags never execute.
//
// Flow: Record -> mic permission -> MediaRecorder runs for up to data-max-seconds
// while the button's fill layer drains right-to-left and its label reads
// "Finish" -> on Finish/timeout the take is kept, the button reads "Re-Record"
// and Submit appears -> Submit POSTs the clip to the results fragment
// (intent=submit-interview, which re-validates everything server-side).

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

interface RecorderState {
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  startedAt: number;
  raf: number;
  recording: boolean;
  blob: Blob | null;
  durationSeconds: number;
  previewUrl: string | null;
  submitting: boolean;
}

const state: RecorderState = {
  stream: null,
  recorder: null,
  chunks: [],
  startedAt: 0,
  raf: 0,
  recording: false,
  blob: null,
  durationSeconds: 0,
  previewUrl: null,
  submitting: false,
};

function parts(dialog: HTMLDialogElement) {
  const q = <T extends HTMLElement>(sel: string) => dialog.querySelector<T>(sel)!;
  return {
    record: q<HTMLButtonElement>('[data-interview-record]'),
    fill: q<HTMLElement>('[data-interview-fill]'),
    label: q<HTMLElement>('[data-interview-record-label]'),
    time: q<HTMLElement>('[data-interview-time]'),
    recordIcon: q<SVGElement & HTMLElement>('[data-interview-record-icon]'),
    stopIcon: q<SVGElement & HTMLElement>('[data-interview-stop-icon]'),
    status: q<HTMLElement>('[data-interview-status]'),
    preview: q<HTMLAudioElement>('[data-interview-preview]'),
    submit: q<HTMLButtonElement>('[data-interview-submit]'),
  };
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `0:${String(s).padStart(2, '0')}`;
}

function releaseMic() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

function discardTake(dialog: HTMLDialogElement) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  state.blob = null;
  state.durationSeconds = 0;
  const p = parts(dialog);
  p.preview.removeAttribute('src');
  p.preview.classList.add('hidden');
  p.submit.classList.add('hidden');
}

function resetDialog(dialog: HTMLDialogElement) {
  cancelAnimationFrame(state.raf);
  if (state.recorder && state.recording) {
    state.recording = false;
    try {
      state.recorder.ondataavailable = null;
      state.recorder.onstop = null;
      state.recorder.stop();
    } catch {
      /* already stopped */
    }
  }
  state.recorder = null;
  releaseMic();
  discardTake(dialog);
  state.submitting = false;
  const p = parts(dialog);
  p.record.disabled = false;
  p.submit.disabled = false;
  p.fill.style.width = '100%';
  p.label.textContent = 'Record';
  p.time.classList.add('hidden');
  p.recordIcon.classList.remove('hidden');
  p.stopIcon.classList.add('hidden');
  p.status.textContent = '';
  p.status.classList.remove('text-brand-pink', 'text-brand-primary');
}

function setStatus(dialog: HTMLDialogElement, message: string, tone: 'neutral' | 'error' | 'ok' = 'neutral') {
  const el = parts(dialog).status;
  el.textContent = message;
  el.classList.toggle('text-brand-pink', tone === 'error');
  el.classList.toggle('text-brand-primary', tone === 'ok');
  el.classList.toggle('text-white/50', tone === 'neutral');
}

async function startRecording(dialog: HTMLDialogElement) {
  const p = parts(dialog);
  const maxSeconds = Number(dialog.dataset.maxSeconds) || 60;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    setStatus(dialog, 'Your browser can’t record audio. Try a recent version of Chrome, Edge, Firefox or Safari.', 'error');
    return;
  }
  discardTake(dialog);
  setStatus(dialog, 'Waiting for microphone permission…');
  p.record.disabled = true;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    p.record.disabled = false;
    setStatus(dialog, 'Microphone access was blocked. Allow it in your browser’s site settings and try again.', 'error');
    return;
  }
  // The dialog may have been closed while the permission prompt was open.
  if (!dialog.open) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  state.stream = stream;
  const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  state.recorder = recorder;
  state.chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) state.chunks.push(e.data);
  };
  recorder.onstop = () => {
    releaseMic();
    const type = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(state.chunks, { type });
    state.recorder = null;
    p.record.disabled = false;
    if (blob.size === 0) {
      setStatus(dialog, 'Nothing was recorded. Check your microphone and try again.', 'error');
      return;
    }
    state.blob = blob;
    state.previewUrl = URL.createObjectURL(blob);
    p.preview.src = state.previewUrl;
    p.preview.classList.remove('hidden');
    p.submit.classList.remove('hidden');
    setStatus(dialog, `Recorded ${fmt(state.durationSeconds)}. Listen back, re-record, or submit.`);
  };

  state.startedAt = performance.now();
  state.recording = true;
  recorder.start(1000);
  p.record.disabled = false;
  p.label.textContent = 'Finish';
  p.time.classList.remove('hidden');
  p.recordIcon.classList.add('hidden');
  p.stopIcon.classList.remove('hidden');
  p.submit.classList.add('hidden');
  setStatus(dialog, 'Recording… speak now.');

  const tick = () => {
    if (!state.recording) return;
    const elapsed = (performance.now() - state.startedAt) / 1000;
    const remaining = Math.max(0, maxSeconds - elapsed);
    p.fill.style.width = `${(remaining / maxSeconds) * 100}%`;
    p.time.textContent = fmt(remaining);
    if (remaining <= 0) {
      stopRecording(dialog);
      return;
    }
    state.raf = requestAnimationFrame(tick);
  };
  p.fill.style.width = '100%';
  state.raf = requestAnimationFrame(tick);
}

function stopRecording(dialog: HTMLDialogElement) {
  if (!state.recording || !state.recorder) return;
  const maxSeconds = Number(dialog.dataset.maxSeconds) || 60;
  state.recording = false;
  cancelAnimationFrame(state.raf);
  state.durationSeconds = Math.min(maxSeconds, Math.max(1, Math.round((performance.now() - state.startedAt) / 1000)));
  const p = parts(dialog);
  p.record.disabled = true; // re-enabled once the recorder has flushed its last chunk
  try {
    state.recorder.stop();
  } catch {
    /* already stopped */
  }
  p.fill.style.width = '100%';
  p.label.textContent = 'Re-Record';
  p.time.classList.add('hidden');
  p.recordIcon.classList.remove('hidden');
  p.stopIcon.classList.add('hidden');
}

async function submitTake(dialog: HTMLDialogElement) {
  if (!state.blob || state.submitting) return;
  const p = parts(dialog);
  state.submitting = true;
  p.submit.disabled = true;
  p.record.disabled = true;
  setStatus(dialog, 'Submitting…');
  try {
    const type = state.blob.type || 'audio/webm';
    const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
    const body = new FormData();
    body.set('intent', 'submit-interview');
    body.set('duration', String(state.durationSeconds));
    body.set('audio', new File([state.blob], `interview.${ext}`, { type }));
    const res = await fetch(dialog.dataset.action ?? '', { method: 'POST', body, headers: { Accept: 'application/json' } });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !json?.ok) throw new Error(json?.error || 'failed');
    discardTake(dialog);
    p.record.disabled = true;
    setStatus(dialog, 'Thanks! Your interview was submitted to the media team.', 'ok');
    // One interview per driver per round: lock the page's microphone button right away.
    document.querySelectorAll<HTMLButtonElement>('[data-open-interview-dialog]').forEach((b) => (b.disabled = true));
    window.setTimeout(() => {
      if (dialog.open) dialog.close();
    }, 1800);
  } catch (err) {
    state.submitting = false;
    p.submit.disabled = false;
    p.record.disabled = false;
    setStatus(dialog, err instanceof Error && err.message !== 'failed' ? err.message : 'Couldn’t submit your interview right now. Please try again.', 'error');
  }
}

function initInterviewRecorder() {
  if (document.body.dataset.interviewInit === 'true') return;
  document.body.dataset.interviewInit = 'true';
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const opener = target.closest<HTMLButtonElement>('[data-open-interview-dialog]');
    if (opener) {
      if (opener.disabled) return;
      const dialog = document.querySelector<HTMLDialogElement>('dialog[data-interview-dialog]');
      if (dialog && !dialog.open) {
        resetDialog(dialog);
        dialog.showModal();
      }
      return;
    }
    const dialog = target.closest<HTMLDialogElement>('dialog[data-interview-dialog]');
    if (target instanceof HTMLDialogElement && target.hasAttribute('data-interview-dialog')) {
      target.close();
      return;
    }
    if (!dialog) return;
    if (target.closest('[data-interview-close]')) {
      dialog.close();
    } else if (target.closest('[data-interview-record]')) {
      if (state.recording) stopRecording(dialog);
      else void startRecording(dialog);
    } else if (target.closest('[data-interview-submit]')) {
      void submitTake(dialog);
    }
  });
  // <dialog> 'close' doesn't bubble, so listen in the capture phase: closing (X, Esc, backdrop) always frees the mic and drops an unsent take.
  document.addEventListener(
    'close',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLDialogElement && t.hasAttribute('data-interview-dialog')) resetDialog(t);
    },
    true
  );
}

initInterviewRecorder();
export {};
