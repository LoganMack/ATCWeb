// The Worker entry (wrangler.jsonc `main`): Astro's built handler for requests, the notifications run for the
// cron. Type-checked only after `astro build` (tsconfig.worker.json); nothing else imports this file.
import astro from '../../dist/_worker.js/index.js';
import { runNotifications } from '../lib/notifications/run';
import { createWorker } from '../lib/notifications/worker';

export default createWorker(astro, runNotifications);
