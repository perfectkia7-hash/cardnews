#!/usr/bin/env node
/**
 * 리드 마그넷 자료집 만들기 — PDF 한 부
 *
 *   node scripts/leadmagnet.mjs --topic "이번 주 AI 뉴스 총정리" --preset tech --days 7
 *
 * 카드뉴스에 "댓글 남기시면 자료집 보내드려요" 를 붙이려면 줄 물건이 있어야 한다.
 * 이 스크립트가 그 물건을 만든다.
 *
 * 설계 원칙 하나 — **근거 없는 숫자를 만들지 않는다.**
 * 수익 사례 같은 걸 모델의 일반 지식으로 쓰게 하면 그럴듯한 거짓말이 나온다.
 * 그래서 여기서는 실제로 수집한 기사만 근거로 삼고, 항목마다 출처와 시점을
 * 붙이고, 근거의 단단함을 A/B/C 로 표시한다. 면책 문구는 모델이 아니라
 * 코드가 붙인다 — 모델이 빠뜨릴 수 있는 종류의 것이라서.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, parseArgs, fail, log, readJson, writeJson, exists } from './lib/util.mjs';
import { writeStructured, detectProvider } from './lib/copywriter.mjs';
import { launchBrowser } from './lib/browser.mjs';

const run = promisify(execFile);

const GRADES = {
  A: '1차 출처(공식 발표·공시·규제 문서)를 매체가 직접 확인한 내용',
  B: '복수 매체가 각자 취재해 보도한 내용',
  C: '단일 매체 보도이거나 익명 소스에 기댄 내용',
};

/**
 * 자료집의 종류. 위험도가 다르므로 만드는 방법과 면책 문구가 다르다.
 *
 *   news     이 스크립트가 RSS 로 근거를 모아 쓴다. 예약 실행에 적합.
 *   research 사례·수치를 다룬다. 출처가 반드시 필요하므로 Claude 가 웹에서
 *            직접 조사해 원고를 만들고, 이 스크립트는 조판만 한다.
 *   guide    방법·노하우. 인용할 기사가 없고 독자가 즉시 시험해 볼 수 있다.
 *            등급 대신 "직접 확인" 표시를 쓴다.
 */
const KINDS = {
  news: {
    label: '뉴스 정리',
    auto: true,
    disclaimer:
      '이 자료집은 공개된 언론 보도를 정리한 것이며, 각 항목의 출처와 보도 시점을 함께 표기했습니다. ' +
      '수치와 전망은 보도 시점 기준이며 이후 달라질 수 있습니다. ' +
      '투자·창업 권유가 아니며 어떤 결과도 보장하지 않습니다.',
  },
  research: {
    label: '사례 조사',
    auto: false,
    disclaimer:
      '이 자료집의 수치는 각 창업자나 매체가 공개한 내용을 정리한 것이며, 항목마다 출처와 시점을 밝혔습니다. ' +
      '공개된 수치는 검증이 어렵고 과장이 섞일 수 있어 근거의 단단함을 등급으로 표시했습니다. ' +
      '수익을 보장하지 않으며 투자·창업 권유가 아닙니다.',
  },
  guide: {
    label: '실전 가이드',
    auto: false,
    disclaimer:
      '이 자료집의 방법은 작성 시점에 실제로 시험해 본 것을 정리했습니다. ' +
      '도구가 업데이트되면 결과가 달라질 수 있으니 직접 확인하며 사용하세요. ' +
      '특정 서비스의 공식 문서가 아니며, 각 서비스의 이용약관을 함께 확인하시기 바랍니다.',
  },
};

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '자료집 제목. 무엇을 얻는지 한눈에 보이게.' },
    subtitle: { type: 'string', description: '부제 한 줄. 수록 건수와 기간을 넣는다.' },
    intro: {
      type: 'string',
      description:
        '이 자료집이 무엇이고 무엇을 기준으로 골랐는지 3~5문장. 범위와 한계를 솔직히 밝힌다.',
    },
    sections: {
      type: 'array',
      description: '주제별 묶음 3~6개. 각 묶음에 항목 2~6개.',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: '묶음 제목' },
          note: { type: 'string', description: '이 묶음을 한 줄로 요약' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '항목 제목. 사실 중심으로.' },
                oneLine: { type: 'string', description: '무슨 일인지 한 줄 요약' },
                body: {
                  type: 'string',
                  description:
                    '3~6문장 설명. 기사에 있는 숫자와 인용만 쓴다. 문단은 \\n 으로 나눈다.',
                },
                grade: {
                  type: 'string',
                  enum: ['A', 'B', 'C'],
                  description:
                    'A=1차 출처를 매체가 직접 확인 / B=복수 매체가 각자 보도 / C=단일 매체 또는 익명 소스',
                },
                articleIndex: {
                  type: 'integer',
                  description: '근거로 삼은 기사 번호. 반드시 실제로 읽은 기사여야 한다.',
                },
              },
              required: ['title', 'oneLine', 'body', 'grade', 'articleIndex'],
            },
          },
        },
        required: ['heading', 'note', 'items'],
      },
    },
    takeaways: {
      type: 'array',
      items: { type: 'string' },
      description: '전체를 관통하는 관찰 3~5개. 각 한 문장.',
    },
  },
  required: ['title', 'subtitle', 'intro', 'sections', 'takeaways'],
};

/** 1단계: 근거가 될 기사를 모은다. */
async function collect(outDir, options) {
  const args = [
    path.join(ROOT, 'scripts', 'fetch-news.mjs'),
    '--hours', String(options.days * 24),
    '--limit', String(options.limit),
    '--out', path.join(outDir, 'news.json'),
    '--full',
    '--cluster',
  ];
  if (options.preset) args.push('--preset', options.preset);
  if (options.query) args.push('--query', options.query);

  log(`[1/4] 근거 수집 (최근 ${options.days}일)`);
  await run(process.execPath, args, { maxBuffer: 64 * 1024 * 1024 });

  const news = await readJson(path.join(outDir, 'news.json'));
  const usable = (news.articles ?? []).filter((a) => a.fullText);
  log(`      기사 ${news.count}건 · 본문 확보 ${usable.length}건`);

  if (usable.length < 5) {
    fail(
      `본문을 확보한 기사가 ${usable.length}건뿐이라 자료집을 만들 수 없습니다.\n` +
        '  --days 를 늘리거나 --preset 을 바꿔 후보를 넓히세요.',
    );
  }
  return news;
}

/** 2단계: 모델이 자료집 원고를 쓴다. */
async function compose(news, options) {
  const articles = (news.articles ?? []).filter((a) => a.fullText);

  const list = articles
    .map((a, i) => {
      const when = a.publishedAt
        ? new Date(a.publishedAt).toISOString().slice(0, 10)
        : '시각 미상';
      return `[${i}] ${a.title}\n    매체: ${a.publisher} / ${when}\n    본문: ${a.fullText.slice(0, 2000)}`;
    })
    .join('\n\n');

  const gradeGuide = Object.entries(GRADES)
    .map(([k, v]) => `  ${k}급 — ${v}`)
    .join('\n');

  const systemPrompt =
    '너는 자료집을 만드는 편집자다. 독자가 돈을 내고 사도 아깝지 않을 밀도로 쓴다.\n\n' +
    '반드시 지킨다:\n' +
    '- 아래 기사에 없는 사실은 절대 쓰지 않는다. 숫자와 인용은 원문 그대로 옮긴다.\n' +
    '- 기억으로 아는 내용을 보태지 않는다. 근거는 준 기사뿐이다.\n' +
    '- 항목마다 근거가 얼마나 단단한지 등급을 매긴다:\n' +
    gradeGuide +
    '\n- 등급은 내용의 중요도가 아니라 **믿을 수 있는 정도**다.\n' +
    '- 과장하지 않는다. 확정되지 않은 것은 확정된 것처럼 쓰지 않는다.';

  const prompt = `아래는 "${options.topic}" 주제로 최근 ${options.days}일 동안 모은 기사 ${articles.length}건이다.

${list}

이걸 한 부의 자료집으로 엮어라.
기사를 주제별로 묶고, 각 항목에 무슨 일인지와 왜 중요한지를 쓴다.
비슷한 기사는 하나로 합치고, 다룰 가치가 없는 건 버려라. 전부 넣을 필요 없다.
출력 언어: 한국어. 위 스키마에 맞는 결과만 낸다.`;

  log('[2/4] 원고 작성 중… ' + (detectProvider() === 'cli' ? '(구독 · 추가 요금 없음)' : '(API)'));

  const report = await writeStructured({
    systemPrompt,
    prompt,
    schema: REPORT_SCHEMA,
    toolName: 'submit_report',
    maxTokens: 8000,
  });

  // 모델이 고른 기사 번호를 실제 출처 정보로 바꾼다.
  // 모델에게 URL 을 쓰게 하면 지어내므로, 번호만 받고 매핑은 코드가 한다.
  let dropped = 0;
  for (const section of report.sections ?? []) {
    section.items = (section.items ?? []).filter((item) => {
      const article = articles[item.articleIndex];
      if (!article) {
        dropped += 1;
        return false;
      }
      item.source = {
        publisher: article.publisher,
        link: article.link,
        publishedAt: article.publishedAt ?? '',
      };
      return true;
    });
  }
  if (dropped) log(`      ! 근거를 못 찾은 항목 ${dropped}건은 뺐습니다`);

  const count = (report.sections ?? []).reduce((s, x) => s + x.items.length, 0);
  log(`      묶음 ${(report.sections ?? []).length}개 · 항목 ${count}건`);
  return report;
}

/** 3~4단계: HTML 로 만들고 PDF 로 굽는다. */
async function toPdf(report, outDir, options) {
  const templatePath = path.join(ROOT, 'templates', 'report.html');
  if (!(await exists(templatePath))) fail('templates/report.html 이 없습니다.');

  log('[3/4] 문서 조판');
  const browser = await launchBrowser();
  const pdfPath = path.join(outDir, 'leadmagnet.pdf');

  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(
      (payload) => {
        window.__REPORT__ = payload;
      },
      { report, brand: options.brand, grades: GRADES, disclaimer: options.disclaimer },
    );
    await page.goto(pathToFileURL(templatePath).href, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);

    log('[4/4] PDF 굽는 중');
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });
  } finally {
    await browser.close();
  }

  return pdfPath;
}

async function main() {
  const args = parseArgs();

  const topic = typeof args.topic === 'string' ? args.topic : null;
  if (!topic) {
    fail(
      '--topic 이 필요합니다.\n\n' +
        '  뉴스 정리 (혼자 다 함)\n' +
        '    node scripts/leadmagnet.mjs --topic "이번 주 AI 뉴스" --preset tech --days 7\n\n' +
        '  사례 조사 / 실전 가이드 (Claude 가 원고를 만든 뒤 조판만)\n' +
        '    node scripts/leadmagnet.mjs --topic "..." --kind guide --report out/magnet/report.json',
    );
  }

  const kind = typeof args.kind === 'string' ? args.kind : 'news';
  if (!KINDS[kind]) {
    fail(`--kind 는 ${Object.keys(KINDS).join(', ')} 중 하나입니다.`);
  }

  const configPath = path.join(ROOT, 'config', 'config.json');
  const config = (await exists(configPath)) ? await readJson(configPath) : {};

  const options = {
    topic,
    preset: typeof args.preset === 'string' ? args.preset : config.topic?.preset,
    query: typeof args.query === 'string' ? args.query : undefined,
    days: Number(args.days ?? 7),
    limit: Number(args.limit ?? 40),
    brand: {
      handle: typeof args.handle === 'string' ? args.handle : config.brand?.handle ?? '',
      accent: typeof args.accent === 'string' ? args.accent : config.brand?.accent ?? '#22C55E',
    },
    // 면책은 모델이 아니라 코드가 붙인다. 빠뜨리면 안 되는 종류라서.
    disclaimer: KINDS[kind].disclaimer,
  };

  const outDir = path.resolve(typeof args.out === 'string' ? args.out : 'out/magnet');
  await fs.mkdir(outDir, { recursive: true });

  // 이미 만든 원고로 조판만 다시 하려면 --report 를 준다.
  // 문구를 손보고 다시 굽는 일이 잦아서, 그때마다 수집·작성을 되풀이할 필요가 없다.
  const preset = typeof args.report === 'string' ? args.report : null;

  let report;
  if (preset) {
    log(`[1-2/4] 기존 원고 사용 — ${KINDS[kind].label} (수집·작성 건너뜀)`);
    report = await readJson(path.resolve(preset));
  } else if (!KINDS[kind].auto) {
    // 사례·노하우는 RSS 로 못 모은다. 근거를 어디서 가져올지가 핵심이라
    // 이 스크립트가 혼자 지어내게 두면 안 된다.
    fail(
      `--kind ${kind} 는 원고를 자동으로 쓰지 않습니다.\n\n` +
        '  이 종류는 근거를 어디서 가져올지가 핵심입니다. RSS 로는 안 모이고,\n' +
        '  모델의 기억으로 채우면 그럴듯한 거짓이 나옵니다.\n\n' +
        '  Claude Code 에게 "자료집 원고 써줘" 라고 하세요. Claude 가 웹에서\n' +
        '  직접 찾아보고 report.json 을 만들어 줍니다. 그 파일을 넘기세요:\n\n' +
        `    node scripts/leadmagnet.mjs --topic "${topic}" --kind ${kind} \\\n` +
        '      --report out/magnet/report.json',
    );
  } else {
    const news = await collect(outDir, options);
    report = await compose(news, options);
    await writeJson(path.join(outDir, 'report.json'), report);
  }

  const pdfPath = await toPdf(report, outDir, options);
  const { size } = await fs.stat(pdfPath);

  log(`\n✔ 완성 — ${path.relative(process.cwd(), pdfPath)}  (${Math.round(size / 1024)} KB)`);
  log('  이 파일을 ManyChat 에 올려 댓글 자동응답으로 내보내면 됩니다.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
