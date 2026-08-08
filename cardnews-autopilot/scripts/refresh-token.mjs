#!/usr/bin/env node
/**
 * 인스타그램 장기 토큰 갱신 / 남은 기간 확인
 *
 * 장기 토큰은 60일이면 만료된다. 만료되면 발행이 조용히 멈추므로
 * 50일쯤에 한 번 돌려서 새 토큰을 Secrets 에 덮어쓰면 된다.
 *
 *   node scripts/refresh-token.mjs           새 토큰 발급
 *   node scripts/refresh-token.mjs --check   남은 기간만 확인
 */
import { pathToFileURL } from 'node:url';
import { parseArgs, fail, fetchWithRetry } from './lib/util.mjs';

const DAY = 86_400;

function apiBase() {
  return (process.env.IG_API_BASE || 'https://graph.instagram.com').replace(/\/$/, '');
}

/**
 * 새 장기 토큰과 남은 기간을 받아온다.
 * 기존 토큰은 만료 전까지 그대로 쓸 수 있으므로 호출해도 위험하지 않다.
 * @returns {Promise<{accessToken:string, expiresInDays:number}>}
 */
export async function refreshLongLivedToken(token = process.env.IG_ACCESS_TOKEN) {
  if (!token) throw new Error('IG_ACCESS_TOKEN 환경변수가 없습니다.');

  const url =
    `${apiBase()}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithRetry(url, {}, { retries: 1 });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.error) {
    throw new Error(
      `토큰 갱신 실패: ${data.error?.message ?? res.status}\n` +
        '  토큰이 이미 만료됐다면 Meta 앱에서 새로 발급받아야 합니다.\n' +
        '  references/setup-automation.md 4-4 단계를 참고하세요.',
    );
  }

  return {
    accessToken: data.access_token,
    expiresInDays: Math.round((data.expires_in ?? 0) / DAY),
  };
}

/** 만료가 임박했는지 조용히 확인한다. 실패해도 본 작업을 막지 않는다. */
export async function checkTokenExpiry() {
  try {
    const { expiresInDays } = await refreshLongLivedToken();
    return { ok: true, expiresInDays };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  const args = parseArgs();
  const { accessToken, expiresInDays } = await refreshLongLivedToken();

  console.log(`\n남은 기간: 약 ${expiresInDays}일`);

  if (args.check) {
    if (expiresInDays < 10) console.log('⚠ 곧 만료됩니다. --check 없이 다시 실행해 새 토큰을 받으세요.');
    return;
  }

  console.log('\n새 토큰 ─────────────────────────────────');
  console.log(accessToken);
  console.log('─────────────────────────────────────────');
  console.log('\n이 값을 GitHub 레포에 덮어쓰세요:');
  console.log('  Settings → Secrets and variables → Actions → IG_ACCESS_TOKEN → Update\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
