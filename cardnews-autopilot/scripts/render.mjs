#!/usr/bin/env node
/**
 * draft.json → 인스타그램 캐러셀 이미지(1080×1350 JPEG)
 *
 *   node scripts/render.mjs --draft out/draft.json --template minimal --out out/cards
 *   node scripts/render.mjs --draft out/draft.json --template darktech --handle "@my_news" --accent "#3B82F6"
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';
import { attachImages } from './lib/images.mjs';
import { ROOT, parseArgs, fail, log, readJson, exists } from './lib/util.mjs';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

export const TEMPLATES = ['story', 'news', 'minimal', 'breaking', 'magazine', 'darktech', 'board'];

/**
 * 표지 + 본문 + 엔딩을 하나의 덱으로 조립한다. 템플릿은 이 구조만 알면 된다.
 *
 * cta 를 주면 마지막 장이 "댓글 남기면 보내드려요" 카드로 바뀐다. 반응이
 * 몰리는 계정들의 마지막 장이 전부 이 형태다 — 좋아요보다 댓글이 몇 배 많은
 * 게시물은 예외 없이 여기서 만들어진다.
 *
 * cta 는 모델이 아니라 설정에서 온다. 줄 물건이 실제로 있을 때만 약속해야
 * 하는데, 모델은 그걸 알 수 없기 때문이다.
 */
export function buildDeck(draft, { outro = true, cta = null } = {}) {
  const cards = [];
  const body = draft.cards ?? [];

  cards.push({
    kind: 'cover',
    headline: draft.title ?? '',
    body: draft.subtitle ?? '',
    source: '',
    // 표지 사진을 따로 안 줬으면 첫 기사 사진을 쓴다.
    image: draft.coverImage ?? body[0]?.image ?? '',
  });

  for (const card of body) {
    cards.push({
      kind: 'content',
      headline: card.headline ?? '',
      body: card.body ?? '',
      source: card.source ?? '',
      image: card.image ?? '',
    });
  }

  if (outro) {
    const publishers = [...new Set((draft.sources ?? []).map((s) => s.publisher).filter(Boolean))];
    const headline = cta?.promise
      ? `댓글 남기면\n${cta.promise}`
      : draft.outroHeadline ?? '도움이 되셨다면\n저장 & 팔로우';
    const body = cta?.promise
      ? `${cta.trigger ?? '아무 댓글'}이나 남겨 주시면\nDM 으로 바로 보내드려요.\n\n팔로우하고 계셔야 전송됩니다.`
      : draft.outroBody ?? '매일 새로운 소식을 정리해 드려요.';

    cards.push({
      kind: 'outro',
      headline,
      body,
      source: publishers.length ? `출처 · ${publishers.slice(0, 4).join(', ')}` : '',
      image: draft.outroImage ?? '',
    });
  }

  // 인스타 캐러셀 한도
  if (cards.length > 10) cards.length = 10;

  return cards.map((card, i) => ({ ...card, index: i + 1, total: Math.min(cards.length, 10) }));
}

async function main() {
  const args = parseArgs();

  const draftPath = typeof args.draft === 'string' ? args.draft : 'out/draft.json';
  if (!(await exists(draftPath))) {
    fail(`초안 파일이 없습니다: ${draftPath}\n먼저 뉴스를 수집하고 draft.json 을 작성하세요.`);
  }
  const draft = await readJson(draftPath);

  const template = typeof args.template === 'string' ? args.template : 'story';
  const templatePath = path.join(ROOT, 'templates', `${template}.html`);
  if (!(await exists(templatePath))) {
    fail(`템플릿 '${template}' 이 없습니다. 사용 가능: ${TEMPLATES.join(', ')}`);
  }

  const outDir = path.resolve(typeof args.out === 'string' ? args.out : 'out/cards');

  const brand = {
    handle: typeof args.handle === 'string' ? args.handle : draft.brand?.handle ?? '',
    accent: typeof args.accent === 'string' ? args.accent : draft.brand?.accent ?? '',
    label: typeof args.label === 'string' ? args.label : draft.brand?.label ?? '',
  };

  // 사진을 폴더째 넘기면 파일명 순서대로 표지부터 붙인다.
  //
  // 프롬프트 가이드 같은 카드뉴스는 "이 프롬프트로 뽑으면 이렇게 나옵니다" 가
  // 핵심이라 직접 만든 이미지를 써야 한다. draft.json 에 경로를 하나씩 적는
  // 것보다 폴더에 넣고 한 번에 넘기는 편이 손이 덜 간다.
  if (typeof args.photos === 'string') {
    const dir = path.resolve(args.photos);
    const files = (await fs.readdir(dir))
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort()
      .map((f) => path.join(dir, f));

    if (files.length === 0) fail(`${dir} 안에 이미지가 없습니다.`);
    log(`사진 ${files.length}장을 ${path.basename(dir)} 에서 가져옵니다.`);

    // 첫 장은 표지, 나머지는 본문 카드에 순서대로.
    const [cover, ...rest] = files;
    draft.coverImage = cover;
    (draft.cards ?? []).forEach((card, i) => {
      if (rest[i]) card.image = rest[i];
    });
  }

  // 줄 물건이 있을 때만 CTA 를 붙인다. --cta-promise 가 곧 "무엇을 준다"는 약속이다.
  const cta =
    typeof args['cta-promise'] === 'string'
      ? {
          promise: args['cta-promise'],
          trigger: typeof args['cta-trigger'] === 'string' ? args['cta-trigger'] : '아무 댓글',
        }
      : draft.cta ?? null;

  const deck = buildDeck(draft, {
    outro: args.outro !== 'false' && args['no-outro'] !== true,
    cta,
  });
  if (deck.length < 2) fail('카드가 1장뿐입니다. draft.json 의 cards 배열을 확인하세요.');

  log(`카드 ${deck.length}장 렌더링 (템플릿: ${template})…`);

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  // 사진은 미리 받아서 로컬로 붙인다 (핫링크 차단 회피).
  if (args['no-images'] !== true) {
    await attachImages(deck, path.join(outDir, '.src'));
  }

  const browser = await launchBrowser();
  const files = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: CARD_WIDTH, height: CARD_HEIGHT, deviceScaleFactor: 1 });

    // 템플릿 스크립트가 읽어갈 데이터. goto 이전에 주입해야 한다.
    await page.evaluateOnNewDocument(
      (payload) => {
        window.__DECK__ = payload;
      },
      { cards: deck, brand },
    );

    await page.goto(pathToFileURL(templatePath).href, { waitUntil: 'networkidle0', timeout: 60_000 });

    // 웹폰트가 늦게 오면 글자가 잘려 보인다. 폰트 로딩까지 기다린다.
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    await page.waitForSelector('.card', { timeout: 15_000 });

    const handles = await page.$$('.card');
    if (handles.length !== deck.length) {
      log(`  ! 템플릿이 만든 카드 수(${handles.length})가 예상(${deck.length})과 다릅니다.`);
    }

    for (let i = 0; i < handles.length; i++) {
      const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}.jpg`);
      await handles[i].screenshot({ path: file, type: 'jpeg', quality: 92 });
      files.push(file);
      log(`  ✔ ${path.basename(file)}`);
    }
  } finally {
    await browser.close();
  }

  // 매체 사진을 쓰므로 출처 표기는 항상 캡션에 붙인다.
  const publishers = [...new Set((draft.sources ?? []).map((s) => s.publisher).filter(Boolean))];
  const credit = publishers.length ? `출처 · ${publishers.join(', ')}` : '';

  // CTA 는 캡션 맨 앞에 둔다. 인스타는 두 줄만 보이고 나머지는 "더 보기" 로
  // 접히므로, 뒤에 두면 아무도 못 본다. 반응이 몰리는 게시물은 예외 없이
  // 첫 줄이 트리거 문구다.
  const ctaLine = cta?.promise
    ? `[${cta.trigger ?? '아무 댓글'}→전송] ${cta.promise}`
    : '';

  const caption = [ctaLine, draft.caption ?? '', credit, (draft.hashtags ?? []).join(' ')]
    .filter(Boolean)
    .join('\n\n');
  const manifest = {
    template,
    brand,
    title: draft.title ?? '',
    caption,
    hashtags: draft.hashtags ?? [],
    sources: draft.sources ?? [],
    files,
    renderedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  log(`\n✔ 완료 — ${outDir}`);
  process.stdout.write(JSON.stringify(manifest, null, 2));
}

// 다른 스크립트가 import 할 때는 실행하지 않는다.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
