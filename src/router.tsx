import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // 0 meant every hover-preload treated its beforeLoad/loader result as
    // instantly stale, so hovering a <Link> a few times re-ran auth checks
    // and campaign-membership inserts over and over — a big contributor to
    // hitting Supabase's auth rate limit (429) during normal dev use.
    // 30s keeps preload snappy while letting results be reused briefly.
    defaultPreloadStaleTime: 30_000,
  });

  return router;
};
