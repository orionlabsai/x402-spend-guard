#!/usr/bin/env node
/**
 * Única ferramenta que liga/desliga o kill switch financeiro. Rodar
 * manualmente — este arquivo nunca é importado por spend-guard.js nem
 * spend-store.js. É assim que "o agente não pode desativar o próprio kill
 * switch" é garantido: o código que gasta dinheiro nunca tem, à disposição,
 * uma função capaz de escrever esse arquivo.
 *
 * Depois de escrever, o arquivo fica read-only (chmod 444) — fricção extra
 * contra qualquer escrita acidental ou automatizada; desligar de novo exige
 * rodar este script à mão de novo (que já tira e recoloca o read-only).
 *
 * Uso:
 *   node kill-switch-cli.js status [--path caminho/kill-switch.json]
 *   node kill-switch-cli.js on "motivo aqui" [--path caminho/kill-switch.json]
 *   node kill-switch-cli.js off [--path caminho/kill-switch.json]
 *
 * Se --path não for passado, usa ./data/kill-switch.json relativo ao
 * diretório onde o comando é rodado (mesmo default do SpendStore).
 *
 * NOTA DE SEGURANÇA (achado de auditoria, 2026-09-12): este arquivo é só
 * READ-ONLY pro código que gasta, mas isso protege contra ESCRITA, não
 * contra DELEÇÃO — apagar o arquivo (rm) faz o kill switch voltar a "nunca
 * foi ativado" (inativo), indistinguível de fato de um estado seguro. Quem
 * usa esta lib deve garantir que o processo que gasta dinheiro não tem
 * permissão de escrita no DIRETÓRIO onde este arquivo vive (não só no
 * arquivo em si).
 */
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = [...argv];
  let explicitPath;
  const pathFlagIndex = args.indexOf("--path");
  if (pathFlagIndex !== -1) {
    explicitPath = args[pathFlagIndex + 1];
    args.splice(pathFlagIndex, 2);
  }
  return { rest: args, explicitPath };
}

function resolveKillSwitchPath(explicitPath) {
  return explicitPath || path.join(process.cwd(), "data", "kill-switch.json");
}

function readState(killSwitchPath) {
  try {
    return JSON.parse(fs.readFileSync(killSwitchPath, "utf8"));
  } catch {
    return { disabled: false, reason: null, updatedAt: null };
  }
}

function writeState(killSwitchPath, state) {
  fs.mkdirSync(path.dirname(killSwitchPath), { recursive: true });
  try {
    fs.chmodSync(killSwitchPath, 0o644);
  } catch {
    // arquivo ainda não existe — sem problema, writeFileSync cria
  }
  fs.writeFileSync(killSwitchPath, JSON.stringify(state, null, 2));
  fs.chmodSync(killSwitchPath, 0o444);
}

function main() {
  const [, , cmd, ...rawRest] = process.argv;
  const { rest, explicitPath } = parseArgs(rawRest);
  const killSwitchPath = resolveKillSwitchPath(explicitPath);

  if (cmd === "status") {
    console.log(readState(killSwitchPath));
    return;
  }
  if (cmd === "on") {
    writeState(killSwitchPath, { disabled: true, reason: rest.join(" ") || "sem motivo informado", updatedAt: new Date().toISOString() });
    console.log(`Kill switch ATIVADO (${killSwitchPath}). Saídas financeiras bloqueadas até 'off' manual.`);
    return;
  }
  if (cmd === "off") {
    writeState(killSwitchPath, { disabled: false, reason: null, updatedAt: new Date().toISOString() });
    console.log(`Kill switch DESATIVADO (${killSwitchPath}). Saídas financeiras liberadas (sujeitas às demais políticas).`);
    return;
  }
  console.log('Uso: node kill-switch-cli.js <status|"on <motivo>"|off> [--path caminho/kill-switch.json]');
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = { readState, writeState, resolveKillSwitchPath, parseArgs };
