import fs from 'node:fs/promises';
import path from 'node:path';
import { log, fetchWithRetry } from './util.mjs';

/**
 * 카드 배경 이미지를 만든다.
 *
 * 참여형 카드뉴스는 사진이 곧 내용이다. "이 프롬프트로 뽑으면 이렇게 나옵니다"
 * 를 보여주지 못하면 텍스트만 남아 단조로워진다. 뉴스는 기사 사진을 쓰면 되지만
 * 노하우·가이드는 가져올 사진이 없어서 직접 만들어야 한다.
 *
 * 수단은 있는 자격증명에 따라 고른다.
 *   1) GEMINI_API_KEY  — 하루 500장까지 무료. 화질이 낫고 서비스가 안정적이다.
 *   2) 없으면 Pollinations — 키도 가입도 없다. 대신 속도와 가용성이 들쭉날쭉하고
 *      운영 주체가 예고 없이 정책을 바꿀 수 있다.
 *
 * 상시 운영이라면 1번을 권한다. 무료 한도가 하루 500장이라 하루 세 편(15장)은
 * 한참 남는다.
 */

const GEMINI_MODEL = 'imagen-4.0-fast-generate-001';

export function detectImageProvider() {
  if (process.env.CARDNEWS_IMAGE_PROVIDER) return process.env.CARDNEWS_IMAGE_PROVIDER;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'pollinations';
}

/** 키 없이 도는 쪽. 주소에 프롬프트를 실어 보내면 이미지가 돌아온다. */
async function viaPollinations(prompt, { width, height, seed }) {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;

  const res = await fetchWithRetry(url, { headers: { accept: 'image/*' } }, {
    retries: 2,
    timeoutMs: 120_000,
  });
  if (!res.ok) throw new Error(`이미지 생성 실패 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** 무료 한도가 넉넉하고 결과가 안정적인 쪽. */
async function viaGemini(prompt, { width, height }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 가 없습니다.');

  // 가로세로 비율만 고르게 돼 있어서 요청 크기에서 가장 가까운 것을 고른다.
  const ratio = width / height;
  const aspect = ratio > 1.2 ? '16:9' : ratio < 0.85 ? '3:4' : '1:1';

  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:predict`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: aspect, personGeneration: 'allow_adult' },
      }),
    },
    { retries: 1, timeoutMs: 120_000 },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini 이미지 생성 실패: ${data?.error?.message ?? res.status}`);
  }
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('Gemini 가 이미지를 돌려주지 않았습니다.');
  return Buffer.from(b64, 'base64');
}

/**
 * 이미지 한 장을 만들어 파일로 저장한다.
 * @returns {Promise<string>} 저장된 경로. 실패하면 빈 문자열.
 */
export async function generateImage(prompt, destDir, basename, options = {}) {
  const { width = 1080, height = 1350, seed = Math.floor(Math.random() * 1e9) } = options;
  const provider = detectImageProvider();

  try {
    const buffer =
      provider === 'gemini'
        ? await viaGemini(prompt, { width, height })
        : await viaPollinations(prompt, { width, height, seed });

    if (buffer.length < 5_000) throw new Error('돌아온 이미지가 너무 작습니다.');

    await fs.mkdir(destDir, { recursive: true });
    const file = path.join(destDir, `${basename}.jpg`);
    await fs.writeFile(file, buffer);
    return file;
  } catch (err) {
    log(`  ! 이미지 생성 실패(${basename}): ${err.message}`);
    return '';
  }
}

/**
 * 카드마다 붙은 imagePrompt 로 이미지를 만들어 image 에 채운다.
 *
 * 한 번에 몰아치면 무료 서비스가 막으므로 순서대로 만든다. 장당 2~10초라
 * 다섯 장이면 1분 안쪽이다.
 *
 * 인물이 나오는 카드뉴스는 **같은 얼굴이 유지돼야** 한다. 같은 seed 를 쓰면
 * 편차가 크게 줄어서, 카드마다 다른 사람이 나오는 걸 막을 수 있다.
 */
export async function generateDeckImages(cards, destDir, options = {}) {
  const seed = options.seed ?? Math.floor(Math.random() * 1e9);
  let ok = 0;

  for (const [i, card] of cards.entries()) {
    if (!card.imagePrompt || card.image) continue;

    const file = await generateImage(card.imagePrompt, destDir, String(i + 1).padStart(2, '0'), {
      ...options,
      seed,
    });
    if (file) {
      card.image = file;
      ok += 1;
    }
  }

  const wanted = cards.filter((c) => c.imagePrompt).length;
  if (wanted) log(`      이미지 ${ok}/${wanted}장 생성 (${detectImageProvider()})`);
  return ok;
}
