/**
 * Saúde de endpoint derivada do OUTCOME REAL de pagamento (settled vs
 * falhou) — não de polling de liveness (GET /health). Ninguém no
 * ecossistema x402 faz isso hoje do lado de quem paga (pesquisa DeepSeek,
 * 2026-09-18): todo "circuit breaker"/"failover" existente monitora se o
 * facilitador/endpoint responde, não se ele REALMENTE entrega o que promete
 * quando alguém tenta pagar. Aqui a fonte de verdade é `logOutcome()`, que
 * já existe desde a v1.0.0 — esta classe só lê e agrega o mesmo dado.
 *
 * Circuit breaker clássico de 2 estados persistidos (closed/open) + 1
 * derivado na leitura (half_open, calculado a partir do cooldown — nunca
 * persistido, pra evitar duas leituras concorrentes decidirem estados
 * diferentes por conta própria).
 *
 * Esta classe é agnóstica sobre o que é a "chave" (parâmetro `resourceHost`
 * nos métodos abaixo, nome histórico) -- quem decide o que vira chave é
 * `spend-guard.js` (`resourceKeyFor()`, host+pathname desde v1.1.1, corrigido
 * depois de um host+path virar host inteiro agrupar rotas independentes sob
 * o mesmo circuito). Esta classe só agrega o que recebe.
 */
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

class HealthStore {
  /** @param {import("node:sqlite").DatabaseSync} db - MESMA conexão do SpendStore (mesmo arquivo .sqlite) */
  constructor(db) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS endpoint_health (
        resource_host TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        circuit_state TEXT NOT NULL DEFAULT 'closed',
        opened_at TEXT,
        last_outcome TEXT,
        last_outcome_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Chamado pelo SpendGuard.logOutcome() pra todo outcome real (settled,
   * settle_failed, erro de rede, etc). "settled" fecha o circuito e zera o
   * contador; qualquer outra coisa incrementa falhas consecutivas e abre o
   * circuito ao atingir `failureThreshold`. Nunca lança (best-effort, mesmo
   * padrão de logOutcome).
   *
   * O incremento é ATÔMICO NO SQL (referencia `endpoint_health.consecutive_
   * failures` direto no UPSERT) -- nunca lê o valor em JS pra recalcular e
   * escrever de volta, senão dois processos concorrentes lendo o mesmo "0"
   * escreveriam "1" os dois (lost update, confirmado por auditoria rodando
   * 4 processos reais x 50 falhas cada: sem isso o contador final dava 54
   * em vez de 200). Um único INSERT...ON CONFLICT é atômico por si só no
   * SQLite (sua própria transação implícita), sem precisar de BEGIN manual.
   */
  recordOutcome(resourceHost, outcome, { failureThreshold = DEFAULT_FAILURE_THRESHOLD } = {}) {
    if (!resourceHost) return;
    const now = new Date().toISOString();

    if (outcome === "settled") {
      this.db
        .prepare(
          `INSERT INTO endpoint_health (resource_host, consecutive_failures, circuit_state, opened_at, last_outcome, last_outcome_at)
           VALUES (?, 0, 'closed', NULL, ?, ?)
           ON CONFLICT(resource_host) DO UPDATE SET
             consecutive_failures = 0, circuit_state = 'closed', opened_at = NULL,
             last_outcome = excluded.last_outcome, last_outcome_at = excluded.last_outcome_at`
        )
        .run(resourceHost, outcome, now);
      return;
    }

    // opened_at reseta pra "agora" toda vez que o estado calculado é 'open'
    // -- inclusive numa falha subsequente enquanto já estava aberto (é isso
    // que faz uma sonda de half_open que falha de novo reiniciar o
    // cooldown, em vez de abrir de novo com o cronômetro velho).
    this.db
      .prepare(
        `INSERT INTO endpoint_health (resource_host, consecutive_failures, circuit_state, opened_at, last_outcome, last_outcome_at)
         VALUES (?, 1, CASE WHEN 1 >= ? THEN 'open' ELSE 'closed' END, CASE WHEN 1 >= ? THEN ? ELSE NULL END, ?, ?)
         ON CONFLICT(resource_host) DO UPDATE SET
           consecutive_failures = endpoint_health.consecutive_failures + 1,
           circuit_state = CASE WHEN endpoint_health.consecutive_failures + 1 >= ? THEN 'open' ELSE 'closed' END,
           opened_at = CASE WHEN endpoint_health.consecutive_failures + 1 >= ? THEN ? ELSE NULL END,
           last_outcome = excluded.last_outcome, last_outcome_at = excluded.last_outcome_at`
      )
      .run(resourceHost, failureThreshold, failureThreshold, now, outcome, now, failureThreshold, failureThreshold, now);
  }

  /**
   * Estado EFETIVO agora (calcula half_open on-the-fly, nunca persiste esse
   * estado intermediário). "closed" = passa normal. "open" = circuito
   * aberto, ainda dentro do cooldown -- bloquear. "half_open" = cooldown
   * expirou, permitir UMA tentativa de teste (quem chama decide o que
   * fazer com isso; o resultado real via recordOutcome fecha ou reabre).
   */
  getState(resourceHost, { cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
    const row = this.db
      .prepare("SELECT consecutive_failures, circuit_state, opened_at, last_outcome, last_outcome_at FROM endpoint_health WHERE resource_host = ?")
      .get(resourceHost);
    if (!row || row.circuit_state === "closed") {
      return {
        state: "closed",
        consecutiveFailures: row ? Number(row.consecutive_failures) : 0,
        lastOutcome: row?.last_outcome ?? null,
        lastOutcomeAt: row?.last_outcome_at ?? null,
      };
    }
    const openedAtMs = row.opened_at ? Date.parse(row.opened_at) : 0;
    const cooldownElapsed = Date.now() - openedAtMs >= cooldownMs;
    return {
      state: cooldownElapsed ? "half_open" : "open",
      consecutiveFailures: Number(row.consecutive_failures),
      lastOutcome: row.last_outcome,
      lastOutcomeAt: row.last_outcome_at,
      openedAt: row.opened_at,
    };
  }
}

module.exports = { HealthStore, DEFAULT_FAILURE_THRESHOLD, DEFAULT_COOLDOWN_MS };
