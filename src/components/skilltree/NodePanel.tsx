import { useEffect, useState } from "react";
import type { SkillNode, SkillNodeColor } from "@/lib/board-types";
import { SKILL_NODE_COLORS } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Link2, X } from "lucide-react";

interface Props {
  node: SkillNode;
  connecting: boolean;
  onToggleConnect: () => void;
  onSave: (patch: Partial<Pick<SkillNode, "title" | "description" | "cost" | "color" | "effect">>) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function NodePanel({ node, connecting, onToggleConnect, onSave, onDelete, onClose }: Props) {
  const [title, setTitle] = useState(node.title);
  const [description, setDescription] = useState(node.description ?? "");
  const [cost, setCost] = useState(String(node.cost));
  const [effectText, setEffectText] = useState(
    (node.effect as { text?: string } | null)?.text ?? "",
  );

  // Selecting a different node resets local draft state to that node's values.
  useEffect(() => {
    setTitle(node.title);
    setDescription(node.description ?? "");
    setCost(String(node.cost));
    setEffectText((node.effect as { text?: string } | null)?.text ?? "");
  }, [node.id]);

  const commit = () => {
    const parsedCost = Math.max(0, Number.parseInt(cost, 10) || 0);
    onSave({
      title: title.trim() || "Novo nó",
      description: description.trim() || null,
      cost: parsedCost,
      effect: effectText.trim() ? { text: effectText.trim() } : {},
    });
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 border-l border-primary/15 bg-ink-2/80 p-4 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <h2 className="grimoire-title text-sm text-primary">Nó da árvore</h2>
        <button onClick={onClose} className="grid size-6 place-items-center rounded text-muted-foreground hover:text-primary" aria-label="Fechar">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Título</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={commit} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Descrição</Label>
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={commit} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">O que desbloqueia (efeito na ficha)</Label>
        <Textarea
          rows={2}
          placeholder="ex: +2 em testes de Furtividade"
          value={effectText}
          onChange={(e) => setEffectText(e.target.value)}
          onBlur={commit}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Custo (pontos)</Label>
        <Input
          type="number"
          min={0}
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          onBlur={commit}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Cor</Label>
        <div className="flex gap-2">
          {(Object.keys(SKILL_NODE_COLORS) as SkillNodeColor[]).map((c) => (
            <button
              key={c}
              onClick={() => onSave({ color: c })}
              title={SKILL_NODE_COLORS[c].label}
              className="size-7 rounded-full ring-offset-2 ring-offset-ink-2 transition-shadow"
              style={{
                backgroundColor: SKILL_NODE_COLORS[c].glow,
                boxShadow: node.color === c ? `0 0 0 2px ${SKILL_NODE_COLORS[c].glow}` : "none",
              }}
            />
          ))}
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-2 border-t border-primary/10 pt-4">
        <Button
          variant={connecting ? "default" : "outline"}
          size="sm"
          className="justify-start gap-2"
          onClick={onToggleConnect}
        >
          <Link2 className="size-3.5" />
          {connecting ? "Clique no outro nó…" : "Conectar a outro nó"}
        </Button>
        <Button variant="outline" size="sm" className="justify-start gap-2 text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="size-3.5" />
          Excluir nó
        </Button>
      </div>
    </aside>
  );
}
