import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { BOARD_THEMES } from "@/lib/board-themes";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Palette, Check, Star } from "lucide-react";
import { toast } from "sonner";

interface Props {
  campaignId: string;
  userId: string | null;
  isMaster: boolean;
  /** The campaign's default preset id (campaigns.theme). */
  campaignTheme: string;
  /** This viewer's personal override, if any (null = "use the default"). */
  myOverride: string | null;
}

export function ThemePicker({ campaignId, userId, isMaster, campaignTheme, myOverride }: Props) {
  const qc = useQueryClient();

  const setCampaignDefault = useMutation({
    mutationFn: async (themeId: string) => {
      const { error } = await supabase
        .from("campaigns")
        .update({ theme: themeId })
        .eq("id", campaignId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", campaignId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const setMyOverride = useMutation({
    mutationFn: async (themeId: string | null) => {
      if (!userId) return;
      if (themeId === null) {
        const { error } = await supabase
          .from("campaign_theme_overrides")
          .delete()
          .eq("campaign_id", campaignId)
          .eq("user_id", userId);
        if (error) throw error;
        return;
      }
      const { error } = await supabase
        .from("campaign_theme_overrides")
        .upsert({ campaign_id: campaignId, user_id: userId, theme: themeId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["theme_override", campaignId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Tema visual da mesa"
          title="Tema visual da mesa"
          className="absolute top-4 right-4 h-9 w-9 rounded-full bg-ink-2/90 p-0 text-primary ring-1 ring-primary/25 backdrop-blur-md hover:bg-primary/10"
        >
          <Palette className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="gold-frame w-64 bg-ink-2/95 p-3">
        {isMaster && (
          <div className="mb-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-primary/70">
              Padrão da mesa
            </p>
            <div className="grid grid-cols-4 gap-2">
              {BOARD_THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setCampaignDefault.mutate(t.id)}
                  title={t.name}
                  className="group flex flex-col items-center gap-1"
                >
                  <span
                    className="relative size-8 rounded-full ring-2 ring-transparent group-hover:ring-primary/40 data-[active=true]:ring-primary"
                    data-active={campaignTheme === t.id}
                    style={{ backgroundImage: t.swatch }}
                  >
                    {campaignTheme === t.id && (
                      <Star className="absolute inset-0 m-auto size-3.5 text-cream drop-shadow" />
                    )}
                  </span>
                  <span className="text-[9px] text-muted-foreground">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-primary/70">
            Meu tema (só pra mim)
          </p>
          <div className="grid grid-cols-4 gap-2">
            <button
              onClick={() => setMyOverride.mutate(null)}
              title="Usar o padrão da mesa"
              className="group flex flex-col items-center gap-1"
            >
              <span className="relative grid size-8 place-items-center rounded-full bg-muted ring-2 ring-transparent group-hover:ring-primary/40">
                {myOverride === null && <Check className="size-3.5 text-primary" />}
              </span>
              <span className="text-[9px] text-muted-foreground">Padrão</span>
            </button>
            {BOARD_THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => setMyOverride.mutate(t.id)}
                title={t.name}
                className="group flex flex-col items-center gap-1"
              >
                <span
                  className="relative size-8 rounded-full ring-2 ring-transparent group-hover:ring-primary/40"
                  style={{
                    backgroundImage: t.swatch,
                    boxShadow: myOverride === t.id ? "0 0 0 2px var(--color-primary)" : undefined,
                  }}
                >
                  {myOverride === t.id && (
                    <Check className="absolute inset-0 m-auto size-3.5 text-cream drop-shadow" />
                  )}
                </span>
                <span className="text-[9px] text-muted-foreground">{t.name}</span>
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
