/**
 * Ledger persistente (SQLite via node:sqlite) do teto de gasto diário e do
 * kill switch. Cada instância abre (ou cria) um arquivo SQLite próprio — se
 * o processo que chama isto é de vida curta (um script CLI que roda, gasta,
 * sai), o SQLite é o que persiste o gasto acumulado do dia entre uma
 * execução e a próxima. Se o processo é de vida longa (um servidor), a
 * mesma instância serve todas as chamadas.
 *
 * A atomicidade de "reservar sem estourar o teto" vem de uma transação
 * SQLite (`BEGIN IMMEDIATE`) — o próprio SQLite serializa escritores
 * concorrentes via lock de arquivo, o que cobre múltiplos processos no
 * mesmo host. Se isso precisar rodar em múltiplos hosts, troque esta classe
 * por um store compartilhado real (Redis/Postgres) implementando a mesma
 * interface (reserve/getSpentToday/logDecision/isKillSwitchActive) — nada
 * em spend-guard.js precisaria mudar.
 */
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { HealthStore } = require("./health-store");

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "x402-spend-guard.sqlite");
const DEFAULT_KILL_SWITCH_PATH = path.join(process.cwd(), "data", "kill-switch.json");

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

class SpendStore {
  constructor({ dbPath = DEFAULT_DB_PATH, killSwitchPath = DEFAULT_KILL_SWITCH_PATH } = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.killSwitchPath = killSwitchPath;
    this.db = new DatabaseSync(dbPath);
    // Sem isso, DatabaseSync lança SQLITE_BUSY ("database is locked") na hora
    // sob concorrência real entre processos, em vez de esperar o lock soltar
    // (achado real de auditoria, 2026-09-12 — reproduzido com processos
    // filhos de verdade, não microtask no mesmo processo). O lock de arquivo
    // do SQLite ainda serializa os escritores; isto só faz esperar em vez de
    // falhar imediatamente.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_spend (
        date TEXT PRIMARY KEY,
        spent_units INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS spend_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        amount_units INTEGER,
        asset TEXT,
        network TEXT,
        pay_to TEXT,
        resource_url TEXT
      );
    `);
    // mesma conexão/arquivo -- HealthStore cria sua própria tabela
    // (endpoint_health), nunca duplica o daily_spend/spend_log.
    this.health = new HealthStore(this.db);
  }

  /**
   * Reserva `amountUnits` (inteiro, unidades atômicas do ativo) contra
   * `dailyCapUnits` de forma atômica. Nunca lança em caso de estouro — só
   * retorna `{ ok: false, reason: "daily_cap_exceeded", ... }`. Uma exceção
   * real (erro de I/O do SQLite) propaga pro chamador, que deve tratá-la
   * como "não reservou" (fail-closed é responsabilidade de quem chama, ver
   * spend-guard.js).
   */
  reserve(amountUnits, dailyCapUnits) {
    const date = todayUTC();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT spent_units FROM daily_spend WHERE date = ?").get(date);
      const spentBefore = row ? Number(row.spent_units) : 0;
      if (spentBefore + amountUnits > dailyCapUnits) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "daily_cap_exceeded", spentBefore, dailyCapUnits };
      }
      if (row) {
        this.db.prepare("UPDATE daily_spend SET spent_units = spent_units + ? WHERE date = ?").run(amountUnits, date);
      } else {
        this.db.prepare("INSERT INTO daily_spend (date, spent_units) VALUES (?, ?)").run(date, amountUnits);
      }
      this.db.exec("COMMIT");
      return { ok: true, spentBefore, spentAfter: spentBefore + amountUnits };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // já sem transação aberta — ignora
      }
      throw err;
    }
  }

  getSpentToday() {
    const row = this.db.prepare("SELECT spent_units FROM daily_spend WHERE date = ?").get(todayUTC());
    return row ? Number(row.spent_units) : 0;
  }

  logDecision({ decision, reason, amountUnits = null, asset = null, network = null, payTo = null, resourceUrl = null }) {
    this.db
      .prepare(
        `INSERT INTO spend_log (ts, decision, reason, amount_units, asset, network, pay_to, resource_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(new Date().toISOString(), decision, reason, amountUnits, asset, network, payTo, resourceUrl);
  }

  getLog(limit = 50) {
    return this.db.prepare("SELECT * FROM spend_log ORDER BY id DESC LIMIT ?").all(limit);
  }

  /**
   * Só leitura — nada nesta classe (nem em spend-guard.js) escreve o kill
   * switch. A única escrita possível é via kill-switch-cli.js, rodado à mão,
   * nunca importado pelo código que gasta. Distingue "nunca foi ativado"
   * (ENOENT — sem risco, retorna inativo) de qualquer outro erro de leitura
   * (permissão, JSON corrompido — fail-closed: trata como ativo, já que não
   * dá pra confirmar que está seguro prosseguir).
   */
  isKillSwitchActive() {
    let raw;
    try {
      raw = fs.readFileSync(this.killSwitchPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return false;
      return true; // não deu pra ler por outro motivo — assume o pior
    }
    try {
      return !!JSON.parse(raw).disabled;
    } catch {
      return true; // JSON corrompido — assume o pior
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { SpendStore, todayUTC };
