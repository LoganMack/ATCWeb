// Shell-then-skeleton loader shared by every page shell: the shell paints a
// skeleton at once, then this fetches the page's fragment route (the expensive
// data work) and drops the HTML in. A <script> inside fetched HTML never runs,
// so the page's own scripts live in the shell and rebind on the re-dispatched
// astro:page-load.

/** The parts of `window` the loader and its built-in hooks touch, injectable for tests. */
export interface LoaderEnv {
  location: Pick<Location, 'replace' | 'reload' | 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'state'>;
  document: Pick<Document, 'title' | 'getElementById'>;
}

export interface FragmentOptions {
  /** Text before "fragment request failed" in the error thrown for a non-OK response. */
  label: string;
  /** Exact `console.error` message on failure. */
  logMessage: string;
  /** Exact HTML put in the container on failure. */
  errorHtml: string;
  /** Mark `.reveal` descendants visible: reveal.ts only observes what existed at the real page load. */
  reveal?: boolean;
  /** Default true. Deleting the URL stops the re-dispatched astro:page-load from fetching it again. */
  clearUrl?: boolean;
  /** Default true. Re-dispatch astro:page-load so sitewide and page scripts bind the new content. */
  dispatch?: boolean;
  /** Runs before the OK check; it may redirect, reload or throw, which stops the load. */
  checkResponse?: (res: Response, env: LoaderEnv) => void | Promise<never>;
  /** Runs right after the HTML is inserted, before the reveal. */
  afterInsert?: (container: HTMLElement, env: LoaderEnv) => void;
  /** Runs after the dispatch. */
  afterDispatch?: (container: HTMLElement, env: LoaderEnv) => void;
}

export interface LoaderDeps {
  fetch?: typeof fetch;
  dispatch?: () => void;
  env?: LoaderEnv;
}

/** Unknown round (or a hidden report): the fragment answers with X-Redirect-To instead of redirecting. */
export const redirectHeader: NonNullable<FragmentOptions['checkResponse']> = (res, env) => {
  const redirectTo = res.headers.get('X-Redirect-To');
  if (redirectTo) {
    env.location.replace(redirectTo);
    throw new Error('redirecting');
  }
};

/**
 * If the session expired while the page sat open, middleware answers the
 * fragment request with a 302 to /login, which fetch() follows silently, so the
 * "successful" body would be the login page. Reload instead, so middleware
 * redirects the real page; the never-settling promise stops anything flashing.
 */
export const reloadOnRedirect: NonNullable<FragmentOptions['checkResponse']> = (res, env) => {
  if (res.redirected) {
    env.location.reload();
    return new Promise<never>(() => {});
  }
};

/** Takes the page title from the fragment's `[data-page-title]` marker. */
export const pageTitle: NonNullable<FragmentOptions['afterInsert']> = (container, env) => {
  const title = container.querySelector<HTMLElement>('[data-page-title]')?.dataset.pageTitle;
  if (title) env.document.title = `${title} · Alpha Touring Challenge`;
};

/**
 * The browser's own jump to #hash happened before this content existed, so do
 * it now, then drop the hash so a later refresh doesn't jump back here.
 */
export const hashScroll: NonNullable<FragmentOptions['afterDispatch']> = (_container, env) => {
  if (!env.location.hash) return;
  try {
    env.document.getElementById(decodeURIComponent(env.location.hash.slice(1)))?.scrollIntoView();
  } catch {
    // Malformed hash: not worth losing the page over.
  }
  env.history.replaceState(env.history.state, '', env.location.pathname + env.location.search);
};

function defaultEnv(): LoaderEnv {
  return { location: window.location, history: window.history, document };
}

function defaultDispatch(): void {
  document.dispatchEvent(new Event('astro:page-load'));
}

/** Loads one fragment into `container`. Does nothing without a container or a `data-fragment-url`. */
export async function loadFragment(
  container: HTMLElement | null | undefined,
  options: FragmentOptions,
  deps: LoaderDeps = {},
): Promise<void> {
  const url = container?.dataset.fragmentUrl;
  if (!container || !url) return;
  if (options.clearUrl !== false) delete container.dataset.fragmentUrl;
  const env = deps.env ?? defaultEnv();

  try {
    const res = await (deps.fetch ? deps.fetch(url) : fetch(url));
    const check = options.checkResponse?.(res, env);
    if (check) await check;
    if (!res.ok) throw new Error(`${options.label} fragment request failed (${res.status})`);
    container.innerHTML = await res.text();
    options.afterInsert?.(container, env);
    if (options.reveal) {
      container.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-visible'));
    }
    if (options.dispatch !== false) (deps.dispatch ?? defaultDispatch)();
    options.afterDispatch?.(container, env);
  } catch (err) {
    console.error(options.logMessage, err);
    container.innerHTML = options.errorHtml;
  }
}

/** Loads the fragment for `selector` on every astro:page-load, soft navigations included. */
export function bindFragment(selector: string, options: FragmentOptions): void {
  document.addEventListener('astro:page-load', () => {
    void loadFragment(document.querySelector<HTMLElement>(selector), options);
  });
}
