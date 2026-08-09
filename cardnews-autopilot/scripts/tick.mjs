#!/usr/bin/env node
/**
 * 자동 모드 진입점 — GitHub Actions 가 정해진 시각에 이 파일을 부른다.
 *
 *   뉴스 수집 → 카피 → 렌더 → 레포 업로드 → 텔레그램 전송
 *   → 발행 버튼 대기 → 인스타 발행
 *
 *   node scripts/tick.mjs                          정상 실행
 *   node scripts/tick.mjs --dry                    텔레그램까지만, 발행 안 함
 *   node scripts/tick.mjs --skip-approval          승인 없이 바로 발행
 *   node scripts/tick.mjs --draft out/draft.json   이미 만든 초안으로 발행만
 *   node scripts/tick.mjs --host telegram          GitHub 없이 발행 (테스트용)
 *
 * --draft 를 주면 뉴스 수집과 카피 작성을 건너뛴다. Anthropic 키 없이도
 * 돌아가므로 인스타 연동만 따로 검증할 때 쓴다.
 *
 * --host telegram 은 텔레그램에 올린 사진 주소를 그대로 인스타에 넘긴다.
 * GitHub 레포 없이 연동을 확인할 수 있지만, 주소에 봇 토큰이 들어가고
 * 텔레그램이 사진을 재압축하므로 상시 운영에는 기본값(github)을 쓴다.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, parseArgs, fail, log, readJson, writeJson, exists } from './lib/util.mjs';
import { writeCardNews, detectProvider } from './lib/copywriter.mjs';
import { writeEngageCards } from './lib/engage.mjs';
import { generateDeckImages } from './lib/imagegen.mjs';
import { uploadCards } from './upload-github.mjs';
import { publishCarousel } from './publish-ig.mjs';
import { checkTokenExpiry } from './refresh-token.mjs';
import {
  sendAlbum,
  sendControls,
  sendMessage,
  photoUrls,
  answerCallback,
  clearButtons,
  awaitDecision,
  sendMusicHint,
} from './telegram.mjs';
import { loadPublished, recordPublished, addPending, removePending } from './lib/state.mjs';
import { processDecisions } from './lib/approve.mjs';

const run = promisify(execFile);

async function loadConfig() {
  const file = path.join(ROOT, 'config', 'config.json');
  if (!(await exists(file))) {
    fail('config/config.json 이 없습니다.  먼저 실행하세요:  node scripts/setup.mjs');
  }
  return readJson(file);
}

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    fail(
      `환경변수가 없습니다: ${missing.join(', ')}\n` +
        'GitHub 레포 → Settings → Secrets and variables → Actions 에 등록하세요.',
    );
  }
}

/** 1~2단계: 뉴스 수집 → 카피 작성 */
async function buildDraft(config, outDir, alreadyUsed) {
  const topic = config.topic ?? {};
  const fetchArgs = [
    path.join(ROOT, 'scripts', 'fetch-news.mjs'),
    '--hours', String(topic.hours ?? 24),
    '--limit', String(topic.limit ?? 25),
    '--out', path.join(outDir, 'news.json'),
    '--full',
    '--prefer-images',
    '--cluster', // 카피라이터가 다룰 사건 하나를 고르는 근거
  ];
  if (topic.preset) fetchArgs.push('--preset', topic.preset);
  if (topic.query) fetchArgs.push('--query', topic.query);
  if (topic.lang) fetchArgs.push('--lang', topic.lang);
  if (topic.region) fetchArgs.push('--region', topic.region);
  if (topic.exclude?.length) fetchArgs.push('--exclude', topic.exclude.join(','));
  if (topic.match?.length) fetchArgs.push('--match', topic.match.join(','));

  log('[1/6] 뉴스 수집');
  await run(process.execPath, fetchArgs, { maxBuffer: 32 * 1024 * 1024 });
  const news = await readJson(path.join(outDir, 'news.json'));
  log(`      기사 ${news.count}건`);

  log('[2/6] 카피 작성');
  const cardConf = config.cards ?? {};
  const draft = await writeCardNews(news, {
    cardCount: cardConf.count ?? 5,
    outputLang: cardConf.outputLang ?? 'ko',
    topicLabel: topic.label ?? topic.preset ?? '뉴스',
    alreadyUsed,
  });
  log(`      "${draft.title.replace(/\n/g, ' ')}"`);
  return draft;
}

/**
 * 참여형: 소재 목록에서 하나를 꺼내 원고를 쓰고 사진까지 만든다.
 *
 * 뉴스와 달리 가져올 사진이 없으므로 카드마다 이미지를 생성한다. 사진 없이
 * 텍스트만 나가면 단조로워서 반응이 안 온다.
 *
 * @returns {Promise<object|null>} 쓸 소재가 없으면 null
 */
async function buildEngageDraft(config, outDir, alreadyUsed) {
  const file = path.join(ROOT, 'config', 'topics.json');
  if (!(await exists(file))) return null;

  const queue = (await readJson(file)).topics ?? [];
  // 이미 다룬 소재는 건너뛴다. 지문은 소재 문장 그대로 쓴다.
  const next = queue.find((t) => t.topic && !alreadyUsed.has(`topic:${t.topic}`));
  if (!next) {
    log('      소재 목록을 다 썼습니다 — 뉴스 모드로 진행합니다.');
    return null;
  }

  log('[1-2/6] 참여형 원고 작성');
  const cardConf = config.cards ?? {};
  const draft = await writeEngageCards(next.topic, {
    outputLang: cardConf.outputLang ?? 'ko',
    cardCount: cardConf.count ?? 4,
    brandLabel: config.brand?.label ?? '',
  });
  log(`      "${String(draft.title).replace(/\n/g, ' ')}"`);

  // 표지도 같은 방식으로 만든다. 카드 배열 앞에 잠깐 끼워 한 번에 처리한다.
  const withCover = [{ imagePrompt: draft.coverImagePrompt, image: '' }, ...draft.cards];
  await generateDeckImages(withCover, path.join(outDir, 'gen'), { width: 1080, height: 1350 });
  draft.coverImage = withCover[0].image ?? '';

  // 자료집이 있을 때만 CTA 를 붙인다. 없는 걸 약속하지 않는다.
  if (next.magnet && next.magnetName) {
    draft.cta = { promise: next.magnetName, trigger: config.cta?.trigger ?? '아무 댓글' };
    draft.magnetUrl = next.magnet;
  }
  draft.fingerprints = [`topic:${next.topic}`];
  return draft;
}

/** 3단계: 카드 렌더 */
async function renderCards(config, outDir, cardsDir, draft) {
  log('[3/6] 카드 렌더');
  const cardConf = config.cards ?? {};
  const brand = config.brand ?? {};

  const renderArgs = [
    path.join(ROOT, 'scripts', 'render.mjs'),
    '--draft', path.join(outDir, 'draft.json'),
    '--template', cardConf.template ?? 'story',
    '--out', cardsDir,
  ];
  if (brand.handle) renderArgs.push('--handle', brand.handle);
  if (brand.accent) renderArgs.push('--accent', brand.accent);
  if (brand.label) renderArgs.push('--label', brand.label);

  // 줄 물건이 있을 때만 "댓글 남기면 보내드려요" 를 붙인다.
  //
  // 소재별 자료집(topics.json 의 magnet)이 먼저고, 없으면 config 의 기본 CTA 를
  // 쓴다. 둘 다 비어 있으면 CTA 없이 나간다 — 없는 걸 약속하지 않기 위해서다.
  // draft.cta 는 render.mjs 가 draft.json 에서 직접 읽으므로 여기선 config 만 본다.
  const cta = config.cta ?? {};
  if (!draft?.cta && cta.enabled && cta.promise) {
    renderArgs.push('--cta-promise', cta.promise);
    if (cta.trigger) renderArgs.push('--cta-trigger', cta.trigger);
  }

  await run(process.execPath, renderArgs, { maxBuffer: 32 * 1024 * 1024 });

  const manifest = await readJson(path.join(cardsDir, 'manifest.json'));
  log(`      ${manifest.files.length}장`);
  return manifest;
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig();
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // 미리 만들어 둔 초안을 쓰면 수집·카피 단계를 건너뛴다.
  const presetDraft = typeof args.draft === 'string' ? args.draft : null;

  // 이미지 호스팅 방식. github = 상시 운영, telegram = 연동 테스트용
  const host = args.host === 'telegram' ? 'telegram' : (config.imageHost ?? 'github');

  requireEnv(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  if (!presetDraft && !detectProvider()) {
    fail(
      '카피를 쓸 수단이 없습니다. 둘 중 하나를 등록하세요.\n\n' +
        '  ① CLAUDE_CODE_OAUTH_TOKEN  — Claude 구독으로 실행. 추가 요금 없음 (권장)\n' +
        '       로컬에서  claude setup-token  실행 후 나온 토큰을 등록\n\n' +
        '  ② ANTHROPIC_API_KEY        — API 로 실행. 토큰당 과금',
    );
  }
  if (!args.dry) {
    requireEnv(['IG_USER_ID', 'IG_ACCESS_TOKEN']);
    if (host === 'github') requireEnv(['GITHUB_TOKEN']);
  }

  const draftId = `d${Date.now().toString(36)}`;
  const outDir = path.join(ROOT, 'out');
  const cardsDir = path.join(outDir, 'cards');

  try {
    // ── 1~2. 초안 확보 ───────────────────────────────────────
    let draft;
    if (presetDraft) {
      log('[1-2/6] 기존 초안 사용 (수집·카피 건너뜀)');
      draft = await readJson(path.resolve(presetDraft));
      log(`        "${String(draft.title ?? '').replace(/\n/g, ' ')}"`);
    } else {
      // 최근에 다룬 사건은 빼고 고른다. 하루에 여러 편 낼 때 중복을 막는다.
      const alreadyUsed = await loadPublished(config);
      if (alreadyUsed.size) log(`        (최근 다룬 것 ${alreadyUsed.size}건 제외)`);

      // 참여형 소재가 남아 있으면 그걸 먼저 쓴다. 다 쓰면 뉴스로 돌아간다.
      if ((config.contentMode ?? 'news') === 'engage') {
        draft = await buildEngageDraft(config, outDir, alreadyUsed);
      }
      if (!draft) draft = await buildDraft(config, outDir, alreadyUsed);
    }
    draft.brand = { ...(config.brand ?? {}), ...(draft.brand ?? {}) };
    await writeJson(path.join(outDir, 'draft.json'), draft);

    // ── 3. 렌더 ──────────────────────────────────────────────
    const manifest = await renderCards(config, outDir, cardsDir, draft);

    // ── 4~5. 공개 URL 확보 + 텔레그램 전송 ───────────────────
    // github 방식은 먼저 올려서 얻은 주소로 미리보기를 보내고,
    // telegram 방식은 미리보기로 올린 사진의 주소를 되받아 쓴다.
    let imageUrls = [];
    const useGithub = host === 'github' && !args.dry;

    if (useGithub) {
      log('[4/6] 이미지 업로드 (GitHub)');
      imageUrls = await uploadCards(manifest.files, {
        repo: config.imageRepo ?? process.env.IMAGE_REPO,
        branch: config.imageBranch ?? 'main',
      });
    } else {
      log(`[4/6] 업로드 건너뜀 (${args.dry ? '--dry' : '텔레그램 호스팅'})`);
    }

    // 지난 실행의 버튼 응답을 비우면 안 된다 — 늦게 누른 발행이 사라진다.
    // 회수 잡(drain.mjs)이 처리하므로 여기서는 손대지 않는다.
    log('[5/6] 텔레그램 전송');
    const album = await sendAlbum(chatId, imageUrls.length ? imageUrls : manifest.files, '');

    if (host === 'telegram' && !args.dry) {
      imageUrls = await photoUrls(album);
      log(`      텔레그램 사진 주소 ${imageUrls.length}장 확보`);
      if (imageUrls.length !== manifest.files.length) {
        throw new Error(
          `사진 주소를 ${imageUrls.length}/${manifest.files.length}장만 얻었습니다. 다시 시도하세요.`,
        );
      }
    }

    // 캡션은 렌더 단계에서 출처·해시태그까지 붙여 만든다.
    const caption = manifest.caption ?? '';
    const summary =
      `<b>${String(draft.title ?? '').replace(/\n/g, ' ')}</b>\n` +
      `<i>${draft.subtitle ?? ''}</i>\n\n` +
      `${caption}\n\n` +
      `<code>카드 ${manifest.files.length}장 · 출처 ${(draft.sources ?? []).length}건</code>`;
    const control = await sendControls(chatId, draftId, summary);

    if (args.dry) {
      log('\n✔ --dry 완료 (발행하지 않음)');
      return;
    }

    // 대기 목록에 올려 둔다. 이 잡이 끝난 뒤에 버튼을 눌러도 회수 잡이 발행한다.
    await addPending(config, {
      draftId,
      title: String(draft.title ?? '').replace(/\n/g, ' '),
      imageUrls,
      caption,
      musicMood: draft.musicMood ?? '',
      fingerprints: draft.fingerprints ?? [],
      createdAt: new Date().toISOString(),
    });

    // 발행 여부와 무관하게, 한 번 초안으로 만든 사건은 다시 고르지 않는다.
    // (발행 시점에 기록하면 승인 전에 다음 회차가 같은 사건을 또 만든다)
    if (draft.fingerprints?.length) {
      await recordPublished(
        config,
        draft.fingerprints.map((fingerprint) => ({ fingerprint, at: new Date().toISOString() })),
      );
    }

    // ── 6. 승인 후 발행 ──────────────────────────────────────
    let callbackId = null;
    let controlMessageId = control.message_id;
    const autoPublish = Boolean(args['skip-approval']) || config.autoPublish === true;

    if (autoPublish) {
      log('[6/6] 자동 발행 (승인 생략)');
    } else {
      log('[6/6] 승인 대기');
      const decision = await awaitDecision(draftId, {
        minutes: config.approvalMinutes ?? 30,
        chatId,
        // 기다리는 동안 지난 초안의 버튼이 눌리면 여기서 바로 처리한다.
        // 넘기지 않으면 그 응답은 오프셋만 지나가고 영영 사라진다.
        onOther: (others) => processDecisions(config, chatId, others),
      });
      callbackId = decision.callbackId ?? null;
      if (decision.messageId) controlMessageId = decision.messageId;

      if (decision.decision === 'skip') {
        if (callbackId) await answerCallback(callbackId, '취소했습니다.');
        await clearButtons(chatId, controlMessageId, '🗑 <b>취소됨</b> — 발행하지 않았습니다.');
        await removePending(config, draftId);
        log('\n사용자가 취소했습니다.');
        return;
      }
      if (decision.decision === 'timeout') {
        // 버튼은 그대로 둔다. 나중에 눌러도 회수 잡이 발행한다.
        log('\n대기 시간이 끝났습니다 — 초안은 대기 목록에 남겨 두었습니다.');
        log('  나중에 발행 버튼을 눌러도 그대로 올라갑니다.');
        return;
      }
    }

    await answerCallback(callbackId, '발행합니다…');
    await clearButtons(chatId, controlMessageId, '⏳ <b>발행 중…</b>');

    const mediaId = await publishCarousel(imageUrls, caption);

    await clearButtons(chatId, controlMessageId, `✅ <b>발행 완료</b>\n<code>media ${mediaId}</code>`);
    await removePending(config, draftId);
    await sendMusicHint(chatId, config, { musicMood: draft.musicMood });
    log(`\n✔ 발행 완료 — media ${mediaId}`);

    // 토큰이 만료되면 발행이 조용히 멈춘다. 미리 알려준다.
    const expiry = await checkTokenExpiry();
    if (expiry.ok && expiry.expiresInDays < 10) {
      await sendMessage(
        chatId,
        `⚠️ <b>인스타 토큰이 약 ${expiry.expiresInDays}일 뒤 만료됩니다.</b>\n` +
          '갱신하지 않으면 발행이 멈춥니다.\n\n' +
          '<code>node scripts/refresh-token.mjs</code>\n' +
          '나온 값을 Secrets 의 IG_ACCESS_TOKEN 에 덮어쓰세요.',
      ).catch(() => {});
      log(`  ! 토큰 만료 ${expiry.expiresInDays}일 남음`);
    }
  } catch (err) {
    log(`\n✖ 실패: ${err.stack || err.message}`);

    // 조용히 넘기면 며칠째 안 올라간 걸 모르게 된다. 반드시 알리되,
    // 원인이 뻔한 것들은 무엇을 해야 하는지까지 적어 보낸다.
    const message = String(err.message);
    let hint = '';
    if (/setup-token|OAuth|인증|authentication|unauthorized|401/i.test(message)) {
      hint =
        '\n\n<b>Claude 토큰 문제로 보입니다.</b>\n' +
        '<code>claude setup-token</code> 으로 다시 발급해서\n' +
        'Secrets 의 CLAUDE_CODE_OAUTH_TOKEN 을 덮어쓰세요.\n' +
        '고칠 때까지 발행이 멈춥니다.';
    } else if (/rate.?limit|quota|usage limit|한도|429/i.test(message)) {
      hint =
        '\n\n<b>사용량 한도에 걸렸습니다.</b>\n' +
        '한도가 풀리면 다음 예약 때 자동으로 재개됩니다.\n' +
        '자주 걸리면 발행 편수를 줄이거나 상위 요금제를 확인하세요.';
    } else if (/새로 다룰 사건이 없습니다/.test(message)) {
      hint = '\n\n이번 회차만 건너뜁니다. 다음 예약 때 새 소식으로 다시 시도합니다.';
    }

    if (chatId && process.env.TELEGRAM_BOT_TOKEN) {
      await sendMessage(
        chatId,
        `⚠️ <b>카드뉴스 자동화 실패</b>\n<code>${message.slice(0, 400)}</code>${hint}`,
      ).catch(() => {});
    }
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
