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

  /** Registra o resultado real do envio (settled/settle_failed/erro) — separado da decisão do gate, pra auditoria completa. */
  logOutcome({ outcome, amountUnits, resourceUrl }) {
    try {
      this.store.logDecision({ decision: `outcome_${outcome}`, reason: outcome, amountUnits, resourceUrl });
    } catch {
      // log de melhor esforço — não deve derrubar o script por causa disso
    }
  }
}

module.exports = { SpendGuard };
