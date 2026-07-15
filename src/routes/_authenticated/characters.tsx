import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getLocalUser } from "@/lib/auth-helpers";
import type { Character } from "@/lib/board-types";
import { normalizeSheet } from "@/lib/character-sheet-types";
import { CharacterSheetEditor } from "@/components/board/CharacterSheetEditor";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Moon, Plus, UserCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/characters")({
  component: CharacterLibraryPage,
});

function CharacterLibraryPage() {
  const qc = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [openCharacterId, setOpenCharacterId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    getLocalUser().then((user) => setUserId(user?.id ?? null));
  }, []);

  // This is the user's whole library — every character they own, regardless
  // of which table(s) they've ever brought it to.
  const { data: characters = [], isLoading } = useQuery({
    queryKey: ["characters", "library", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("characters")
        .select("*")
        .eq("owner_id", userId!)
        .order("name");
      if (error) throw error;
      return data as Character[];
    },
    enabled: !!userId,
  });

  const openCharacter = characters.find((c) => c.id === openCharacterId) ?? null;

  const createCharacter = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Não autenticado");
      const { data, error } = await supabase
        .from("characters")
        .insert({ owner_id: userId, name: "Novo personagem" })
        .select()
        .single();
      if (error) throw error;
      return data as Character;
    },
    onSuccess: (character) => {
      qc.invalidateQueries({ queryKey: ["characters"] });
      setOpenCharacterId(character.id);
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setCreating(false),
  });

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
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-primary">
            <Link to="/tables">
              <ArrowLeft className="mr-2 size-4" />
              Suas Mesas
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-8 flex flex-col gap-4 sm:mb-10 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <div>
            <h2 className="grimoire-title text-3xl sm:text-4xl">Seus Personagens</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Uma biblioteca sua, independente de mesa. Monte a ficha do seu jeito e leve para
              qualquer table em que você esteja.
            </p>
          </div>
          <Button
            disabled={createCharacter.isPending}
            onClick={() => {
              setCreating(true);
              createCharacter.mutate();
            }}
          >
            {creating ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Plus className="mr-2 size-4" />
            )}
            Novo personagem
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-6 animate-spin text-primary/60" />
          </div>
        ) : characters.length === 0 ? (
          <div className="rounded-lg border border-dashed border-primary/20 py-16 text-center">
            <UserCircle2 className="mx-auto mb-4 size-10 text-primary/60" strokeWidth={1} />
            <p className="text-sm text-muted-foreground">
              Nenhum personagem ainda. Crie o primeiro acima.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {characters.map((c) => (
              <button
                key={c.id}
                onClick={() => setOpenCharacterId(c.id)}
                className="gold-frame parchment-surface flex flex-col items-start gap-2 rounded-lg p-4 text-left transition-transform hover:-translate-y-0.5"
              >
                <UserCircle2 className="size-8 text-primary/70" strokeWidth={1.25} />
                <span className="grimoire-title text-lg text-ink">{c.name}</span>
                <span className="text-xs text-ink/50">
                  {normalizeSheet(c.sheet).flatMap((t) => t.fields).length} campo(s)
                </span>
              </button>
            ))}
          </div>
        )}
      </main>

      <CharacterSheetEditor
        campaignId={null}
        character={openCharacter}
        onOpenChange={(open) => !open && setOpenCharacterId(null)}
        canEdit={!!openCharacter && openCharacter.owner_id === userId}
      />
    </div>
  );
}
