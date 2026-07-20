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
 * Wraps `fetch` so the given Supabase key is always sent as the `apikey`
 * header, and — for the new opaque key format — is never duplicated onto the
 * `Authorization` header as if it were a bearer JWT.
 */
export function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }

    headers.set("apikey", supabaseKey);

    if (typeof window !== "undefined") {
      headers.set("X-Client-Environment", "browser");
      headers.set("X-Client-Origin", window.location.origin);
    }

    return fetch(input, { ...init, headers }).catch((error) => {
      if (typeof window !== "undefined" && error instanceof TypeError) {
        console.error("[Supabase] network request failed", {
          error,
          origin: window.location.origin,
          url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        });
      }
      throw error;
    });
  };
}
