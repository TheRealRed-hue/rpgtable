// Shared helper used by every Supabase client we create (browser, server/admin,
// and the per-request auth middleware client). Previously this exact logic was
// copy-pasted verbatim in three files — any fix had to be applied three times.
// Keep this file dependency-free (no imports from './client' etc.) so it can be
// safely imported from both client and server bundles.

/** New-style Supabase API keys are opaque strings, not bearer JWTs. */
export function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

/**
 * HTTP status codes that mean "the edge/proxy couldn't complete the request",
 * not "the server processed it and rejected it". Cloudflare returns these
 * (520-524) when it can't reach or gets no timely response from the origin —
 * i.e. the request never actually ran server-side, so retrying is safe
 * regardless of HTTP method.
 */
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with a little jitter so retries from multiple concurrent requests don't sync up. */
function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

/**
 * Wraps `fetch` so the given Supabase key is always sent as the `apikey`
 * header, and — for the new opaque key format — is never duplicated onto the
 * `Authorization` header as if it were a bearer JWT.
 *
 * Also retries transient failures with exponential backoff:
 *  - Network-level failures (`TypeError: Failed to fetch`), which is what a
 *    browser reports for a Cloudflare 522 too, since a 522 response carries
 *    no CORS headers and gets surfaced as a blocked/failed fetch instead of
 *    its real status.
 *  - Explicit 5xx/52x edge status codes, on the rare occasions the browser
 *    *does* get to see the real status.
 * Both cases mean the origin never processed the request, so retrying is
 * safe even for POST/PATCH/DELETE.
 */
export function createSupabaseFetch(
  supabaseKey: string,
  options?: { maxRetries?: number; baseDelayMs?: number },
): typeof fetch {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  return async (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (isNewSupabaseApiKey(supabaseKey)) {
      if (headers.get("Authorization") === `Bearer ${supabaseKey}`) {
        headers.delete("Authorization");
      }
      if (headers.get("authorization") === `Bearer ${supabaseKey}`) {
        headers.delete("authorization");
      }
    }

    headers.set("apikey", supabaseKey);

    if (typeof window !== "undefined") {
      headers.set("X-Client-Environment", "browser");
      headers.set("X-Client-Origin", window.location.origin);
    }

    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(input, { ...init, headers });

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) {
          if (typeof window !== "undefined") {
            console.warn(
              `[Supabase] transient ${response.status} from edge, retrying (${attempt + 1}/${maxRetries})`,
              { url },
            );
          }
          await sleep(backoffDelay(attempt, baseDelayMs));
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;

        const isNetworkFailure = error instanceof TypeError;
        if (isNetworkFailure && attempt < maxRetries) {
          if (typeof window !== "undefined") {
            console.warn(
              `[Supabase] network request failed, retrying (${attempt + 1}/${maxRetries})`,
              { error, url },
            );
          }
          await sleep(backoffDelay(attempt, baseDelayMs));
          continue;
        }

        if (typeof window !== "undefined" && isNetworkFailure) {
          console.error("[Supabase] network request failed after retries", {
            error,
            origin: window.location.origin,
            url,
          });
        }
        throw error;
      }
    }

    // Unreachable in practice (the loop always returns or throws), but keeps
    // TypeScript happy and fails loudly if that assumption ever breaks.
    throw lastError;
  };
}
