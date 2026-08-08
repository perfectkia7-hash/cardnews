#!/usr/bin/env node
/**
 * 인스타그램 캐러셀 발행 (Instagram Graph API)
 *
 * 발행은 3단계다.
 *   1) 이미지마다 컨테이너 생성 (is_carousel_item=true)
 *   2) 자식들을 묶어 캐러셀 컨테이너 생성
 *   3) 컨테이너가 FINISHED 되면 media_publish
 *
 *   node scripts/publish-ig.mjs --cards out/cards
 *
 * 필요한 환경변수: IG_USER_ID, IG_ACCESS_TOKEN
 * 선택: IG_API_BASE (Instagram Login = graph.instagram.com / 페북 페이지 연결 = graph.facebook.com)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, fail, log, readJson, sleep, fetchWithRetry } from './lib/util.mjs';

const API_VERSION = 'v23.0';

function apiBase() {
  return (process.env.IG_API_BASE || 'https://graph.instagram.com').replace(/\/$/, '');
}

function creds() {
  const userId = process.env.IG_USER_ID;
  const accessToken = process.env.IG_ACCESS_TOKEN;
  if (!userId) throw new Error('IG_USER_ID 환경변수가 없습니다.');
  if (!accessToken) throw new Error('IG_ACCESS_TOKEN 환경변수가 없습니다.');
  return { userId, accessToken };
}

async function post(endpoint, params) {
  const { accessToken } = creds();
  const body = new URLSearchParams({ ...params, access_token: accessToken });

  const res = await fetchWithRetry(`${apiBase()}/${API_VERSION}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error ?? {};
    throw new Error(
      `인스타 API 오류 (${res.status}): ${e.message ?? '알 수 없음'}` +
        (e.error_user_msg ? `\n  → ${e.error_user_msg}` : '') +
        (e.code ? `\n  code=${e.code}` : ''),
    );
  }
  return data;
}

async function get(endpoint, params = {}) {
  const { accessToken } = creds();
  const qs = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await fetchWithRetry(`${apiBase()}/${API_VERSION}/${endpoint}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`인스타 API 오류 (${res.status}): ${data.error?.message ?? '알 수 없음'}`);
  }
  return data;
}

/** 컨테이너가 처리될 때까지 기다린다. 이미지는 보통 몇 초면 끝난다. */
async function waitUntilReady(containerId, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let delay = 2000;

  while (Date.now() < deadline) {
    const info = await get(containerId, { fields: 'status_code,status' });
    if (info.status_code === 'FINISHED') return;
    if (info.status_code === 'ERROR') {
      throw new Error(`컨테이너 처리 실패: ${info.status ?? '상세 없음'}`);
    }
    await sleep(delay);
    delay = Math.min(delay * 1.4, 8000);
  }
  throw new Error('컨테이너 처리 시간 초과 (2분). 잠시 후 다시 시도하세요.');
}

/**
 * @param {string[]} imageUrls 공개 접근 가능한 JPEG URL (2~10장)
 * @param {string} caption
 * @returns {Promise<string>} 발행된 미디어 ID
 */
export async function publishCarousel(imageUrls, caption) {
  const { userId } = creds();

  if (imageUrls.length < 2) throw new Error('캐러셀은 최소 2장이 필요합니다.');
  if (imageUrls.length > 10) throw new Error('캐러셀은 최대 10장까지입니다.');
  const local = imageUrls.filter((u) => !/^https?:\/\//.test(u));
  if (local.length) {
    throw new Error(
      '인스타그램은 공개 URL 만 받습니다. 로컬 파일 경로가 섞여 있습니다.\n' +
        '  먼저 upload-github.mjs 로 업로드하세요.',
    );
  }

  log(`자식 컨테이너 ${imageUrls.length}개 생성 중…`);
  const children = [];
  for (const [i, url] of imageUrls.entries()) {
    const { id } = await post(`${userId}/media`, {
      image_url: url,
      is_carousel_item: 'true',
    });
    children.push(id);
    log(`  ✔ ${i + 1}/${imageUrls.length}`);
  }

  log('캐러셀 컨테이너 생성 중…');
  const { id: carouselId } = await post(`${userId}/media`, {
    media_type: 'CAROUSEL',
    children: children.join(','),
    caption: (caption ?? '').slice(0, 2200), // 인스타 캡션 한도
  });

  log('처리 대기 중…');
  await waitUntilReady(carouselId);

  log('발행 중…');
  const { id: mediaId } = await post(`${userId}/media_publish`, { creation_id: carouselId });

  return mediaId;
}

async function main() {
  const args = parseArgs();
  const dir = typeof args.cards === 'string' ? args.cards : 'out/cards';
  const manifest = await readJson(path.join(dir, 'manifest.json'));

  const urls = manifest.imageUrls ?? [];
  if (urls.length === 0) {
    fail(
      'manifest.json 에 imageUrls 가 없습니다.\n' +
        '먼저 실행하세요:  node scripts/upload-github.mjs --cards ' + dir + ' --repo owner/repo',
    );
  }

  const mediaId = await publishCarousel(urls, manifest.caption);
  log(`\n✔ 발행 완료 — media id ${mediaId}`);
  process.stdout.write(JSON.stringify({ mediaId }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
