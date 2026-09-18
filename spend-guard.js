/**
 * Trava financeira de SAÍDA pra quem constrói um agente x402 (o lado que
 * PAGA, não o que recebe). O SDK oficial (@x402/core) só trava POR
 * TRANSAÇÃO (`SpendControls.maxAmountPerPayment`) — não existe teto diário
 * agregado, kill switch, allowlist de destinatário/host nem log de
 * auditoria persistente entre chamadas. Esta lib cobre exatamente esse gap,
 * como camada FORA do caminho de decisão do código que gasta — o código que
 * assina a transação nunca vê nem controla os limites, só recebe
 * `{ allowed, reason }`.
 *
 * Zero dependência nova (usa node:sqlite nativo — requer Node 22+).
 * Agnóstico de rede/ativo: você configura suas próprias allowlists, nunca
 * hardcoded na lib.
 */
const { SpendStore } = require("./spend-store");

// Chave de saúde do circuit breaker: host + pathname, NUNCA só o host.
// Achado real (18/09/2026, tentando usar isso de verdade num caso real):
// um domínio pode hospedar várias rotas independentes (ex: agentum.lat/foo
// e agentum.lat/foo-mirror, pensado como espelho um do outro) -- agrupar
// por host inteiro faz falhas numa rota abrirem o circuito de TODAS as
// outras do mesmo domínio, inclusive do "espelho" que devia servir de
// fallback (mesmo host = mesma chave = mesmo estado, o failover nunca
// funcionaria). Pathname é normalizado (sem query string), então
// `/verificar-cnpj?cnpj=A` e `/verificar-cnpj?cnpj=B` continuam
// compartilhando saúde (é o mesmo endpoint, argumentos diferentes) --
// só rotas com PATH diferente é que agora têm saúde independente.
function resourceKeyFor(resourceUrl) {
  const u = new URL(resourceUrl);
  return u.hostname + u.pathname;
}

class SpendGuard {
  /**
   * @param {object} config
   * @param {number} config.maxPerTransactionUnits - teto por transação, em unidades atômicas do ativo (obrigatório)
   * @param {number} config.dailyCapUnits - teto acumulado por dia UTC, em unidades atômicas (obrigatório)
   * @param {string[]} config.allowedNetworks - ex: ["eip155:8453"] (obrigatório, não pode ser vazio)
   * @param {string[]} config.allowedAssets - endereços de contrato do ativo aceito (obrigatório, não pode ser vazio)
   * @param {string[]} config.allowedPayTo - destinatários aceitos (obrigatório, não pode ser vazio)
   * @param {string[]} config.allowedResourceHosts - hosts do recurso pago aceitos (obrigatório, não pode ser vazio)
   * @param {SpendStore} [config.store] - store customizado (padrão: novo SpendStore() com paths default)
   */
  constructor(config = {}) {
    const required = ["maxPerTransactionUnits", "dailyCapUnits", "allowedNetworks", "allowedAssets", "allowedPayTo", "allowedResourceHosts"];
    for (const key of required) {
      const value = config[key];
      const isArrayField = Array.isArray(config[key]) || ["allowedNetworks", "allowedAssets", "allowedPayTo", "allowedResourceHosts"].includes(key);
      if (isArrayField) {
        if (!Array.isArray(value) || value.length === 0) {
          throw new Error(
            `SpendGuard: "${key}" precisa ser um array não-vazio. Uma allowlist vazia/ausente por engano viraria "aceita qualquer coisa" — este construtor falha explicitamente em vez de assumir esse default perigoso.`
          );
        }
      } else if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`SpendGuard: "${key}" precisa ser um número positivo.`);
      }
    }
    if (config.dailyCapUnits < config.maxPerTransactionUnits) {
      throw new Error(
        "SpendGuard: \"dailyCapUnits\" não pode ser menor que \"maxPerTransactionUnits\" — configuração provavelmente invertida (nenhuma transação real conseguiria passar)."
      );
    }
    if (config.store) {
      const requiredMethods = ["reserve", "getSpentToday", "logDecision", "isKillSwitchActive"];
      const missing = requiredMethods.filter((m) => typeof config.store[m] !== "function");
      if (missing.length > 0) {
        throw new Error(`SpendGuard: "store" customizado não implementa: ${missing.join(", ")}.`);
      }
    }

    this.maxPerTransactionUnits = config.maxPerTransactionUnits;
    this.dailyCapUnits = config.dailyCapUnits;
    this.allowedNetworks = new Set(config.allowedNetworks);
    this.allowedAssets = new Set(config.allowedAssets.map((a) => String(a).toLowerCase()));
    this.allowedPayTo = new Set(config.allowedPayTo.map((a) => String(a).toLowerCase()));
    // hosts sempre em minúsculas: new URL(url).hostname já normaliza pra
    // minúsculas (WHATWG URL spec) — sem isso, um host configurado com
    // maiúscula por engano nunca bateria com nada (achado de auditoria, L-2).
    this.allowedResourceHosts = new Set(config.allowedResourceHosts.map((h) => String(h).toLowerCase()));
    this.store = config.store || new SpendStore();

    // Circuit breaker é OPT-IN -- ausente por padrão, comportamento
    // idêntico à v1.0.x pra quem não configurar isso. `health` (saúde
    // derivada de outcome real, ver health-store.js) ainda é sempre
    // alimentado quando o store der suporte (best-effort, nunca obrigatório
    // -- um store customizado antigo sem `.health` continua funcionando
    // exatamente como antes, só sem essa feature nova).
    if (config.circuitBreaker !== undefined) {
      const { failureThreshold = 3, cooldownMs = 60_000 } = config.circuitBreaker || {};
      if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
        throw new Error('SpendGuard: "circuitBreaker.failureThreshold" precisa ser um inteiro >= 1.');
      }
      if (!Number.isInteger(cooldownMs) || cooldownMs < 0) {
        throw new Error('SpendGuard: "circuitBreaker.cooldownMs" precisa ser um inteiro >= 0.');
      }
      this.circuitBreaker = { failureThreshold, cooldownMs };
    }
  }

  _health() {
    return this.store.health && typeof this.store.health.recordOutcome === "function" ? this.store.health : null;
  }

  /**
   * Valida allowlist/formato/limite por transação de UMA opção de
   * `accepts[]` (o array que um servidor x402 devolve num 402). Não toca no
   * ledger — só diz se essa opção específica seria aceitável. Retorna
   * `{ ok, reason, amountUnits }`.
   */
  checkOption(requirement, resourceUrl) {
    if (!requirement) {
      return { ok: false, reason: "missing_requirement" };
    }
    const { amount, asset, network, payTo } = requirement;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
      return { ok: false, reason: "amount_not_recognized" };
    }
    const amountUnits = Number(amount);
    if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) {
      return { ok: false, reason: "amount_invalid" };
    }
    if (!network || !this.allowedNetworks.has(network)) {
      return { ok: false, reason: "network_not_allowlisted" };
    }
    if (!asset || !this.allowedAssets.has(String(asset).toLowerCase())) {
      return { ok: false, reason: "asset_not_allowlisted" };
    }
    if (!payTo || !this.allowedPayTo.has(String(payTo).toLowerCase())) {
      return { ok: false, reason: "payTo_not_allowlisted" };
    }
    let resourceHost;
    try {
      resourceHost = new URL(resourceUrl).hostname;
    } catch {
      return { ok: false, reason: "resource_url_invalid" };
    }
    if (!this.allowedResourceHosts.has(resourceHost)) {
      return { ok: false, reason: "resource_host_not_allowlisted" };
    }
    if (amountUnits > this.maxPerTransactionUnits) {
      return { ok: false, reason: "per_transaction_limit_exceeded" };
    }
    return { ok: true, amountUnits };
  }

  /**
   * Fluxo completo: valida TODAS as opções de `accepts[]` do 402 (o SDK
   * pode escolher qualquer uma delas, então aprovar só a que "parece" ser a
   * escolhida não seria fail-closed de verdade). Se todas passarem, reserva
   * atomicamente pelo MAIOR valor entre elas (nunca subestima o que pode
   * ser cobrado) e loga a decisão, aprovada ou bloqueada, com motivo.
   *
   * Nunca lança — qualquer exceção interna vira `{ allowed: false, reason:
   * "internal_error: ..." }` (fail-closed).
   */
  evaluateAccepts(acceptsArray, resourceUrl) {
    try {
      return this._evaluateInner(acceptsArray, resourceUrl);
    } catch (err) {
      const decision = { allowed: false, reason: `internal_error: ${err.message}` };
      try {
        this.store.logDecision({ decision: "blocked", reason: decision.reason, resourceUrl });
      } catch {
        // se nem o log funcionar, ainda assim bloqueia — fail-closed não depende do log ter sucesso
      }
      return decision;
    }
  }

  _evaluateInner(acceptsArray, resourceUrl) {
    if (this.store.isKillSwitchActive()) {
      return this._logAndReturn("blocked", "kill_switch_active", {}, resourceUrl);
    }
    // circuito aberto bloqueia ANTES de qualquer outra checagem -- nunca
    // vale a pena gastar ciclo de allowlist/teto num host que os últimos N
    // pagamentos reais confirmaram estar falhando. "half_open" passa (é a
    // sonda de teste); o resultado real de outcome decide se fecha ou reabre.
    if (this.circuitBreaker) {
      const health = this._health();
      if (health) {
        let key;
        try {
          key = resourceKeyFor(resourceUrl);
        } catch {
          key = null;
        }
        if (key) {
          const { state } = health.getState(key, { cooldownMs: this.circuitBreaker.cooldownMs });
          if (state === "open") {
            return this._logAndReturn("blocked", "circuit_open", {}, resourceUrl);
          }
        }
      }
    }
    if (!Array.isArray(acceptsArray) || acceptsArray.length === 0) {
      return this._logAndReturn("blocked", "accepts_empty", {}, resourceUrl);
    }

    const checked = acceptsArray.map((requirement) => ({
      requirement,
      result: this.checkOption(requirement, resourceUrl),
    }));
    const failed = checked.find((c) => !c.result.ok);
    if (failed) {
      return this._logAndReturn("blocked", failed.result.reason, failed.requirement || {}, resourceUrl);
    }

    const best = checked.reduce((max, c) => (c.result.amountUnits > max.result.amountUnits ? c : max));
    const amountUnits = best.result.amountUnits;

    const reservation = this.store.reserve(amountUnits, this.dailyCapUnits);
    if (!reservation.ok) {
      return this._logAndReturn("blocked", reservation.reason, best.requirement, resourceUrl, amountUnits);
    }

    return this._logAndReturn("approved", "ok", best.requirement, resourceUrl, amountUnits, reservation.spentAfter);
  }

  _logAndReturn(decision, reason, requirement, resourceUrl, amountUnits = null, spentAfter = undefined) {
    this.store.logDecision({
      decision,
      reason,
      amountUnits,
      asset: requirement?.asset ?? null,
      network: requirement?.network ?? null,
      payTo: requirement?.payTo ?? null,
      resourceUrl,
    });
    return decision === "approved" ? { allowed: true, amountUnits, spentAfter } : { allowed: false, reason };
  }

  /**
   * Registra o resultado real do envio (settled/settle_failed/erro) —
   * separado da decisão do gate, pra auditoria completa. Também alimenta o
   * HealthStore (sempre, best-effort) -- é essa alimentação que faz o
   * circuit breaker funcionar; sem chamar logOutcome depois de cada
   * pagamento de verdade, o resto desta feature fica sem dado.
   */
  logOutcome({ outcome, amountUnits, resourceUrl }) {
    try {
      this.store.logDecision({ decision: `outcome_${outcome}`, reason: outcome, amountUnits, resourceUrl });
    } catch {
      // log de melhor esforço — não deve derrubar o script por causa disso
    }
    const health = this._health();
    if (health && resourceUrl) {
      try {
        health.recordOutcome(resourceKeyFor(resourceUrl), outcome, this.circuitBreaker || {});
      } catch {
        // best-effort -- URL malformada ou erro de store nunca derruba o outcome logging acima
      }
    }
  }

  /**
   * Consulta a saúde/estado do circuito de um host, sem depender de
   * `circuitBreaker` estar configurado (usa os defaults do health-store.js
   * pra leitura só-consulta). Útil pra decidir manualmente antes de tentar
   * pagar, mesmo sem habilitar o bloqueio automático em evaluateAccepts.
   */
  getEndpointHealth(resourceUrl, opts) {
    const unknown = { state: "unknown", consecutiveFailures: 0, lastOutcome: null, lastOutcomeAt: null };
    const health = this._health();
    if (!health) return unknown;
    let key;
    try {
      key = resourceKeyFor(resourceUrl);
    } catch {
      return unknown; // URL malformada/ausente -- nunca lança (mesma garantia fail-closed do resto da lib)
    }
    // `opts` default só cobre `undefined` (parâmetro omitido), não `null`
    // explícito -- achado real de reauditoria (2026-09-18): passar `null`
    // de propósito lançava "Cannot read properties of null". `?? {}` cobre
    // os dois casos.
    return health.getState(key, { cooldownMs: (opts ?? {}).cooldownMs ?? this.circuitBreaker?.cooldownMs });
  }

  /**
   * Failover mínimo e honesto: dado uma lista ORDENADA de URLs candidatas
   * pro MESMO recurso (ex: espelhos do mesmo serviço em hosts diferentes),
   * devolve a primeira cujo circuito não está "open". Esta lib nunca
   * descobre alternativas sozinha -- quem chama já precisa saber quais são
   * os próprios espelhos/fallbacks. Retorna `null` se todas estiverem
   * abertas (fail-closed: nenhum candidato confiável agora).
   */
  pickHealthyResource(candidateUrls) {
    if (!Array.isArray(candidateUrls)) return null; // input errado (ex: string) nunca lança, fail-closed
    for (const url of candidateUrls) {
      const { state } = this.getEndpointHealth(url); // "unknown"/"closed"/"half_open" passam, só "open" pula
      if (state !== "open") return url;
    }
    return null;
  }
}

module.exports = { SpendGuard };
