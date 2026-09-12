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

Testado em produção real: é a mesma trava usada pelo [Payment Agent da AGENTUM](https://agentum.lat) desde 2026-09-05, com pagamentos reais em Base mainnet.

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

## Store customizado

Por padrão, `SpendGuard` cria seu próprio `SpendStore` (SQLite em `./data/x402-spend-guard.sqlite`). Se precisar compartilhar o mesmo ledger entre múltiplos hosts, implemente a mesma interface (`reserve`/`getSpentToday`/`logDecision`/`isKillSwitchActive`) sobre Redis/Postgres e passe via `new SpendGuard({ ..., store: meuStoreCustomizado })`.

## Riscos residuais conhecidos

- A trava só protege quem chama `evaluateAccepts()` antes de assinar — nada intercepta automaticamente um caminho de saída novo que não a chame.
- Kill switch é garantia de código + `chmod 444`, não isolamento de SO real — protege contra escrita, não contra deleção do arquivo (ver seção "Kill switch" acima).
- Sem rollback depois que a reserva é feita — se o envio falhar depois, o valor já contou pro teto diário (decisão deliberada: nunca estourar o teto é mais importante que permitir retry fácil). Isso também significa que **erro/timeout repetido consome o teto diário sem gastar dinheiro de verdade** — se seu agente tende a falhar bastante, o teto pode esgotar por tentativa, não por gasto real.
- O SQLite local do `SpendStore` padrão cobre múltiplos processos num host só, não múltiplos hosts. Sob concorrência real (múltiplos processos), o SQLite espera o lock soltar (`PRAGMA busy_timeout`) em vez de falhar na hora — mas ainda serializa, não paraleliza: throughput alto concorrente pode ficar lento, não incorreto.
- **Se você criar mais de um `SpendGuard` no mesmo processo sem passar `store` explícito pra cada um, os dois vão compartilhar o mesmo arquivo SQLite padrão** (`./data/x402-spend-guard.sqlite`) e portanto o mesmo teto diário acumulado — provavelmente não é o que você quer. Passe um `store` com `dbPath` próprio pra cada guard se precisar de políticas independentes.

## Licença

MIT
