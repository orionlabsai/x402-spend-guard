const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readState, writeState, resolveKillSwitchPath, parseArgs } = require("../kill-switch-cli.js");

test("parseArgs extrai --path e devolve o resto como motivo, em qualquer ordem", () => {
  const a = parseArgs(["motivo", "aqui", "--path", "/x/y.json"]);
  assert.deepStrictEqual(a.rest, ["motivo", "aqui"]);
  assert.strictEqual(a.explicitPath, "/x/y.json");

  const b = parseArgs(["--path", "/x/y.json", "motivo", "aqui"]);
  assert.deepStrictEqual(b.rest, ["motivo", "aqui"]);
  assert.strictEqual(b.explicitPath, "/x/y.json");

  const c = parseArgs(["motivo terminando em .json"]);
  assert.deepStrictEqual(c.rest, ["motivo terminando em .json"]);
  assert.strictEqual(c.explicitPath, undefined, "sem --path explícito, nunca deve tratar o motivo como caminho");
});

test("resolveKillSwitchPath usa o explícito quando presente, senão o default relativo ao cwd", () => {
  assert.strictEqual(resolveKillSwitchPath("/custom/path.json"), "/custom/path.json");
  assert.strictEqual(resolveKillSwitchPath(undefined), path.join(process.cwd(), "data", "kill-switch.json"));
});

test("writeState grava, deixa read-only (chmod 444), e readState lê de volta", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kill-switch-cli-"));
  const killSwitchPath = path.join(dir, "sub", "kill-switch.json");

  writeState(killSwitchPath, { disabled: true, reason: "teste", updatedAt: "2026-01-01T00:00:00.000Z" });
  const state = readState(killSwitchPath);
  assert.strictEqual(state.disabled, true);
  assert.strictEqual(state.reason, "teste");

  const mode = fs.statSync(killSwitchPath).mode & 0o777;
  assert.strictEqual(mode, 0o444, "arquivo deveria ficar read-only depois de escrito");

  // rescrever (ex: "off" depois de "on") precisa funcionar mesmo com o arquivo read-only
  writeState(killSwitchPath, { disabled: false, reason: null, updatedAt: "2026-01-02T00:00:00.000Z" });
  assert.strictEqual(readState(killSwitchPath).disabled, false);
});

test("readState() com motivo terminando em .json não confunde o CONTEÚDO do arquivo (só o parseArgs trata argv, não o conteúdo)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kill-switch-cli-"));
  const killSwitchPath = path.join(dir, "kill-switch.json");
  writeState(killSwitchPath, { disabled: true, reason: "backup corrompido em snapshot.json", updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.strictEqual(readState(killSwitchPath).reason, "backup corrompido em snapshot.json");
});
