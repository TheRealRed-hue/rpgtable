import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getLocalUser, parseAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Moon, Loader2, MailCheck } from "lucide-react";

export const Route = createFileRoute("/auth")({
  ssr: false,
  component: AuthPage,
});

/** How long we lock the buttons after a 429, since Supabase doesn't hand us
 * an exact retry-after value through supabase-js — this is a conservative
 * client-side guess, not a guarantee the server-side window has cleared. */
const RATE_LIMIT_COOLDOWN_SECONDS = 45;
/** Cooldown between "resend confirmation email" clicks, independent of the
 * general rate-limit cooldown, so we don't spam the very limited email quota. */
const RESEND_COOLDOWN_SECONDS = 30;

function AuthPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendingConfirmation, setResendingConfirmation] = useState(false);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // If already signed in, jump to app. Local session read — no network
    // call, so this can't itself contribute to rate limiting.
    getLocalUser().then((user) => {
      if (user && mountedRef.current) navigate({ to: "/tables", replace: true });
    });
  }, [navigate]);

  // Countdown ticker for both cooldowns.
  useEffect(() => {
    if (cooldown <= 0 && resendCooldown <= 0) return;
    const id = setInterval(() => {
      if (!mountedRef.current) return;
      setCooldown((c) => Math.max(0, c - 1));
      setResendCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown, resendCooldown]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mountedRef.current || submittingRef.current || cooldown > 0) return;

    submittingRef.current = true;
    setLoading(true);
    setNeedsConfirmation(false);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (!mountedRef.current) return;
    submittingRef.current = false;
    setLoading(false);

    if (error) {
      const parsed = parseAuthError(error);
      toast.error(parsed.message);
      if (parsed.kind === "rate_limit") setCooldown(RATE_LIMIT_COOLDOWN_SECONDS);
      if (parsed.kind === "email_not_confirmed") setNeedsConfirmation(true);
      return;
    }

    toast.success("Bem-vindo à mesa.");
    navigate({ to: "/tables", replace: true });
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mountedRef.current || submittingRef.current || cooldown > 0) return;

    submittingRef.current = true;
    setLoading(true);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/tables` },
    });

    if (!mountedRef.current) return;
    submittingRef.current = false;
    setLoading(false);

    if (error) {
      const parsed = parseAuthError(error);
      toast.error(parsed.message);
      if (parsed.kind === "rate_limit") setCooldown(RATE_LIMIT_COOLDOWN_SECONDS);
      return;
    }

    toast.success("Convocação aceita — confirme seu email para entrar.");
    setNeedsConfirmation(true);
  };

  const handleResendConfirmation = async () => {
    if (!email || resendingConfirmation || resendCooldown > 0) return;
    setResendingConfirmation(true);

    const { error } = await supabase.auth.resend({ type: "signup", email });

    if (!mountedRef.current) return;
    setResendingConfirmation(false);

    if (error) {
      const parsed = parseAuthError(error);
      toast.error(parsed.message);
      if (parsed.kind === "rate_limit") setResendCooldown(RATE_LIMIT_COOLDOWN_SECONDS);
      return;
    }

    toast.success("Email de confirmação reenviado.");
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
  };

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center px-4 py-12">
      {/* Constellations backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(1px 1px at 20% 30%, oklch(0.85 0.06 82 / 0.6), transparent), radial-gradient(1px 1px at 70% 60%, oklch(0.85 0.06 82 / 0.5), transparent), radial-gradient(1.5px 1.5px at 40% 80%, oklch(0.85 0.06 82 / 0.4), transparent), radial-gradient(1px 1px at 85% 20%, oklch(0.85 0.06 82 / 0.6), transparent)",
        }}
      />

      <div className="ink-bleed-in relative z-10 w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-full border border-primary/40 bg-ink-2/60 text-primary">
            <Moon className="size-7" strokeWidth={1.25} />
          </div>
          <h1 className="grimoire-title text-4xl text-primary">
            TableLab<span className="italic opacity-80">RPG</span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-[36ch]">
            Uma mesa arcana para mestres e jogadores. Abra o grimório.
          </p>
        </div>

        <div className="gold-frame rounded-lg bg-card/70 p-6 backdrop-blur-sm">
          <Tabs defaultValue="signin" className="w-full">
            <TabsList className="grid w-full grid-cols-2 bg-ink-2/60">
              <TabsTrigger value="signin">Entrar</TabsTrigger>
              <TabsTrigger value="signup">Criar conta</TabsTrigger>
            </TabsList>

            <TabsContent value="signin">
              <form onSubmit={handleSignIn} className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email-in">Email</Label>
                  <Input
                    id="email-in"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="voce@exemplo.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pw-in">Senha</Label>
                  <Input
                    id="pw-in"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={loading || cooldown > 0}
                  className="w-full font-medium"
                >
                  {loading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      <span className="sr-only">Entrando…</span>
                    </>
                  ) : cooldown > 0 ? (
                    `Aguarde ${cooldown}s`
                  ) : (
                    "Entrar na mesa"
                  )}
                </Button>

                {needsConfirmation && (
                  <div className="flex flex-col items-center gap-2 rounded-md border border-primary/30 bg-ink-2/40 p-3 text-center text-xs text-muted-foreground">
                    <div className="flex items-center gap-2 text-primary">
                      <MailCheck className="size-4" strokeWidth={1.5} />
                      <span>Falta confirmar seu email.</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleResendConfirmation}
                      disabled={resendingConfirmation || resendCooldown > 0 || !email}
                      className="text-primary underline underline-offset-2 hover:opacity-80 disabled:opacity-50 disabled:no-underline"
                    >
                      {resendingConfirmation
                        ? "Reenviando…"
                        : resendCooldown > 0
                          ? `Reenviar em ${resendCooldown}s`
                          : "Reenviar email de confirmação"}
                    </button>
                  </div>
                )}
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignUp} className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email-up">Email</Label>
                  <Input
                    id="email-up"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="voce@exemplo.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pw-up">Senha</Label>
                  <Input
                    id="pw-up"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={loading || cooldown > 0}
                  className="w-full font-medium"
                >
                  {loading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      <span className="sr-only">Selando…</span>
                    </>
                  ) : cooldown > 0 ? (
                    `Aguarde ${cooldown}s`
                  ) : (
                    "Selar contrato"
                  )}
                </Button>

                {needsConfirmation && (
                  <div className="flex flex-col items-center gap-2 rounded-md border border-primary/30 bg-ink-2/40 p-3 text-center text-xs text-muted-foreground">
                    <div className="flex items-center gap-2 text-primary">
                      <MailCheck className="size-4" strokeWidth={1.5} />
                      <span>Convocação enviada. Confirme seu email para entrar.</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleResendConfirmation}
                      disabled={resendingConfirmation || resendCooldown > 0 || !email}
                      className="text-primary underline underline-offset-2 hover:opacity-80 disabled:opacity-50 disabled:no-underline"
                    >
                      {resendingConfirmation
                        ? "Reenviando…"
                        : resendCooldown > 0
                          ? `Reenviar em ${resendCooldown}s`
                          : "Reenviar email de confirmação"}
                    </button>
                  </div>
                )}
              </form>
            </TabsContent>
          </Tabs>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          <Link to="/" className="hover:text-primary transition-colors">
            ← Voltar
          </Link>
        </p>
      </div>
    </div>
  );
}
