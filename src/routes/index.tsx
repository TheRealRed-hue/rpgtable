import { createFileRoute, redirect } from "@tanstack/react-router";
import { getLocalUser } from "@/lib/auth-helpers";

// Home = redirect based on session
export const Route = createFileRoute("/")({
  ssr: false,
  beforeLoad: async () => {
    // Local session read (no network call) — see auth-helpers.ts for why
    // this matters: beforeLoad reruns on every preload/navigation.
    const user = await getLocalUser();
    if (user) throw redirect({ to: "/tables" });
    throw redirect({ to: "/auth" });
  },
  component: () => null,
});
