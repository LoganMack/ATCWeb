/**
 * Discord/Redbubble URLs, read from the runtime binding first like `resolveSupabaseEnv`: Nav and Footer
 * render per request on the Worker, where `import.meta.env.PUBLIC_*` is undefined.
 */

export interface SiteLinks {
  discordUrl: string;
  redbubbleUrl: string;
}

export function resolveSiteLinks(locals: App.Locals): SiteLinks {
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, string> } } | undefined)?.runtime?.env;
  return {
    discordUrl: runtimeEnv?.PUBLIC_DISCORD_URL || import.meta.env.PUBLIC_DISCORD_URL,
    redbubbleUrl: runtimeEnv?.PUBLIC_REDBUBBLE_URL || import.meta.env.PUBLIC_REDBUBBLE_URL,
  };
}
