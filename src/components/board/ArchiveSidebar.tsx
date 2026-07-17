import { useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Folder, FileRow, BoardObject, Character } from "@/lib/board-types";
import { FOLDER_ICONS } from "@/lib/board-types";
import { CharacterPanel } from "@/components/board/CharacterPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronRight,
  Plus,
  Trash2,
  FolderPlus,
  FilePlus2,
  Upload,
  Loader2,
  Layers,
  BookOpenText,
  ChevronsUp,
  ChevronsDown,
  Eye,
  EyeOff,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";

interface Props {
  campaignId: string;
  folders: Folder[];
  files: FileRow[];
  /** Board objects currently on the table, used by the "Camadas" tab so the
   * front/back (overlap) controls that live on each object's hover toolbar
   * in BoardCanvas are also reachable from here — handy once a scene has
   * several stacked objects and hovering the right one gets fiddly. */
  objects?: BoardObject[];
  isMaster: boolean;
  /** Native HTML5 drag-and-drop (draggable/dataTransfer) has no touch
   * equivalent in any mobile browser, so on mobile we fall back to
   * tap-to-add instead of drag-to-drop. */
  isMobile?: boolean;
  onAddFile?: (fileId: string) => void;
  characters?: Character[];
  currentUserId?: string | null;
  onOpenCharacter?: (character: Character) => void;
  onAddCharacterToBoard?: (characterId: string) => void;
  /** Owned by the campaign page — see the matching comment on BoardCanvas's
   * Props for why these replaced this panel's own direct Supabase calls. */
  onReorder?: (obj: BoardObject, dir: "front" | "back") => void;
  onToggleVisibility?: (obj: BoardObject) => void;
  onRemoveObject?: (obj: BoardObject) => void;
}

const KIND_GLYPH: Record<string, string> = {
  pin: "•",
  map: "✧",
  image: "✧",
  document: "❦",
  sheet: "❦",
};

function kindLabel(kind: string): string {
  switch (kind) {
    case "pin":
      return "Pin";
    case "map":
      return "Mapa";
    case "image":
      return "Imagem";
    case "sheet":
      return "Ficha";
    default:
      return "Pergaminho";
  }
}

// Uploads land in a shared Storage bucket and are later rendered as <img>
// (for images) or offered for reference (for documents) to everyone in the
// campaign, so we validate both size and MIME type client-side before
// spending an upload round-trip. (Server-side, Storage/RLS still constrain
// who can write to a given campaign's path — this is a UX/cost guard, not
// the security boundary.)
const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024; // 15MB
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function ArchiveSidebar({
  campaignId,
  folders,
  files,
  objects = [],
  isMaster,
  isMobile = false,
  onAddFile,
  characters = [],
  currentUserId = null,
  onOpenCharacter,
  onAddCharacterToBoard,
  onReorder,
  onToggleVisibility,
  onRemoveObject,
}: Props) {
  const qc = useQueryClient();
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [targetParent, setTargetParent] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"archive" | "layers" | "characters">("archive");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reorder/visibility/remove are owned by the campaign page now (onReorder,
  // onToggleVisibility, onRemoveObject) — they patch the query cache
  // immediately instead of writing here and waiting for Realtime to loop
  // back, which is what made this panel feel laggy before.

  const [folderName, setFolderName] = useState("");
  const [folderIcon, setFolderIcon] = useState("moon");

  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileFolderId, setFileFolderId] = useState<string>("__root");

  const createFolder = useMutation({
    mutationFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("folders").insert({
        campaign_id: campaignId,
        parent_id: targetParent,
        name: folderName.trim(),
        icon: folderIcon,
        created_by: userRes.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Pasta criada.");
      setNewFolderOpen(false);
      setFolderName("");
      qc.invalidateQueries({ queryKey: ["folders", campaignId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createFile = useMutation({
    mutationFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("files").insert({
        campaign_id: campaignId,
        folder_id: fileFolderId === "__root" ? null : fileFolderId,
        name: fileName.trim(),
        kind: "document",
        icon: "scroll",
        content: fileContent,
        created_by: userRes.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Pergaminho selado.");
      setNewFileOpen(false);
      setFileName("");
      setFileContent("");
      qc.invalidateQueries({ queryKey: ["files", campaignId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Deleting a file only removes the `files` row — board_objects.file_id is
  // ON DELETE SET NULL, not CASCADE, and each board object also keeps its
  // own copy of storage_path in `data` (captured at drop time), completely
  // independent of the files row. So without this, removing a file from the
  // archive left any copy already placed on the board dangling forever
  // (map/image kept rendering, since neither the object row nor the actual
  // file in Storage were ever touched).
  const deleteFilesEverywhere = async (fileIds: string[], storagePaths: (string | null)[]) => {
    if (fileIds.length === 0) return;
    const { error: boErr } = await supabase.from("board_objects").delete().in("file_id", fileIds);
    if (boErr) throw new Error("Não foi possível remover da mesa: " + boErr.message);
    const paths = storagePaths.filter((p): p is string => !!p);
    if (paths.length > 0) {
      // Best-effort: if this fails we still want the DB rows gone, so we
      // don't block on it — just leaves an orphaned blob in Storage rather
      // than a broken reference in the app.
      await supabase.storage.from("campaign-assets").remove(paths);
    }
  };

  const deleteItem = async (kind: "folder" | "file", id: string) => {
    try {
      if (kind === "file") {
        const file = files.find((f) => f.id === id);
        await deleteFilesEverywhere([id], [file?.storage_path ?? null]);
      } else {
        // Collect this folder + every nested subfolder, then every file
        // inside any of them, so a folder delete cleans up the board the
        // same way a single-file delete now does.
        const folderIds = new Set([id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const f of folders) {
            if (f.parent_id && folderIds.has(f.parent_id) && !folderIds.has(f.id)) {
              folderIds.add(f.id);
              grew = true;
            }
          }
        }
        const filesInside = files.filter((f) => f.folder_id && folderIds.has(f.folder_id));
        await deleteFilesEverywhere(
          filesInside.map((f) => f.id),
          filesInside.map((f) => f.storage_path),
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return;
    }
    const table = kind === "folder" ? "folders" : "files";
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) toast.error(error.message);
    else {
      toast.success("Removido.");
      qc.invalidateQueries({ queryKey: [kind === "folder" ? "folders" : "files", campaignId] });
      qc.invalidateQueries({ queryKey: ["board_objects", campaignId] });
    }
  };

  const uploadFile = async (file: File) => {
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      toast.error(
        `Arquivo muito grande (${formatBytes(file.size)}). O limite é ${formatBytes(MAX_UPLOAD_SIZE_BYTES)}.`,
      );
      return;
    }
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.type)) {
      toast.error(
        "Tipo de arquivo não suportado. Envie imagens (PNG, JPEG, WEBP, GIF), PDF ou texto.",
      );
      return;
    }
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) return;
    const ext = file.name.split(".").pop() ?? "bin";
    const path = `${campaignId}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("campaign-assets")
      .upload(path, file, { cacheControl: "3600" });
    if (upErr) return toast.error(upErr.message);
    const kind = file.type.startsWith("image/") ? "image" : "document";
    const { error } = await supabase.from("files").insert({
      campaign_id: campaignId,
      folder_id: null,
      name: file.name,
      kind: kind as "image" | "document",
      icon: kind === "image" ? "map" : "scroll",
      storage_path: path,
      created_by: userRes.user.id,
    });
    if (error) return toast.error(error.message);
    toast.success("Arquivo arquivado.");
    qc.invalidateQueries({ queryKey: ["files", campaignId] });
  };

  const rootFolders = folders.filter((f) => f.parent_id === null);
  const rootFiles = files.filter((f) => f.folder_id === null);

  const onDragFile = (e: React.DragEvent, fileId: string) => {
    e.dataTransfer.setData("text/file-id", fileId);
    e.dataTransfer.effectAllowed = "copyMove";
  };

  // Drag a file card onto a folder (or onto empty space, for the root) to
  // reorganize it — previously the only way to move a file between folders
  // was to delete it and re-upload into the right one.
  const moveFileToFolder = async (fileId: string, folderId: string | null) => {
    const { error } = await supabase.from("files").update({ folder_id: folderId }).eq("id", fileId);
    if (error) toast.error("Não foi possível mover o arquivo: " + error.message);
    else qc.invalidateQueries({ queryKey: ["files", campaignId] });
  };

  return (
    <aside className="flex h-full w-80 max-w-[85vw] shrink-0 flex-col border-l border-primary/15 bg-ink-2/60 backdrop-blur-md">
      <div className="border-b border-primary/15 p-4">
        <h2 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-primary/70">
          Arquivo Arcano
        </h2>
        <p className="grimoire-title text-base italic text-foreground/80">Cloud Archive</p>
      </div>

      <div role="tablist" aria-label="Painéis da mesa" className="flex border-b border-primary/10">
        <button
          role="tab"
          aria-selected={activeTab === "archive"}
          onClick={() => setActiveTab("archive")}
          className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium uppercase tracking-widest transition-colors ${
            activeTab === "archive"
              ? "border-b-2 border-primary text-primary"
              : "border-b-2 border-transparent text-muted-foreground hover:text-primary"
          }`}
        >
          <BookOpenText className="size-3.5" aria-hidden="true" />
          Arquivo
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "characters"}
          onClick={() => setActiveTab("characters")}
          className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium uppercase tracking-widest transition-colors ${
            activeTab === "characters"
              ? "border-b-2 border-primary text-primary"
              : "border-b-2 border-transparent text-muted-foreground hover:text-primary"
          }`}
        >
          <UsersRound className="size-3.5" aria-hidden="true" />
          Personagens
        </button>
        {isMaster && (
          <button
            role="tab"
            aria-selected={activeTab === "layers"}
            onClick={() => setActiveTab("layers")}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium uppercase tracking-widest transition-colors ${
              activeTab === "layers"
                ? "border-b-2 border-primary text-primary"
                : "border-b-2 border-transparent text-muted-foreground hover:text-primary"
            }`}
          >
            <Layers className="size-3.5" aria-hidden="true" />
            Camadas
          </button>
        )}
      </div>

      {activeTab === "characters" ? (
        <CharacterPanel
          campaignId={campaignId}
          characters={characters}
          currentUserId={currentUserId}
          isMaster={isMaster}
          isMobile={isMobile}
          onOpenCharacter={(c) => onOpenCharacter?.(c)}
          onAddCharacterToBoard={onAddCharacterToBoard}
        />
      ) : activeTab === "layers" && isMaster ? (
        <div className="scrollbar-arcane flex-1 overflow-y-auto p-3">
          <p className="mb-3 px-1 text-[10px] leading-relaxed text-muted-foreground">
            Ordem de sobreposição da mesa — o topo da lista é o que fica na frente. Use as setas
            para reordenar.
          </p>
          <div className="space-y-1">
            {objects
              .slice()
              .sort((a, b) => b.z_index - a.z_index)
              .map((obj) => (
                <div
                  key={obj.id}
                  className="group flex items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground ring-1 ring-transparent hover:bg-primary/5 hover:text-primary hover:ring-primary/10"
                >
                  <span aria-hidden="true" className="shrink-0 text-primary/60">
                    {KIND_GLYPH[obj.kind] ?? "◆"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{obj.label || "Sem nome"}</div>
                    <div className="text-[9px] uppercase tracking-widest text-muted-foreground/70">
                      {kindLabel(obj.kind)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      onClick={() => onToggleVisibility?.(obj)}
                      aria-label={
                        obj.visible_to_players ? "Ocultar dos jogadores" : "Mostrar aos jogadores"
                      }
                      title={
                        obj.visible_to_players ? "Ocultar dos jogadores" : "Mostrar aos jogadores"
                      }
                      className="grid size-6 place-items-center rounded hover:bg-primary/10 hover:text-primary"
                    >
                      {obj.visible_to_players ? (
                        <Eye className="size-3.5" aria-hidden="true" />
                      ) : (
                        <EyeOff className="size-3.5" aria-hidden="true" />
                      )}
                    </button>
                    <button
                      onClick={() => onReorder?.(obj, "back")}
                      aria-label="Mandar para trás"
                      title="Mandar para trás"
                      className="grid size-6 place-items-center rounded hover:bg-primary/10 hover:text-primary"
                    >
                      <ChevronsDown className="size-3.5" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => onReorder?.(obj, "front")}
                      aria-label="Trazer para frente"
                      title="Trazer para frente"
                      className="grid size-6 place-items-center rounded hover:bg-primary/10 hover:text-primary"
                    >
                      <ChevronsUp className="size-3.5" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => onRemoveObject?.(obj)}
                      aria-label={`Remover ${obj.label || "objeto"} da mesa`}
                      title="Remover da mesa"
                      className="grid size-6 place-items-center rounded hover:bg-destructive/20 hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            {objects.length === 0 && (
              <div className="py-8 text-center text-xs text-muted-foreground italic">
                Nada na mesa ainda.
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {isMaster && (
            <div className="flex gap-1 border-b border-primary/10 p-3">
              <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
                <DialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1 text-xs text-primary/80 hover:bg-primary/10 hover:text-primary"
                    onClick={() => setTargetParent(null)}
                  >
                    <FolderPlus className="mr-1.5 size-3.5" />
                    Pasta
                  </Button>
                </DialogTrigger>
                <DialogContent className="gold-frame">
                  <DialogHeader>
                    <DialogTitle className="grimoire-title text-primary">Nova pasta</DialogTitle>
                    <DialogDescription>Organize seu grimório em capítulos.</DialogDescription>
                  </DialogHeader>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!folderName.trim()) return;
                      createFolder.mutate();
                    }}
                    className="space-y-4"
                  >
                    <div className="space-y-2">
                      <Label htmlFor="fn">Nome</Label>
                      <Input
                        id="fn"
                        value={folderName}
                        onChange={(e) => setFolderName(e.target.value)}
                        required
                        autoFocus
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Ícone</Label>
                      <div className="grid grid-cols-7 gap-2">
                        {Object.entries(FOLDER_ICONS).map(([key, glyph]) => (
                          <button
                            type="button"
                            key={key}
                            onClick={() => setFolderIcon(key)}
                            className={`grid aspect-square place-items-center rounded font-serif text-lg transition-all ${
                              folderIcon === key
                                ? "bg-primary/20 text-primary ring-1 ring-primary/50"
                                : "bg-ink-2/60 text-muted-foreground hover:text-primary hover:bg-primary/10"
                            }`}
                          >
                            {glyph}
                          </button>
                        ))}
                      </div>
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={createFolder.isPending}>
                        {createFolder.isPending ? (
                          <>
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            <span className="sr-only">Criando…</span>
                          </>
                        ) : (
                          "Criar"
                        )}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>

              <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
                <DialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1 text-xs text-primary/80 hover:bg-primary/10 hover:text-primary"
                  >
                    <FilePlus2 className="mr-1.5 size-3.5" />
                    Documento
                  </Button>
                </DialogTrigger>
                <DialogContent className="gold-frame max-w-lg">
                  <DialogHeader>
                    <DialogTitle className="grimoire-title text-primary">
                      Novo pergaminho
                    </DialogTitle>
                    <DialogDescription>Lore, regras, fichas — texto livre.</DialogDescription>
                  </DialogHeader>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!fileName.trim()) return;
                      createFile.mutate();
                    }}
                    className="space-y-4"
                  >
                    <div className="space-y-2">
                      <Label htmlFor="doc-name">Título</Label>
                      <Input
                        id="doc-name"
                        value={fileName}
                        onChange={(e) => setFileName(e.target.value)}
                        required
                        autoFocus
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Pasta</Label>
                      <Select value={fileFolderId} onValueChange={setFileFolderId}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__root">Raiz</SelectItem>
                          {folders.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {FOLDER_ICONS[f.icon] ?? "◆"} {f.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="doc-body">Conteúdo</Label>
                      <Textarea
                        id="doc-body"
                        value={fileContent}
                        onChange={(e) => setFileContent(e.target.value)}
                        rows={10}
                        className="grimoire-title text-base"
                        placeholder="Escreva a lore, regras, notas do NPC…"
                      />
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={createFile.isPending}>
                        {createFile.isPending ? (
                          <>
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            <span className="sr-only">Selando…</span>
                          </>
                        ) : (
                          "Selar"
                        )}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          )}

          <div
            className="scrollbar-arcane flex-1 overflow-y-auto p-3"
            onDragOver={(e) => {
              if (isMaster) e.preventDefault();
            }}
            onDrop={(e) => {
              if (!isMaster) return;
              const fileId = e.dataTransfer.getData("text/file-id");
              if (fileId) moveFileToFolder(fileId, null);
            }}
          >
            <div className="space-y-0.5">
              {rootFolders.map((f) => (
                <FolderNode
                  key={f.id}
                  folder={f}
                  folders={folders}
                  files={files}
                  open={openFolders}
                  setOpen={setOpenFolders}
                  isMaster={isMaster}
                  onDeleteFolder={(id) => deleteItem("folder", id)}
                  onDeleteFile={(id) => deleteItem("file", id)}
                  onDragFile={onDragFile}
                  onMoveFile={moveFileToFolder}
                  isMobile={isMobile}
                  onAddFile={onAddFile}
                  depth={0}
                />
              ))}
              {rootFiles.map((f) => (
                <FileNode
                  key={f.id}
                  file={f}
                  isMaster={isMaster}
                  onDelete={() => deleteItem("file", f.id)}
                  onDragFile={onDragFile}
                  isMobile={isMobile}
                  onAddFile={onAddFile}
                  depth={0}
                />
              ))}
              {rootFolders.length === 0 && rootFiles.length === 0 && (
                <div className="py-8 text-center text-xs text-muted-foreground italic">
                  Grimório em branco.
                </div>
              )}
            </div>
          </div>

          {isMaster && (
            <div className="p-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="group flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary/15 p-6 transition-all hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="grid size-8 place-items-center rounded-full border border-primary/25 text-primary/50 group-hover:text-primary">
                  <Upload className="size-4" />
                </div>
                <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground group-hover:text-primary">
                  Arquivar imagem / mapa
                </span>
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function FolderNode({
  folder,
  folders,
  files,
  open,
  setOpen,
  isMaster,
  onDeleteFolder,
  onDeleteFile,
  onDragFile,
  onMoveFile,
  isMobile = false,
  onAddFile,
  depth,
}: {
  folder: Folder;
  folders: Folder[];
  files: FileRow[];
  open: Record<string, boolean>;
  setOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  isMaster: boolean;
  onDeleteFolder: (id: string) => void;
  onDeleteFile: (id: string) => void;
  onDragFile: (e: React.DragEvent, fileId: string) => void;
  onMoveFile: (fileId: string, folderId: string | null) => void;
  isMobile?: boolean;
  onAddFile?: (fileId: string) => void;
  depth: number;
}) {
  const isOpen = open[folder.id] ?? true;
  const children = folders.filter((f) => f.parent_id === folder.id);
  const childFiles = files.filter((f) => f.folder_id === folder.id);
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div>
      <div
        className={`group flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-primary/5 hover:text-primary ${
          isDragOver ? "bg-primary/15 text-primary ring-1 ring-primary/40" : ""
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onDragOver={(e) => {
          if (!isMaster) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          if (!isMaster) return;
          e.preventDefault();
          e.stopPropagation();
          setIsDragOver(false);
          const fileId = e.dataTransfer.getData("text/file-id");
          if (fileId) onMoveFile(fileId, folder.id);
        }}
      >
        <button
          onClick={() => setOpen((s) => ({ ...s, [folder.id]: !isOpen }))}
          aria-expanded={isOpen}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            aria-hidden="true"
            className={`size-3 shrink-0 text-primary/60 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
          <span
            aria-hidden="true"
            className="grid size-5 shrink-0 place-items-center font-serif text-lg leading-none text-primary/80"
          >
            {FOLDER_ICONS[folder.icon] ?? "◆"}
          </span>
          <span className="truncate font-medium">{folder.name}</span>
        </button>
        {isMaster && (
          <button
            onClick={() => onDeleteFolder(folder.id)}
            aria-label={`Remover pasta ${folder.name}`}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
            title="Remover"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {isOpen && (
        <div className="border-l border-primary/10 ml-4 mt-0.5">
          {children.map((c) => (
            <FolderNode
              key={c.id}
              folder={c}
              folders={folders}
              files={files}
              open={open}
              setOpen={setOpen}
              isMaster={isMaster}
              onDeleteFolder={onDeleteFolder}
              onDeleteFile={onDeleteFile}
              onDragFile={onDragFile}
              onMoveFile={onMoveFile}
              isMobile={isMobile}
              onAddFile={onAddFile}
              depth={depth + 1}
            />
          ))}
          {childFiles.map((f) => (
            <FileNode
              key={f.id}
              file={f}
              isMaster={isMaster}
              onDelete={() => onDeleteFile(f.id)}
              onDragFile={onDragFile}
              isMobile={isMobile}
              onAddFile={onAddFile}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileNode({
  file,
  isMaster,
  onDelete,
  onDragFile,
  isMobile = false,
  onAddFile,
  depth,
}: {
  file: FileRow;
  isMaster: boolean;
  onDelete: () => void;
  onDragFile: (e: React.DragEvent, fileId: string) => void;
  isMobile?: boolean;
  onAddFile?: (fileId: string) => void;
  depth: number;
}) {
  const glyph = file.kind === "image" || file.kind === "map" ? "✧" : "❦";
  return (
    <div
      draggable={!isMobile}
      onDragStart={isMobile ? undefined : (e) => onDragFile(e, file.id)}
      onClick={isMobile ? () => onAddFile?.(file.id) : undefined}
      className={`group flex items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-primary/5 hover:text-primary ${
        isMobile ? "cursor-pointer active:bg-primary/10" : "cursor-grab"
      }`}
      style={{ paddingLeft: 8 + depth * 12 + 12 }}
      title={isMobile ? "Toque para adicionar à mesa" : "Arraste para a mesa"}
    >
      <span aria-hidden="true" className="text-primary/60">
        {glyph}
      </span>
      <span className="flex-1 truncate">{file.name}</span>
      {isMaster && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Remover ${file.name}`}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
        >
          <Trash2 className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}