#!/usr/bin/env node
/**
 * 늦게 누른 발행 버튼을 처리한다.
 *
 * 초안을 만든 잡은 몇 분 기다리다 끝난다. 그 뒤에 버튼을 눌러도 발행되도록,
 * 이 스크립트가 주기적으로 돌면서 텔레그램 응답을 확인하고 대기 중인 초안을 올린다.
 *
 *   node scripts/drain.mjs
 *
 * 대기 중인 초안이 없으면 아무것도 하지 않고 바로 끝난다.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, fail, log, readJson, exists } from './lib/util.mjs';
import { loadPending } from './lib/state.mjs';
import { processDecisions } from './lib/approve.mjs';
import { pollDecisions } from './telegram.mjs';

async function loadConfig() {
  const file = path.join(ROOT, 'config', 'config.json');
  if (!(await exists(file))) fail('config/config.json 이 없습니다.');
  return readJson(file);
}

async function main() {
  const config = await loadConfig();
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) {
    fail('TELEGRAM_BOT_TOKEN 과 TELEGRAM_CHAT_ID 가 필요합니다.');
  }

  const pending = await loadPending(config);
  if (pending.length === 0) {
    log('대기 중인 초안이 없습니다.');
    return;
  }
  log(`대기 중인 초안 ${pending.length}건 — 버튼 응답 확인 중…`);

  // 한 번만 훑는다. 오래 붙들고 있을 필요가 없다 — 다음 주기에 또 돈다.
  const decisions = await pollDecisions({ chatId, timeoutSec: 5 });
  if (decisions.length === 0) {
    log('새 응답이 없습니다.');
    return;
  }

  await processDecisions(config, chatId, decisions);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
