// The built Astro handler, which exists only after `astro build`. A pattern declaration, because TypeScript
// refuses an ambient module with a relative name; tsconfig.worker.json turns allowJs off so this is used.
declare module '*/dist/_worker.js/index.js' {
  const handler: { fetch: (...args: unknown[]) => Promise<Response> };
  export default handler;
}
