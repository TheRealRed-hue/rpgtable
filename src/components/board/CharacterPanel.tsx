import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Character } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Plus, Loader2, Eye, EyeOff, UserCircle2, Link2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  campaignId: string;
  characters: Character[];
  currentUserId: string | null;
  isMaster: boolean;
  isMobile?: boolean;
  onOpenCharacter: (character: Character) => void;
  /** Mobile has no drag-and-drop, so tapping adds directly to the board center. */
  onAddCharacterToBoard?: (characterId: string) => void;
}

export function CharacterPanel({
  campaignId,
  characters,
  currentUserId,
  isMaster,
  isMobile = false,
  onOpenCharacter,
  onAddCharacterToBoard,
}: Props) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  // "Seus Personagens" (the personal library) creates characters with
  // campaign_id = null — they were never reachable from any table until
  // now. This surfaces them here so a player can attach an existing sheet
  // instead of only ever starting a fresh "Novo personagem" per table.
  const { data: libraryCharacters = [] } = useQuery({
    queryKey: ["characters", "library-unlinked", currentUserId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("characters")
        .select("*")
        .is("campaign_id", null)
        .eq("owner_id", currentUserId!)
        .order("name");
      if (error) throw error;
      return data as Character[];
    },
    enabled: !!currentUserId,
  });

  const linkCharacter = async (characterId: string) => {
    setLinkingId(characterId);
    const { error } = await supabase
      .from("characters")
      .update({ campaign_id: campaignId })
      .eq("id", characterId);
    setLinkingId(null);
    if (error) {
      toast.error("Não foi possível trazer o personagem: " + error.message);
      return;
    }
    toast.success("Personagem trazido para a mesa!");
    qc.invalidateQueries({ queryKey: ["characters", campaignId] });
    qc.invalidateQueries({ queryKey: ["characters", "library-unlinked", currentUserId] });
  };

  // Players only see their own characters plus anything the master marked
  // visible (NPCs shown to the table); the master sees every sheet,
  // including hidden ones — mirrors the RLS policy so the UI never implies
  // access the database wouldn't actually grant.
  const visible = characters.filter(
    (c) => isMaster || c.owner_id === currentUserId || c.visible_to_players,
  );

  const createCharacter = useMutation({
    mutationFn: async () => {
      if (!currentUserId) throw new Error("Não autenticado");
      const { data, error } = await supabase
        .from("characters")
        .insert({ campaign_id: campaignId, owner_id: currentUserId, name: "Novo personagem" })
        .select()
        .single();
      if (error) throw error;
      return data as Character;
    },
    onSuccess: (character) => {
      qc.invalidateQueries({ queryKey: ["characters", campaignId] });
      onOpenCharacter(character);
    },
    onError: (e: Error) => {
      toast.error(e.message);
      // The request may have actually landed even though the client saw a
      // failure (dropped connection, not a real rejection) — refetch so a
      // silently-successful create shows up instead of inviting a retry
      // that creates a duplicate.
      qc.invalidateQueries({ queryKey: ["characters", campaignId] });
    },
    onSettled: () => setCreating(false),
  });

  const onDragCharacter = (e: React.DragEvent, characterId: string) => {
    e.dataTransfer.setData("text/character-id", characterId);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="scrollbar-arcane flex-1 overflow-y-auto p-3">
      <p className="mb-3 px-1 text-[10px] leading-relaxed text-muted-foreground">
        Cada personagem tem sua própria ficha, montada do seu jeito. Arraste um card para a mesa
        para colocar o token.
      </p>

      {libraryCharacters.length > 0 && (
        <div className="mb-3 space-y-1 rounded-md border border-dashed border-primary/20 p-2">
          <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
            Personagens da sua biblioteca, ainda em nenhuma mesa:
          </p>
          {libraryCharacters.map((c) => (
            <button
              key={c.id}
              onClick={() => linkCharacter(c.id)}
              disabled={linkingId === c.id}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-primary/5 hover:text-primary disabled:opacity-50"
            >
              {linkingId === c.id ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <Link2 className="size-3.5 shrink-0 text-primary/60" />
              )}
              <span className="flex-1 truncate">{c.name}</span>
              <span className="text-[9px] uppercase tracking-widest text-primary/70">
                Inserir na mesa
              </span>
            </button>
          ))}
        </div>
      )}

      <Button
        size="sm"
        variant="outline"
        disabled={createCharacter.isPending}
        onClick={() => {
          setCreating(true);
          createCharacter.mutate();
        }}
        className="mb-3 w-full text-xs"
      >
        {creating ? (
          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
        ) : (
          <Plus className="mr-1.5 size-3.5" />
        )}
        Novo personagem
      </Button>

      <div className="space-y-1">
        {visible.map((c) => (
          <div
            key={c.id}
            draggable={!isMobile}
            onDragStart={isMobile ? undefined : (e) => onDragCharacter(e, c.id)}
            onClick={() => onOpenCharacter(c)}
            className={`group flex items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-primary/5 hover:text-primary ${
              isMobile ? "cursor-pointer active:bg-primary/10" : "cursor-grab"
            }`}
            title={isMobile ? "Toque para abrir a ficha" : "Arraste para a mesa · clique para abrir"}
          >
            <UserCircle2 className="size-4 shrink-0 text-primary/60" aria-hidden="true" />
            <span className="flex-1 truncate font-medium">{c.name}</span>
            {c.owner_id !== currentUserId && (
              <span className="text-[9px] uppercase tracking-widest text-muted-foreground/60">
                NPC
              </span>
            )}
            {isMobile ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAddCharacterToBoard?.(c.id);
                }}
                aria-label="Adicionar à mesa"
                title="Adicionar à mesa"
                className="-m-1 shrink-0 rounded p-1 text-primary/70 active:bg-primary/10 active:text-primary"
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </button>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenCharacter(c);
                }}
                className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary"
                title="Abrir ficha"
              >
                {c.visible_to_players ? (
                  <Eye className="size-3.5" aria-hidden="true" />
                ) : (
                  <EyeOff className="size-3.5" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        ))}
        {visible.length === 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground italic">
            Nenhum personagem ainda.
          </div>
        )}
      </div>
    </div>
  );
}