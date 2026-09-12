const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SpendStore } = require("../spend-store.js");

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-spend-store-"));
  return {
    dir,
    dbPath: path.join(dir, "ledger.sqlite"),
    killSwitchPath: path.join(dir, "kill-switch.json"),
  };
}

test("reserve() aceita dentro do teto e acumula o gasto do dia", () => {
  const { dbPath, killSwitchPath } = tempPaths();
  const store = new SpendStore({ dbPath, killSwitchPath });

  const r1 = store.reserve(10_000, 100_000);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.spentAfter, 10_000);

  const r2 = store.reserve(20_000, 100_000);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.spentAfter, 30_000);

  assert.strictEqual(store.getSpentToday(), 30_000);
  store.close();
});

test("reserve() recusa quando estouraria o teto diário, sem alterar o gasto acumulado", () => {
  const { dbPath, killSwitchPath } = tempPaths();
  const store = new SpendStore({ dbPath, killSwitchPath });

  const r1 = store.reserve(90_000, 100_000);
  assert.strictEqual(r1.ok, true);

  const r2 = store.reserve(20_000, 100_000);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, "daily_cap_exceeded");

  assert.strictEqual(store.getSpentToday(), 90_000);
  store.close();
});

test("condição de corrida: duas reservas concorrentes que individualmente cabem, mas somadas estourariam o teto — só uma passa", async () => {
  const { dbPath, killSwitchPath } = tempPaths();
  const cap = 100_000;

  const storeA = new SpendStore({ dbPath, killSwitchPath });
  const storeB = new SpendStore({ dbPath, killSwitchPath });

  const [resA, resB] = await Promise.all([
    Promise.resolve().then(() => storeA.reserve(70_000, cap)),
    Promise.resolve().then(() => storeB.reserve(70_000, cap)),
  ]);

  const oks = [resA, resB].filter((r) => r.ok);
  const blocked = [resA, resB].filter((r) => !r.ok);

  assert.strictEqual(oks.length, 1, "exatamente uma das duas reservas concorrentes deve passar");
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].reason, "daily_cap_exceeded");

  const totalGasto = storeA.getSpentToday();
  assert.ok(totalGasto <= cap, `gasto total (${totalGasto}) não pode passar do teto (${cap})`);
  assert.strictEqual(totalGasto, 70_000);

  storeA.close();
  storeB.close();
});

test("logDecision() e getLog() registram aprovações e bloqueios com motivo", () => {
  const { dbPath, killSwitchPath } = tempPaths();
  const store = new SpendStore({ dbPath, killSwitchPath });

  store.logDecision({ decision: "approved", reason: "ok", amountUnits: 10_000, asset: "0xasset", network: "eip155:8453", payTo: "0xdest", resourceUrl: "https://example.com/x" });
  store.logDecision({ decision: "blocked", reason: "daily_cap_exceeded", amountUnits: 999_999, resourceUrl: "https://example.com/x" });

  const log = store.getLog(10);
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].decision, "blocked");
  assert.strictEqual(log[0].reason, "daily_cap_exceeded");
  assert.strictEqual(log[1].decision, "approved");
  store.close();
});

test("isKillSwitchActive() é false quando o arquivo nunca foi criado (ENOENT)", () => {
  const { dbPath, killSwitchPath } = tempPaths();
  const store = new SpendStore({ dbPath, killSwitchPath });
  assert.strictEqual(store.isKillSwitchActive(), false);
  store.close();
});

test("isKillSwitchActive() é true quando o arquivo diz disabled:true", () => {
  const { dbPath, killSwitchPath } = tempPaths();
  fs.writeFileSync(killSwitchPath, JSON.stringify({ disabled: true, reason: "teste" }));
  const store = new SpendStore({ dbPath, killSwitchPath });
  assert.strictEqual(store.isKillSwitchActive(), true);
  store.close();
});

test("isKillSwitchActive() falha fechado (true) quando o arquivo existe mas está corrompido", () => {
  const { dbPath, killSwitchPath } = tempPaths();
  fs.writeFileSync(killSwitchPath, "isso não é JSON válido {{{");
  const store = new SpendStore({ dbPath, killSwitchPath });
  assert.strictEqual(store.isKillSwitchActive(), true, "JSON corrompido deve ser tratado como kill switch ativo (fail-closed)");
  store.close();
});
