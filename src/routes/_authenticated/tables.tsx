import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getLocalUser } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { BookOpenText, Plus, Moon, LogOut, Loader2, Users, Crown, Trash2, UsersRound } from "lucide-react";
import { toast } from "sonner";

/** Shape actually returned by the campaigns list query below — narrower than
 * the full `Campaign` row type (no `updated_at`), which is all the delete
 * flow needs. */
type CampaignCard = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
};

export const Route = createFileRoute("/_authenticated/tables")({
  component: TablesPage,
});

function TablesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    getLocalUser().then((user) => setUserId(user?.id ?? null));
  }, []);

  const { data: campaigns, isLoading } = useQuery({
    queryKey: ["campaigns"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("id, name, description, owner_id, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const showLoading = !isMounted || isLoading;

  const createMutation = useMutation({
    mutationFn: async () => {
      const user = await getLocalUser();
      if (!user) throw new Error("Não autenticado");
      const { data, error } = await supabase
        .from("campaigns")
        .insert({ name, description, owner_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (created) => {
      toast.success("Mesa forjada.");
      setOpen(false);
      setName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      navigate({ to: "/campaign/$campaignId", params: { campaignId: created.id } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Two-step destructive flow: a first "are you sure" step, then a second
  // step that requires typing the exact campaign name before the delete
  // button unlocks. DB-side, campaign_members/folders/files/board_objects
  // all cascade off campaigns.id — the only thing that doesn't cascade is
  // the actual blobs in Storage (files just holds a storage_path, same as
  // the single-file delete path in ArchiveSidebar), so we sweep those first.
  const [deleteTarget, setDeleteTarget] = useState<CampaignCard | null>(null);
  const [deleteStep, setDeleteStep] = useState<1 | 2>(1);
  const [confirmText, setConfirmText] = useState("");

  const closeDeleteDialog = () => {
    setDeleteTarget(null);
    setDeleteStep(1);
    setConfirmText("");
  };

  const deleteMutation = useMutation({
    mutationFn: async (campaign: CampaignCard) => {
      const { data: objects } = await supabase.storage
        .from("campaign-assets")
        .list(campaign.id, { limit: 1000 });
      if (objects && objects.length > 0) {
        const paths = objects.map((o) => `${campaign.id}/${o.name}`);
        await supabase.storage.from("campaign-assets").remove(paths);
      }
      const { error } = await supabase.from("campaigns").delete().eq("id", campaign.id);
      if (error) throw error;
    },
    onSuccess: (_data, campaign) => {
      toast.success(`"${campaign.name}" foi apagada para sempre.`);
      closeDeleteDialog();
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (e: Error) => toast.error("Não foi possível apagar a mesa: " + e.message),
  });

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="min-h-screen w-full">
      <header className="border-b border-border/60 bg-ink-2/40 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Moon className="size-5 text-primary" strokeWidth={1.25} />
            <h1 className="grimoire-title text-xl text-primary">
              TableLab<span className="italic opacity-80">RPG</span>
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-primary">
              <Link to="/characters">
                <UsersRound className="mr-2 size-4" />
                Meus Personagens
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={signOut}
              className="text-muted-foreground hover:text-primary"
            >
              <LogOut className="mr-2 size-4" />
              Sair
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-8 flex flex-col gap-4 sm:mb-10 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <div>
            <h2 className="grimoire-title text-3xl sm:text-4xl">Suas Mesas</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Cada mesa é um grimório — mapas, fichas e lore num só lugar.
            </p>
          </div>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="w-full sm:w-auto">
                <Plus className="mr-2 size-4" />
                Nova mesa
              </Button>
            </DialogTrigger>
            <DialogContent className="gold-frame">
              <DialogHeader>
                <DialogTitle className="grimoire-title text-2xl text-primary">
                  Fundar uma nova mesa
                </DialogTitle>
                <DialogDescription>
                  Você será o Mestre. Poderá convidar jogadores depois.
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  createMutation.mutate();
                }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="c-name">Nome da campanha</Label>
                  <Input
                    id="c-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: A Coroa de Ébano"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="c-desc">Descrição (opcional)</Label>
                  <Textarea
                    id="c-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Uma linha sobre o mundo, o tom, os jogadores…"
                    rows={3}
                  />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createMutation.isPending}>
                    {createMutation.isPending ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        <span className="sr-only">Forjando…</span>
                      </>
                    ) : (
                      "Forjar mesa"
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {showLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-lg bg-card/40" />
            ))}
          </div>
        ) : campaigns && campaigns.length > 0 ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {campaigns.map((c) => {
              const isOwner = !!userId && c.owner_id === userId;
              return (
                <Link
                  key={c.id}
                  to="/campaign/$campaignId"
                  params={{ campaignId: c.id }}
                  className="ink-bleed-in group gold-frame relative flex flex-col overflow-hidden rounded-lg bg-card/60 p-6 transition-all hover:bg-card/80 hover:shadow-[0_0_30px_-10px_oklch(0.72_0.11_78/0.4)]"
                >
                  <div className="mb-4 flex items-start justify-between">
                    <BookOpenText className="size-6 text-primary" strokeWidth={1.25} />
                    <div className="flex items-center gap-2">
                      {isOwner && <Crown className="size-4 text-gold-muted" strokeWidth={1.25} />}
                      {isOwner && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDeleteTarget(c);
                            setDeleteStep(1);
                            setConfirmText("");
                          }}
                          aria-label={`Apagar mesa ${c.name}`}
                          title="Apagar mesa"
                          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                  <h3 className="grimoire-title text-xl text-foreground group-hover:text-primary transition-colors">
                    {c.name}
                  </h3>
                  {c.description && (
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                      {c.description}
                    </p>
                  )}
                  <div className="mt-4 flex items-center gap-2 text-[10px] uppercase tracking-widest text-gold-muted">
                    <Users className="size-3" />
                    <span>{isOwner ? "Mestre" : "Jogador"}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="gold-frame rounded-lg bg-card/40 py-16 text-center">
            <Moon className="mx-auto mb-4 size-10 text-primary/60" strokeWidth={1} />
            <h3 className="grimoire-title text-2xl">Nenhuma mesa ainda</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              A primeira página do seu grimório está em branco. Comece uma campanha.
            </p>
          </div>
        )}
      </main>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog();
        }}
      >
        <AlertDialogContent className="gold-frame">
          {deleteTarget && deleteStep === 1 && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="grimoire-title text-primary">
                  Apagar "{deleteTarget.name}"?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Todos os mapas, fichas, pastas e pergaminhos dessa mesa serão perdidos para sempre
                  — jogadores, mestre, tudo. Essa ação não pode ser desfeita.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={closeDeleteDialog}>Cancelar</AlertDialogCancel>
                <Button variant="destructive" onClick={() => setDeleteStep(2)}>
                  Continuar
                </Button>
              </AlertDialogFooter>
            </>
          )}

          {deleteTarget && deleteStep === 2 && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="grimoire-title text-primary">
                  Confirme para apagar
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Para confirmar, digite o nome exato da mesa:{" "}
                  <span className="font-semibold text-foreground">{deleteTarget.name}</span>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-2">
                <Label htmlFor="confirm-name" className="sr-only">
                  Nome da mesa
                </Label>
                <Input
                  id="confirm-name"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={deleteTarget.name}
                  autoFocus
                  autoComplete="off"
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={closeDeleteDialog}>Cancelar</AlertDialogCancel>
                <Button
                  variant="destructive"
                  disabled={confirmText !== deleteTarget.name || deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(deleteTarget)}
                >
                  {deleteMutation.isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      <span className="sr-only">Apagando…</span>
                    </>
                  ) : (
                    "Apagar definitivamente"
                  )}
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}