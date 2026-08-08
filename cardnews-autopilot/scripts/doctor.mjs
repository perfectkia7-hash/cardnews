#!/usr/bin/env node
/**
 * 진단 도구 — 무엇이 준비됐고 무엇이 빠졌는지 한눈에 보여준다.
 * 세팅이 막혔을 때 가장 먼저 돌려볼 것.
 *
 *   node scripts/doctor.mjs
 */
import path from 'node:path';
import { ROOT, log, readJson, exists } from './lib/util.mjs';
import { isPlaceholder } from './lib/env.mjs';

const results = [];
const ok = (name, detail = '') => results.push(['✔', name, detail]);
const warn = (name, detail = '') => results.push(['△', name, detail]);
const bad = (name, detail = '') => results.push(['✖', name, detail]);

async function checkRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok('Node.js', `v${process.versions.node}`);
  else bad('Node.js', `v${process.versions.node} — 20 이상이 필요합니다.`);

  if (await exists(path.join(ROOT, 'node_modules'))) ok('의존성 설치됨');
  else bad('의존성 없음', 'npm install 을 실행하세요.');
}

async function checkBrowser() {
  try {
    const { findBrowser } = await import('./lib/browser.mjs');
    ok('브라우저', findBrowser());
  } catch (err) {
    bad('브라우저 없음', err.message.split('\n')[0]);
  }
}

async function checkConfig() {
  const file = path.join(ROOT, 'config', 'config.json');
  if (!(await exists(file))) {
    warn('config.json 없음', '생성 모드만 쓸 거면 없어도 됩니다. 자동 모드는 setup.mjs 실행.');
    return null;
  }
  const config = await readJson(file);
  const times = config.publishTimes ?? (config.publishAt ? [config.publishAt] : []);
  ok(
    'config.json',
    `${config.topic?.label ?? '?'} · 하루 ${times.length}편 (${times.join(', ')}) ${config.timezone}`,
  );
  if (times.length === 0) bad('발행 시각', 'publishTimes 가 비어 있습니다. setup.mjs 를 다시 실행하세요.');

  const host = config.imageHost ?? 'github';
  if (host === 'telegram') {
    warn('이미지 호스팅', '텔레그램 (테스트용). 상시 운영은 github 를 쓰세요.');
  } else if (!config.imageRepo?.includes('/')) {
    bad('imageRepo', 'owner/repo 형식이 아닙니다.');
  } else {
    ok('이미지 호스팅', `GitHub ${config.imageRepo}`);
  }
  return config;
}

/** 값이 없는지 / 예시값 그대로인지 / 진짜 채워졌는지 구분한다. */
function checkValue(key, label, { optional = false, note = '' } = {}) {
  const value = process.env[key];
  if (!value) {
    (optional ? warn : bad)(label, `${key} 없음${note ? ` — ${note}` : ''}`);
    return false;
  }
  if (isPlaceholder(value)) {
    bad(label, `${key} 가 .env.example 의 예시값 그대로입니다. 실제 값으로 바꾸세요.`);
    return false;
  }
  ok(label, `${key} 설정됨`);
  return true;
}

function checkEnv(config) {
  const host = config?.imageHost ?? 'github';

  checkValue('TELEGRAM_BOT_TOKEN', '텔레그램 봇 토큰');
  checkValue('TELEGRAM_CHAT_ID', '텔레그램 채팅 ID');
  checkValue('IG_USER_ID', '인스타 계정 ID');
  checkValue('IG_ACCESS_TOKEN', '인스타 액세스 토큰');

  // 카피 수단은 둘 중 하나만 있으면 된다.
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (oauth && !isPlaceholder(oauth)) {
    ok('카피 작성 수단', 'Claude 구독 (CLAUDE_CODE_OAUTH_TOKEN) — 추가 요금 없음');
  } else if (apiKey && !isPlaceholder(apiKey)) {
    ok('카피 작성 수단', 'Anthropic API (ANTHROPIC_API_KEY) — 토큰당 과금');
  } else {
    warn(
      '카피 작성 수단',
      'CLAUDE_CODE_OAUTH_TOKEN 또는 ANTHROPIC_API_KEY 필요 (자동 스케줄에만)',
    );
  }

  if (host === 'telegram') {
    ok('GitHub 토큰', '텔레그램 호스팅이라 필요 없음');
  } else {
    checkValue('GITHUB_TOKEN', 'GitHub 토큰', {
      optional: true,
      note: 'Actions 안에서는 자동 주입됩니다',
    });
  }
}

async function checkTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || isPlaceholder(token)) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok) ok('텔레그램 연결', `@${data.result.username}`);
    else bad('텔레그램 연결', data.description ?? '토큰을 확인하세요.');
  } catch (err) {
    bad('텔레그램 연결', err.message);
  }
}

async function checkInstagram() {
  const { IG_USER_ID: id, IG_ACCESS_TOKEN: token } = process.env;
  if (!id || !token || isPlaceholder(id) || isPlaceholder(token)) return;
  const base = (process.env.IG_API_BASE || 'https://graph.instagram.com').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/v23.0/${id}?fields=username&access_token=${token}`);
    const data = await res.json();
    if (data.error) {
      bad('인스타 연결', `${data.error.message}\n     → 토큰이 만료됐거나 권한이 부족합니다.`);
    } else {
      ok('인스타 연결', `@${data.username ?? id}`);
    }
  } catch (err) {
    bad('인스타 연결', err.message);
  }
}

async function main() {
  console.log('\n카드뉴스 오토파일럿 — 진단\n' + '─'.repeat(46));

  await checkRuntime();
  await checkBrowser();
  const config = await checkConfig();
  checkEnv(config);
  await checkTelegram();
  await checkInstagram();

  for (const [mark, name, detail] of results) {
    console.log(`  ${mark} ${name}${detail ? `\n     ${detail}` : ''}`);
  }

  const failures = results.filter(([m]) => m === '✖').length;
  const warnings = results.filter(([m]) => m === '△').length;

  console.log('─'.repeat(46));
  if (failures === 0 && warnings === 0) {
    console.log('모두 정상입니다.\n');
  } else {
    console.log(`문제 ${failures}건 · 확인 필요 ${warnings}건`);
    console.log('해결 방법은 references/troubleshooting.md 를 보세요.\n');
  }

  // process.exit() 로 즉시 끊으면 아직 정리 중인 fetch 핸들 때문에
  // 윈도우에서 libuv 어서션이 터진다. 종료 코드만 정해두고 자연히 끝나게 둔다.
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  log(err.stack || err.message);
  process.exitCode = 1;
});
