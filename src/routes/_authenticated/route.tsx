import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getLocalUser } from "@/lib/auth-helpers";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // IMPORTANT: this beforeLoad runs on every navigation into the
    // authenticated section AND on every preload (hovering a <Link>, since
    // router.tsx uses defaultPreloadStaleTime: 0). Calling
    // supabase.auth.getUser() here hit Supabase's Auth server on every one
    // of those, which is what was exhausting the hosted rate limit (429)
    // during normal use. getLocalUser() is a local, network-free read.
    // Real authorization still happens server-side (RLS + auth middleware),
    // so this guard only needs to be "good enough" to gate the UI.
    const user = await getLocalUser();
    if (!user) {
      throw redirect({ to: "/auth" });
    }
    return { user };
  },
  component: () => <Outlet />,
});
