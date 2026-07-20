// NOTE: this file was originally marked "automatically generated. Do not edit
// directly" by Lovable Cloud. We still edited it to remove duplicated logic
// (see fetch-utils.ts) — if you regenerate integrations from Lovable, re-apply
// this change, since a regeneration may restore the old inline copy.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { createSupabaseFetch } from "./fetch-utils";

function createSupabaseClient() {
  const fallbackUrl = "https://btxrdoszavplrubqmrfz.supabase.co";
  const fallbackKey = "sb_publishable_heBbs1fDwQ2w7BqQwFPSwA_KIRKol2k";

  const SUPABASE_URL = (
    (typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_URL) ||
    (typeof process !== "undefined" && process.env?.VITE_SUPABASE_URL) ||
    (typeof process !== "undefined" && process.env?.SUPABASE_URL) ||
    fallbackUrl
  ).replace(/\/$/, "");

  const SUPABASE_PUBLISHABLE_KEY = (
    (typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY) ||
    (typeof process !== "undefined" && process.env?.VITE_SUPABASE_PUBLISHABLE_KEY) ||
    (typeof process !== "undefined" && process.env?.SUPABASE_PUBLISHABLE_KEY) ||
    fallbackKey
  ).trim();

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ["SUPABASE_URL"] : []),
      ...(!SUPABASE_PUBLISHABLE_KEY ? ["SUPABASE_PUBLISHABLE_KEY"] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(", ")}. Connect Supabase in Lovable Cloud.`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: {
      fetch: createSupabaseFetch(SUPABASE_PUBLISHABLE_KEY),
    },
    auth: {
      storage: typeof window !== "undefined" ? localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    },
    db: {
      schema: "public",
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
