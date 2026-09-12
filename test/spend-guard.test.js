const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SpendGuard } = require("../spend-guard.js");
const { SpendStore } = require("../spend-store.js");

const RESOURCE_URL = "https://example.com/paid-route?q=oi";
const NETWORK_OK = "eip155:8453";
const ASSET_OK = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO_OK = "0x000000000000000000000000000000000000aa";

const BASE_CONFIG = {
  maxPerTransactionUnits: 100_000,
  dailyCapUnits: 1_000_000,
  allowedNetworks: [NETWORK_OK],
  allowedAssets: [ASSET_OK],
  allowedPayTo: [PAYTO_OK],
  allowedResourceHosts: ["example.com"],
};

function requirement(overrides = {}) {
  return {
    scheme: "exact",
    network: NETWORK_OK,
    amount: "10000",
    asset: ASSET_OK,
    payTo: PAYTO_OK,
    maxTimeoutSeconds: 300,
    ...overrides,
  };
}

function freshGuard(configOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-spend-guard-"));
  const store = new SpendStore({ dbPath: path.join(dir, "ledger.sqlite"), killSwitchPath: path.join(dir, "kill-switch.json") });
  const guard = new SpendGuard({ ...BASE_CONFIG, ...configOverrides, store });
  return { guard, store, dir };
}

test("construtor recusa configuração sem allowlist (falha explícita, não default permissivo)", () => {
  assert.throws(() => new SpendGuard({ ...BASE_CONFIG, allowedNetworks: [] }), /allowedNetworks/);
  assert.throws(() => new SpendGuard({ ...BASE_CONFIG, allowedAssets: undefined }), /allowedAssets/);
  assert.throws(() => new SpendGuard({ ...BASE_CONFIG, maxPerTransactionUnits: 0 }), /maxPerTransactionUnits/);
  assert.throws(() => new SpendGuard({ ...BASE_CONFIG, dailyCapUnits: -1 }), /dailyCapUnits/);
});

test("construtor recusa dailyCapUnits menor que maxPerTransactionUnits (config invertida)", () => {
  assert.throws(() => new SpendGuard({ ...BASE_CONFIG, maxPerTransactionUnits: 100_000, dailyCapUnits: 50_000 }), /dailyCapUnits/);
});

test("construtor recusa store customizado que não implementa a interface esperada", () => {
  assert.throws(() => new SpendGuard({ ...BASE_CONFIG, store: { reserve: () => {} } }), /getSpentToday|logDecision|isKillSwitchActive/);
});

test("host allowlist é case-insensitive (normalizado como new URL().hostname já normaliza)", () => {
  const { guard } = freshGuard({ allowedResourceHosts: ["EXAMPLE.COM"] });
  const decision = guard.evaluateAccepts([requirement()], "https://example.com/x");
  assert.strictEqual(decision.allowed, true);
});

test("aprova uma opção válida dentro dos limites e reserva o valor exato", () => {
  const { guard, store } = freshGuard();
  const decision = guard.evaluateAccepts([requirement()], RESOURCE_URL);
  assert.strictEqual(decision.allowed, true);
  assert.strictEqual(decision.amountUnits, 10_000);
  assert.strictEqual(store.getSpentToday(), 10_000);
  store.close();
});

test("bloqueia acima do limite por transação, sem reservar nada", () => {
  const { guard, store } = freshGuard();
  const decision = guard.evaluateAccepts([requirement({ amount: "999999999" })], RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(decision.reason, "per_transaction_limit_exceeded");
  assert.strictEqual(store.getSpentToday(), 0, "nada deve ter sido reservado numa transação recusada");
  store.close();
});

test("bloqueia quando estouraria o teto diário acumulado", () => {
  const { guard, store } = freshGuard();
  for (let i = 0; i < 10; i++) {
    const r = guard.evaluateAccepts([requirement({ amount: "100000" })], RESOURCE_URL);
    assert.strictEqual(r.allowed, true, `reserva ${i + 1}/10 deveria passar`);
  }
  assert.strictEqual(store.getSpentToday(), 1_000_000);

  const overflow = guard.evaluateAccepts([requirement({ amount: "1" })], RESOURCE_URL);
  assert.strictEqual(overflow.allowed, false);
  assert.strictEqual(overflow.reason, "daily_cap_exceeded");
  store.close();
});

test("rede fora da allowlist é bloqueada", () => {
  const { guard } = freshGuard();
  const decision = guard.evaluateAccepts([requirement({ network: "eip155:1" })], RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(decision.reason, "network_not_allowlisted");
});

test("ativo (asset) fora da allowlist é bloqueado", () => {
  const { guard } = freshGuard();
  const decision = guard.evaluateAccepts([requirement({ asset: "0xdeadbeef00000000000000000000000000dead" })], RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(decision.reason, "asset_not_allowlisted");
});

test("destinatário (payTo) fora da allowlist é bloqueado", () => {
  const { guard } = freshGuard();
  const decision = guard.evaluateAccepts([requirement({ payTo: "0x000000000000000000000000000000000000ff" })], RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(decision.reason, "payTo_not_allowlisted");
});

test("host do recurso fora da allowlist é bloqueado", () => {
  const { guard } = freshGuard();
  const decision = guard.evaluateAccepts([requirement()], "https://site-desconhecido.example/rota");
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(decision.reason, "resource_host_not_allowlisted");
});

test("accepts vazio é bloqueado (fail-closed)", () => {
  const { guard } = freshGuard();
  const decision = guard.evaluateAccepts([], RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(decision.reason, "accepts_empty");
});

test("accepts ausente/malformado é bloqueado (fail-closed)", () => {
  const { guard } = freshGuard();
  const decision = guard.evaluateAccepts(undefined, RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
});

test("se QUALQUER opção do accepts[] falhar a política, a requisição inteira é bloqueada", () => {
  const { guard, store } = freshGuard();
  const decision = guard.evaluateAccepts([requirement({ amount: "10000" }), requirement({ network: "eip155:1" })], RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(store.getSpentToday(), 0, "nenhuma opção deve ter sido reservada se uma delas falhou a política");
  store.close();
});

test("com múltiplas opções válidas, reserva o MAIOR valor entre elas (nunca subestima o que pode ser cobrado)", () => {
  const { guard, store } = freshGuard();
  const decision = guard.evaluateAccepts([requirement({ amount: "10000" }), requirement({ amount: "30000" })], RESOURCE_URL);
  assert.strictEqual(decision.allowed, true);
  assert.strictEqual(decision.amountUnits, 30_000);
  assert.strictEqual(store.getSpentToday(), 30_000);
  store.close();
});

test("kill switch ativo bloqueia mesmo uma opção totalmente válida", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-spend-guard-"));
  const killSwitchPath = path.join(dir, "kill-switch.json");
  fs.writeFileSync(killSwitchPath, JSON.stringify({ disabled: true, reason: "teste manual" }));
  const store = new SpendStore({ dbPath: path.join(dir, "ledger.sqlite"), killSwitchPath });
  const guard = new SpendGuard({ ...BASE_CONFIG, store });

  const decision = guard.evaluateAccepts([requirement()], RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(decision.reason, "kill_switch_active");
  assert.strictEqual(store.getSpentToday(), 0);
  store.close();
});

test("erro interno (store quebrado) vira bloqueio, nunca exceção não tratada (fail-closed)", () => {
  const { guard, store } = freshGuard();
  store.reserve = () => {
    throw new Error("falha simulada de I/O");
  };
  const decision = guard.evaluateAccepts([requirement()], RESOURCE_URL);
  assert.strictEqual(decision.allowed, false);
  assert.match(decision.reason, /internal_error/);
  store.close();
});

test("toda decisão (aprovada ou bloqueada) gera uma entrada de log com motivo", () => {
  const { guard, store } = freshGuard();
  guard.evaluateAccepts([requirement()], RESOURCE_URL);
  guard.evaluateAccepts([requirement({ network: "eip155:1" })], RESOURCE_URL);

  const log = store.getLog(10);
  assert.strictEqual(log.length, 2);
  assert.ok(log.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0));
  assert.strictEqual(log[0].decision, "blocked");
  assert.strictEqual(log[0].reason, "network_not_allowlisted");
  assert.strictEqual(log[1].decision, "approved");
  store.close();
});

test("logOutcome() registra o resultado real do envio separado da decisão do gate", () => {
  const { guard, store } = freshGuard();
  const decision = guard.evaluateAccepts([requirement()], RESOURCE_URL);
  guard.logOutcome({ outcome: "settled", amountUnits: decision.amountUnits, resourceUrl: RESOURCE_URL });

  const log = store.getLog(10);
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].decision, "outcome_settled");
  store.close();
});

test("allowlists são case-insensitive pra endereço (asset/payTo)", () => {
  const { guard } = freshGuard({ allowedAssets: [ASSET_OK.toUpperCase()], allowedPayTo: [PAYTO_OK.toUpperCase()] });
  const decision = guard.evaluateAccepts([requirement()], RESOURCE_URL);
  assert.strictEqual(decision.allowed, true);
});

test("cada instância mantém sua própria allowlist — configs diferentes não vazam entre si", () => {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "x402-spend-guard-"));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "x402-spend-guard-"));
  const guardA = new SpendGuard({
    ...BASE_CONFIG,
    allowedResourceHosts: ["a.example.com"],
    store: new SpendStore({ dbPath: path.join(dir1, "l.sqlite"), killSwitchPath: path.join(dir1, "k.json") }),
  });
  const guardB = new SpendGuard({
    ...BASE_CONFIG,
    allowedResourceHosts: ["b.example.com"],
    store: new SpendStore({ dbPath: path.join(dir2, "l.sqlite"), killSwitchPath: path.join(dir2, "k.json") }),
  });

  assert.strictEqual(guardA.evaluateAccepts([requirement()], "https://a.example.com/x").allowed, true);
  assert.strictEqual(guardA.evaluateAccepts([requirement()], "https://b.example.com/x").allowed, false);
  assert.strictEqual(guardB.evaluateAccepts([requirement()], "https://b.example.com/x").allowed, true);
  assert.strictEqual(guardB.evaluateAccepts([requirement()], "https://a.example.com/x").allowed, false);
});
