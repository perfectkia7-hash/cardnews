import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { log, fetchWithRetry } from './util.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 로고·트래킹 픽셀처럼 카드 배경으로 못 쓸 것들 */
const MIN_BYTES = 12_000;

function extensionFor(contentType = '') {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  return '.jpg';
}

/**
 * 이미지 하나를 받아 로컬에 저장한다.
 * @returns {Promise<string>} 저장된 파일 경로. 실패하면 빈 문자열.
 */
export async function downloadImage(url, destDir, basename) {
  if (!url || !/^https?:\/\//.test(url)) return '';

  try {
    const res = await fetchWithRetry(
      url,
      { headers: { 'user-agent': UA, accept: 'image/*' }, redirect: 'follow' },
      { retries: 1, timeoutMs: 20_000 },
    );
    if (!res.ok) return '';

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !contentType.startsWith('image/')) return '';

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < MIN_BYTES) return ''; // 너무 작으면 로고일 가능성이 높다

    await fs.mkdir(destDir, { recursive: true });
    const file = path.join(destDir, basename + extensionFor(contentType));
    await fs.writeFile(file, buffer);
    return file;
  } catch {
    return '';
  }
}

/**
 * 덱의 각 카드에 붙은 image URL 을 내려받아 file:// 주소로 바꿔 넣는다.
 * 브라우저가 원격 이미지를 직접 불러오면 핫링크 차단에 걸리는 매체가 있어
 * 미리 받아서 로컬로 붙인다.
 */
export async function attachImages(cards, destDir) {
  let ok = 0;
  await Promise.all(
    cards.map(async (card, i) => {
      if (!card.image) return;
      const file = await downloadImage(card.image, destDir, String(i + 1).padStart(2, '0'));
      if (file) {
        card.imageSrc = pathToFileURL(file).href;
        ok++;
      }
    }),
  );

  const wanted = cards.filter((c) => c.image).length;
  if (wanted) log(`  이미지 ${ok}/${wanted}장 확보`);
  return ok;
}
