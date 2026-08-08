#!/usr/bin/env node
/**
 * 인스타그램 연결 마법사.
 *
 * 액세스 토큰만 .env 에 넣어두면 나머지를 알아서 채운다.
 *   - 어떤 연동 방식인지 (Instagram 로그인 / 페이스북 페이지) 자동 판별
 *   - 발행에 쓸 올바른 계정 ID 조회        ← 여기서 제일 많이 틀린다
 *   - 발행 권한이 실제로 있는지 확인
 *
 *   node scripts/instagram-setup.mjs
 */
import { pathToFileURL } from 'node:url';
import { fail, log, fetchWithRetry } from './lib/util.mjs';
import { setEnvValue, isPlaceholder } from './lib/env.mjs';

const VERSION = 'v23.0';
const IG_LOGIN = 'https://graph.instagram.com';
const FB_LOGIN = 'https://graph.facebook.com';

async function api(base, endpoint, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const res = await fetchWithRetry(`${base}/${VERSION}/${endpoint}?${qs}`, {}, { retries: 1, timeoutMs: 20_000 });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !data.error, data };
}

/**
 * Instagram 로그인 방식.
 * 발행에 쓰는 건 `id` 가 아니라 `user_id` 다. 이걸 헷갈리면
 * 발행 단계에서 권한 오류가 나는데 원인을 찾기가 어렵다.
 */
async function tryInstagramLogin() {
  const { ok, data } = await api(IG_LOGIN, 'me', { fields: 'user_id,username,account_type' });
  if (!ok) return null;

  return {
    base: IG_LOGIN,
    userId: String(data.user_id ?? data.id),
    username: data.username,
    accountType: data.account_type,
    route: 'Instagram 로그인',
  };
}

/** 페이스북 페이지에 연결된 인스타 계정을 찾는 방식. */
async function tryFacebookLogin() {
  const { ok, data } = await api(FB_LOGIN, 'me/accounts', {
    fields: 'name,instagram_business_account{id,username}',
  });
  if (!ok) return null;

  const linked = (data.data ?? []).filter((page) => page.instagram_business_account);
  if (linked.length === 0) return null;

  if (linked.length > 1) {
    log('\n연결된 인스타 계정이 여러 개입니다:');
    for (const page of linked) {
      log(`  · @${page.instagram_business_account.username}  (페이지: ${page.name})`);
    }
    log('첫 번째 것을 씁니다. 다른 걸 쓰려면 .env 의 IG_USER_ID 를 직접 바꾸세요.\n');
  }

  const account = linked[0].instagram_business_account;
  return {
    base: FB_LOGIN,
    userId: String(account.id),
    username: account.username,
    accountType: 'BUSINESS',
    route: '페이스북 페이지 연결',
  };
}

/** 발행 권한이 실제로 붙어 있는지 확인한다. 토큰만 있고 권한이 빠진 경우가 흔하다. */
async function checkPublishPermission(account) {
  const { ok, data } = await api(account.base, `${account.userId}/content_publishing_limit`, {
    fields: 'config,quota_usage',
  });
  if (!ok) return { ok: false, message: data.error?.message ?? '확인 실패' };

  const row = data.data?.[0] ?? {};
  return {
    ok: true,
    used: row.quota_usage ?? 0,
    quota: row.config?.quota_total ?? 100,
  };
}

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  인스타그램 연결');
  console.log('══════════════════════════════════════════\n');

  if (isPlaceholder(process.env.IG_ACCESS_TOKEN)) {
    console.log('먼저 액세스 토큰을 받아 .env 에 넣어주세요.\n');
    console.log('  1. 인스타 앱 → 설정 → 계정 유형 및 도구');
    console.log('       → 프로페셔널 계정으로 전환 (비즈니스 또는 크리에이터)');
    console.log('  2. developers.facebook.com → 개발자 등록 → 앱 만들기');
    console.log('  3. 제품 추가 → Instagram → 설정');
    console.log('  4. "Instagram 로그인 사용" 방식 선택 → 내 계정 연결');
    console.log('  5. 액세스 토큰 생성 → 나온 값을 .env 의 IG_ACCESS_TOKEN 에\n');
    console.log('계정 ID 는 이 스크립트가 알아서 찾습니다. 토큰만 넣으면 됩니다.\n');
    console.log('그다음 다시 실행하세요:');
    console.log('  node scripts/instagram-setup.mjs\n');
    process.exitCode = 1;
    return;
  }

  console.log('연동 방식을 확인하는 중…\n');

  const account = (await tryInstagramLogin()) ?? (await tryFacebookLogin());

  if (!account) {
    fail(
      '토큰으로 계정을 찾지 못했습니다. 아래를 확인하세요.\n\n' +
        '  · 토큰을 통째로(잘리지 않게) 붙여넣었는지\n' +
        '  · 인스타 계정이 프로페셔널(비즈니스/크리에이터)인지\n' +
        '  · Meta 앱의 Instagram 설정에서 내 계정을 연결했는지\n' +
        '  · 토큰이 만료되지 않았는지 (새로 발급받아 보세요)\n',
    );
  }

  console.log(`✔ 계정 확인됨 — @${account.username}`);
  console.log(`  연동 방식: ${account.route}`);
  console.log(`  계정 유형: ${account.accountType ?? '알 수 없음'}`);
  console.log(`  계정 ID:   ${account.userId}\n`);

  if (account.accountType === 'PERSONAL') {
    fail(
      '개인 계정입니다. 발행 API 는 프로페셔널 계정에서만 동작합니다.\n' +
        '  인스타 앱 → 설정 → 계정 유형 및 도구 → 프로페셔널 계정으로 전환',
    );
  }

  const permission = await checkPublishPermission(account);
  if (permission.ok) {
    console.log(`✔ 발행 권한 확인됨 — 24시간 내 ${permission.used}/${permission.quota}건 사용\n`);
  } else {
    console.log(`△ 발행 권한을 확인하지 못했습니다: ${permission.message}`);
    console.log('  Meta 앱 → Instagram → API 설정에서 아래 권한이 있는지 보세요.');
    console.log('    instagram_business_basic');
    console.log('    instagram_business_content_publish');
    console.log('  권한을 추가했다면 토큰을 다시 발급받아야 반영됩니다.\n');
  }

  await setEnvValue('IG_USER_ID', account.userId);
  await setEnvValue('IG_API_BASE', account.base);
  console.log('✔ .env 에 IG_USER_ID 와 IG_API_BASE 를 채웠습니다.\n');

  console.log('다음 단계:');
  console.log('  node scripts/doctor.mjs     전체 점검\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
