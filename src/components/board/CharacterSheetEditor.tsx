import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Character, DiceRoll } from "@/lib/board-types";
import {
  FIELD_PALETTE,
  makeField,
  makeTab,
  normalizeSheet,
  rollFormula,
  type FieldType,
  type SheetField,
  type SheetTab,
} from "@/lib/character-sheet-types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, Trash2, Dices, Eye, EyeOff, Loader2, X } from "lucide-react";
import { toast } from "sonner";

interface Props {
  /** null when opened from the personal library, outside any campaign. */
  campaignId: string | null;
  character: Character | null;
  onOpenChange: (open: boolean) => void;
  /** Owner of the character, or the campaign master, may edit layout + values. */
  canEdit: boolean;
}

export function CharacterSheetEditor({ campaignId, character, onOpenChange, canEdit }: Props) {
  const qc = useQueryClient();
  const [tabs, setTabs] = useState<SheetTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [name, setName] = useState("");

  // The drawer is driven by `character` from the parent's cached list, so we
  // mirror it into local state on open/switch rather than re-fetching —
  // consistent with how the rest of the app treats React Query as the source
  // of truth and only patches on explicit save.
  useEffect(() => {
    if (character) {
      const normalized = normalizeSheet(character.sheet);
      setTabs(normalized);
      setActiveTabId((prev) =>
        normalized.some((t) => t.id === prev) ? prev : normalized[0].id,
      );
      setName(character.name);
    }
  }, [character]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const fields = activeTab?.fields ?? [];
  // Dice formulas can reference fields from any tab (e.g. an attack in
  // "Combate" using a modifier from "Atributos"), so rolling resolves
  // against every field on the sheet, not just the active tab's.
  const allFields = tabs.flatMap((t) => t.fields);

  const { data: rolls = [] } = useQuery({
    queryKey: ["dice_rolls", character?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dice_rolls")
        .select("*")
        .eq("character_id", character!.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as DiceRoll[];
    },
    enabled: !!character,
  });

  useEffect(() => {
    if (!character) return;
    const characterId = character.id;
    const channel = supabase
      .channel(`dice_rolls:${characterId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "dice_rolls", filter: `character_id=eq.${characterId}` },
        () => qc.invalidateQueries({ queryKey: ["dice_rolls", characterId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // Deliberately keyed on the id, not the whole `character` object: that
    // object gets a new reference on every edit to this same character
    // (rename, toggle, add field...), and re-subscribing on every keystroke
    // was piling up realtime connections faster than they could tear down —
    // the app-wide slowdown that needed a page reload to clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character?.id, qc]);

  const persist = useMutation({
    mutationFn: async (patch: { name?: string; sheet?: SheetTab[] }) => {
      if (!character) return;
      const { error } = await supabase
        .from("characters")
        .update({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.sheet !== undefined ? { sheet: patch.sheet as unknown as never } : {}),
        })
        .eq("id", character.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["characters"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleVisibility = async () => {
    if (!character) return;
    const { error } = await supabase
      .from("characters")
      .update({ visible_to_players: !character.visible_to_players })
      .eq("id", character.id);
    if (error) toast.error(error.message);
    else qc.invalidateQueries({ queryKey: ["characters"] });
  };

  const deleteCharacter = async () => {
    if (!character) return;
    if (!confirm(`Apagar "${character.name}"? Isso remove a ficha e o token da mesa.`)) return;
    const { error } = await supabase.from("characters").delete().eq("id", character.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["characters"] });
    if (campaignId) qc.invalidateQueries({ queryKey: ["board_objects", campaignId] });
    onOpenChange(false);
  };

  const addField = (type: FieldType) => {
    const field = makeField(type, crypto.randomUUID().slice(0, 8));
    const next = tabs.map((t) => (t.id === activeTabId ? { ...t, fields: [...t.fields, field] } : t));
    setTabs(next);
    persist.mutate({ sheet: next });
  };

  const updateField = (id: string, patch: Partial<SheetField>) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, fields: t.fields.map((f) => (f.id === id ? ({ ...f, ...patch } as SheetField) : f)) }
          : t,
      ),
    );
  };

  const removeField = (id: string) => {
    const next = tabs.map((t) =>
      t.id === activeTabId ? { ...t, fields: t.fields.filter((f) => f.id !== id) } : t,
    );
    setTabs(next);
    persist.mutate({ sheet: next });
  };

  const addTab = () => {
    const tab = makeTab("Nova aba", crypto.randomUUID().slice(0, 8));
    const next = [...tabs, tab];
    setTabs(next);
    setActiveTabId(tab.id);
    persist.mutate({ sheet: next });
  };

  const renameTab = (id: string, name: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  };

  const removeTab = (id: string) => {
    if (tabs.length <= 1) {
      toast.error("A ficha precisa de pelo menos uma aba.");
      return;
    }
    if (!confirm("Apagar esta aba e todos os campos dentro dela?")) return;
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (activeTabId === id) setActiveTabId(next[0].id);
    persist.mutate({ sheet: next });
  };

  const roll = async (field: SheetField) => {
    if (field.type !== "dice" || !character) return;
    const result = rollFormula(field.formula, allFields);
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) return;
    const { error } = await supabase.from("dice_rolls").insert({
      campaign_id: campaignId,
      character_id: character.id,
      roller_id: userRes.user.id,
      label: `${character.name} — ${field.label}`,
      formula: result.formula,
      total: result.total,
      breakdown: result.breakdown as unknown as never,
    });
    if (error) toast.error(error.message);
  };

  return (
    <Sheet open={!!character} onOpenChange={onOpenChange}>
      <SheetContent side="fullscreen" className="gold-frame overflow-y-auto p-0">
        {character && (
          <div className="mx-auto flex min-h-full max-w-5xl flex-col px-6 py-8 sm:px-10">
            <SheetHeader className="space-y-1 text-left">
              <SheetTitle className="grimoire-title text-primary">
                {canEdit ? (
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => name.trim() && persist.mutate({ name: name.trim() })}
                    className="border-none bg-transparent px-0 text-2xl font-normal shadow-none focus-visible:ring-0"
                  />
                ) : (
                  <span className="text-2xl">{character.name}</span>
                )}
              </SheetTitle>
              <SheetDescription>Ficha de personagem — totalmente customizável.</SheetDescription>
            </SheetHeader>

            {canEdit && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="text-xs">
                      <Plus className="mr-1 size-3.5" /> Adicionar campo
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {FIELD_PALETTE.map((p) => (
                      <DropdownMenuItem key={p.type} onClick={() => addField(p.type)}>
                        <span className="mr-2 w-4 text-center">{p.icon}</span>
                        {p.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button size="sm" variant="ghost" onClick={toggleVisibility} className="text-xs">
                  {character.visible_to_players ? (
                    <>
                      <Eye className="mr-1 size-3.5" /> Visível
                    </>
                  ) : (
                    <>
                      <EyeOff className="mr-1 size-3.5" /> Oculta
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={deleteCharacter}
                  className="ml-auto text-xs text-destructive hover:text-destructive"
                >
                  <Trash2 className="mr-1 size-3.5" /> Apagar
                </Button>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-1.5 border-b border-primary/10 pb-2">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`group flex items-center gap-1 rounded-t px-3 py-1.5 text-xs font-medium transition-colors ${
                    tab.id === activeTabId
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-primary/5 hover:text-primary"
                  }`}
                >
                  {canEdit && tab.id === activeTabId ? (
                    <Input
                      value={tab.name}
                      onChange={(e) => renameTab(tab.id, e.target.value)}
                      onBlur={() => tab.name.trim() && persist.mutate({ sheet: tabs })}
                      className="h-5 w-24 border-none bg-transparent px-0 text-xs font-medium shadow-none focus-visible:ring-0"
                    />
                  ) : (
                    <button onClick={() => setActiveTabId(tab.id)}>{tab.name}</button>
                  )}
                  {canEdit && tabs.length > 1 && (
                    <button
                      onClick={() => removeTab(tab.id)}
                      aria-label={`Apagar aba ${tab.name}`}
                      className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              ))}
              {canEdit && (
                <button
                  onClick={addTab}
                  className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-primary/5 hover:text-primary"
                  title="Nova aba/categoria"
                >
                  <Plus className="size-3.5" />
                </button>
              )}
            </div>

            <div className="mt-6 grid flex-1 grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
              <div className="space-y-3">
                {fields.length === 0 && (
                  <p className="py-6 text-center text-xs italic text-muted-foreground">
                    {canEdit
                      ? "Aba em branco. Use “Adicionar campo” para montar do seu jeito."
                      : "Esta aba ainda não tem campos."}
                  </p>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {fields.map((field) => (
                    <div
                      key={field.id}
                      className={field.type === "section" ? "sm:col-span-2" : undefined}
                    >
                      <FieldRow
                        field={field}
                        canEdit={canEdit}
                        onChange={(patch) => updateField(field.id, patch)}
                        onBlurSave={() => persist.mutate({ sheet: tabs })}
                        onRemove={() => removeField(field.id)}
                        onRoll={() => roll(field)}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="lg:border-l lg:border-primary/10 lg:pl-6">
                <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-primary/70">
                  <Dices className="size-3.5" /> Histórico de rolagens
                </h3>
                <div className="scrollbar-arcane max-h-[70vh] space-y-1.5 overflow-y-auto pr-1">
                  {rolls.length === 0 && (
                    <p className="text-xs italic text-muted-foreground">Nenhuma rolagem ainda.</p>
                  )}
                  {rolls.map((r) => (
                    <div
                      key={r.id}
                      className="rounded border border-primary/10 bg-ink-2/40 px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{r.label ?? r.formula}</span>
                        <span className="font-serif text-base font-bold text-primary">
                          {r.total}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground/70">
                        {r.formula} ·{" "}
                        {(
                          r.breakdown as unknown as { die?: string; rolls?: number[]; mod?: number }[]
                        )
                          .map((b) => (b.die ? `${b.die}[${b.rolls?.join(",")}]` : `${b.mod}`))
                          .join(" + ")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function FieldRow({
  field,
  canEdit,
  onChange,
  onBlurSave,
  onRemove,
  onRoll,
}: {
  field: SheetField;
  canEdit: boolean;
  onChange: (patch: Partial<SheetField>) => void;
  onBlurSave: () => void;
  onRemove: () => void;
  onRoll: () => void;
}) {
  if (field.type === "section") {
    return (
      <div className="group flex items-center gap-2 pt-2">
        {canEdit ? (
          <Input
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            onBlur={onBlurSave}
            className="border-none bg-transparent px-0 text-xs font-semibold uppercase tracking-widest text-primary/80 shadow-none focus-visible:ring-0"
          />
        ) : (
          <span className="text-xs font-semibold uppercase tracking-widest text-primary/80">
            {field.label}
          </span>
        )}
        <div className="h-px flex-1 bg-primary/15" />
        {canEdit && <RemoveBtn onRemove={onRemove} />}
      </div>
    );
  }

  return (
    <div className="group rounded-md border border-primary/10 bg-ink-2/30 p-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        {canEdit ? (
          <Input
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            onBlur={onBlurSave}
            className="h-6 border-none bg-transparent px-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground shadow-none focus-visible:ring-0"
          />
        ) : (
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {field.label}
          </span>
        )}
        {canEdit && <RemoveBtn onRemove={onRemove} />}
      </div>

      {field.type === "text" && (
        <Input
          value={field.value}
          onChange={(e) => onChange({ value: e.target.value })}
          onBlur={onBlurSave}
        />
      )}

      {field.type === "textarea" && (
        <Textarea
          value={field.value}
          onChange={(e) => onChange({ value: e.target.value })}
          onBlur={onBlurSave}
          rows={3}
        />
      )}

      {field.type === "number" && (
        <Input
          type="number"
          value={field.value}
          onChange={(e) => onChange({ value: Number(e.target.value) })}
          onBlur={onBlurSave}
        />
      )}

      {field.type === "resource" && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={field.value}
            onChange={(e) => onChange({ value: Number(e.target.value) })}
            onBlur={onBlurSave}
            className="w-20"
          />
          <span className="text-muted-foreground">/</span>
          <Input
            type="number"
            value={field.max}
            onChange={(e) => onChange({ max: Number(e.target.value) })}
            onBlur={onBlurSave}
            className="w-20"
          />
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-2">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.max(0, Math.min(100, (field.value / (field.max || 1)) * 100))}%` }}
            />
          </div>
        </div>
      )}

      {field.type === "checkbox" && (
        <Checkbox
          checked={field.value}
          onCheckedChange={(v) => {
            onChange({ value: !!v });
            onBlurSave();
          }}
        />
      )}

      {field.type === "select" && (
        <div className="space-y-1.5">
          <Input
            value={field.value}
            onChange={(e) => onChange({ value: e.target.value })}
            onBlur={onBlurSave}
            placeholder="Valor atual"
          />
          {canEdit && (
            <Input
              defaultValue={field.options.join(", ")}
              onBlur={(e) => {
                onChange({ options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) });
                onBlurSave();
              }}
              placeholder="Opções, separadas por vírgula"
              className="text-[11px] text-muted-foreground"
            />
          )}
        </div>
      )}

      {field.type === "list" && (
        <Textarea
          value={field.items.join("\n")}
          onChange={(e) => onChange({ items: e.target.value.split("\n") })}
          onBlur={onBlurSave}
          rows={3}
          placeholder="Um item por linha"
        />
      )}

      {field.type === "image" && (
        <Input
          value={field.storagePath ?? ""}
          onChange={(e) => onChange({ storagePath: e.target.value })}
          onBlur={onBlurSave}
          placeholder="URL da imagem"
        />
      )}

      {field.type === "dice" && (
        <div className="flex items-center gap-2">
          <Input
            value={field.formula}
            onChange={(e) => onChange({ formula: e.target.value })}
            onBlur={onBlurSave}
            placeholder="1d20+{forca}"
            className="font-mono text-xs"
          />
          <Button size="sm" onClick={onRoll} className="shrink-0">
            <Dices className="mr-1 size-3.5" /> Rolar
          </Button>
        </div>
      )}
    </div>
  );
}

function RemoveBtn({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      onClick={onRemove}
      aria-label="Remover campo"
      className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}
