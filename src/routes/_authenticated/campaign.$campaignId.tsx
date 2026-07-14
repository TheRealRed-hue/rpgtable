import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getLocalUser } from "@/lib/auth-helpers";
import { isMembershipConfirmed, markMembershipConfirmed } from "@/lib/membership-cache";
import { useIsMobile } from "@/hooks/use-mobile";
import { BoardCanvas } from "@/components/board/BoardCanvas";
import { ArchiveSidebar } from "@/components/board/ArchiveSidebar";
import type { BoardObject, Campaign, FileRow, Folder } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Moon,
  Users,
  UserPlus,
  Copy,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function ensureCampaignMembership(campaignId: string) {
  // Skip the round-trip entirely if we already confirmed membership this
  // session — the loader reruns on every navigation AND every hover-preload,
  // so without this an existing member's browser was hammering both the
  // auth server and the DB just to hit a unique-constraint no-op every time.
  if (isMembershipConfirmed(campaignId)) return {};

  const user = await getLocalUser();
  if (!user) {
    return { error: new Error("Not authenticated") };
  }

  const { error } = await supabase.from("campaign_members").insert({
    campaign_id: campaignId,
    user_id: user.id,
    role: "player",
  });

  if (error && error.code !== "23505") {
    return { error };
  }

  markMembershipConfirmed(campaignId);
  return {};
}

export const Route = createFileRoute("/_authenticated/campaign/$campaignId")({
  // Ensures the visitor is added as a member before any other query for this
  // campaign runs. The older RPC-based flow depended on a database function
  // that is not always available, so we now use the table directly.
  loader: async ({ params }) => {
    const { error } = await ensureCampaignMembership(params.campaignId);
    if (error) {
      console.error("[campaign] unable to ensure membership", error);
      toast.error("Não foi possível entrar nessa mesa");
      throw redirect({ to: "/tables" });
    }
  },
  component: CampaignPage,
});

/** Next z-index for a newly created board object: highest existing + offset. */
function nextZIndex(objects: BoardObject[], offset = 1): number {
  const max = objects.reduce((acc, o) => Math.max(acc, o.z_index), 0);
  return max + offset;
}

function CampaignPage() {
  const { campaignId } = Route.useParams();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [userId, setUserId] = useState<string | null>(null);
  const [viewAsPlayer, setViewAsPlayer] = useState(false);
  const [addPinOpen, setAddPinOpen] = useState(false);
  const [pinLabel, setPinLabel] = useState("");
  const [sidebarOpenMobile, setSidebarOpenMobile] = useState(false);

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

  const isOwner = useMemo(
    () => !!campaign && !!userId && campaign.owner_id === userId,
    [campaign, userId],
  );
  const isMaster = isOwner && !viewAsPlayer;

  const { data: folders = [] } = useQuery({
    queryKey: ["folders", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("folders")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("sort_order")
        .order("name");
      if (error) throw error;
      return data as Folder[];
    },
  });

  const { data: files = [] } = useQuery({
    queryKey: ["files", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("files")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("name");
      if (error) throw error;
      return data as FileRow[];
    },
  });

  const { data: objects = [] } = useQuery({
    queryKey: ["board_objects", campaignId, viewAsPlayer],
    queryFn: async () => {
      let query = supabase.from("board_objects").select("*").eq("campaign_id", campaignId);
      if (viewAsPlayer) query = query.eq("visible_to_players", true);
      const { data, error } = await query;
      if (error) throw error;
      return data as BoardObject[];
    },
  });

  // Realtime — board_objects, folders, files
  useEffect(() => {
    const channel = supabase
      .channel(`campaign:${campaignId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "board_objects",
          filter: `campaign_id=eq.${campaignId}`,
        },
        () => qc.invalidateQueries({ queryKey: ["board_objects", campaignId] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "folders", filter: `campaign_id=eq.${campaignId}` },
        () => qc.invalidateQueries({ queryKey: ["folders", campaignId] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "files", filter: `campaign_id=eq.${campaignId}` },
        () => qc.invalidateQueries({ queryKey: ["files", campaignId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [campaignId, qc]);

  // Optimistic cache patch used by BoardCanvas while a drag/nudge is settling,
  // so the object doesn't visibly snap back before Realtime confirms the
  // write (see BoardCanvas.tsx). Both possible cache entries (master view and
  // player view) are patched since either may be mounted/cached.
  const handleObjectMove = (id: string, x: number, y: number) => {
    const patch = (old: BoardObject[] | undefined) =>
      old?.map((o) => (o.id === id ? { ...o, x, y } : o));
    qc.setQueryData<BoardObject[]>(["board_objects", campaignId, true], patch);
    qc.setQueryData<BoardObject[]>(["board_objects", campaignId, false], patch);
  };

  const handleDropFromSidebar = async (fileId: string, worldX: number, worldY: number) => {
    if (!isMaster || !userId) return;
    try {
      const file = files.find((f) => f.id === fileId);
      if (!file) {
        toast.error("Arquivo não encontrado no arquivo arcano.");
        return;
      }
      const isImage = file.kind === "image" || file.kind === "map";
      const kind = isImage ? (file.kind === "map" ? "map" : "image") : "document";
      const width = isImage ? 640 : 320;
      const height = isImage ? 420 : 260;
      const { error } = await supabase.from("board_objects").insert({
        campaign_id: campaignId,
        kind,
        file_id: file.id,
        label: file.name,
        x: worldX,
        y: worldY,
        width,
        height,
        z_index: nextZIndex(objects),
        data: {
          storage_path: file.storage_path ?? null,
          content: file.content ?? "",
        },
        created_by: userId,
      });
      if (error) toast.error(error.message);
    } catch (err) {
      console.error("Erro ao soltar item na mesa:", err);
      toast.error(
        "Não foi possível colocar o item na mesa: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const addPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isMaster || !userId) return;
    const label = pinLabel.trim();
    if (!label) return;
    try {
      const { error } = await supabase.from("board_objects").insert({
        campaign_id: campaignId,
        kind: "pin",
        label,
        x: 200 + Math.random() * 200,
        y: 200 + Math.random() * 200,
        width: 40,
        height: 40,
        z_index: nextZIndex(objects, 10),
        created_by: userId,
      });
      if (error) throw error;
      setAddPinOpen(false);
      setPinLabel("");
    } catch (err) {
      console.error("Erro ao adicionar pin:", err);
      toast.error(
        "Não foi possível adicionar o pin: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  // Fallback for mobile: native HTML5 drag-and-drop (used by the sidebar's
  // draggable file rows) has no touch equivalent in any mobile browser, so
  // ArchiveSidebar calls this on tap instead of drag when isMobile is true.
  // Reuses the same insert path as a desktop drop, just with a nudge-style
  // default position instead of exact drop coordinates.
  const handleAddFileFromSidebarTap = (fileId: string) => {
    handleDropFromSidebar(fileId, 200 + Math.random() * 200, 200 + Math.random() * 200);
    setSidebarOpenMobile(false);
  };

  const copyInvite = () => {
    navigator.clipboard.writeText(`${window.location.origin}/campaign/${campaignId}`);
    toast.success(
      "Link copiado. Envie ao jogador — ele será adicionado como jogador ao abrir o link.",
    );
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
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-primary/15 bg-ink-2/60 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            to="/tables"
            aria-label="Voltar às mesas"
            className="grid size-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <Moon className="size-4 shrink-0 text-primary" strokeWidth={1.25} aria-hidden="true" />
            <h1 className="grimoire-title text-lg text-primary truncate max-w-[14rem] sm:max-w-[24rem]">
              {campaign.name}
            </h1>
          </div>
          {isOwner && (
            <div className="ml-1 hidden gap-1 rounded-md bg-ink/60 p-1 ring-1 ring-primary/15 sm:ml-4 sm:flex">
              <button
                onClick={() => setViewAsPlayer(false)}
                aria-pressed={!viewAsPlayer}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  !viewAsPlayer
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                Mestre
              </button>
              <button
                onClick={() => setViewAsPlayer(true)}
                aria-pressed={viewAsPlayer}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  viewAsPlayer
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                Ver como jogador
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {isMaster && (
            <Dialog open={addPinOpen} onOpenChange={setAddPinOpen}>
              <DialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-primary/80 hover:text-primary hover:bg-primary/10"
                >
                  <span
                    aria-hidden="true"
                    className="mr-1.5 grid size-4 place-items-center rounded-full bg-wax text-[10px] text-primary"
                  >
                    •
                  </span>
                  <span className="hidden sm:inline">Adicionar pin</span>
                  <span className="sm:hidden">Pin</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="gold-frame">
                <DialogHeader>
                  <DialogTitle className="grimoire-title text-primary">Novo pin</DialogTitle>
                  <DialogDescription>Marque um ponto de interesse na mesa.</DialogDescription>
                </DialogHeader>
                <form onSubmit={addPin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="pin-label">Nome do pin</Label>
                    <Input
                      id="pin-label"
                      value={pinLabel}
                      onChange={(e) => setPinLabel(e.target.value)}
                      placeholder="Ex: Torre do Sábio"
                      required
                      autoFocus
                    />
                  </div>
                  <DialogFooter>
                    <Button type="submit">Adicionar</Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          )}

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5" aria-hidden="true" />
            <span>{members.length}</span>
          </div>

          {isOwner && (
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-primary/30 text-primary hover:bg-primary/10"
                >
                  <UserPlus className="mr-1.5 size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Convidar</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="gold-frame">
                <DialogHeader>
                  <DialogTitle className="grimoire-title text-primary">
                    Convidar jogador
                  </DialogTitle>
                  <DialogDescription>
                    O jogador precisa ter conta no TableLabRPG. Copie e envie o link — ele será
                    adicionado automaticamente como jogador na primeira visita.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={`${typeof window !== "undefined" ? window.location.origin : ""}/campaign/${campaignId}`}
                  />
                  <Button onClick={copyInvite} size="sm">
                    <Copy className="mr-1.5 size-3.5" aria-hidden="true" /> Copiar
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}

          {/* Mobile-only toggle for the archive sidebar, which becomes an
              overlay drawer on small screens instead of a fixed 320px column
              that would otherwise consume most of the viewport. */}
          <Button
            size="sm"
            variant="ghost"
            className="text-primary/80 hover:text-primary hover:bg-primary/10 lg:hidden"
            aria-label={sidebarOpenMobile ? "Fechar arquivo arcano" : "Abrir arquivo arcano"}
            aria-expanded={sidebarOpenMobile}
            onClick={() => setSidebarOpenMobile((v) => !v)}
          >
            {sidebarOpenMobile ? (
              <PanelRightClose className="size-4" aria-hidden="true" />
            ) : (
              <PanelRightOpen className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </header>

      {/* Main */}
      <div className="relative flex flex-1 overflow-hidden">
        <div className="relative flex-1 overflow-hidden">
          <BoardCanvas
            objects={objects}
            isMaster={isMaster}
            onDropFromSidebar={handleDropFromSidebar}
            onObjectMove={handleObjectMove}
          />
        </div>

        {/* Backdrop for the mobile drawer */}
        {isMobile && sidebarOpenMobile && (
          <div
            className="fixed inset-0 z-30 bg-black/50 lg:hidden"
            onClick={() => setSidebarOpenMobile(false)}
            aria-hidden="true"
          />
        )}

        <div
          className={`z-40 transition-transform duration-300 ease-out lg:static lg:translate-x-0 ${
            isMobile
              ? `fixed inset-y-0 right-0 top-14 ${sidebarOpenMobile ? "translate-x-0" : "translate-x-full"}`
              : ""
          }`}
        >
          <ArchiveSidebar
            campaignId={campaignId}
            folders={folders}
            files={files}
            isMaster={isMaster}
            isMobile={isMobile}
            onAddFile={handleAddFileFromSidebarTap}
          />
        </div>
      </div>
    </div>
  );
}
