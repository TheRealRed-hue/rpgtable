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
import { BookOpenText, Plus, Moon, LogOut, Loader2, Users, Crown } from "lucide-react";
import { toast } from "sonner";

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

  useEffect(() => {
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

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="min-h-screen w-full">
      <header className="border-b border-border/60 bg-ink-2/40 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Moon className="size-5 text-primary" strokeWidth={1.25} />
            <h1 className="grimoire-title text-xl text-primary">
              TableLab<span className="italic opacity-80">RPG</span>
            </h1>
          </div>
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
      </header>

      <main className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-10 flex items-end justify-between gap-6">
          <div>
            <h2 className="grimoire-title text-4xl">Suas Mesas</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Cada mesa é um grimório — mapas, fichas e lore num só lugar.
            </p>
          </div>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
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

        {isLoading ? (
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
                    {isOwner && <Crown className="size-4 text-gold-muted" strokeWidth={1.25} />}
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
    </div>
  );
}
