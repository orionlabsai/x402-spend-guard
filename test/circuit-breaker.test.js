const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SpendGuard } = require("../spend-guard.js");
const { SpendStore } = require("../spend-store.js");

const RESOURCE_URL = "https://example.com/paid-route?q=oi";
const OTHER_HOST_URL = "https://mirror.example.com/paid-route?q=oi";
const NETWORK_OK = "eip155:8453";
const ASSET_OK = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO_OK = "0x000000000000000000000000000000000000aa";

const BASE_CONFIG = {
  maxPerTransactionUnits: 100_000,
  dailyCapUnits: 1_000_000,
  allowedNetworks: [NETWORK_OK],
  allowedAssets: [ASSET_OK],
  allowedPayTo: [PAYTO_OK],
  allowedResourceHosts: ["example.com", "mirror.example.com"],
};

function requirement(overrides = {}) {
  return { scheme: "exact", network: NETWORK_OK, amount: "10000", asset: ASSET_OK, payTo: PAYTO_OK, maxTimeoutSeconds: 300, ...overrides };
}

function freshGuard(configOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-spend-guard-cb-"));
  const store = new SpendStore({ dbPath: path.join(dir, "ledger.sqlite"), killSwitchPath: path.join(dir, "kill-switch.json") });
  const guard = new SpendGuard({ ...BASE_CONFIG, ...configOverrides, store });
  return { guard, store, dir };
}

test("circuitBreaker ausente na config: comportamento idêntico à v1.0.x, nunca bloqueia por saúde", () => {
  const { guard } = freshGuard(); // sem circuitBreaker
  for (let i = 0; i < 5; i++) guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  const result = guard.evaluateAccepts([requirement()], RESOURCE_URL);
  assert.equal(result.allowed, true, "sem circuitBreaker configurado, falhas anteriores nunca bloqueiam");
});

test("abre o circuito depois de N falhas consecutivas (outcome != settled)", () => {
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 } });

  for (let i = 0; i < 2; i++) {
    guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  }
  assert.equal(guard.evaluateAccepts([requirement()], RESOURCE_URL).allowed, true, "2 falhas ainda não atingiu o threshold de 3");

  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  const blocked = guard.evaluateAccepts([requirement()], RESOURCE_URL);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "circuit_open");
});

test("um outcome settled reseta o contador e fecha o circuito de novo", () => {
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } });
  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  assert.equal(guard.evaluateAccepts([requirement()], RESOURCE_URL).allowed, false, "circuito abriu com 2 falhas");

  // sonda manual bem-sucedida (simula uma tentativa fora do gate, ou um
  // sucesso registrado depois do cooldown) -- fecha o circuito
  guard.logOutcome({ outcome: "settled", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  assert.equal(guard.evaluateAccepts([requirement()], RESOURCE_URL).allowed, true, "settled fecha o circuito e zera o contador");

  const health = guard.getEndpointHealth(RESOURCE_URL);
  assert.equal(health.state, "closed");
  assert.equal(health.consecutiveFailures, 0);
});

test("depois do cooldown, o circuito aberto vira half_open e deixa passar a sonda de teste", async () => {
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 1, cooldownMs: 50 } });
  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  assert.equal(guard.getEndpointHealth(RESOURCE_URL).state, "open");
  assert.equal(guard.evaluateAccepts([requirement()], RESOURCE_URL).allowed, false);

  await new Promise((r) => setTimeout(r, 80)); // espera o cooldown de 50ms passar

  assert.equal(guard.getEndpointHealth(RESOURCE_URL).state, "half_open");
  const probe = guard.evaluateAccepts([requirement()], RESOURCE_URL);
  assert.equal(probe.allowed, true, "half_open permite a sonda de teste passar");
});

test("sonda de half_open que falha de novo reabre o circuito e reinicia o cooldown", async () => {
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 1, cooldownMs: 50 } });
  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(guard.getEndpointHealth(RESOURCE_URL).state, "half_open");

  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL }); // sonda falhou
  assert.equal(guard.getEndpointHealth(RESOURCE_URL).state, "open", "reabriu imediatamente após a sonda falhar");
});

test("hosts diferentes nunca se afetam (nem por instância global)", () => {
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL }); // example.com
  assert.equal(guard.evaluateAccepts([requirement()], RESOURCE_URL).allowed, false);
  assert.equal(guard.evaluateAccepts([requirement()], OTHER_HOST_URL).allowed, true, "mirror.example.com nunca falhou, deve continuar saudável");
});

test("chave de saúde é HOST+PATH, não só o host (achado real, 18/09/2026)", () => {
  // motivo real da mudança: um domínio pode hospedar rotas independentes
  // (ex: uma rota real e seu espelho, mesmo host, path diferente) -- se a
  // chave fosse só o host, falha numa rota abriria o circuito da OUTRA
  // também, e pickHealthyResource nunca conseguiria desviar pro "espelho"
  // porque ele teria a MESMA saúde (mesmo host) o tempo todo.
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
  const rotaA = "https://example.com/rota-a";
  const rotaB = "https://example.com/rota-b"; // MESMO host, path diferente

  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: rotaA });
  assert.equal(guard.getEndpointHealth(rotaA).state, "open");
  assert.equal(guard.getEndpointHealth(rotaB).state, "closed", "path diferente no MESMO host precisa ter saúde independente");
  assert.equal(guard.pickHealthyResource([rotaA, rotaB]), rotaB, "failover real: desvia pro path saudável do mesmo domínio");
});

test("mesmo path com query string diferente continua compartilhando saúde (é o mesmo endpoint, argumento diferente)", () => {
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
  const chamada1 = "https://example.com/verificar-cnpj?cnpj=11111111000191";
  const chamada2 = "https://example.com/verificar-cnpj?cnpj=22222222000172";

  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: chamada1 });
  assert.equal(guard.getEndpointHealth(chamada2).state, "open", "mesmo pathname, query diferente -- ainda é o mesmo endpoint, deve compartilhar saúde");
});

test("pickHealthyResource devolve o primeiro candidato saudável e null se todos estiverem abertos", () => {
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
  assert.equal(guard.pickHealthyResource([RESOURCE_URL, OTHER_HOST_URL]), RESOURCE_URL, "sem histórico, o primeiro da lista vence");

  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  assert.equal(guard.pickHealthyResource([RESOURCE_URL, OTHER_HOST_URL]), OTHER_HOST_URL, "pula o primeiro (aberto), usa o espelho saudável");

  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: OTHER_HOST_URL });
  assert.equal(guard.pickHealthyResource([RESOURCE_URL, OTHER_HOST_URL]), null, "todos abertos -- fail-closed, nenhum candidato confiável");
});

test("getEndpointHealth funciona mesmo sem circuitBreaker configurado (leitura sempre disponível)", () => {
  const { guard } = freshGuard(); // sem circuitBreaker
  guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL });
  const health = guard.getEndpointHealth(RESOURCE_URL);
  assert.equal(health.consecutiveFailures, 1);
  assert.equal(health.lastOutcome, "settle_failed");
});

test("store customizado sem .health continua funcionando (retrocompatibilidade total)", () => {
  const fakeStore = {
    reserve: () => ({ ok: true, spentBefore: 0, spentAfter: 10_000 }),
    getSpentToday: () => 0,
    logDecision: () => {},
    isKillSwitchActive: () => false,
    // sem .health de propósito -- simula um store customizado escrito antes desta feature existir
  };
  const guard = new SpendGuard({ ...BASE_CONFIG, circuitBreaker: { failureThreshold: 1, cooldownMs: 1000 }, store: fakeStore });
  assert.doesNotThrow(() => guard.logOutcome({ outcome: "settle_failed", amountUnits: 10_000, resourceUrl: RESOURCE_URL }));
  assert.equal(guard.evaluateAccepts([requirement()], RESOURCE_URL).allowed, true, "sem .health no store, circuit breaker nunca bloqueia (best-effort)");
  assert.equal(guard.getEndpointHealth(RESOURCE_URL).state, "unknown");
});

test("getEndpointHealth/pickHealthyResource nunca lançam, mesmo com input malformado (fail-closed de verdade)", () => {
  const { guard } = freshGuard({ circuitBreaker: { failureThreshold: 1, cooldownMs: 1000 } });
  assert.doesNotThrow(() => guard.getEndpointHealth("não é uma url"));
  assert.equal(guard.getEndpointHealth("não é uma url").state, "unknown");
  assert.doesNotThrow(() => guard.getEndpointHealth(undefined));
  assert.equal(guard.getEndpointHealth(undefined).state, "unknown");
  assert.doesNotThrow(() => guard.pickHealthyResource("https://example.com")); // string, não array
  assert.equal(guard.pickHealthyResource("https://example.com"), null);
  assert.doesNotThrow(() => guard.pickHealthyResource(undefined));
  assert.equal(guard.pickHealthyResource(undefined), null);
  // achado real de reauditoria: `null` explícito no 2º argumento (não só omitido)
  assert.doesNotThrow(() => guard.getEndpointHealth(RESOURCE_URL, null));
  assert.equal(guard.getEndpointHealth(RESOURCE_URL, null).state, "closed");
});

test("incremento de falhas é atômico sob concorrência REAL entre processos (não só entre chamadas no mesmo processo)", async () => {
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-spend-guard-race-"));
  const dbPath = path.join(dir, "shared.sqlite");
  const killSwitchPath = path.join(dir, "kill-switch.json");
  const guardDir = path.join(__dirname, "..");

  const childScript = `
    const { SpendStore } = require(${JSON.stringify(path.join(guardDir, "spend-store.js"))});
    const store = new SpendStore({ dbPath: ${JSON.stringify(dbPath)}, killSwitchPath: ${JSON.stringify(killSwitchPath)} });
    for (let i = 0; i < 50; i++) store.health.recordOutcome("example.com", "settle_failed");
    store.close();
  `;
  const results = [1, 2, 3, 4].map(() => spawnSync(process.execPath, ["-e", childScript], { encoding: "utf8" }));
  for (const r of results) assert.equal(r.status, 0, `processo filho falhou: ${r.stderr}`);

  const { SpendStore } = require("../spend-store.js");
  const finalStore = new SpendStore({ dbPath, killSwitchPath });
  const state = finalStore.health.getState("example.com");
  finalStore.close();
  // 4 processos x 50 falhas cada = 200 -- sem incremento atômico no SQL, isto
  // dava 54 (lost update confirmado por auditoria antes da correção).
  assert.equal(state.consecutiveFailures, 200, "incremento deve ser exato sob concorrência real entre processos");
});

test("construtor valida circuitBreaker.failureThreshold e cooldownMs", () => {
  assert.throws(() => freshGuard({ circuitBreaker: { failureThreshold: 0 } }), /failureThreshold/);
  assert.throws(() => freshGuard({ circuitBreaker: { failureThreshold: 1, cooldownMs: -1 } }), /cooldownMs/);
  assert.doesNotThrow(() => freshGuard({ circuitBreaker: {} }), "defaults (3 falhas, 60s) devem ser aceitos");
});
