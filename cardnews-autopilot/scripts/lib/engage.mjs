import path from 'node:path';
import fs from 'node:fs/promises';
import { ROOT, log } from './util.mjs';
import { writeStructured } from './copywriter.mjs';

/**
 * 참여형 카드뉴스 원고 — 뉴스가 아니라 "읽으면 뭘 할 수 있는지" 를 다룬다.
 *
 * 뉴스 요약은 팔로우를 부르지 않는다. 반응이 몰리는 계정들은 전부 노하우를
 * 주고, 마지막에 "댓글 남기면 전부 보내드려요" 로 받아간다. 그 구조를 그대로
 * 만든다.
 *
 * 사진도 모델이 정한다. 카드마다 어떤 그림이 어울리는지 프롬프트를 같이 쓰게
 * 해서, 나중에 이미지 생성기가 그대로 뽑는다. 텍스트만 있는 카드는 단조롭고,
 * 사람이 매번 사진을 고르면 자동이 아니다.
 */

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '표지 제목. 두 줄로 나누되 줄바꿈은 \\n 으로. 문제나 증상을 찌른다.' },
    subtitle: {
      type: 'string',
      description: '표지 보조 문구. **개수를 반드시 넣는다.** 예) "같은 사람으로 고정하는 법 7가지"',
    },
    coverImagePrompt: {
      type: 'string',
      description:
        '표지 배경으로 쓸 이미지의 영어 프롬프트. 사진처럼 보이게 쓴다. ' +
        '글자는 넣지 말 것 — 카드 위에 따로 얹는다.',
    },
    cards: {
      type: 'array',
      description:
        '본문 카드 3~4장. 전부 알려주지 않는다. 가장 쓸모 있는 것 2~3개만 풀고 ' +
        '마지막 카드는 "나머지 N가지" 목록으로 남긴다.',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: '카드 제목. 1줄 후킹, 2줄 사실. 줄바꿈은 \\n. 한 줄 16자 이내.' },
          body: {
            type: 'string',
            description:
              '2~4문장. 문장마다 \\n 으로 줄을 나눈다. 한 문장 30자 이내. ' +
              '핵심 구절은 **강조** 로 감싼다. 바로 따라 할 수 있게 구체적으로.',
          },
          imagePrompt: {
            type: 'string',
            description:
              '이 카드 배경 이미지의 영어 프롬프트. 내용과 맞아야 한다. ' +
              '글자·로고·워터마크는 넣지 않는다. 사진 느낌으로.',
          },
        },
        required: ['headline', 'body', 'imagePrompt'],
      },
    },
    magnetName: {
      type: 'string',
      description: '댓글 남기면 보내줄 자료의 이름. 예) "프롬프트 7종 전부". 짧고 셀 수 있게.',
    },
    caption: { type: 'string', description: '인스타 캡션 본문. 해시태그와 CTA 는 빼고 쓴다.' },
    hashtags: { type: 'array', items: { type: 'string' }, description: '# 포함 해시태그 5~8개' },
  },
  required: ['title', 'subtitle', 'coverImagePrompt', 'cards', 'magnetName', 'caption', 'hashtags'],
};

/** 이미지 프롬프트에 공통으로 붙일 것 — 글자가 들어가면 카드 문구와 겹쳐 지저분해진다. */
const IMAGE_SUFFIX =
  ', photorealistic, natural lighting, shallow depth of field, ' +
  'no text, no words, no letters, no watermark, no logo';

export async function writeEngageCards(topic, options = {}) {
  const { outputLang = 'ko', cardCount = 4, brandLabel = '' } = options;

  const rules = await fs.readFile(path.join(ROOT, 'references', 'copywriting.md'), 'utf8');

  const systemPrompt =
    '너는 인스타그램에서 반응이 잘 나오는 카드뉴스를 만드는 에디터다.\n\n' +
    rules +
    '\n\n추가로 반드시 지킨다:\n' +
    '- 뉴스가 아니라 **바로 써먹을 수 있는 것**을 다룬다. 읽고 나면 뭔가 할 수 있어야 한다.\n' +
    '- **전부 알려주지 않는다.** 가장 쓸모 있는 2~3개만 풀고 나머지는 목록으로만 보여준다.\n' +
    '  다 보여주면 댓글을 달 이유가 사라진다.\n' +
    '- 확신이 없는 건 쓰지 않는다. 독자가 바로 따라 해보고 안 되면 신뢰를 잃는다.\n' +
    '- 글자 수 제한을 어기면 이미지가 깨진다.';

  const prompt = `"${topic}" 주제로 참여형 카드뉴스를 만들어라.

본문 카드 ${cardCount}장. 출력 언어: ${outputLang === 'en' ? '영어' : '한국어'}
${brandLabel ? `카드 상단 배지 문구는 "${brandLabel}" 다.\n` : ''}
구성은 이렇게 간다.
  1장  이 문제가 왜 생기는지 — 독자가 "내 얘기다" 싶게
  2~3장 가장 쓸모 있는 방법을 하나씩. 바로 따라 할 수 있게 구체적으로
  마지막 장 "나머지 N가지" 를 제목만 나열. 무엇이 오는지 알려주되 방법은 감춘다

이미지 프롬프트는 영어로, 각 카드 내용과 맞게 쓴다.
위 스키마에 맞는 결과만 낸다.`;

  log(`      "${topic}" 원고 작성 중…`);
  const draft = await writeStructured({
    systemPrompt,
    prompt,
    schema: CARD_SCHEMA,
    toolName: 'submit_engage_cards',
    maxTokens: 4000,
  });

  // 이미지 프롬프트에 공통 지시를 붙인다. 모델이 매번 다 적게 하면 빠뜨린다.
  const cards = (draft.cards ?? []).map((card) => ({
    headline: card.headline,
    body: card.body,
    source: '',
    image: '',
    imagePrompt: (card.imagePrompt ?? '') + IMAGE_SUFFIX,
  }));

  return {
    title: draft.title,
    subtitle: draft.subtitle,
    coverImage: '',
    coverImagePrompt: (draft.coverImagePrompt ?? '') + IMAGE_SUFFIX,
    cards,
    caption: draft.caption,
    hashtags: draft.hashtags,
    magnetName: draft.magnetName,
    sources: [],
  };
}
