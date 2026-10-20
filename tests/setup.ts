// Tests call pure helpers only; any attempt to reach Supabase (or anything else) fails loudly.
globalThis.fetch = (() => {
  throw new Error('network is blocked in tests');
}) as typeof fetch;
