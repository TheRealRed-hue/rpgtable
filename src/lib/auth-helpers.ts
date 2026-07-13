import type { AuthError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

/**
 * Cheap, LOCAL read of the current user — decodes the JWT already sitting in
 * localStorage instead of calling the Supabase Auth server.
 *
 * Use this for route guards, preload checks, and UI state (`beforeLoad`,
 * `loader`, effects that just want "who's logged in right now"). It is safe
 * even though it doesn't re-verify the token with the server: every real
 * data access is still protected by Postgres RLS, and every privileged
 * server function still verifies the Bearer token itself
 * (see `integrations/supabase/auth-middleware.ts`). This function only
 * decides whether to *show* the app shell, never whether a request is
 * allowed to succeed.
 *
 * Why this matters: TanStack Router calls `beforeLoad`/`loader` on every
 * navigation AND on every preload (e.g. hovering a `<Link>`, since
 * `defaultPreloadStaleTime` is low). `supabase.auth.getUser()` hits the
 * network every single time, which is exactly what was exhausting Supabase's
 * hosted auth rate limit (429) during normal dev usage. `getSession()` reads
 * from local storage and only touches the network when the token actually
 * needs refreshing (handled automatically, infrequently, by `autoRefreshToken`).
 */
export async function getLocalUser() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session?.user ?? null;
}

export type AuthErrorKind =
  | "rate_limit"
  | "invalid_credentials"
  | "email_not_confirmed"
  | "user_exists"
  | "weak_password"
  | "unknown";

export interface ParsedAuthError {
  kind: AuthErrorKind;
  message: string;
}

/**
 * Turns a raw Supabase AuthError into something we can branch UI on
 * (start a cooldown, offer to resend confirmation, etc.) plus a friendly
 * PT-BR message. Supabase's `code` field is the most reliable signal when
 * present; we fall back to status + message sniffing for older/edge cases.
 */
export function parseAuthError(error: AuthError): ParsedAuthError {
  const code = (error as { code?: string }).code ?? "";
  const status = error.status ?? 0;
  const msg = error.message?.toLowerCase() ?? "";

  if (
    status === 429 ||
    code.includes("rate_limit") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  ) {
    return {
      kind: "rate_limit",
      message: "Muitas tentativas seguidas. Espere um pouco antes de tentar de novo.",
    };
  }

  if (code === "email_not_confirmed" || msg.includes("email not confirmed")) {
    return {
      kind: "email_not_confirmed",
      message: "Seu email ainda não foi confirmado. Confira sua caixa de entrada.",
    };
  }

  if (code === "user_already_exists" || msg.includes("already registered")) {
    return {
      kind: "user_exists",
      message: "Já existe uma conta com esse email. Tente entrar em vez de criar uma nova.",
    };
  }

  if (code === "weak_password" || msg.includes("password")) {
    return {
      kind: "weak_password",
      message: "Senha muito curta ou fraca. Use pelo menos 8 caracteres.",
    };
  }

  if (
    code === "invalid_credentials" ||
    msg.includes("invalid login credentials") ||
    msg.includes("invalid credentials")
  ) {
    return {
      kind: "invalid_credentials",
      message: "Email ou senha incorretos.",
    };
  }

  return { kind: "unknown", message: error.message || "Algo deu errado. Tente de novo." };
}
