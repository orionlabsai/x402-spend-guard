"use strict";

// Teste EXTRA de auditoria — corrida REAL entre PROCESSOS separados (não
// microtasks na mesma thread, que nunca se intercalam porque node:sqlite
// DatabaseSync é síncrono).
//
// Por que este teste existe: o teste original ("condição de corrida" em
// spend-store.test.js) usa duas instâncias de SpendStore no MESMO processo e
// `Promise.all` com `Promise.resolve().then(...)` — como `reserve()` é
// síncrono, esses callbacks rodam em sequência, NUNCA concorrentemente. Ele
// não prova atomicidade real.
//
// ACHADO DESTE TESTE (documentado em AUDIT-2026-09-12.md): sob concorrência
// REAL de processos, `node:sqlite` DatabaseSync SEM `PRAGMA busy_timeout`
// lança `SQLITE_BUSY` ("database is locked") imediatamente em vez de esperar
// — inclusive no `CREATE TABLE` do CONSTRUTOR do SpendStore, que não está em
// try/catch e derruba o processo chamador. O dinheiro continua seguro (o
// erro falha fechado, nunca há double-spend), mas a promessa de "cobre
// múltiplos processos via lock de arquivo" não vale na prática sem retry.
//
// Este teste prova a propriedade de SEGURANÇA que de fato importa — nenhum
// double-spend — tolerando o SQLITE_BUSY com retry (a mitigação que o
// chamador hoje precisaria aplicar por conta própria). Para rodar a versão
// "crua" (sem retry) e ver o crash, veja o registro no relatório de auditoria.

const { test } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SpendStore } = require("../spend-store.js");

const GUARD_DIR = path.resolve(__dirname, "..");

// Busy-wait síncrono (ms) — necessário porque DatabaseSync é síncrono e um
// loop que não "espera" não dá chance ao outro processo de soltar o lock.
function busyWaitScript(ms) {
  return `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`;
}

function childScript(dbPath, cap, reserveAmount, iterations) {
  return `
    const { SpendStore } = require(${JSON.stringify(path.join(GUARD_DIR, "spend-store.js"))});
    let store = null;
    // construtor pode lançar SQLITE_BUSY em corrida real — retenta com busy-wait
    for (let attempt = 0; attempt < 50 && !store; attempt++) {
      try { store = new SpendStore({ dbPath: ${JSON.stringify(dbPath)}, killSwitchPath: ${JSON.stringify(dbPath + ".kill.json")} }); }
      catch (e) { ${busyWaitScript(1)}; }
    }
    if (!store) { console.log(JSON.stringify({ constructorFailed: true })); process.exit(0); }

    let ok = 0, capped = 0, errors = 0;
    for (let i = 0; i < ${iterations}; i++) {
      let done = false;
      for (let attempt = 0; attempt < 50 && !done; attempt++) {
        try {
          const r = store.reserve(${reserveAmount}, ${cap});
          if (r.ok) { ok++; }
          else if (r.reason === "daily_cap_exceeded") { capped++; }
          else { errors++; }
          done = true;
        } catch (e) {
          ${busyWaitScript(1)}; // SQLITE_BUSY: espera e retenta
        }
      }
      if (!done) errors++;
    }
    store.close();
    console.log(JSON.stringify({ ok, capped, errors }));
  `;
}

function runChild(script) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
  });
}

test("corrida entre PROCESSOS: nunca há double-spend (total gasto <= teto, exato)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-race-"));
  const dbPath = path.join(dir, "shared.sqlite");
  const cap = 10_000;
  const perReserve = 1_000;
  const iterations = 200;
  const children = 4;

  const scripts = Array.from({ length: children }, () => childScript(dbPath, cap, perReserve, iterations));
  const outputs = await Promise.all(scripts.map(runChild));
  const results = outputs.map((o) => JSON.parse(o));

  const totalOk = results.reduce((s, r) => s + (r.ok || 0), 0);
  const totalCapped = results.reduce((s, r) => s + (r.capped || 0), 0);
  const totalErrors = results.reduce((s, r) => s + (r.errors || 0), 0);

  const finalStore = new SpendStore({ dbPath, killSwitchPath: dbPath + ".kill.json" });
  const totalSpent = finalStore.getSpentToday();
  finalStore.close();

  // Propriedade central de segurança: o ledger nunca pode passar do teto, e
  // o total gasto tem que ser EXATAMENTE o nº de reservas bem-sucedidas (se
  // houvesse double-spend, spent > ok*perReserve).
  assert.ok(totalSpent <= cap, `total gasto (${totalSpent}) não pode passar do teto (${cap})`);
  assert.strictEqual(totalSpent, totalOk * perReserve, "ledger deve refletir exatamente o nº de reservas que passaram");
  assert.ok(totalOk >= 1, "ao menos uma reserva deveria ter passado");

  console.log(`[race] ok=${totalOk} capExceeded=${totalCapped} errors=${totalErrors} spent=${totalSpent} (cap=${cap})`);
});
