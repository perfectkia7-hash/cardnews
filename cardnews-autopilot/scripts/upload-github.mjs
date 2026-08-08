#!/usr/bin/env node
/**
 * 카드 이미지를 GitHub 공개 레포에 올려 공개 raw URL 을 얻는다.
 *
 * 인스타그램 그래프 API 는 "인터넷에서 접근 가능한 이미지 URL" 을 요구한다.
 * 스케줄러로 이미 GitHub 를 쓰고 있으니 추가 가입 없이 이걸로 해결한다.
 *
 *   node scripts/upload-github.mjs --cards out/cards --repo owner/repo
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, fail, log, readJson, fetchWithRetry } from './lib/util.mjs';

const GITHUB_API = 'https://api.github.com';

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN 환경변수가 없습니다.');
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };
}

/**
 * 레포에서 파일 하나를 읽는다. 없으면 null.
 * @returns {Promise<{content: Buffer, sha: string} | null>}
 */
export async function getFile({ repo, branch = 'main', remotePath }) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${remotePath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 읽기 실패 (${res.status}): ${remotePath}`);

  const meta = await res.json();
  return { content: Buffer.from(meta.content ?? '', 'base64'), sha: meta.sha };
}

/**
 * 파일 하나를 레포에 커밋한다.
 * 같은 경로에 파일이 있으면 sha 를 넣어야 해서, 충돌 시 한 번 조회 후 재시도한다.
 */
export async function putFile({ repo, branch, remotePath, buffer, message }) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${remotePath}`;
  const body = {
    message,
    content: buffer.toString('base64'),
    branch,
  };

  let res = await fetchWithRetry(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });

  if (res.status === 409 || res.status === 422) {
    const existing = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders() });
    if (existing.ok) {
      const meta = await existing.json();
      body.sha = meta.sha;
      res = await fetchWithRetry(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 업로드 실패 (${res.status}): ${text.slice(0, 300)}`);
  }

  return `https://raw.githubusercontent.com/${repo}/${branch}/${remotePath}`;
}

/**
 * @returns {Promise<string[]>} 업로드된 이미지의 공개 raw URL 목록 (순서 유지)
 */
export async function uploadCards(files, { repo, branch = 'main', prefix = 'cards' } = {}) {
  if (!repo || !repo.includes('/')) {
    throw new Error(`레포 형식이 잘못됐습니다: '${repo}' — owner/repo 형태여야 합니다.`);
  }

  // 발행 때마다 새 폴더에 넣어 캐시·덮어쓰기 문제를 피한다.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const folder = `${prefix}/${stamp}`;

  const urls = [];
  for (const file of files) {
    const buffer = await fs.readFile(file);
    const remotePath = `${folder}/${path.basename(file)}`;
    const url = await putFile({
      repo,
      branch,
      remotePath,
      buffer,
      message: `카드뉴스 이미지 ${path.basename(file)}`,
    });
    urls.push(url);
    log(`  ✔ ${path.basename(file)}`);
  }

  return urls;
}

async function main() {
  const args = parseArgs();
  const dir = typeof args.cards === 'string' ? args.cards : 'out/cards';
  const repo = typeof args.repo === 'string' ? args.repo : process.env.IMAGE_REPO;
  if (!repo) fail('--repo owner/repo 또는 IMAGE_REPO 환경변수가 필요합니다.');

  const manifest = await readJson(path.join(dir, 'manifest.json'));
  log(`이미지 ${manifest.files.length}장 업로드 → ${repo}`);

  const urls = await uploadCards(manifest.files, {
    repo,
    branch: typeof args.branch === 'string' ? args.branch : process.env.IMAGE_BRANCH || 'main',
  });

  manifest.imageUrls = urls;
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  log('\n✔ 업로드 완료');
  process.stdout.write(JSON.stringify({ urls }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
