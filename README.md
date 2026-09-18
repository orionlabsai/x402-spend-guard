# @agentum/x402-spend-guard

Trava financeira de **saída** pra quem constrói um agente que paga via [x402](https://github.com/x402-foundation/x402) — o lado que gasta, não o que vende.

## O problema

O SDK oficial (`@x402/core`) só trava **por transação** (`SpendControls.maxAmountPerPayment`). Não existe:
- teto agregado por dia,
- kill switch,
- allowlist de destinatário (`payTo`) ou host do recurso,
- log de auditoria persistente entre chamadas.

Nem [A2A](https://a2a-protocol.org/latest/topics/extensions/) nem [MCP](https://modelcontextprotocol.io/specification/2025-06-18) preenchem esse gap — nenhum dos dois tem conceito de orçamento/política de gasto do lado do requisitante.

## O que esta lib faz

Uma camada **fora** do caminho de decisão do código que assina a transação — ele nunca vê nem controla os limites, só recebe `{ allowed, reason }`.

- Teto por transação **e** teto diário agregado (SQLite nativo via `node:sqlite`, zero dependência nova)
- Allowlist obrigatória de rede, ativo, destinatário e host do recurso — o construtor **recusa** rodar sem elas (nunca assume "aceita tudo" por omissão)
- Kill switch read-only pro código que gasta — só um CLI separado escreve, com `chmod 444` de fricção extra
- Fail-closed em tudo: erro interno, JSON corrompido, `accepts[]` vazio/malformado — tudo vira bloqueio, nunca exceção não tratada
- Log de toda decisão (aprovada ou bloqueada) + do resultado real do envio, separados
- **Circuit breaker opcional por saúde real de outcome** (v1.1.0) — pausa automaticamente pagamentos pra um host que os últimos pagamentos reais confirmaram estar falhando, sem depender de polling de liveness (`GET /health`)

Testado em produção real: o teto/allowlist/kill switch é a mesma trava usada pelo [Payment Agent da AGENTUM](https://agentum.lat) desde 2026-09-05, com pagamentos reais em Base mainnet. **O circuit breaker (v1.1.0) é novo e ainda não passou por produção** — testado com concorrência real entre processos (não só chamadas no mesmo processo) antes do release, mas sem histórico de uso real ainda.

## Instalação

```bash
npm install @agentum/x402-spend-guard
```

## Uso

```js
const { SpendGuard } = require("@agentum/x402-spend-guard");

const guard = new SpendGuard({
  maxPerTransactionUnits: 100_000,   // 0,10 USDC (6 casas decimais)
  dailyCapUnits: 1_000_000,          // 1,00 USDC/dia
  allowedNetworks: ["eip155:8453"],  // Base mainnet
  allowedAssets: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], // USDC na Base
  allowedPayTo: ["0xSeuDestinatarioConfiavel..."],
  allowedResourceHosts: ["api.confiavel.com"],
});

// depois de receber um 402 de um servidor x402, antes de assinar qualquer coisa:
const decision = guard.evaluateAccepts(paymentRequired.accepts, resourceUrl);

if (!decision.allowed) {
  throw new Error(`Pagamento bloqueado pela política: ${decision.reason}`);
}

// ... assine e envie o pagamento normalmente (wrapFetchWithPayment, etc) ...

// depois de saber o resultado real do envio:
guard.logOutcome({ outcome: "settled", amountUnits: decision.amountUnits, resourceUrl });
```

Todas as opções de configuração são **obrigatórias e validadas no construtor** — uma allowlist vazia ou ausente por engano lança erro na hora, em vez de silenciosamente virar "aceita qualquer coisa".

## Kill switch

```bash
npx x402-kill-switch status
npx x402-kill-switch on "investigando comportamento suspeito"
npx x402-kill-switch off
# com caminho customizado (senão usa ./data/kill-switch.json):
npx x402-kill-switch on "motivo" --path /caminho/seguro/kill-switch.json
```

O kill switch só é **lido** pelo `SpendGuard` — nenhuma função de escrita existe na lib em si. A única forma de ligar/desligar é rodando o CLI manualmente. Isso garante que o próprio código que gasta dinheiro nunca tem, à disposição, uma função capaz de se autodesbloquear.

**Importante:** isso protege contra escrita, não contra deleção. Se o arquivo do kill switch for apagado (não editado, apagado), `isKillSwitchActive()` trata isso como "nunca foi ativado" — ou seja, apagar um kill switch ATIVO o desliga silenciosamente. Garanta que o processo que gasta dinheiro não tenha permissão de escrita no **diretório** onde esse arquivo vive, não só no arquivo em si.

## Circuit breaker por saúde real de outcome (v1.1.0)

Todo "circuit breaker"/"failover" que existe hoje pro x402 monitora se um endpoint **responde** (polling de liveness). Nenhum monitora se ele **entrega** quando alguém tenta pagar de verdade. Esta lib deriva a saúde do host a partir do que você já reporta em `logOutcome()` — sem outcome real, sem dado, sem custo extra.

```js
const guard = new SpendGuard({
  // ...allowlists de sempre...
  circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 }, // opcional -- ausente = comportamento idêntico à v1.0.x
});

const decision = guard.evaluateAccepts(paymentRequired.accepts, resourceUrl);
if (!decision.allowed) {
  // decision.reason pode ser "circuit_open" agora -- 3 outcomes reais
  // seguidos que não foram "settled" pra esse HOST, e o cooldown ainda não expirou.
}

// sempre chamar logOutcome depois do resultado real -- é isso que alimenta o circuit breaker
guard.logOutcome({ outcome: "settled" /* ou "settle_failed", "network_error", etc */, amountUnits, resourceUrl });
```

- **Estados**: `closed` (normal) → `open` (depois de N falhas consecutivas, bloqueia) → `half_open` (cooldown expirou, deixa passar 1 sonda de teste) → `closed` de novo se a sonda vier `settled`, ou `open` de novo (reinicia o cooldown) se falhar.
- **Por host**, não por URL completa nem por instância global — `/rota-a` e `/rota-b` do mesmo domínio compartilham saúde; hosts diferentes nunca se afetam.
- **Sempre opt-in**: sem `circuitBreaker` na config, nada disso roda — só o teto/allowlist de sempre. Consultar saúde manualmente com `guard.getEndpointHealth(url)` funciona mesmo sem habilitar o bloqueio automático.
- **Failover mínimo**: `guard.pickHealthyResource([urlPrincipal, urlEspelho, ...])` devolve a primeira URL cujo host não está `open`, ou `null` se todas estiverem — a lib nunca descobre espelhos sozinha, só ajuda a escolher entre os que você já conhece.
- **Retrocompatível de propósito**: um `store` customizado escrito antes desta versão (sem `.health`) continua funcionando exatamente como antes — o circuit breaker simplesmente nunca bloqueia nesse caso (best-effort, nunca lança).

## Store customizado

Por padrão, `SpendGuard` cria seu próprio `SpendStore` (SQLite em `./data/x402-spend-guard.sqlite`). Se precisar compartilhar o mesmo ledger entre múltiplos hosts, implemente a mesma interface (`reserve`/`getSpentToday`/`logDecision`/`isKillSwitchActive`) sobre Redis/Postgres e passe via `new SpendGuard({ ..., store: meuStoreCustomizado })`.

## Riscos residuais conhecidos

- A trava só protege quem chama `evaluateAccepts()` antes de assinar — nada intercepta automaticamente um caminho de saída novo que não a chame.
- Kill switch é garantia de código + `chmod 444`, não isolamento de SO real — protege contra escrita, não contra deleção do arquivo (ver seção "Kill switch" acima).
- Sem rollback depois que a reserva é feita — se o envio falhar depois, o valor já contou pro teto diário (decisão deliberada: nunca estourar o teto é mais importante que permitir retry fácil). Isso também significa que **erro/timeout repetido consome o teto diário sem gastar dinheiro de verdade** — se seu agente tende a falhar bastante, o teto pode esgotar por tentativa, não por gasto real.
- O SQLite local do `SpendStore` padrão cobre múltiplos processos num host só, não múltiplos hosts. Sob concorrência real (múltiplos processos), o SQLite espera o lock soltar (`PRAGMA busy_timeout`) em vez de falhar na hora — mas ainda serializa, não paraleliza: throughput alto concorrente pode ficar lento, não incorreto.
- **Se você criar mais de um `SpendGuard` no mesmo processo sem passar `store` explícito pra cada um, os dois vão compartilhar o mesmo arquivo SQLite padrão** (`./data/x402-spend-guard.sqlite`) e portanto o mesmo teto diário acumulado — provavelmente não é o que você quer. Passe um `store` com `dbPath` próprio pra cada guard se precisar de políticas independentes.
- **Circuit breaker é heurística simples, não um SLA**: threshold fixo de falhas consecutivas (sem backoff exponencial, sem distinguir "servidor fora do ar" de "seu próprio saldo/config está errado" — qualquer outcome diferente de `settled` conta igual). Um provedor genuinamente saudável pode ficar bloqueado por alguns minutos por uma sequência de erro transitório do SEU lado (rede, nonce, etc), não necessariamente do lado dele.
- **Estado de saúde é local ao `SpendStore`** (mesmo SQLite do teto diário) — múltiplos processos no mesmo host compartilham (se apontarem pro mesmo `dbPath`), múltiplos hosts, não.
- **Não avalia destinatários secundários de split-payment** (ex: `PaymentRequirements.extra.splits`, proposto na [PR #3221](https://github.com/x402-foundation/x402/pull/3221) do x402 core — ainda não é spec oficial hoje). `checkOption()` só confere o `payTo`/`amount` do nível principal de cada opção em `accepts[]`; se um esquema de pagamento dividido virar padrão, uma perna secundária (taxa de plataforma, referral) poderia sair da allowlist de destinatário ou empurrar o gasto agregado além do teto sem a guard perceber. Achado real, levantado por [@whawk46](https://github.com/x402-foundation/x402/issues/3170#issuecomment-5646093920) — rastreado aqui, não implementado ainda porque o campo não existe em nenhuma resposta real de servidor x402 hoje.

## Licença

MIT
