// See campaign.$campaignId_.grimorio.tsx for the note on the trailing
// underscore in the filename — same reasoning applies here: this is a
// separate full-screen area, not a tab nested under the board layout.
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getLocalUser } from "@/lib/auth-helpers";
import { ensureCampaignMembership } from "./campaign.$campaignId";
import type { Campaign, Character, SkillEdge, SkillNode, SkillTree } from "@/lib/board-types";
import { SkillTreeCanvas } from "@/components/skilltree/SkillTreeCanvas";
import { NodePanel } from "@/components/skilltree/NodePanel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, BookOpenText, Sparkles, Gem, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/campaign/$campaignId_/sistema")({
  loader: async ({ params }) => {
    const { error } = await ensureCampaignMembership(params.campaignId);
    if (error) {
      console.error("[sistema] unable to ensure membership", error);
      toast.error("Não foi possível entrar nessa mesa");
      throw redirect({ to: "/tables" });
    }
  },
  component: SistemaPage,
});

function SistemaPage() {
  const { campaignId } = Route.useParams();
  const qc = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [viewAsPlayer, setViewAsPlayer] = useState(false);

  useEffect(() => {
    getLocalUser().then((user) => setUserId(user?.id ?? null));
  }, []);

  const { data: campaign } = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase.from("campaigns").select("*").eq("id", campaignId).single();
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

  const isOwner = !!campaign && !!userId && campaign.owner_id === userId;
  const isActualMaster = isOwner || members.some((m) => m.user_id === userId && m.role === "master");
  // Lets a master preview the read-only player experience without actually
  // demoting their role — same pattern as the board's "Ver como jogador"
  // toggle. Tree-creation and other master-only writes below check
  // `isActualMaster`, not this, so previewing never skips real setup work.
  const isMaster = isActualMaster && !viewAsPlayer;

  // One constellation per campaign for now — created lazily the first time
  // the master opens this area. (Multiple trees per campaign, e.g. one per
  // class/archetype, is a natural extension but not needed for a v1.)
  const { data: tree } = useQuery({
    queryKey: ["skill_tree", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("skill_trees")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("created_at")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as SkillTree | null;
    },
    enabled: !!campaignId,
  });

  useEffect(() => {
    if (tree || !isActualMaster || !userId || !campaignId) return;
    supabase
      .from("skill_trees")
      .insert({ campaign_id: campaignId, created_by: userId })
      .then(({ error }) => {
        if (error) toast.error("Não foi possível criar a árvore: " + error.message);
        else qc.invalidateQueries({ queryKey: ["skill_tree", campaignId] });
      });
  }, [tree, isActualMaster, userId, campaignId, qc]);

  const treeId = tree?.id ?? null;

  const { data: nodes = [] } = useQuery({
    queryKey: ["skill_nodes", treeId],
    queryFn: async () => {
      const { data, error } = await supabase.from("skill_nodes").select("*").eq("tree_id", treeId!);
      if (error) throw error;
      return data as SkillNode[];
    },
    enabled: !!treeId,
  });

  const { data: edges = [] } = useQuery({
    queryKey: ["skill_edges", treeId],
    queryFn: async () => {
      const { data, error } = await supabase.from("skill_edges").select("*").eq("tree_id", treeId!);
      if (error) throw error;
      return data as SkillEdge[];
    },
    enabled: !!treeId,
  });

  // Realtime: nodes/edges change live for everyone at the table (master
  // editing, or another player's unlock lighting up a shared prerequisite).
  useEffect(() => {
    if (!treeId) return;
    const channel = supabase
      .channel(`skill_tree:${treeId}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "skill_nodes", filter: `tree_id=eq.${treeId}` }, () =>
        qc.invalidateQueries({ queryKey: ["skill_nodes", treeId] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "skill_edges", filter: `tree_id=eq.${treeId}` }, () =>
        qc.invalidateQueries({ queryKey: ["skill_edges", treeId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [treeId, qc]);

  if (!campaign) {
    return (
      <div className="grid h-screen place-items-center text-muted-foreground">Abrindo sistema…</div>
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
            <Sparkles className="size-4 shrink-0 text-primary" strokeWidth={1.25} aria-hidden="true" />
            <h1 className="grimoire-title text-lg text-primary truncate max-w-[14rem] sm:max-w-[24rem]">
              Sistema — {campaign.name}
            </h1>
          </div>
          <nav className="ml-2 flex items-center gap-1 rounded-md bg-ink/50 p-0.5 text-xs">
            <Link
              to="/campaign/$campaignId/grimorio"
              params={{ campaignId }}
              className="flex items-center gap-1.5 rounded px-2.5 py-1 text-muted-foreground hover:text-primary"
            >
              <BookOpenText className="size-3.5" /> Livro
            </Link>
            <span className="flex items-center gap-1.5 rounded bg-primary/15 px-2.5 py-1 text-primary">
              <Sparkles className="size-3.5" /> Sistema
            </span>
          </nav>
          {isActualMaster && (
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
      </header>

      <div className="flex min-h-0 flex-1">
        {isMaster ? (
          <MasterTreeEditor campaignId={campaignId} treeId={treeId} nodes={nodes} edges={edges} />
        ) : (
          <PlayerTreeView campaignId={campaignId} userId={userId} nodes={nodes} edges={edges} />
        )}
      </div>
    </div>
  );
}

// ============================================================
// MASTER: free-canvas editor
// ============================================================
function MasterTreeEditor({
  campaignId,
  treeId,
  nodes,
  edges,
}: {
  campaignId: string;
  treeId: string | null;
  nodes: SkillNode[];
  edges: SkillEdge[];
}) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  const invalidateNodes = () => qc.invalidateQueries({ queryKey: ["skill_nodes", treeId] });
  const invalidateEdges = () => qc.invalidateQueries({ queryKey: ["skill_edges", treeId] });

  const createNode = async (x: number, y: number) => {
    if (!treeId) return;
    const { data, error } = await supabase
      .from("skill_nodes")
      .insert({ tree_id: treeId, x, y })
      .select()
      .single();
    if (error) toast.error("Não foi possível criar o nó: " + error.message);
    else {
      invalidateNodes();
      setSelectedId(data.id);
    }
  };

  // Optimistic local move so dragging feels immediate; the actual write
  // happens once on pointer-up (handleNodeDragEnd) to avoid hammering the DB.
  const handleNodeDragMove = (id: string, x: number, y: number) => {
    qc.setQueryData<SkillNode[]>(["skill_nodes", treeId], (old) =>
      old?.map((n) => (n.id === id ? { ...n, x, y } : n)),
    );
  };

  const handleNodeDragEnd = async (id: string, x: number, y: number) => {
    const { error } = await supabase.from("skill_nodes").update({ x, y }).eq("id", id);
    if (error) toast.error("Não foi possível salvar a posição: " + error.message);
  };

  const handleNodeClick = (id: string) => {
    if (connecting) {
      if (id === selectedId) return; // no self-links
      createEdge(selectedId!, id);
      setConnecting(false);
      return;
    }
    setSelectedId(id);
  };

  const createEdge = async (fromId: string, toId: string) => {
    if (!treeId) return;
    const { error } = await supabase
      .from("skill_edges")
      .insert({ tree_id: treeId, from_node_id: fromId, to_node_id: toId });
    if (error) {
      if (error.code === "23505") toast.error("Esses nós já estão conectados");
      else toast.error("Não foi possível conectar: " + error.message);
    } else {
      invalidateEdges();
    }
  };

  const handleEdgeClick = async (id: string) => {
    const { error } = await supabase.from("skill_edges").delete().eq("id", id);
    if (error) toast.error("Não foi possível remover a conexão: " + error.message);
    else invalidateEdges();
  };

  const saveNode = async (patch: Partial<SkillNode>) => {
    if (!selectedId) return;
    qc.setQueryData<SkillNode[]>(["skill_nodes", treeId], (old) =>
      old?.map((n) => (n.id === selectedId ? { ...n, ...patch } : n)),
    );
    const { error } = await supabase.from("skill_nodes").update(patch).eq("id", selectedId);
    if (error) toast.error("Não foi possível salvar: " + error.message);
  };

  const deleteNode = async () => {
    if (!selectedId) return;
    const { error } = await supabase.from("skill_nodes").delete().eq("id", selectedId);
    if (error) toast.error("Não foi possível excluir: " + error.message);
    else {
      setSelectedId(null);
      invalidateNodes();
      invalidateEdges();
    }
  };

  return (
    <>
      <main className="relative min-h-0 flex-1">
        <SkillTreeCanvas
          nodes={nodes}
          edges={edges}
          mode="edit"
          selectedNodeId={selectedId}
          pendingEdgeFrom={connecting ? selectedId : null}
          onNodeClick={handleNodeClick}
          onNodeDragMove={handleNodeDragMove}
          onNodeDragEnd={handleNodeDragEnd}
          onEdgeClick={handleEdgeClick}
          onCanvasDoubleClick={createNode}
        />
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <p className="rounded-full bg-ink-2/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
            Duplo clique no fundo para criar um nó · arraste para reposicionar · clique numa conexão para removê-la
          </p>
        </div>
      </main>
      {selectedNode && (
        <NodePanel
          node={selectedNode}
          connecting={connecting}
          onToggleConnect={() => setConnecting((c) => !c)}
          onSave={saveNode}
          onDelete={deleteNode}
          onClose={() => {
            setSelectedId(null);
            setConnecting(false);
          }}
        />
      )}
    </>
  );
}

// ============================================================
// PLAYER / TABLE: live, read-only view with unlockable nodes
// ============================================================
function PlayerTreeView({
  campaignId,
  userId,
  nodes,
  edges,
}: {
  campaignId: string;
  userId: string | null;
  nodes: SkillNode[];
  edges: SkillEdge[];
}) {
  const qc = useQueryClient();
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [creatingCharacter, setCreatingCharacter] = useState(false);

  const { data: characters = [] } = useQuery({
    queryKey: ["characters", "own", campaignId, userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("characters")
        .select("*")
        .eq("campaign_id", campaignId)
        .eq("owner_id", userId!)
        .order("name");
      if (error) throw error;
      return data as Character[];
    },
    enabled: !!userId && !!campaignId,
  });

  // Characters built from "Seus Personagens" (the personal library) have
  // campaign_id = null until brought into a table, so they never show up
  // here — this is the most common reason the picker looks empty even
  // though the player already has a sheet somewhere. Creating directly
  // from this page (same insert CharacterPanel uses on the board) sidesteps
  // that confusion entirely for the skill-tree flow.
  const createCharacter = async () => {
    if (!userId || !campaignId) return;
    setCreatingCharacter(true);
    const { data, error } = await supabase
      .from("characters")
      .insert({ campaign_id: campaignId, owner_id: userId, name: "Novo personagem" })
      .select()
      .single();
    setCreatingCharacter(false);
    if (error) {
      toast.error("Não foi possível criar o personagem: " + error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ["characters", "own", campaignId, userId] });
    setCharacterId(data.id);
  };

  useEffect(() => {
    if (!characterId && characters.length > 0) setCharacterId(characters[0].id);
  }, [characters, characterId]);

  const character = characters.find((c) => c.id === characterId) ?? null;

  const { data: unlocks = [] } = useQuery({
    queryKey: ["character_skill_unlocks", characterId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("character_skill_unlocks")
        .select("*")
        .eq("character_id", characterId!);
      if (error) throw error;
      return data;
    },
    enabled: !!characterId,
  });

  useEffect(() => {
    if (!characterId) return;
    const channel = supabase
      .channel(`char_unlocks:${characterId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "character_skill_unlocks", filter: `character_id=eq.${characterId}` },
        () => qc.invalidateQueries({ queryKey: ["character_skill_unlocks", characterId] }),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "characters", filter: `id=eq.${characterId}` },
        () => qc.invalidateQueries({ queryKey: ["characters", "own", campaignId, userId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [characterId, qc, campaignId, userId]);

  const unlockedNodeIds = useMemo(() => new Set(unlocks.map((u) => u.node_id)), [unlocks]);

  const unlockableNodeIds = useMemo(() => {
    const set = new Set<string>();
    const hasIncoming = new Set(edges.map((e) => e.to_node_id));
    for (const node of nodes) {
      if (unlockedNodeIds.has(node.id)) continue;
      const isRoot = !hasIncoming.has(node.id);
      const prereqMet = edges.some((e) => e.to_node_id === node.id && unlockedNodeIds.has(e.from_node_id));
      if (isRoot || prereqMet) set.add(node.id);
    }
    return set;
  }, [nodes, edges, unlockedNodeIds]);

  const handleUnlock = async (nodeId: string) => {
    if (!characterId) return;
    if (!unlockableNodeIds.has(nodeId)) return;
    const { error } = await supabase.rpc("unlock_skill_node", {
      _character_id: characterId,
      _node_id: nodeId,
    });
    if (error) {
      if (error.message.includes("Not enough")) toast.error("Pontos de habilidade insuficientes");
      else if (error.message.includes("Prerequisites")) toast.error("Pré-requisitos ainda não desbloqueados");
      else toast.error("Não foi possível desbloquear: " + error.message);
    } else {
      toast.success("Habilidade desbloqueada!");
      qc.invalidateQueries({ queryKey: ["character_skill_unlocks", characterId] });
      qc.invalidateQueries({ queryKey: ["characters", "own", campaignId, userId] });
    }
  };

  return (
    <main className="relative min-h-0 flex-1">
      <SkillTreeCanvas
        nodes={nodes}
        edges={edges}
        mode="view"
        unlockedNodeIds={unlockedNodeIds}
        unlockableNodeIds={unlockableNodeIds}
        onNodeClick={handleUnlock}
      />
      {characters.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-ink-2/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
            {/* Always a Select, even with a single character — a static
                label here reads as "nothing to pick", which is exactly the
                "I can't find where to link my character" confusion this
                page used to cause. */}
            <Select value={characterId ?? undefined} onValueChange={setCharacterId}>
              <SelectTrigger className="h-6 w-40 border-none bg-transparent px-1 text-xs">
                <SelectValue placeholder="Personagem" />
              </SelectTrigger>
              <SelectContent>
                {characters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {character && (
              <span className="flex items-center gap-1 text-primary">
                <Gem className="size-3.5" /> {character.skill_points_available} pts
              </span>
            )}
          </div>
        </div>
      )}
      {characters.length === 0 && (
        <div className="grid h-full place-items-center gap-3 text-center">
          <p className="text-sm italic text-ink/50">
            Você ainda não tem um personagem nessa mesa.
            <br />
            (Personagens da sua biblioteca não aparecem aqui até serem criados dentro desta mesa.)
          </p>
          <Button size="sm" onClick={createCharacter} disabled={creatingCharacter || !userId}>
            {creatingCharacter ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 size-3.5" />
            )}
            Criar personagem nessa mesa
          </Button>
        </div>
      )}
    </main>
  );
}