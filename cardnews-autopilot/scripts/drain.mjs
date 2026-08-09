#!/usr/bin/env node
/**
 * 늦게 누른 발행 버튼을 처리한다.
 *
 * 초안을 만든 잡은 몇 분 기다리다 끝난다. 그 뒤에 버튼을 눌러도 발행되도록,
 * 이 스크립트가 주기적으로 돌면서 텔레그램 응답을 확인하고 대기 중인 초안을 올린다.
 *
 *   node scripts/drain.mjs                     한 번만 확인하고 끝
 *   node scripts/drain.mjs --watch --minutes 14  그 시간 동안 계속 지켜보기
 *
 * --watch 를 쓰는 이유: 한 번만 찍고 끝나면 "크론이 뛴 그 순간"에만 반응한다.
 * GitHub 의 예약 실행은 자주 밀리고 가끔 몇 시간씩 건너뛰는데, 그동안 누른
 * 버튼은 다음 실행까지 방치된다. 잡이 살아 있는 내내 롱폴링하면 누르는 즉시
 * 반응하고, 예약이 밀려도 잡이 뜨는 순간 밀린 응답을 한꺼번에 처리한다.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, parseArgs, fail, log, readJson, exists, sleep } from './lib/util.mjs';
import { loadPending } from './lib/state.mjs';
import { processDecisions } from './lib/approve.mjs';
import { pollDecisions } from './telegram.mjs';

async function loadConfig() {
  const file = path.join(ROOT, 'config', 'config.json');
  if (!(await exists(file))) fail('config/config.json 이 없습니다.');
  return readJson(file);
}

/**
 * 초안 잡이 지금 돌고 있는지 본다.
 *
 * 초안 잡도 자기 초안의 버튼을 기다리며 폴링한다. 둘이 동시에 폴링하면
 * 텔레그램이 한쪽을 끊으므로(409), 초안 잡이 도는 동안은 이쪽이 쉰다.
 * 폴러를 항상 하나로 유지하는 게 목적이다.
 *
 * 확인에 실패하면 "안 돈다"고 본다 — 지켜보기를 멈추는 것보다 겹치는 편이 낫다.
 */
async function tickIsRunning(config) {
  const repo = process.env.GITHUB_REPOSITORY ?? config?.imageRepo;
  if (!repo?.includes('/')) return false;

  const url = `https://api.github.com/repos/${repo}/actions/workflows/cardnews.yml/runs?status=in_progress&per_page=1`;
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.total_count ?? 0) > 0;
  } catch {
    return false;
  }
}

/** 한 번 훑고 처리한다. 처리한 건수를 돌려준다. */
async function sweep(config, chatId, { timeoutSec }) {
  const decisions = await pollDecisions({ chatId, timeoutSec });
  if (decisions.length === 0) return 0;
  const results = await processDecisions(config, chatId, decisions);
  return results.length;
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig();
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) {
    fail('TELEGRAM_BOT_TOKEN 과 TELEGRAM_CHAT_ID 가 필요합니다.');
  }

  const watch = Boolean(args.watch);
  const minutes = Number(args.minutes ?? config.drainWatchMinutes ?? 14);

  if (!watch) {
    // 단발 모드 — 대기 초안이 없으면 폴링할 이유가 없다.
    const pending = await loadPending(config);
    if (pending.length === 0) {
      log('대기 중인 초안이 없습니다.');
      return;
    }
    log(`대기 중인 초안 ${pending.length}건 — 버튼 응답 확인 중…`);
    const handled = await sweep(config, chatId, { timeoutSec: 5 });
    log(handled === 0 ? '새 응답이 없습니다.' : `${handled}건 처리했습니다.`);
    return;
  }

  // 지켜보기 모드.
  //
  // 대기 초안이 없어도 계속 돈다. 지켜보는 중에 초안 잡이 새 초안을 올릴 수 있고,
  // 그때 바로 반응해야 "누르면 즉시 올라간다"가 성립한다.
  const deadline = Date.now() + minutes * 60_000;
  log(`발행 버튼 지켜보는 중… (${minutes}분)`);

  let handled = 0;
  let paused = false;
  let checkedAt = 0;

  while (Date.now() < deadline) {
    const remainingSec = Math.floor((deadline - Date.now()) / 1000);
    if (remainingSec < 5) break;

    // 초안 잡 확인은 1분에 한 번이면 충분하다.
    if (Date.now() - checkedAt > 60_000) {
      checkedAt = Date.now();
      const busy = await tickIsRunning(config);
      if (busy !== paused) {
        log(busy ? '  · 초안 잡이 도는 중 — 잠시 양보합니다' : '  · 다시 지켜봅니다');
        paused = busy;
      }
    }

    if (paused) {
      await sleep(20_000);
      continue;
    }

    const before = handled;
    handled += await sweep(config, chatId, { timeoutSec: Math.min(45, remainingSec) });
    if (handled > before) log(`  누적 ${handled}건 처리`);

    // 롱폴링이 즉시 빈손으로 돌아오는 건 대개 오류(예: 다른 폴러와 충돌)다.
    // 그럴 때 곧바로 다시 때리면 서로를 계속 끊으므로 잠깐 쉰다.
    await sleep(1000);
  }

  log(handled === 0 ? '처리할 응답이 없었습니다.' : `총 ${handled}건 처리했습니다.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
