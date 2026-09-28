import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertOk,
  createStellarBillClient,
  safeParseErrorBody,
  StellarBillConfigError,
  StellarBillError,
} from '../src/index.js';

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
  /** Headers extracted from the Request object (openapi-fetch passes Request as input). */
  inputHeaders: Record<string, string>;
  /** Headers extracted from init.headers (fallback if openapi-fetch passes a URL). */
  initHeaders: Record<string, string>;
};

function toUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function headersFromInit(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init?.headers) return out;
  new Headers(init.headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Headers as observed by the mock fetch (covers both Request input + URL+init input). */
function callHeaders(call: FetchCall): Record<string, string> {
  return { ...call.initHeaders, ...call.inputHeaders };
}

function mockFetchOnce(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const status = init.status ?? 200;
  const contentType = init.contentType ?? 'application/json';
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const res = new Response(text, { status, headers: { 'content-type': contentType } });
  const fetch: typeof globalThis.fetch = vi.fn(async (input, initArg) => {
    const inputHeaders: Record<string, string> = {};
    if (input instanceof Request) {
      input.headers.forEach((value, key) => {
        inputHeaders[key.toLowerCase()] = value;
      });
    }
    calls.push({
      url: toUrl(input),
      init: initArg as RequestInit | undefined,
      inputHeaders,
      initHeaders: headersFromInit(initArg as RequestInit | undefined),
    });
    return res;
  });
  return { fetch, calls };
}

function makeFetchForResponse(response: Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, initArg) => {
    const inputHeaders: Record<string, string> = {};
    if (input instanceof Request) {
      input.headers.forEach((value, key) => {
        inputHeaders[key.toLowerCase()] = value;
      });
    }
    calls.push({
      url: toUrl(input),
      init: initArg as RequestInit | undefined,
      inputHeaders,
      initHeaders: headersFromInit(initArg as RequestInit | undefined),
    });
    return response;
  });
  return { fetch, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStellarBillClient - configuration', () => {
  it('throws StellarBillConfigError on missing baseUrl', () => {
    expect(() => createStellarBillClient({ baseUrl: undefined as unknown as string })).toThrow(
      StellarBillConfigError,
    );
    expect(() => createStellarBillClient({ baseUrl: '' })).toThrow(/non-empty/);
    expect(() => createStellarBillClient({ baseUrl: '   ' })).toThrow(/non-empty/);
    expect(() => createStellarBillClient({ baseUrl: 'not-a-url' })).toThrow(/not a valid URL/);
  });

  it('warns when baseUrl is http and not localhost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetch } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({ baseUrl: 'http://example.com', fetch });
    await sdk.getHealth();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Insecure baseUrl'));
  });

  it('does not warn when baseUrl is https', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetch } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await sdk.getHealth();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when baseUrl is http on localhost/127.0.0.1', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetch: f1 } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk1 = createStellarBillClient({ baseUrl: 'http://localhost:8080', fetch: f1 });
    await sdk1.getHealth();
    const { fetch: f2 } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk2 = createStellarBillClient({ baseUrl: 'http://127.0.0.1:8080', fetch: f2 });
    await sdk2.getHealth();
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws StellarBillConfigError when no fetch implementation is available', () => {
    const saved = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      expect(() => createStellarBillClient({ baseUrl: 'https://api.example.com' })).toThrow(/No fetch/);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = saved;
    }
  });

  it('accepts an explicit fetch option', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await sdk.getHealth();
    expect(calls).toHaveLength(1);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com///', fetch });
    await sdk.getHealth();
    expect(calls[0]!.url.startsWith('https://api.example.com/api/health')).toBe(true);
    expect(calls[0]!.url).not.toContain('///api');
  });

  it('strips trailing slashes from baseUrl including port variants', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({ baseUrl: 'http://127.0.0.1:8080/', fetch });
    await sdk.getHealth();
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/api/health');
  });
});

describe('createStellarBillClient - headers and auth', () => {
  it('injects Authorization Bearer header when token is set', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      token: '  my-token  ',
      fetch,
    });
    await sdk.getHealth();
    const headers = callHeaders(calls[0]!);
    expect(headers['authorization']).toBe('Bearer my-token');
  });

  it('drops malformed token (whitespace inside)', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      token: 'bad token',
      fetch,
    });
    await sdk.getHealth();
    const headers = callHeaders(calls[0]!);
    expect(headers['authorization']).toBeUndefined();
  });

  it('setToken rotates the token; subsequent calls use the new one', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', token: 'old', fetch });
    expect(sdk.getToken()).toBe('old');
    sdk.setToken('new');
    expect(sdk.getToken()).toBe('new');
    sdk.setToken(undefined);
    expect(sdk.getToken()).toBeUndefined();
    await sdk.getHealth();
    const headers = callHeaders(calls[0]!);
    expect(headers['authorization']).toBeUndefined();
  });

  it('attaches user-agent and static headers on every request', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      headers: { 'X-Custom-Trace': 'abc' },
      fetch,
    });
    await sdk.getHealth();
    const headers = callHeaders(calls[0]!);
    expect(headers['user-agent']).toMatch(/^@stellabill\/sdk\//);
    expect(headers['x-custom-trace']).toBe('abc');
  });

  it('skips empty-valued static headers', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      headers: { 'X-Empty': '', 'X-Keep': 'v' },
      fetch,
    });
    await sdk.getHealth();
    const headers = callHeaders(calls[0]!);
    expect(headers['x-empty']).toBeUndefined();
    expect(headers['x-keep']).toBe('v');
  });

  it('rejects caller-supplied Authorization header (auth bypass prevention)', async () => {
    const { fetch, calls } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      headers: { Authorization: 'Bearer attacker-controlled' },
      fetch,
    });
    await sdk.getHealth();
    const headers = callHeaders(calls[0]!);
    expect(headers['authorization']).toBeUndefined();
  });

  it('runs user-supplied middleware around the auth middleware', async () => {
    const order: string[] = [];
    let bearerSeen = false;
    const res = new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    const inner = makeFetchForResponse(res);
    const trackingFetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      order.push('fetch');
      return inner.fetch(input, init as RequestInit | undefined);
    });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      token: 'tok',
      fetch: trackingFetch,
      middleware: [
        {
          async onRequest({ request }) {
            order.push('user-mw-before');
            // Request must already carry Bearer by the time user middleware runs.
            bearerSeen = request.headers.get('authorization') === 'Bearer tok';
            return request;
          },
          async onResponse({ response }) {
            order.push('user-mw-after');
            return response;
          },
        },
      ],
    });
    await sdk.getHealth();
    expect(order).toEqual(['user-mw-before', 'fetch', 'user-mw-after']);
    expect(bearerSeen).toBe(true);
  });
});

describe('createStellarBillClient - typed wrappers (success paths)', () => {
  it('getHealth returns parsed data', async () => {
    const { fetch } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.getHealth();
    expect(r.status).toBe(200);
    expect(r.error).toBeUndefined();
    expect(r.data?.status).toBe('ok');
    expect(r.requestMethod).toBe('GET');
    expect(r.requestUrl).toContain('/api/health');
  });

  it('listPlans forwards cursor and limit', async () => {
    const { fetch, calls } = mockFetchOnce({ plans: [{ id: 'p1' }], pagination: { has_more: false } });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await sdk.listPlans({ cursor: 'c', limit: 25 });
    expect(calls[0]!.url).toContain('/api/v1/plans');
    expect(calls[0]!.url).toContain('cursor=c');
    expect(calls[0]!.url).toContain('limit=25');
  });

  it('listSubscriptions forwards cursor and limit', async () => {
    const { fetch, calls } = mockFetchOnce({ subscriptions: [], pagination: { has_more: false } });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await sdk.listSubscriptions({ cursor: 'c', limit: 25 });
    expect(calls[0]!.url).toContain('/api/subscriptions');
    expect(calls[0]!.url).toContain('cursor=c');
    expect(calls[0]!.url).toContain('limit=25');
  });

  it('listSubscriptions omits undefined query params', async () => {
    const { fetch, calls } = mockFetchOnce({ subscriptions: [], pagination: { has_more: false } });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await sdk.listSubscriptions();
    expect(calls[0]!.url).toContain('/api/subscriptions');
    expect(calls[0]!.url).not.toContain('cursor=');
    expect(calls[0]!.url).not.toContain('limit=');
  });

  it('getSubscription throws on empty id', async () => {
    const { fetch } = mockFetchOnce({ id: 'x', plan_id: 'p', customer: 'c', status: 'a', amount: '1', interval: 'm' });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await expect(sdk.getSubscription('')).rejects.toBeInstanceOf(StellarBillConfigError);
  });

  it('getSubscription preserves special characters in the path', async () => {
    const { fetch, calls } = mockFetchOnce({ id: 'sub/with spaces', plan_id: 'p' });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await sdk.getSubscription('sub/with spaces');
    expect(calls[0]!.url).toContain('/api/subscriptions/');
    expect(decodeURIComponent(calls[0]!.url)).toContain('/api/subscriptions/sub/with spaces');
  });

  it('inspectIdempotencyKey rejects empty key', async () => {
    const { fetch } = mockFetchOnce({});
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await expect(sdk.inspectIdempotencyKey('')).rejects.toBeInstanceOf(StellarBillConfigError);
  });

  it('inspectIdempotencyKey rejects key longer than 255 chars', async () => {
    const { fetch } = mockFetchOnce({});
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    await expect(sdk.inspectIdempotencyKey('x'.repeat(256))).rejects.toBeInstanceOf(
      StellarBillConfigError,
    );
  });

  it('inspectIdempotencyKey returns parsed record on success', async () => {
    const { fetch } = mockFetchOnce({
      key: 'abc',
      used_at: '2026-01-01T00:00:00Z',
      expires_at: '2026-01-02T00:00:00Z',
      status_code: 201,
      request_fingerprint: 'fp',
    });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.inspectIdempotencyKey('abc');
    expect(r.data?.status_code).toBe(201);
  });

  it('exposes version, raw client, and token accessors', () => {
    const { fetch } = mockFetchOnce({});
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', token: 't', fetch });
    expect(sdk.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof sdk.raw).toBe('object');
    expect(sdk.getToken()).toBe('t');
  });

  it('listPlans throws when throwOnError + non-2xx', async () => {
    const { fetch } = mockFetchOnce({ error: 'Bad Request', message: 'bad', code: 'x' }, { status: 400 });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      throwOnError: true,
      fetch,
    });
    await expect(sdk.listPlans()).rejects.toMatchObject({ status: 400 });
  });

  it('listSubscriptions returns parsed data on success', async () => {
    const { fetch } = mockFetchOnce({ subscriptions: [], pagination: { has_more: false } });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.listSubscriptions();
    expect(r.data?.subscriptions.length).toBe(0);
  });

  it('getSubscription throws when throwOnError + non-2xx', async () => {
    const { fetch } = mockFetchOnce({ error: 'Not Found', message: 'gone', code: 'missing' }, { status: 404 });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      throwOnError: true,
      fetch,
    });
    await expect(sdk.getSubscription('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('inspectIdempotencyKey throws when throwOnError + non-2xx', async () => {
    const { fetch } = mockFetchOnce(
      { error: 'Unauthorized', message: 'auth', code: 'auth_unauthorized' },
      { status: 401 },
    );
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      throwOnError: true,
      fetch,
    });
    await expect(sdk.inspectIdempotencyKey('abc')).rejects.toMatchObject({ status: 401 });
  });
});

describe('createStellarBillClient - error paths (non-2xx)', () => {
  it('returns parsed error in result when not throwOnError', async () => {
    const { fetch } = mockFetchOnce(
      { error: 'Bad Request', message: 'Invalid cursor', code: 'invalid_cursor' },
      { status: 400 },
    );
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.listPlans({ limit: 999 });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe('invalid_cursor');
    expect(r.data).toBeUndefined();
  });

  it('throws StellarBillError when throwOnError: true and status is non-2xx', async () => {
    const { fetch } = mockFetchOnce(
      { error: 'Not Found', message: 'gone', code: 'missing' },
      { status: 404 },
    );
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      throwOnError: true,
      fetch,
    });
    let caught: unknown;
    try {
      await sdk.getSubscription('missing-id');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StellarBillError);
    const e = caught as StellarBillError;
    expect(e.status).toBe(404);
    expect(e.requestMethod).toBe('GET');
    expect(e.requestUrl).toContain('/api/subscriptions/');
    expect(e.body?.code).toBe('missing');
  });

  it('non-2xx with non-JSON content returns undefined error body', async () => {
    const { fetch } = mockFetchOnce('<html>nope</html>', { status: 500, contentType: 'text/html' });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      throwOnError: true,
      fetch,
    });
    await expect(sdk.getHealth()).rejects.toMatchObject({
      status: 500,
      body: undefined,
    });
  });
});

describe('createStellarBillClient - warning path coverage', () => {
  it('does not crash when console is fully unavailable', async () => {
    const { fetch } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const savedConsole = globalThis.console;
    (globalThis as { console?: Console }).console = undefined as unknown as Console;
    try {
      const sdk = createStellarBillClient({ baseUrl: 'http://example.com', fetch });
      const r = await sdk.getHealth();
      expect(r.status).toBe(200);
    } finally {
      (globalThis as { console?: Console }).console = savedConsole;
    }
  });

  it('skips warning when console.warn is missing', async () => {
    const { fetch } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const savedWarn = console.warn;
    (console as unknown as { warn?: () => void }).warn = undefined;
    try {
      const sdk = createStellarBillClient({ baseUrl: 'http://example.com', fetch });
      const r = await sdk.getHealth();
      expect(r.status).toBe(200);
    } finally {
      console.warn = savedWarn;
    }
  });
});

describe('assertOk', () => {
  it('returns data when 2xx and data present', async () => {
    const { fetch } = mockFetchOnce({ status: 'ok', service: 'stellarbill-backend' });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.getHealth();
    const data = await assertOk(r);
    expect(data.status).toBe('ok');
  });

  it('throws when 2xx but body has no parsed data', async () => {
    // openapi-fetch always calls res.json(), so the SDK cannot produce
    // a `data === undefined` with status 200. Construct the SdkResult
    // inline to exercise the assertOk branch directly.
    const r = {
      data: undefined,
      error: undefined,
      status: 200,
      response: new Response('{}', { status: 200 }),
      requestMethod: 'GET',
      requestUrl: '/test',
    };
    await expect(assertOk(r)).rejects.toThrow(/empty body/);
  });

  it('throws StellarBillError on non-2xx', async () => {
    const { fetch } = mockFetchOnce({ error: 'oops' }, { status: 500 });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.getHealth();
    await expect(assertOk(r)).rejects.toBeInstanceOf(StellarBillError);
    await expect(assertOk(r)).rejects.toMatchObject({ status: 500 });
  });
});

describe('safeParseErrorBody', () => {
  it('returns undefined when content-type is missing', async () => {
    const r = new Response('{}', { status: 400 });
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });

  it('returns undefined when content-type is not JSON', async () => {
    const r = new Response('oops', { status: 400, headers: { 'content-type': 'text/plain' } });
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });

  it('returns undefined when body is empty', async () => {
    const r = new Response('', { status: 400, headers: { 'content-type': 'application/json' } });
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });

  it('parses a valid error body', async () => {
    const r = new Response(JSON.stringify({ message: 'bad', code: 'x' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    expect(await safeParseErrorBody(r)).toEqual({ message: 'bad', code: 'x' });
  });

  it('returns undefined on invalid JSON', async () => {
    const r = new Response('not-json', { status: 400, headers: { 'content-type': 'application/json' } });
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });

  it('returns undefined when parsed value is a string', async () => {
    const r = new Response('"a string"', { status: 400, headers: { 'content-type': 'application/json' } });
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });

  it('returns undefined when parsed value is an array', async () => {
    const r = new Response('[1,2,3]', { status: 400, headers: { 'content-type': 'application/json' } });
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });

  it('returns undefined when parsed value is null', async () => {
    const r = new Response('null', { status: 400, headers: { 'content-type': 'application/json' } });
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });

  it('returns undefined when status 200 with empty body and non-json content', async () => {
    const r = new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });

  it('returns undefined when res.text() throws', async () => {
    const r = new Response('ok', { status: 400, headers: { 'content-type': 'application/json' } });
    vi.spyOn(r, 'text').mockRejectedValue(new Error('boom'));
    expect(await safeParseErrorBody(r)).toBeUndefined();
  });
});

describe('Token integration with createStellarBillClient', () => {
  it('handles basic TokenHolder behavior via the SDK', async () => {
    const { fetch } = mockFetchOnce({});
    const sdk1 = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    expect(sdk1.getToken()).toBeUndefined();
    sdk1.setToken('a');
    expect(sdk1.getToken()).toBe('a');
    sdk1.setToken(undefined);
    expect(sdk1.getToken()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// safeParseErrorBody – accepted-input branch (client.ts:116)
//
// Line 116: `return parsed as ApiErrorBody;`
// Guard:    `parsed && typeof parsed === 'object' && !Array.isArray(parsed)`
//
// These tests exercise the branch both directly (unit) and end-to-end through
// the SDK pipeline so the SDK contract is verifiable and deterministic.
// ---------------------------------------------------------------------------

describe('safeParseErrorBody – accepted-input branch (line 116)', () => {
  // -- Direct unit tests for the accepted-input branch ---------------------

  it('returns the full ApiErrorBody object when all three fields are present', async () => {
    const body = { error: 'Bad Request', message: 'Invalid cursor', code: 'invalid_cursor' };
    const r = new Response(JSON.stringify(body), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    const result = await safeParseErrorBody(r);
    // Branch accepted the input → result must equal the original object shape.
    expect(result).toEqual(body);
    expect(result?.error).toBe('Bad Request');
    expect(result?.message).toBe('Invalid cursor');
    expect(result?.code).toBe('invalid_cursor');
  });

  it('returns the object when only the error field is present (partial ApiErrorBody)', async () => {
    const body = { error: 'Unauthorized' };
    const r = new Response(JSON.stringify(body), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const result = await safeParseErrorBody(r);
    expect(result).toEqual({ error: 'Unauthorized' });
    expect(result?.code).toBeUndefined();
    expect(result?.message).toBeUndefined();
  });

  it('returns the object when only the message field is present', async () => {
    const body = { message: 'Resource not found' };
    const r = new Response(JSON.stringify(body), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
    const result = await safeParseErrorBody(r);
    expect(result).toEqual({ message: 'Resource not found' });
  });

  it('preserves extra unknown fields that are not part of ApiErrorBody', async () => {
    // The `as ApiErrorBody` cast does not strip extra properties — they must
    // remain observable so callers who inspect the raw object are not surprised.
    const body = { error: 'Gone', message: 'deleted', code: 'soft_deleted', detail: 'removed at t0' };
    const r = new Response(JSON.stringify(body), {
      status: 410,
      headers: { 'content-type': 'application/json' },
    });
    const result = await safeParseErrorBody(r);
    expect(result).toEqual(body);
    expect((result as Record<string, unknown>)['detail']).toBe('removed at t0');
  });

  it('handles a deeply nested error object (accepted as-is, no recursion guard)', async () => {
    const body = { error: 'Validation failed', nested: { inner: true } };
    const r = new Response(JSON.stringify(body), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
    const result = await safeParseErrorBody(r);
    expect(result?.error).toBe('Validation failed');
    expect((result as Record<string, unknown>)['nested']).toEqual({ inner: true });
  });

  it('accepts an empty object {} and returns it (not null, not array, is object)', async () => {
    const r = new Response('{}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
    const result = await safeParseErrorBody(r);
    expect(result).toEqual({});
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  // -- End-to-end pipeline tests (accepted-input flows through full SDK) ---

  it('propagates the parsed error body in the SDK result envelope (non-throwOnError)', async () => {
    // Exercises the full path: fetch → openapi-fetch → wrap() → SdkResult
    // with a valid JSON object response body that hits line 116.
    const errorBody = { error: 'Not Found', message: 'subscription gone', code: 'subscription_not_found' };
    const { fetch } = mockFetchOnce(errorBody, { status: 404 });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.getSubscription('sub-xyz');
    expect(r.status).toBe(404);
    // The error field must be the parsed object (not undefined, not a string).
    expect(r.error).toEqual(errorBody);
    expect(r.error?.code).toBe('subscription_not_found');
    expect(r.error?.message).toBe('subscription gone');
    expect(r.error?.error).toBe('Not Found');
    expect(r.data).toBeUndefined();
  });

  it('propagates parsed error body on 400 from listPlans', async () => {
    const errorBody = { error: 'Bad Request', message: 'limit must be > 0', code: 'invalid_limit' };
    const { fetch } = mockFetchOnce(errorBody, { status: 400 });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.listPlans({ limit: -1 });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe('invalid_limit');
    expect(r.error?.message).toBe('limit must be > 0');
    expect(r.data).toBeUndefined();
  });

  it('propagates parsed error body on 401 from inspectIdempotencyKey', async () => {
    const errorBody = { error: 'Unauthorized', message: 'token missing', code: 'auth_required' };
    const { fetch } = mockFetchOnce(errorBody, { status: 401 });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.inspectIdempotencyKey('idem-key-abc');
    expect(r.status).toBe(401);
    expect(r.error).toEqual(errorBody);
    expect(r.data).toBeUndefined();
  });

  it('parsed error body lands in StellarBillError.body when throwOnError: true', async () => {
    // This verifies the accepted-input (line 116) object reaches the thrown
    // error's .body property intact through the full SDK error path.
    const errorBody = { error: 'Forbidden', message: 'wrong owner', code: 'ownership_violation' };
    const { fetch } = mockFetchOnce(errorBody, { status: 403 });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      throwOnError: true,
      fetch,
    });
    let caught: unknown;
    try {
      await sdk.getSubscription('sub-forbidden');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StellarBillError);
    const e = caught as StellarBillError;
    expect(e.status).toBe(403);
    // The body must be the fully parsed object that came through line 116.
    expect(e.body).toEqual(errorBody);
    expect(e.body?.code).toBe('ownership_violation');
    expect(e.body?.message).toBe('wrong owner');
    expect(e.body?.error).toBe('Forbidden');
    expect(e.requestMethod).toBe('GET');
    expect(e.requestUrl).toContain('/api/subscriptions/');
  });

  it('assertOk throws with the accepted-input error body available on the error', async () => {
    const errorBody = { error: 'Gone', message: 'soft deleted', code: 'soft_deleted' };
    const { fetch } = mockFetchOnce(errorBody, { status: 410 });
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    const r = await sdk.getSubscription('deleted-id');
    // Confirm the SDK result carries the parsed body before assertOk.
    expect(r.error).toEqual(errorBody);
    // assertOk must re-throw a StellarBillError whose .body matches.
    let caught: unknown;
    try {
      await assertOk(r);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StellarBillError);
    const e = caught as StellarBillError;
    expect(e.status).toBe(410);
    expect(e.body).toEqual(errorBody);
    expect(e.body?.code).toBe('soft_deleted');
  });

  it('request metadata (method, url) is preserved alongside the parsed error body', async () => {
    // End-to-end: verify the full SdkResult envelope fields are consistent
    // when line 116 branch is taken.
    const errorBody = { error: 'Internal Server Error', message: 'unexpected', code: 'server_error' };
    const { fetch } = mockFetchOnce(errorBody, { status: 500 });
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      token: 'valid-token',
      fetch,
    });
    const r = await sdk.listSubscriptions();
    expect(r.status).toBe(500);
    expect(r.requestMethod).toBe('GET');
    expect(r.requestUrl).toContain('/api/subscriptions');
    expect(r.response).toBeInstanceOf(Response);
    expect(r.error).toEqual(errorBody);
    expect(r.data).toBeUndefined();
  });

  it('content-type with charset still triggers the accepted-input branch', async () => {
    // Ensures `contentType.includes('application/json')` matches
    // 'application/json; charset=utf-8' so the branch is reachable.
    const body = { error: 'Conflict', message: 'duplicate key', code: 'duplicate' };
    const r = new Response(JSON.stringify(body), {
      status: 409,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    const result = await safeParseErrorBody(r);
    expect(result).toEqual(body);
    expect(result?.code).toBe('duplicate');
  });
});
