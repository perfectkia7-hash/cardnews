import path from 'node:path';
import fs from 'node:fs/promises';
import { ROOT, log } from './util.mjs';
import * as claudeCli from './claude-cli.mjs';

/**
 * 자동 모드 전용 카피라이터.
 *
 * 생성 모드에서는 Claude Code 가 직접 카피를 쓰므로 이 파일이 필요 없다.
 * 사람이 없는 스케줄 실행에서만 모델을 부른다.
 * 규칙은 references/copywriting.md 한 곳에서만 관리한다.
 *
 * 부르는 방법은 두 가지고, 있는 자격증명에 따라 알아서 고른다.
 *   1) CLAUDE_CODE_OAUTH_TOKEN — 구독으로 실행. 추가 요금 없음. (기본)
 *   2) ANTHROPIC_API_KEY       — API 로 실행. 토큰당 과금.
 */

const CARD_SCHEMA = {
  type: 'object',
  properties: {
      title: { type: 'string', description: '표지 제목. 두 줄로 나누되 줄바꿈은 \\n 으로.' },
      subtitle: { type: 'string', description: '표지 보조 문구 한 줄.' },
      cards: {
        type: 'array',
        description:
          '본문 카드 4~6장. 표지와 엔딩은 제외한다. 카드마다 논점 하나씩, ' +
          '무슨 일이 → 왜 중요한가 → 배경 → 사례 → 남은 질문 순으로 전개한다.',
        items: {
          type: 'object',
          properties: {
            headline: {
              type: 'string',
              description: '카드 제목. 1줄은 후킹, 2줄은 사실. 줄바꿈은 \\n 으로. 한 줄 16자 이내.',
            },
            body: {
              type: 'string',
              description:
                '설명 본문 2~4문장. 문장마다 \\n 으로 줄을 나눈다. 한 문장 30자 이내. ' +
                '숫자·인용·핵심 구절은 **강조** 로 감싼다.',
            },
            source: { type: 'string', description: '이 내용의 출처 매체명.' },
          },
          required: ['headline', 'body', 'source'],
        },
      },
      caption: { type: 'string', description: '인스타그램 캡션 본문. 해시태그와 출처는 제외.' },
      hashtags: {
        type: 'array',
        items: { type: 'string' },
        description: '# 을 포함한 해시태그 5~8개.',
      },
      musicMood: {
        type: 'string',
        description:
          '이 소재에 얹으면 어울릴 음악의 결을 12자 이내로. 예: "잔잔한 로파이", ' +
          '"긴장감 있는 신스". 인스타 앱에서 오디오를 고를 때 쓰는 힌트다.',
      },
      usedArticleIndexes: {
        type: 'array',
        items: { type: 'integer' },
        description: '실제로 근거로 삼은 기사 번호.',
      },
  },
  required: ['title', 'subtitle', 'cards', 'caption', 'hashtags', 'musicMood', 'usedArticleIndexes'],
};

/**
 * 다룰 사건 하나를 고른다.
 * 여러 매체가 다룬 묶음일수록 큰 사건이고, 본문·사진도 많이 모인다.
 */
function pickStory(payload, alreadyUsed = new Set()) {
  const articles = payload.articles ?? [];
  const clusters = payload.clusters ?? [];

  // 이미 다룬 사건은 건너뛴다. 하루에 여러 편 낼 때 같은 뉴스가 반복되는 걸 막는다.
  const isUsed = (members) => members.some((a) => alreadyUsed.has(a.fingerprint));

  const scored = clusters
    .map((c) => {
      const members = c.indexes.map((i) => articles[i]).filter(Boolean);
      const withText = members.filter((a) => a.fullText);
      return {
        members,
        // 본문 있는 기사가 있어야 쓸 수 있다. 매체 수와 사진 수로 크기를 잰다.
        score: withText.length * 3 + members.length + (c.images ?? 0),
        usable: withText.length > 0 && !isUsed(members),
      };
    })
    .filter((s) => s.usable)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) return scored[0].members;

  // 묶음 정보가 없으면 본문이 가장 두꺼운 기사 하나로 간다.
  const fallback = articles
    .filter((a) => a.fullText && !alreadyUsed.has(a.fingerprint))
    .sort((a, b) => (b.fullText?.length ?? 0) - (a.fullText?.length ?? 0));
  return fallback.slice(0, 1);
}

/**
 * 사진 배치는 코드가 한다.
 * 모델은 이미지를 볼 수 없어서 URL 을 고르게 하면 엉뚱하거나 지어낸 값이 나온다.
 * 사건 하나만 다루므로 어느 사진을 어느 카드에 붙여도 주제는 맞는다.
 */
function assignImages(cards, articles) {
  const pool = [];
  const seen = new Set();
  for (const article of articles) {
    for (const url of article.images ?? (article.image ? [article.image] : [])) {
      const key = url.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(url);
    }
  }

  const coverImage = pool.shift() ?? '';

  // 남은 사진을 카드에 고르게 흩는다. 사진 카드와 텍스트 카드가 번갈아 나온다.
  const slots = new Array(cards.length).fill('');
  if (pool.length > 0) {
    const step = Math.max(1, Math.round(cards.length / pool.length));
    let at = 0;
    for (const url of pool) {
      if (at >= cards.length) break;
      slots[at] = url;
      at += step;
    }
  }

  cards.forEach((card, i) => {
    card.image = slots[i];
  });

  return { coverImage, used: pool.length + (coverImage ? 1 : 0) };
}

function buildPrompt(articles, options) {
  const list = articles
    .map((a, i) => {
      const when = a.publishedAt
        ? new Date(a.publishedAt).toISOString().slice(0, 16).replace('T', ' ')
        : '시각 미상';
      const text = a.fullText || a.summary || '';
      return `[${i}] ${a.title}\n    매체: ${a.publisher} / ${when}\n    본문: ${text.slice(0, 2500)}`;
    })
    .join('\n\n');

  return `아래는 같은 사건을 다룬 "${options.topicLabel}" 분야 기사 ${articles.length}건이다.

${list}

이 사건 하나를 인스타그램 카드뉴스로 만들어라.
여러 기사를 교차해 읽고, **무슨 일이 일어난 건지 독자가 이해하도록** 순서대로 풀어낸다.
본문 카드는 ${options.cardCount}장. 출력 언어: ${options.outputLang === 'en' ? '영어' : '한국어'}

기사에 없는 사실은 절대 쓰지 않는다. 숫자와 인용은 원문 그대로 옮긴다.
위 스키마에 맞는 결과만 낸다.`;
}

/** 어떤 자격증명이 있는지 보고 실행 방법을 정한다. */
export function detectProvider() {
  if (process.env.CARDNEWS_PROVIDER === 'api') return 'api';
  if (process.env.CARDNEWS_PROVIDER === 'cli') return 'cli';
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'cli'; // 구독 — 추가 요금 없음
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  return null;
}

/** Anthropic API 로 호출 (토큰당 과금) */
async function runViaApi(systemPrompt, prompt, model, { schema, toolName, maxTokens }) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('@anthropic-ai/sdk 가 설치되지 않았습니다.  npm install @anthropic-ai/sdk');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: [{ name: toolName, description: '완성된 결과를 제출한다.', input_schema: schema }],
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error('모델이 원고를 제출하지 않았습니다. 다시 시도하세요.');
  return toolUse.input;
}

/** Claude Code CLI 로 호출 (구독 사용 — 추가 요금 없음) */
async function runViaCli(systemPrompt, prompt, { schema }) {
  if (!(await claudeCli.isAvailable())) {
    throw new Error(
      'Claude Code CLI 를 찾지 못했습니다.\n' +
        '  설치:  npm install -g @anthropic-ai/claude-code\n' +
        '  또는 ANTHROPIC_API_KEY 를 등록해 API 방식으로 전환하세요.',
    );
  }
  return claudeCli.generate({ prompt, systemPrompt, schema });
}

/**
 * 스키마에 맞는 구조화된 결과를 받아 온다. 카드뉴스든 리포트든 이 길을 쓴다.
 *
 * 있는 자격증명에 따라 구독(CLI)과 API 중 알아서 고른다.
 */
export async function writeStructured({
  systemPrompt,
  prompt,
  schema,
  toolName = 'submit_result',
  maxTokens = 4000,
  model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
}) {
  const provider = detectProvider();
  if (!provider) throw new Error(NO_PROVIDER_MESSAGE);

  return provider === 'cli'
    ? runViaCli(systemPrompt, prompt, { schema })
    : runViaApi(systemPrompt, prompt, model, { schema, toolName, maxTokens });
}

const NO_PROVIDER_MESSAGE =
  '카피를 쓸 수단이 없습니다. 둘 중 하나를 등록하세요.\n\n' +
  '  ① CLAUDE_CODE_OAUTH_TOKEN  — Claude 구독으로 실행. 추가 요금 없음 (권장)\n' +
  '       로컬에서:  claude setup-token\n' +
  '       나온 토큰을 GitHub Secrets 에 등록\n\n' +
  '  ② ANTHROPIC_API_KEY        — API 로 실행. 토큰당 과금\n' +
  '       https://console.anthropic.com 에서 발급';

/**
 * @returns {Promise<object>} draft.json 과 같은 구조
 */
export async function writeCardNews(newsPayload, options = {}) {
  const {
    cardCount = 5,
    outputLang = 'ko',
    topicLabel = '뉴스',
    model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    alreadyUsed = new Set(),
  } = options;

  const provider = detectProvider();
  if (!provider) throw new Error(NO_PROVIDER_MESSAGE);

  const story = pickStory(newsPayload, alreadyUsed);
  if (story.length === 0) {
    throw new Error(
      alreadyUsed.size > 0
        ? '새로 다룰 사건이 없습니다. 최근에 다룬 뉴스뿐이라 이번 회차는 건너뜁니다.\n' +
          '  --hours 를 늘리거나 키워드를 넓히면 후보가 늘어납니다.'
        : '본문을 확보한 기사가 없습니다.\n' +
          '  매체 RSS(--preset 또는 --feeds)를 포함하고 --full 을 켰는지 확인하세요.\n' +
          '  구글 뉴스 링크만으로는 본문도 사진도 나오지 않습니다.',
    );
  }
  log(`      사건 선정 — "${story[0].title.slice(0, 50)}" (관련 기사 ${story.length}건)`);

  const rules = await fs.readFile(path.join(ROOT, 'references', 'copywriting.md'), 'utf8');
  const systemPrompt =
    '너는 인스타그램 카드뉴스 전문 에디터다. 아래 규칙을 반드시 지킨다.\n\n' +
    rules +
    '\n\n특히 글자 수 제한을 어기면 이미지가 깨진다. 원문에 없는 사실은 절대 만들지 않는다.';
  const prompt = buildPrompt(story, { cardCount, outputLang, topicLabel });

  log(
    provider === 'cli'
      ? '      카피 작성 중… (Claude 구독 · 추가 요금 없음)'
      : `      카피 작성 중… (API · ${model})`,
  );

  const draft = await writeStructured({
    systemPrompt,
    prompt,
    schema: CARD_SCHEMA,
    toolName: 'submit_cardnews',
    model,
  });
  const cards = (draft.cards ?? []).map((card) => ({
    headline: card.headline,
    body: card.body,
    source: card.source,
    image: '',
  }));

  const { coverImage, used } = assignImages(cards, story);
  log(`      카드 ${cards.length}장 · 사진 ${used}장`);

  const sources = (draft.usedArticleIndexes ?? [])
    .map((i) => story[i])
    .filter(Boolean)
    .map((a) => ({ title: a.title, link: a.link, publisher: a.publisher }));

  return {
    title: draft.title,
    subtitle: draft.subtitle,
    coverImage,
    cards,
    caption: draft.caption,
    hashtags: draft.hashtags,
    musicMood: draft.musicMood ?? '',
    sources: sources.length ? sources : story.slice(0, 3).map((a) => ({
      title: a.title,
      link: a.link,
      publisher: a.publisher,
    })),
    // 다음 회차에서 같은 사건을 또 고르지 않도록 남긴다.
    fingerprints: story.map((a) => a.fingerprint).filter(Boolean),
  };
}
