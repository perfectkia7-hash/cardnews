#!/usr/bin/env node
/**
 * 자동 모드 세팅 마법사.
 *
 * config/config.json 과 GitHub Actions 워크플로를 만들어 준다.
 * 비밀값은 묻지도, 저장하지도 않는다 — 전부 GitHub Secrets 로 간다.
 *
 *   node scripts/setup.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, fail, readJson, writeJson, exists } from './lib/util.mjs';
import { TEMPLATES } from './render.mjs';

const rl = readline.createInterface({ input: stdin, output: stdout });

async function ask(question, fallback = '') {
  const suffix = fallback ? ` (${fallback})` : '';
  const answer = (await rl.question(`${question}${suffix}\n> `)).trim();
  return answer || fallback;
}

/**
 * 답을 그 자리에서 검증한다.
 *
 * 마지막에 한꺼번에 검사하면 하나 틀렸을 때 앞서 입력한 게 전부 날아간다.
 * validate 는 정리된 값을 돌려주거나, 문제를 설명하는 Error 를 던진다.
 */
async function askValid(question, fallback, validate) {
  while (true) {
    const raw = await ask(question, fallback);
    try {
      return validate(raw);
    } catch (err) {
      console.log(`   ✖ ${err.message}`);
    }
  }
}

function askNumber(prompt, fallback, min, max) {
  return askValid(prompt, String(fallback), (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`${min}~${max} 사이의 숫자를 넣어주세요.`);
    }
    return Math.round(n);
  });
}

/** 자주 쓰는 도시 이름을 IANA 시간대로 바꿔 준다. */
const TIMEZONE_ALIASES = {
  seoul: 'Asia/Seoul', 서울: 'Asia/Seoul', kst: 'Asia/Seoul', korea: 'Asia/Seoul', 한국: 'Asia/Seoul',
  tokyo: 'Asia/Tokyo', 도쿄: 'Asia/Tokyo', jst: 'Asia/Tokyo',
  newyork: 'America/New_York', 뉴욕: 'America/New_York', est: 'America/New_York', edt: 'America/New_York',
  la: 'America/Los_Angeles', losangeles: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
  london: 'Europe/London', 런던: 'Europe/London', gmt: 'Europe/London',
  utc: 'UTC',
};

function normalizeTimezone(raw) {
  const key = raw.toLowerCase().replace(/[\s_/-]/g, '');
  const candidate = TIMEZONE_ALIASES[key] ?? raw;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
  } catch {
    throw new Error(
      `'${raw}' 는 알 수 없는 시간대입니다. Asia/Seoul 처럼 '지역/도시' 형식으로 넣어주세요.\n` +
        `     (seoul, 서울, tokyo, london 같은 도시 이름도 알아듣습니다)`,
    );
  }
  if (candidate !== raw) console.log(`   → ${candidate} 로 인식했습니다.`);
  return candidate;
}

/** 색 이름도 받아 준다. 디자인 감각으로 고른 기본값들. */
const COLOR_NAMES = {
  초록: '#22C55E', 녹색: '#22C55E', green: '#22C55E',
  파랑: '#3B82F6', 파란색: '#3B82F6', 파란: '#3B82F6', blue: '#3B82F6',
  빨강: '#EF4444', 빨간색: '#EF4444', 빨간: '#EF4444', red: '#EF4444',
  주황: '#F97316', 오렌지: '#F97316', orange: '#F97316',
  노랑: '#EAB308', 노란색: '#EAB308', yellow: '#EAB308',
  보라: '#A855F7', 퍼플: '#A855F7', purple: '#A855F7',
  분홍: '#EC4899', 핑크: '#EC4899', pink: '#EC4899',
  민트: '#14B8A6', 청록: '#14B8A6', teal: '#14B8A6',
  검정: '#111111', 블랙: '#111111', black: '#111111',
  하양: '#FFFFFF', 흰색: '#FFFFFF', white: '#FFFFFF',
};

function normalizeAccent(raw) {
  const value = raw.trim().replace(/색$/, '');
  if (!value) return '';

  if (/^#?[0-9a-f]{6}$/i.test(value)) {
    return value.startsWith('#') ? value.toUpperCase() : `#${value.toUpperCase()}`;
  }

  const named = COLOR_NAMES[value.toLowerCase()] ?? COLOR_NAMES[value];
  if (named) {
    console.log(`   → ${named} 로 넣겠습니다.`);
    return named;
  }

  throw new Error(
    `'${raw}' 를 색으로 읽지 못했습니다. #3B82F6 처럼 코드로 넣거나\n` +
      `     초록/파랑/빨강/주황/보라/핑크/민트 같은 이름을 쓰세요. 비워두면 기본색입니다.`,
  );
}

/** 안내문을 통째로 붙여넣는 경우가 있어서 첫 토큰만 취한다. */
function normalizeHandle(raw) {
  const first = raw.trim().split(/[\s,/|]+/)[0] ?? '';
  const cleaned = first.replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '');
  if (!cleaned) throw new Error('계정 핸들을 넣어주세요. 예) @my_account');
  if (cleaned !== first.replace(/^@+/, '')) console.log(`   → @${cleaned} 로 정리했습니다.`);
  return `@${cleaned}`;
}

async function askChoice(question, choices, fallback) {
  console.log(`\n${question}`);
  for (const [key, label] of choices) console.log(`   ${key.padEnd(10)} ${label}`);
  while (true) {
    const answer = (await rl.question(`> (${fallback}) `)).trim() || fallback;
    if (choices.some(([key]) => key === answer)) return answer;
    console.log(`   '${answer}' 는 목록에 없습니다. 다시 골라주세요.`);
  }
}

/** 해당 타임존이 UTC 보다 몇 분 앞서는지 */
function tzOffsetMinutes(timeZone, date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** 현지 HH:MM → GitHub Actions 가 쓰는 UTC cron 식 */
function toUtcCron(localTime, timeZone) {
  const [h, m] = localTime.split(':').map(Number);
  const offset = tzOffsetMinutes(timeZone);
  let total = h * 60 + m - offset;
  total = ((total % 1440) + 1440) % 1440;
  return {
    cron: `${total % 60} ${Math.floor(total / 60)} * * *`,
    utc: `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`,
  };
}

function workflowYaml({ crons, localTimes, timeZone, waitMinutes }) {
  const scheduleLines = crons.map((c, i) => `    - cron: '${c}'   # 현지 ${localTimes[i]}`).join('\n');

  return `# 카드뉴스 오토파일럿 — 자동 생성됨
# 현지 ${localTimes.join(', ')} (${timeZone}) 에 맞춰 UTC 로 변환된 스케줄입니다.
name: cardnews

on:
  schedule:
${scheduleLines}
  workflow_dispatch:        # 탭에서 수동 실행도 가능

# 회수 잡과 락을 공유하지 않습니다. 공유하면 회수 잡이 버튼을 지켜보는 동안
# 뉴스 발송이 그만큼 밀립니다. 동시 폴링 충돌은 각자 물러나며 처리합니다.
concurrency:
  group: cardnews-tick
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: ${waitMinutes + 20}
    permissions:
      contents: write       # 이미지·상태 커밋용

    # step 의 if 에서는 secrets 를 못 읽는다. 잡 단계에서 한 번 풀어 둔다.
    env:
      USE_SUBSCRIPTION: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 한글 폰트 설치
        run: sudo apt-get update && sudo apt-get install -y fonts-noto-cjk

      - name: 의존성 설치
        working-directory: cardnews-autopilot
        run: npm ci --omit=optional

      # 구독으로 돌릴 때 필요. API 키 방식이면 이 단계는 그냥 지나갑니다.
      - name: Claude Code 설치
        if: env.USE_SUBSCRIPTION == 'true'
        run: npm install -g @anthropic-ai/claude-code

      # API 키 방식일 때만 SDK 를 깝니다.
      - name: Anthropic SDK 설치
        if: env.USE_SUBSCRIPTION != 'true'
        working-directory: cardnews-autopilot
        run: npm install @anthropic-ai/sdk

      - name: 카드뉴스 생성 및 발행
        working-directory: cardnews-autopilot
        env:
          # 둘 중 등록된 쪽으로 알아서 실행됩니다.
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          TELEGRAM_BOT_TOKEN: \${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: \${{ secrets.TELEGRAM_CHAT_ID }}
          IG_USER_ID: \${{ secrets.IG_USER_ID }}
          IG_ACCESS_TOKEN: \${{ secrets.IG_ACCESS_TOKEN }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: node scripts/tick.mjs
`;
}

/**
 * 늦게 누른 발행 버튼을 처리하는 잡.
 * 초안 잡이 끝난 뒤에 눌러도 이 잡이 주기적으로 확인해서 올려 준다.
 */
function drainWorkflowYaml({ everyHours, watchMinutes }) {
  return `# 카드뉴스 오토파일럿 — 발행 버튼 회수 (자동 생성됨)
# 초안을 만든 잡이 끝난 뒤에 버튼을 눌러도 이 잡이 발행합니다.
name: cardnews-drain

# ${everyHours}시간마다 띄웁니다. 짧은 주기(*/15 같은)는 GitHub 가 대부분
# 버립니다 — 실측 간격이 28분에서 146분까지 튀었습니다. 그래서 "자주 뜨는"
# 대신 "한 번 뜨면 오래 지켜보는" 쪽으로 갑니다.
on:
  schedule:
    - cron: '0 */${everyHours} * * *'
  workflow_dispatch:

# 한 번에 하나만 돌되, 겹친 실행은 취소하지 않고 대기시킵니다. 그래서 감시가
# 끝나는 순간 대기하던 실행이 곧바로 이어받아, 예약이 몇 번 밀려도 지켜보는
# 구간이 끊기지 않습니다. 초안 잡과는 락을 나누지 않습니다 — 나누면 지켜보는
# 동안 뉴스 발송이 밀립니다.
concurrency:
  group: cardnews-drain
  cancel-in-progress: false

jobs:
  drain:
    runs-on: ubuntu-latest
    timeout-minutes: ${Math.min(355, watchMinutes + 5)}
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 의존성 설치
        working-directory: cardnews-autopilot
        run: npm ci --omit=optional

      - name: 발행 버튼 확인
        working-directory: cardnews-autopilot
        env:
          TELEGRAM_BOT_TOKEN: \${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: \${{ secrets.TELEGRAM_CHAT_ID }}
          IG_USER_ID: \${{ secrets.IG_USER_ID }}
          IG_ACCESS_TOKEN: \${{ secrets.IG_ACCESS_TOKEN }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: node scripts/drain.mjs --watch --minutes ${watchMinutes}
`;
}

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  카드뉴스 오토파일럿 — 자동 모드 세팅');
  console.log('══════════════════════════════════════════');
  console.log('\n비밀번호나 토큰은 여기서 묻지 않습니다.');
  console.log('설정만 정하고, 비밀값은 마지막에 안내하는 곳에 직접 넣으시면 됩니다.\n');

  const presets = await readJson(path.join(ROOT, 'config', 'presets.json'));
  const presetKeys = Object.keys(presets).filter((k) => !k.startsWith('_'));

  // ── 분야 ────────────────────────────────────────────────
  const presetChoices = [
    ...presetKeys.map((k) => [k, presets[k].label]),
    ['custom', '직접 키워드 입력'],
  ];
  const presetKey = await askChoice('1. 어떤 분야를 다루시나요?', presetChoices, 'tech');

  const topic = {};
  if (presetKey === 'custom') {
    topic.label = await ask('\n분야 이름은? (카드에 표시되진 않고 관리용입니다)', '내 뉴스');
    topic.query = await ask('\n검색 키워드는? (OR 로 여러 개 가능)', '');
    if (!topic.query) fail('키워드가 없으면 뉴스를 못 모읍니다.');
    topic.lang = await ask('\n수집 언어 코드는? (ko / en / ja …)', 'ko');
    topic.region = await ask('\n수집 지역 코드는? (KR / US / JP …)', 'KR');
  } else {
    topic.preset = presetKey;
    topic.label = presets[presetKey].label;
  }
  topic.hours = Number(await ask('\n최근 몇 시간 내 기사를 볼까요?', '24'));
  const excludeRaw = await ask('\n제외할 키워드가 있나요? (쉼표 구분, 없으면 엔터)', '');
  topic.exclude = excludeRaw ? excludeRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

  // ── 카드 ────────────────────────────────────────────────
  const template = await askChoice(
    '2. 카드 디자인은?',
    [
      ['news', '사진 + 하단 자막 · 실제 뉴스 계정 스타일 (권장)'],
      ['minimal', '밝고 조용한 정보 전달형'],
      ['breaking', '고대비 강조형 · 속보/이슈'],
      ['magazine', '에디토리얼 감성 · 라이프스타일'],
      ['darktech', '다크 + 네온 · 테크/AI/코인'],
      ['board', '패널 정리형 · 교육/꿀팁'],
    ],
    'news',
  );
  if (!TEMPLATES.includes(template)) fail(`알 수 없는 템플릿: ${template}`);

  const cards = {
    count: await askNumber('\n본문 카드 몇 장? (표지·엔딩 제외)', 5, 3, 8),
    template,
    outputLang: await askValid('\n카드에 쓸 언어는? (ko / en)', 'ko', (raw) => {
      const v = raw.trim().toLowerCase();
      if (v !== 'ko' && v !== 'en') throw new Error("ko 또는 en 으로 넣어주세요.");
      return v;
    }),
  };

  // ── 브랜딩 ──────────────────────────────────────────────
  const brand = {
    handle: await askValid('\n3. 카드에 넣을 계정 핸들은?', '@my_account', normalizeHandle),
    accent: await askValid('\n강조색은? (색 이름도 됩니다. 비우면 템플릿 기본색)', '', normalizeAccent),
    label: await ask('\n카드 상단 문구는? (예: 최신 AI 뉴스)', '최신 뉴스'),
  };

  // ── 스케줄 ──────────────────────────────────────────────
  const timezone = await askValid('\n4. 시간대는?', 'Asia/Seoul', normalizeTimezone);

  console.log('\n매일 몇 시에 초안을 받을까요?');
  console.log('   여러 개면 쉼표로 구분합니다. 개수가 곧 하루 발행 편수입니다.');
  console.log('   예)  08:00          → 하루 1편');
  console.log('        08:00,19:00    → 하루 2편');
  console.log('        08:00,13:00,19:00 → 하루 3편');
  const normalized = await askValid('', '08:00,19:00', (raw) => {
    const parts = raw.split(',').map((t) => t.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error('시간을 하나 이상 넣어주세요.');

    return parts.map((t) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!match) throw new Error(`'${t}' 는 시간 형식이 아닙니다. 08:00 처럼 넣어주세요.`);
      const [, h, m] = match;
      if (Number(h) > 23 || Number(m) > 59) throw new Error(`'${t}' 는 없는 시각입니다.`);
      return `${h.padStart(2, '0')}:${m}`;
    });
  });

  console.log('\n발행 버튼을 처음에 몇 분까지 기다릴까요?');
  console.log('   이 시간이 지나도 버튼은 살아 있습니다 — 회수 잡이 나중에 처리합니다.');
  const approvalMinutes = await askNumber('', 30, 1, 300);

  // 회수 잡 주기는 묻지 않는다.
  //
  // 예전에는 "몇 분마다 확인할까요"를 물었지만, GitHub 의 예약 실행은 보장된
  // 시각이 아니라 최선 노력이라 이 값이 거의 의미가 없다. */15 로 걸어도 실측
  // 간격이 28분에서 146분까지 튄다. 그래서 자주 뜨는 대신, 한 번 뜨면 오래
  // 지켜보고 다음 실행이 대기열에서 이어받게 한다.
  const drainEveryHours = 2;
  const drainWatchMinutes = 350; // GitHub 잡 상한 360분 안쪽

  // ── 레포 ────────────────────────────────────────────────
  console.log('\n5. 이미지 호스팅');
  console.log('   인스타그램은 "공개된 이미지 주소"만 받습니다.');
  console.log('   이 자동화를 돌릴 GitHub 레포(공개)를 그대로 쓰면 추가 가입이 없습니다.');
  console.log('   ⚠ 레포 페이지 상단에 적힌 이름을 그대로 쓰세요. 계정명에 -hash 같은 꼬리가 붙기도 합니다.');

  const imageRepo = await askValid('\n레포 주소는? (owner/repo 형식)', '', (raw) => {
    // 주소를 통째로 붙여넣는 경우가 많다.
    const cleaned = raw
      .trim()
      .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');

    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(cleaned)) {
      throw new Error('owner/repo 형식으로 넣어주세요. 예) perfectkia7-hash/cardnews');
    }
    if (cleaned !== raw.trim()) console.log(`   → ${cleaned} 로 정리했습니다.`);
    return cleaned;
  });

  const config = {
    timezone,
    publishTimes: normalized,
    approvalMinutes,
    drainWatchMinutes,
    pendingExpiryHours: 24,
    autoPublish: false,
    imageHost: 'github',
    topic,
    cards,
    brand,
    // 음악은 인스타 앱에서만 붙일 수 있다. 발행 뒤 방법을 알려 준다.
    music: { remind: true },
    imageRepo,
    imageBranch: 'main',
  };

  await writeJson(path.join(ROOT, 'config', 'config.json'), config);

  const converted = normalized.map((t) => toUtcCron(t, timezone));
  const workflowDir = path.join(ROOT, '..', '.github', 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  await fs.writeFile(
    path.join(workflowDir, 'cardnews.yml'),
    workflowYaml({
      crons: converted.map((c) => c.cron),
      localTimes: normalized,
      timeZone: timezone,
      waitMinutes: approvalMinutes,
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(workflowDir, 'cardnews-drain.yml'),
    drainWorkflowYaml({ everyHours: drainEveryHours, watchMinutes: drainWatchMinutes }),
    'utf8',
  );

  console.log('\n══════════════════════════════════════════');
  console.log('  설정 완료');
  console.log('══════════════════════════════════════════\n');
  console.log(`  설정 파일    cardnews-autopilot/config/config.json`);
  console.log(`  워크플로     .github/workflows/cardnews.yml`);
  console.log(`               .github/workflows/cardnews-drain.yml`);
  console.log(`  발행 편수    하루 ${normalized.length}편`);
  for (const [i, t] of normalized.entries()) {
    console.log(`               ${t} (${timezone})  =  UTC ${converted[i].utc}`);
  }
  console.log(`  버튼 대기    초안 잡이 ${approvalMinutes}분 대기 + 회수 잡이 계속 지켜봄`);
  console.log(`               (${config.pendingExpiryHours}시간 지난 초안은 자동 만료)\n`);

  console.log('다음으로 할 일 — GitHub 레포에서:');
  console.log('  Settings → Secrets and variables → Actions → New repository secret\n');
  console.log('  ── 카피 작성 수단 (둘 중 하나만) ──');
  console.log('  CLAUDE_CODE_OAUTH_TOKEN  Claude 구독으로 실행 · 추가 요금 없음 (권장)');
  console.log('                           로컬에서  claude setup-token  실행 후 나온 값');
  console.log('  ANTHROPIC_API_KEY        API 로 실행 · 토큰당 과금');
  console.log('                           console.anthropic.com 에서 발급\n');
  console.log('  ── 나머지 (필수) ──');
  console.log('  TELEGRAM_BOT_TOKEN   텔레그램 @BotFather 에서 발급');
  console.log('  TELEGRAM_CHAT_ID     본인 채팅 ID');
  console.log('  IG_USER_ID           인스타그램 프로 계정 ID');
  console.log('  IG_ACCESS_TOKEN      Meta 앱에서 발급한 장기 토큰');
  console.log('\n  ※ GITHUB_TOKEN 은 Actions 가 자동으로 넣어주므로 등록하지 않습니다.');
  console.log('\n각 값을 어디서 받는지는 references/setup-automation.md 에 화면 순서대로 있습니다.');
  console.log('\n다 넣었으면 Actions 탭 → cardnews → Run workflow 로 한 번 시험 실행해 보세요.\n');
}

main()
  .catch((err) => fail(err.stack || err.message))
  .finally(() => rl.close());
