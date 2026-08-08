import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 스킬 패키지 루트 (scripts/lib 기준 두 단계 위) */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 패키지 루트의 .env 를 읽어 환경변수로 올린다.
 *
 * 이미 설정된 값은 건드리지 않는다 — GitHub Actions 의 Secrets 가
 * 로컬 .env 에 덮이면 안 되기 때문이다.
 * 외부 라이브러리 없이 처리하려고 직접 파싱한다.
 */
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  let raw;
  try {
    raw = fsSync.readFileSync(file, 'utf8');
  } catch {
    return; // .env 는 없어도 정상이다
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // 따옴표로 감싼 값 벗기기
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

/**
 * `--key value` 와 `--flag` 를 모두 받는 간단한 인자 파서.
 * 값에 하이픈이 들어가는 경우(색상 코드 등)를 위해 다음 토큰이 `--` 로
 * 시작할 때만 플래그로 취급한다.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

export function log(message) {
  console.error(message);
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** HTML 엔티티와 태그를 걷어내고 공백을 정리한다. */
export function stripHtml(input = '') {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  return String(input)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;/gi, (m) => entities[m.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 같은 사건을 다룬 기사를 묶기 위한 지문.
 * 조사·기호·공백을 걷어낸 뒤 앞부분만 쓴다.
 */
export function fingerprint(title = '') {
  const normalized = String(title)
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9가-힣]/g, '')
    .slice(0, 60);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `${normalized.slice(0, 24)}_${hash.toString(36)}`;
}

/**
 * 429/5xx 에 한해 지수 백오프로 재시도한다.
 *
 * 타임아웃은 `timeoutMs` 로 넘긴다. options.signal 에 직접 넣으면 첫 시도에서
 * 소진된 시그널이 재사용돼 이후 시도가 곧바로 취소된다.
 */
export async function fetchWithRetry(url, options = {}, { retries = 3, base = 800, timeoutMs } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : options.signal;
      const res = await fetch(url, { ...options, signal });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === retries) return res;
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : base * 2 ** attempt;
        await sleep(waitMs);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
      await sleep(base * 2 ** attempt);
    }
  }
  throw lastError;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 특정 타임존의 현재 시각을 {date:'2026-08-08', time:'08:15', minutes:495} 로 반환 */
export function nowInZone(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour === '24' ? '00' : parts.hour);
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hour).padStart(2, '0')}:${parts.minute}`,
    minutes: hour * 60 + minute,
  };
}
