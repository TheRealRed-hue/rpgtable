# Supabase local — por que o login dava 429, e como rodar sem tomar rate limit

## O que estava causando o 429

Não era um bug isolado no formulário de login — eram três coisas se
somando, todas batendo no projeto **hospedado** (não num Supabase local):

1. **`.env.local` não existia.** O `.env` do projeto aponta para o Supabase
   hospedado (`btxrdoszavplrubqmrfz.supabase.co`) como fallback. Sem um
   `.env.local` sobrescrevendo isso, `npm run dev` sempre falava com o
   projeto hospedado — mesmo em ambiente "local". O rate limit de auth do
   plano hospedado é pensado pra tráfego de produção, não pra um loop de
   "cria conta → confirma email → loga → testa de novo" repetido dezenas de
   vezes por hora.

2. **`beforeLoad`/`loader` chamavam `supabase.auth.getUser()`.** Essa
   função sempre faz uma chamada de rede pro servidor de auth pra validar o
   token. Ela rodava em `_authenticated/route.tsx` e `index.tsx`, que o
   TanStack Router executa **a cada navegação E a cada preload** (passar o
   mouse num `<Link>`, por exemplo).

3. **`defaultPreloadStaleTime: 0`** em `router.tsx` fazia esse preload
   tratar qualquer resultado anterior como sempre expirado — ou seja, cada
   hover num link disparava o `beforeLoad`/`loader` de novo, com uma nova
   chamada de rede. Isso incluía o `loader` de `campaign.$campaignId.tsx`,
   que além de checar o usuário ainda tentava inserir uma linha em
   `campaign_members` toda vez.

Resultado: um punhado de cliques normais no app já gerava dezenas de
chamadas ao servidor de auth hospedado, estourando o limite — e o erro que
aparecia era um 429 genérico, sem relação óbvia com "login".

## O que foi corrigido no código

- `getUser()` (rede) trocado por `getSession()` (local, lê o token já salvo)
  em todos os guards de rota e checagens de "quem está logado" — ver
  `src/lib/auth-helpers.ts`. Isso não enfraquece a segurança: dados
  continuam protegidos por RLS no Postgres e pelas funções server-side que
  validam o Bearer token de verdade (`auth-middleware.ts`). Esses checks no
  cliente só decidem o que mostrar na tela.
- `defaultPreloadStaleTime` subiu de `0` para `30_000` (30s) em
  `router.tsx`, então hover repetido não refaz o `beforeLoad`/`loader` toda
  hora.
- `ensureCampaignMembership` agora usa um cache em memória
  (`src/lib/membership-cache.ts`) pra não tentar inserir de novo um membro
  que já foi confirmado nessa sessão.
- A tela de login/cadastro (`src/routes/auth.tsx`) agora reconhece erro de
  rate limit, email não confirmado e credenciais inválidas separadamente
  (`src/lib/auth-helpers.ts` → `parseAuthError`), trava os botões por um
  tempo depois de um 429 em vez de deixar você bater de novo na hora, e tem
  botão de reenviar email de confirmação com o próprio cooldown.

Isso reduz MUITO o consumo de rate limit, mas se você continuar testando
contra o projeto hospedado, ainda vai eventualmente bater no limite dele —
por isso o passo abaixo importa.

## Rodando o Supabase local (recomendado para dev)

1. Docker Desktop precisa estar rodando.
2. Instale a CLI se ainda não tiver: `npm install -g supabase` (ou via
   scoop/chocolatey no Windows).
3. Na raiz do projeto:
   ```
   supabase start
   ```
   Isso sobe Postgres, o servidor de Auth (GoTrue), Studio e um capturador
   de email local, tudo em containers Docker.
4. Rode `supabase status` e copie a **API URL** e a **anon key**.
5. Copie `.env.local.example` para `.env.local` e cole os valores.
6. Reinicie `npm run dev` (o Vite só lê `.env.local` no start, não faz
   hot-reload disso).
7. Emails de confirmação de cadastro aparecem em
   `http://127.0.0.1:54324` (Inbucket/Mailpit), não numa caixa de entrada
   real — clique no link de confirmação de lá.

O `supabase/config.toml` já tem uma seção `[auth.rate_limit]` bem mais
generosa pro stack local, então testar sign up/sign in repetidas vezes
localmente não deve mais gerar 429. Isso só afeta o `supabase start` local
— não muda o limite do projeto hospedado.

### Migrations

O stack local não vem com o schema do projeto hospedado por padrão. Depois
do `supabase start`, aplique as migrations existentes:
```
supabase db reset
```
Isso roda tudo em `supabase/migrations/` do zero contra o banco local,
incluindo a RPC `join_campaign` mais recente.

## Se preferir continuar testando contra o hospedado

Dá pra continuar sem `.env.local` (cai no fallback hospedado), mas nesse
caso:
- Evite loops de teste rápido (cadastrar/logar várias vezes seguidas).
- Se tomar 429, espere alguns minutos — o cooldown na tela de login agora
  pelo menos deixa isso visível em vez de silencioso.
- Confirmação de email no hospedado tem cota bem menor que o local; se
  ficar reenviando teste, ela esgota rápido.
