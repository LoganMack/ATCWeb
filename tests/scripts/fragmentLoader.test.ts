import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashScroll,
  loadFragment,
  pageTitle,
  redirectHeader,
  reloadOnRedirect,
  type FragmentOptions,
  type LoaderEnv,
} from '../../src/scripts/fragmentLoader';

const ERROR_HTML = '<p class="mt-10 text-white/60">Couldn’t load this page right now — try refreshing.</p>';
const SKELETON = '<div class="animate-pulse"></div>';

const baseOptions: FragmentOptions = {
  label: 'roster',
  logMessage: 'Failed to load roster:',
  errorHtml: ERROR_HTML,
};

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  redirected?: boolean;
  headers?: Record<string, string>;
  body?: string;
}

function fakeResponse({
  ok = true,
  status = 200,
  redirected = false,
  headers = {},
  body = '',
}: FakeResponseInit) {
  return {
    ok,
    status,
    redirected,
    headers: { get: (name: string) => headers[name] ?? null },
    text: vi.fn(async () => body),
  };
}

/** A container with two `.reveal` children whose `classList.add` calls are recorded. */
function fakeContainer(url: string | undefined, onReveal: (cls: string) => void = () => {}) {
  const reveals = [new Set<string>(), new Set<string>()];
  const container = {
    dataset: url === undefined ? {} : { fragmentUrl: url },
    innerHTML: SKELETON,
    querySelectorAll: (selector: string) =>
      selector === '.reveal'
        ? reveals.map((classes) => ({
            classList: {
              add: (cls: string) => {
                classes.add(cls);
                onReveal(cls);
              },
            },
          }))
        : [],
    querySelector: (selector: string) =>
      selector === '[data-page-title]' ? { dataset: { pageTitle: 'Round 3 Results' } } : null,
  };
  return {
    container: container as unknown as HTMLElement,
    dataset: container.dataset as DOMStringMap,
    reveals,
  };
}

function fakeEnv(hash = '') {
  const scrollIntoView = vi.fn();
  const env = {
    location: {
      replace: vi.fn(),
      reload: vi.fn(),
      hash,
      pathname: '/results/42/incidents',
      search: '?view=all',
    },
    history: { replaceState: vi.fn(), state: { from: 'shell' } },
    document: { title: 'Shell title', getElementById: vi.fn(() => ({ scrollIntoView })) },
  };
  return { env, typed: env as unknown as LoaderEnv, scrollIntoView };
}

function fetchReturning(res: ReturnType<typeof fakeResponse>) {
  return vi.fn(async () => res) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('loadFragment', () => {
  it('removes the URL before fetching, inserts the HTML and dispatches once', async () => {
    const { container, dataset, reveals } = fakeContainer('/roster/fragment');
    let urlDuringFetch: string | undefined = 'not read';
    const res = fakeResponse({ body: '<table>roster</table>' });
    const fetchFn = vi.fn(async () => {
      urlDuringFetch = dataset.fragmentUrl;
      return res;
    }) as unknown as typeof fetch;
    const dispatch = vi.fn();

    await loadFragment(container, baseOptions, { fetch: fetchFn, dispatch, env: fakeEnv().typed });

    expect(fetchFn).toHaveBeenCalledWith('/roster/fragment');
    expect(urlDuringFetch).toBeUndefined();
    expect(dataset.fragmentUrl).toBeUndefined();
    expect(container.innerHTML).toBe('<table>roster</table>');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(reveals.every((classes) => classes.size === 0)).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('marks every .reveal descendant visible when reveal is on', async () => {
    const { container, reveals } = fakeContainer('/home/fragment');
    const fetchFn = fetchReturning(fakeResponse({ body: '<section class="reveal"></section>' }));

    await loadFragment(
      container,
      { ...baseOptions, reveal: true },
      { fetch: fetchFn, dispatch: vi.fn(), env: fakeEnv().typed },
    );

    expect(reveals.map((classes) => [...classes])).toEqual([['is-visible'], ['is-visible']]);
  });

  it('runs afterInsert, then reveal, then dispatch, then afterDispatch (with the title and hash-scroll built-ins)', async () => {
    const events: string[] = [];
    const { container } = fakeContainer('/results/42/incidents/fragment', () => events.push('reveal'));
    const { env, typed, scrollIntoView } = fakeEnv('#reported-incidents');
    const fetchFn = fetchReturning(fakeResponse({ body: '<div data-page-title="Round 3 Results"></div>' }));
    const options: FragmentOptions = {
      ...baseOptions,
      reveal: true,
      afterInsert: (c, e) => {
        events.push('afterInsert');
        pageTitle(c, e);
      },
      afterDispatch: (c, e) => {
        events.push('afterDispatch');
        hashScroll(c, e);
      },
    };

    await loadFragment(container, options, {
      fetch: fetchFn,
      dispatch: () => events.push('dispatch'),
      env: typed,
    });

    // Two .reveal children, so 'reveal' is recorded twice.
    expect(events).toEqual(['afterInsert', 'reveal', 'reveal', 'dispatch', 'afterDispatch']);
    expect(env.document.title).toBe('Round 3 Results · Alpha Touring Challenge');
    expect(env.document.getElementById).toHaveBeenCalledWith('reported-incidents');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(env.history.replaceState).toHaveBeenCalledWith(
      { from: 'shell' },
      '',
      '/results/42/incidents?view=all',
    );
  });

  it('keeps the URL and skips the dispatch when clearUrl and dispatch are false', async () => {
    const { container, dataset } = fakeContainer('/champions/fragment?class=pro');
    const fetchFn = fetchReturning(fakeResponse({ body: '<ol>champions</ol>' }));
    const dispatch = vi.fn();

    await loadFragment(
      container,
      { ...baseOptions, clearUrl: false, dispatch: false },
      { fetch: fetchFn, dispatch, env: fakeEnv().typed },
    );

    expect(dataset.fragmentUrl).toBe('/champions/fragment?class=pro');
    expect(container.innerHTML).toBe('<ol>champions</ol>');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('redirectHeader replaces the location before the OK check and never inserts the body', async () => {
    const { container } = fakeContainer('/results/999999999/fragment');
    const { env, typed } = fakeEnv();
    const res = fakeResponse({
      ok: false,
      status: 404,
      headers: { 'X-Redirect-To': '/results' },
      body: 'nope',
    });
    const dispatch = vi.fn();

    await loadFragment(
      container,
      { ...baseOptions, label: 'race', logMessage: 'Failed to load race:', checkResponse: redirectHeader },
      { fetch: fetchReturning(res), dispatch, env: typed },
    );

    expect(env.location.replace).toHaveBeenCalledWith('/results');
    expect(res.text).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    // Same catch as today: the 'redirecting' error is logged and the error HTML shown while the page leaves.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe('Failed to load race:');
    expect((consoleError.mock.calls[0][1] as Error).message).toBe('redirecting');
    expect(container.innerHTML).toBe(ERROR_HTML);
  });

  it('reloadOnRedirect reloads and leaves the container untouched while the load never settles', async () => {
    const { container } = fakeContainer('/admin/fragment');
    const { env, typed } = fakeEnv();
    const res = fakeResponse({ redirected: true, body: '<html>login page</html>' });
    const dispatch = vi.fn();
    let settled = false;

    void loadFragment(
      container,
      { ...baseOptions, checkResponse: reloadOnRedirect },
      { fetch: fetchReturning(res), dispatch, env: typed },
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(env.location.reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(res.text).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe(SKELETON);
    expect(dispatch).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('shows the error HTML and logs a labelled error for an HTTP error', async () => {
    const { container } = fakeContainer('/roster/fragment');
    const res = fakeResponse({ ok: false, status: 503, body: 'Service Unavailable' });
    const dispatch = vi.fn();

    await loadFragment(container, baseOptions, {
      fetch: fetchReturning(res),
      dispatch,
      env: fakeEnv().typed,
    });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe('Failed to load roster:');
    expect((consoleError.mock.calls[0][1] as Error).message).toBe('roster fragment request failed (503)');
    expect(res.text).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe(ERROR_HTML);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('shows the error HTML and logs the original error for a network failure', async () => {
    const { container } = fakeContainer('/roster/fragment');
    const networkError = new TypeError('Failed to fetch');
    const fetchFn = vi.fn(async () => {
      throw networkError;
    }) as unknown as typeof fetch;
    const dispatch = vi.fn();

    await loadFragment(container, baseOptions, { fetch: fetchFn, dispatch, env: fakeEnv().typed });

    expect(consoleError).toHaveBeenCalledWith('Failed to load roster:', networkError);
    expect(container.innerHTML).toBe(ERROR_HTML);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing when the container has no fragment URL', async () => {
    const { container } = fakeContainer(undefined);
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const dispatch = vi.fn();

    await loadFragment(container, baseOptions, { fetch: fetchFn, dispatch, env: fakeEnv().typed });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe(SKELETON);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does nothing when the container is missing', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const dispatch = vi.fn();

    await expect(
      loadFragment(null, baseOptions, { fetch: fetchFn, dispatch, env: fakeEnv().typed }),
    ).resolves.toBeUndefined();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
