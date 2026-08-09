import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, log, exists } from './util.mjs';
import { getFile, putFile } from '../upload-github.mjs';

/**
 * 실행 사이에 남겨야 하는 상태를 보관한다.
 *
 * GitHub Actions 는 매번 새 러너에서 도니까 파일이 남지 않는다. 그래서
 * 이미지 레포에 JSON 으로 커밋해 둔다. 로컬 테스트에서는 그냥 파일로 쓴다.
 *
 * 보관하는 것
 *   pending.json    발행 버튼을 아직 안 누른 초안들
 *   published.json  이미 다룬 사건 지문 — 같은 뉴스를 또 만들지 않으려고
 */

function repoConfig(config) {
  const repo = config?.imageRepo ?? process.env.IMAGE_REPO;
  const usable = (config?.imageHost ?? 'github') === 'github' && repo?.includes('/') && process.env.GITHUB_TOKEN;
  return usable ? { repo, branch: config?.imageBranch ?? 'main' } : null;
}

/**
 * 토큰 없이도 상태를 읽어 본다.
 *
 * 이미지 호스팅 때문에 레포가 Public 이라 raw 주소로 그냥 읽힌다. 로컬에서
 * 돌릴 때(GITHUB_TOKEN 이 없거나 만료됐을 때) 실제 대기 목록을 보려면 이 길이
 * 필요하다. raw 는 CDN 캐시가 끼므로 쓰기 경로로는 쓰지 않는다.
 */
async function readPublic(config, name) {
  const repo = config?.imageRepo ?? process.env.IMAGE_REPO;
  if (!repo?.includes('/')) return null;
  const branch = config?.imageBranch ?? 'main';
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/state/${name}.json?t=${Date.now()}`;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

export async function readState(config, name, fallback) {
  const target = repoConfig(config);

  if (!target) {
    const viaPublic = await readPublic(config, name);
    if (viaPublic !== null) return viaPublic;

    const file = path.join(ROOT, 'out', 'state', `${name}.json`);
    if (!(await exists(file))) return fallback;
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  try {
    const found = await getFile({ ...target, remotePath: `state/${name}.json` });
    if (!found) return fallback;
    return JSON.parse(found.content.toString('utf8'));
  } catch (err) {
    log(`  ! 상태 파일 읽기 실패(${name}): ${err.message}`);
    const viaPublic = await readPublic(config, name);
    if (viaPublic !== null) {
      log('    공개 주소로 대신 읽었습니다.');
      return viaPublic;
    }
    log('    기본값으로 진행합니다.');
    return fallback;
  }
}

export async function writeState(config, name, data) {
  const target = repoConfig(config);
  const body = JSON.stringify(data, null, 2);

  if (!target) {
    const file = path.join(ROOT, 'out', 'state', `${name}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, 'utf8');
    return;
  }

  await putFile({
    ...target,
    remotePath: `state/${name}.json`,
    buffer: Buffer.from(body, 'utf8'),
    message: `상태 갱신: ${name}`,
  });
}

/* ── 발행 대기 초안 ───────────────────────────────────────── */

/** 오래된 초안은 뉴스가 상해서 자동으로 뺀다. */
function isFresh(entry, maxHours) {
  const age = Date.now() - new Date(entry.createdAt).getTime();
  return age < maxHours * 3600_000;
}

export async function loadPending(config) {
  const maxHours = config?.pendingExpiryHours ?? 24;
  const all = await readState(config, 'pending', []);
  return all.filter((entry) => isFresh(entry, maxHours));
}

export async function addPending(config, entry) {
  const pending = await loadPending(config);
  pending.push(entry);
  await writeState(config, 'pending', pending);
}

export async function removePending(config, draftId) {
  const pending = await loadPending(config);
  await writeState(config, 'pending', pending.filter((e) => e.draftId !== draftId));
}

/* ── 이미 다룬 사건 ───────────────────────────────────────── */

export async function loadPublished(config) {
  const list = await readState(config, 'published', []);
  return new Set(list.map((e) => e.fingerprint));
}

/** 최근 것만 남긴다. 오래된 뉴스는 어차피 피드에서 사라진다. */
export async function recordPublished(config, entries) {
  const list = await readState(config, 'published', []);
  const merged = [...list, ...entries].slice(-300);
  await writeState(config, 'published', merged);
}
