// Filename note: "$campaignId_" (trailing underscore) opts this route out of
// nesting under campaign.$campaignId.tsx. Without it, TanStack Router's
// flat-file convention would treat that file as an implicit layout for this
// one — requiring it to render an <Outlet/> just to show this page, and
// wrapping the Grimório in the board's header/sidebar chrome, which isn't
// what we want: this is a separate full-screen area, not a tab inside the
// board.
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getLocalUser } from "@/lib/auth-helpers";
import { ensureCampaignMembership } from "./campaign.$campaignId";
import type { Campaign, CampaignPage } from "@/lib/board-types";
import { GrimoireSidebar } from "@/components/grimoire/GrimoireSidebar";
import { BlockEditor } from "@/components/grimoire/BlockEditor";
import { ArrowLeft, BookOpenText, Eye, EyeOff, Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/campaign/$campaignId_/grimorio")({
  loader: async ({ params }) => {
    const { error } = await ensureCampaignMembership(params.campaignId);
    if (error) {
      console.error("[grimorio] unable to ensure membership", error);
      toast.error("Não foi possível entrar nessa mesa");
      throw redirect({ to: "/tables" });
    }
  },
  component: GrimorioPage,
});

function GrimorioPage() {
  const { campaignId } = Route.useParams();
  const qc = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    getLocalUser().then((user) => setUserId(user?.id ?? null));
  }, []);

  const { data: campaign } = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("*")
        .eq("id", campaignId)
        .single();
      if (error) throw error;
      return data as Campaign;
    },
  });

  const isOwner = !!campaign && !!userId && campaign.owner_id === userId;

  const { data: members = [] } = useQuery({
    queryKey: ["members", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("campaign_members")
        .select("id, user_id, role, display_name")
        .eq("campaign_id", campaignId);
      if (error) throw error;
      return data;
    },
  });

  // Same "owner OR members.role = master" shape is_campaign_master enforces
  // server-side (RLS), so the UI's notion of "can edit" matches what the
  // database will actually allow.
  const isMaster =
    isOwner || members.some((m) => m.user_id === userId && m.role === "master");

  const { data: pages = [] } = useQuery({
    queryKey: ["campaign_pages", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("campaign_pages")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("sort_order")
        .order("title");
      if (error) throw error;
      return data as CampaignPage[];
    },
    enabled: !!campaignId,
  });

  useEffect(() => {
    const channel = supabase
      .channel(`campaign_pages:${campaignId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "campaign_pages",
          filter: `campaign_id=eq.${campaignId}`,
        },
        () => qc.invalidateQueries({ queryKey: ["campaign_pages", campaignId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [campaignId, qc]);

  const selectedPage = useMemo(
    () => pages.find((p) => p.id === selectedId) ?? null,
    [pages, selectedId],
  );

  // First page fetch (or a deletion from another tab) may leave nothing
  // selected — default to the first available page rather than a blank
  // panel with no way in.
  useEffect(() => {
    if (selectedId && pages.some((p) => p.id === selectedId && !p.is_folder)) return;
    const firstPage = pages.find((p) => !p.is_folder);
    setSelectedId(firstPage?.id ?? null);
  }, [pages, selectedId]);

  const saveBlocks = async (page: CampaignPage, blocks: unknown) => {
    const { error } = await supabase
      .from("campaign_pages")
      .update({ blocks: blocks as never })
      .eq("id", page.id);
    if (error) toast.error("Não foi possível salvar a página: " + error.message);
    qc.setQueryData<CampaignPage[]>(["campaign_pages", campaignId], (old) =>
      old?.map((p) => (p.id === page.id ? { ...p, blocks: blocks as never } : p)),
    );
  };

  const togglePublishSelected = async () => {
    if (!selectedPage) return;
    const { error } = await supabase
      .from("campaign_pages")
      .update({ is_published: !selectedPage.is_published })
      .eq("id", selectedPage.id);
    if (error) toast.error("Não foi possível publicar: " + error.message);
    else qc.invalidateQueries({ queryKey: ["campaign_pages", campaignId] });
  };

  if (!campaign) {
    return (
      <div className="grid h-screen place-items-center text-muted-foreground">
        Abrindo grimório…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-primary/15 bg-ink-2/60 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            to="/campaign/$campaignId"
            params={{ campaignId }}
            aria-label="Voltar à mesa"
            className="grid size-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <BookOpenText className="size-4 shrink-0 text-primary" strokeWidth={1.25} aria-hidden="true" />
            <h1 className="grimoire-title text-lg text-primary truncate max-w-[14rem] sm:max-w-[24rem]">
              Grimório — {campaign.name}
            </h1>
          </div>
          <nav className="ml-2 flex items-center gap-1 rounded-md bg-ink/50 p-0.5 text-xs">
            <span className="flex items-center gap-1.5 rounded bg-primary/15 px-2.5 py-1 text-primary">
              <BookOpenText className="size-3.5" /> Livro
            </span>
            <Link
              to="/campaign/$campaignId/sistema"
              params={{ campaignId }}
              className="flex items-center gap-1.5 rounded px-2.5 py-1 text-muted-foreground hover:text-primary"
            >
              <Sparkles className="size-3.5" /> Sistema
            </Link>
          </nav>
        </div>
        {isMaster && selectedPage && (
          <button
            onClick={togglePublishSelected}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              selectedPage.is_published
                ? "bg-primary/15 text-primary"
                : "bg-ink/60 text-muted-foreground ring-1 ring-primary/15 hover:text-primary"
            }`}
          >
            {selectedPage.is_published ? (
              <Eye className="size-3.5" aria-hidden="true" />
            ) : (
              <EyeOff className="size-3.5" aria-hidden="true" />
            )}
            {selectedPage.is_published ? "Publicada" : "Só o mestre vê"}
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <GrimoireSidebar
          campaignId={campaignId}
          pages={pages}
          selectedId={selectedId}
          onSelect={(p) => setSelectedId(p.id)}
          isMaster={isMaster}
        />
        <main className="parchment-surface flex min-h-0 flex-1 flex-col">
          {selectedPage ? (
            <BlockEditor
              key={selectedPage.id}
              page={selectedPage}
              readOnly={!isMaster}
              onSave={(blocks) => saveBlocks(selectedPage, blocks)}
            />
          ) : (
            <div className="grid flex-1 place-items-center text-sm italic text-ink/50">
              {isMaster
                ? "Crie uma página para começar a escrever."
                : "O mestre ainda não publicou nenhuma página."}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}