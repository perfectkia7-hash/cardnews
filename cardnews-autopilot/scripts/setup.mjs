#!/usr/bin/env node
/**
 * 자동 모드 세팅 마법사.
 *
 * config/config.json 과 GitHub Actions 워크플로를 만들어 준다.
 * 비밀값은 묻지도, 저장하지도 않는다 — 전부 GitHub Secrets 로 간다.
 *
 * 두 가지 방법으로 쓴다.
 *
 *   node scripts/setup.mjs                     사람이 터미널에서 답하기
 *   node scripts/setup.mjs --repo owner/repo … 값을 미리 넘기기
 *
 * 두 번째가 있는 이유: 이건 Claude Code 스킬이다. 구매자가 "설정해줘" 라고
 * 하면 Claude 가 대화로 값을 모아 한 번에 넘겨 끝내는 게 맞다. 사람이
 * 터미널에 앉아 열세 번 답하게 만들 이유가 없다.
 *
 * 전체 플래그는 --help 로 본다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stdin, stdout } from 'node:process';
import { ROOT, parseArgs, fail, readJson, writeJson, exists } from './lib/util.mjs';
import { TEMPLATES } from './render.mjs';

const run = promisify(execFile);
const ARGS = parseArgs();

/**
 * 물어볼 수 있는 상황인지.
 *
 * 파이프로 실행되면(= Claude Code 나 CI) readline 이 입력을 통째로 삼키고
 * 닫혀서 첫 질문에서 죽는다. 그래서 이럴 땐 아예 만들지 않고, 플래그와
 * 기본값만으로 진행한다.
 */
const NON_INTERACTIVE = Boolean(ARGS.yes) || !stdin.isTTY;

let rl = null;
function prompt() {
  if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
  return rl;
}

/**
 * 플래그나 기본값으로 답이 이미 정해졌는지 본다.
 * @returns {{value:any}|null} 정해졌으면 값, 아니면 null (= 물어봐야 함)
 */
function fromFlags(flagName, fallback, validate) {
  const given = flagName ? ARGS[flagName] : undefined;

  if (given !== undefined && given !== true) {
    try {
      const value = validate(String(given));
      console.log(`   --${flagName} → ${JSON.stringify(value)}`);
      return { value };
    } catch (err) {
      fail(`--${flagName} 값이 잘못됐습니다.\n  ${err.message}`);
    }
  }

  if (!NON_INTERACTIVE) return null;

  if (fallback === null) {
    fail(
      `--${flagName} 이(가) 필요합니다.\n` +
        '  터미널에서 직접 실행하면 물어봐 드립니다:  node scripts/setup.mjs\n' +
        '  전체 플래그는:  node scripts/setup.mjs --help',
    );
  }

  const value = validate(String(fallback));
  console.log(`   --${flagName} → ${JSON.stringify(value)} (기본값)`);
  return { value };
}

/**
 * 워크플로를 놓을 곳을 찾는다.
 *
 * GitHub Actions 는 **레포 루트의** `.github/workflows/` 만 읽는다. 그런데 이
 * 스킬은 보통 `<레포>/.claude/skills/cardnews-autopilot/` 에 깔리므로,
 * 스킬 폴더 기준 상대경로로 쓰면 `.claude/skills/.github/workflows/` 라는
 * 아무도 안 보는 자리에 파일이 생긴다. 세팅은 성공한 것처럼 끝나고 예약은
 * 영영 안 돈다 — 실제로 그렇게 만들어져 있었다.
 *
 * 그래서 `.git` 을 찾아 올라가며 진짜 레포 루트를 잡는다.
 *
 * @returns {Promise<{dir: string, repoRoot: string|null}>}
 */
async function resolveWorkflowDir() {
  let dir = ROOT;
  for (let i = 0; i < 12; i += 1) {
    if (await exists(path.join(dir, '.git'))) {
      return { dir: path.join(dir, '.github', 'workflows'), repoRoot: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 레포 밖(예: ~/.claude/skills/)에 깔린 경우. 눈에 띄는 곳에 만들어 두고
  // 어디로 옮겨야 하는지 알려 준다. 조용히 엉뚱한 데 쓰는 것보다 낫다.
  return { dir: path.join(ROOT, '_workflows'), repoRoot: null };
}

/** 이미 클론된 레포라면 origin 에서 owner/repo 를 읽어 온다. */
async function gitRemoteRepo(repoRoot) {
  if (!repoRoot) return null;
  try {
    const { stdout: url } = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
    const match = /github\.com[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\s*$/i.exec(url);
    if (!match) return null;
    console.log(`\n   (git origin 에서 ${match[1]} 를 찾았습니다)`);
    return match[1];
  } catch {
    return null;
  }
}

const HELP = `
카드뉴스 오토파일럿 — 자동 모드 세팅

  node scripts/setup.mjs                 터미널에서 하나씩 답하기
  node scripts/setup.mjs --repo a/b …    값을 미리 넘기기 (Claude 가 대신 실행)

파이프로 실행되면 질문하지 않고 플래그와 기본값만 씁니다.
--repo 만 필수고, 레포 안에서 돌리면 git origin 에서 알아서 찾습니다.

  --repo <owner/repo>    이미지 호스팅 + 스케줄러 레포 (필수)

  --preset <키>          분야 프리셋. 목록은 config/presets.json  (기본 tech)
  --query "<키워드>"     프리셋 대신 직접 키워드. 주면 preset 은 무시됨
  --topic-label "<이름>" 분야 이름 (관리용)
  --lang ko --region KR  --query 를 쓸 때의 수집 언어·지역
  --hours <1-168>        최근 몇 시간 기사까지  (기본 24)
  --exclude "a,b"        제외 키워드

  --template <이름>      story|news|minimal|breaking|magazine|darktech|board  (기본 story)
  --cards <3-8>          본문 카드 장수  (기본 5)
  --out-lang ko|en       카드에 쓸 언어  (기본 ko)

  --handle @이름         카드에 찍을 계정 핸들  (기본 @my_account)
  --accent <색>          강조색. #22C55E 또는 초록/파랑 같은 이름
  --brand-label "<문구>" 카드 상단 배지 문구  (기본 최신 뉴스)

  --timezone <지역/도시> 기본 Asia/Seoul. seoul, 서울 같은 별칭도 됨
  --times "08:00,19:00"  초안 받을 시각. 개수가 곧 하루 발행 편수
  --approval <1-300>     초안 잡이 버튼을 기다리는 분  (기본 30)

  --yes                  터미널이어도 묻지 않고 기본값으로 진행
  --help                 이 도움말

예시
  node scripts/setup.mjs --repo me/cardnews --preset tech \\
    --handle @my_account --brand-label "최신 AI 뉴스" \\
    --accent 초록 --times "08:00,13:00,19:00" --cards 3
`;

/**
 * 답을 그 자리에서 검증한다.
 *
 * 마지막에 한꺼번에 검사하면 하나 틀렸을 때 앞서 입력한 게 전부 날아간다.
 * validate 는 정리된 값을 돌려주거나, 문제를 설명하는 Error 를 던진다.
 */
async function askValid(question, fallback, validate, flagName) {
  const preset = fromFlags(flagName, fallback, validate);
  if (preset) return preset.value;

  const suffix = fallback ? ` (${fallback})` : '';
  while (true) {
    const typed = (await prompt().question(`${question}${suffix}\n> `)).trim();
    try {
      return validate(typed || String(fallback ?? ''));
    } catch (err) {
      console.log(`   ✖ ${err.message}`);
    }
  }
}

function ask(question, fallback = '', flagName) {
  return askValid(question, fallback, (raw) => raw.trim(), flagName);
}

function askNumber(question, fallback, min, max, flagName) {
  return askValid(
    question,
    String(fallback),
    (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new Error(`${min}~${max} 사이의 숫자를 넣어주세요.`);
      }
      return Math.round(n);
    },
    flagName,
  );
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

async function askChoice(question, choices, fallback, flagName) {
  const validate = (raw) => {
    const value = raw.trim();
    if (choices.some(([key]) => key === value)) return value;
    throw new Error(
      `'${value}' 는 목록에 없습니다. 고를 수 있는 값: ${choices.map(([k]) => k).join(', ')}`,
    );
  };

  const preset = fromFlags(flagName, fallback, validate);
  if (preset) return preset.value;

  console.log(`\n${question}`);
  for (const [key, label] of choices) console.log(`   ${key.padEnd(10)} ${label}`);
  while (true) {
    const typed = (await prompt().question(`> (${fallback}) `)).trim() || fallback;
    try {
      return validate(typed);
    } catch (err) {
      console.log(`   ✖ ${err.message}`);
    }
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

function workflowYaml({ crons, localTimes, timeZone, waitMinutes, skillPath }) {
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
        working-directory: ${skillPath}
        run: npm ci --omit=optional

      # 구독으로 돌릴 때 필요. API 키 방식이면 이 단계는 그냥 지나갑니다.
      - name: Claude Code 설치
        if: env.USE_SUBSCRIPTION == 'true'
        run: npm install -g @anthropic-ai/claude-code

      # API 키 방식일 때만 SDK 를 깝니다.
      - name: Anthropic SDK 설치
        if: env.USE_SUBSCRIPTION != 'true'
        working-directory: ${skillPath}
        run: npm install @anthropic-ai/sdk

      - name: 카드뉴스 생성 및 발행
        working-directory: ${skillPath}
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
function drainWorkflowYaml({ everyHours, watchMinutes, skillPath }) {
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
        working-directory: ${skillPath}
        run: npm ci --omit=optional

      - name: 발행 버튼 확인
        working-directory: ${skillPath}
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
  if (ARGS.help || ARGS.h) {
    console.log(HELP);
    return;
  }

  console.log('\n══════════════════════════════════════════');
  console.log('  카드뉴스 오토파일럿 — 자동 모드 세팅');
  console.log('══════════════════════════════════════════');
  console.log('\n비밀번호나 토큰은 여기서 묻지 않습니다.');
  console.log('설정만 정하고, 비밀값은 마지막에 안내하는 곳에 직접 넣으시면 됩니다.');
  if (NON_INTERACTIVE) {
    console.log('\n(묻지 않고 진행합니다 — 넘겨받은 값과 기본값을 씁니다)');
  }
  console.log('');

  // 레포 위치를 먼저 잡는다. 레포 주소를 되묻지 않으려면 이게 앞에 있어야 한다.
  const { dir: workflowDir, repoRoot } = await resolveWorkflowDir();

  const presets = await readJson(path.join(ROOT, 'config', 'presets.json'));
  const presetKeys = Object.keys(presets).filter((k) => !k.startsWith('_'));

  // ── 분야 ────────────────────────────────────────────────
  const presetChoices = [
    ...presetKeys.map((k) => [k, presets[k].label]),
    ['custom', '직접 키워드 입력'],
  ];
  // --query 를 준 건 곧 직접 키워드를 쓰겠다는 뜻이다. 굳이 --preset custom 까지
  // 같이 쓰게 만들지 않는다.
  const presetKey = ARGS.query
    ? 'custom'
    : await askChoice('1. 어떤 분야를 다루시나요?', presetChoices, 'tech', 'preset');

  const topic = {};
  if (presetKey === 'custom') {
    topic.label = await ask('\n분야 이름은? (카드에 표시되진 않고 관리용입니다)', '내 뉴스', 'topic-label');
    topic.query = await askValid(
      '\n검색 키워드는? (OR 로 여러 개 가능)',
      null,
      (raw) => {
        const v = raw.trim();
        if (!v) throw new Error('키워드가 없으면 뉴스를 못 모읍니다.');
        return v;
      },
      'query',
    );
    topic.lang = await ask('\n수집 언어 코드는? (ko / en / ja …)', 'ko', 'lang');
    topic.region = await ask('\n수집 지역 코드는? (KR / US / JP …)', 'KR', 'region');
  } else {
    topic.preset = presetKey;
    topic.label = presets[presetKey].label;
  }
  topic.hours = await askNumber('\n최근 몇 시간 내 기사를 볼까요?', 24, 1, 168, 'hours');
  topic.limit = 25;
  const excludeRaw = await ask('\n제외할 키워드가 있나요? (쉼표 구분, 없으면 엔터)', '', 'exclude');
  topic.exclude = excludeRaw ? excludeRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  topic.match = [];

  // ── 카드 ────────────────────────────────────────────────
  const template = await askChoice(
    '2. 카드 디자인은?',
    [
      ['story', '사건 하나를 깊게 · 사진 여러 장 + 자세한 설명 (권장)'],
      ['news', '그날 뉴스 여러 건을 모아보기'],
      ['minimal', '밝고 조용한 정보 전달형'],
      ['breaking', '고대비 강조형 · 속보/이슈'],
      ['magazine', '에디토리얼 감성 · 라이프스타일'],
      ['darktech', '다크 + 네온 · 테크/AI/코인'],
      ['board', '패널 정리형 · 교육/꿀팁'],
    ],
    'story',
    'template',
  );
  if (!TEMPLATES.includes(template)) fail(`알 수 없는 템플릿: ${template}`);

  const cards = {
    count: await askNumber('\n본문 카드 몇 장? (표지·엔딩 제외)', 5, 3, 8, 'cards'),
    template,
    outputLang: await askValid(
      '\n카드에 쓸 언어는? (ko / en)',
      'ko',
      (raw) => {
        const v = raw.trim().toLowerCase();
        if (v !== 'ko' && v !== 'en') throw new Error("ko 또는 en 으로 넣어주세요.");
        return v;
      },
      'out-lang',
    ),
  };

  // ── 브랜딩 ──────────────────────────────────────────────
  const brand = {
    handle: await askValid('\n3. 카드에 넣을 계정 핸들은?', '@my_account', normalizeHandle, 'handle'),
    accent: await askValid(
      '\n강조색은? (색 이름도 됩니다. 비우면 템플릿 기본색)',
      '',
      normalizeAccent,
      'accent',
    ),
    label: await ask('\n카드 상단 문구는? (예: 최신 AI 뉴스)', '최신 뉴스', 'brand-label'),
  };

  // ── 스케줄 ──────────────────────────────────────────────
  const timezone = await askValid('\n4. 시간대는?', 'Asia/Seoul', normalizeTimezone, 'timezone');

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
  }, 'times');

  console.log('\n발행 버튼을 처음에 몇 분까지 기다릴까요?');
  console.log('   이 시간이 지나도 버튼은 살아 있습니다 — 회수 잡이 나중에 처리합니다.');
  const approvalMinutes = await askNumber('', 30, 1, 300, 'approval');

  // 회수 잡 주기는 묻지 않는다.
  //
  // 예전에는 "몇 분마다 확인할까요"를 물었지만, GitHub 의 예약 실행은 보장된
  // 시각이 아니라 최선 노력이라 이 값이 거의 의미가 없다. */15 로 걸어도 실측
  // 간격이 28분에서 146분까지 튄다. 그래서 자주 뜨는 대신, 한 번 뜨면 오래
  // 지켜보고 다음 실행이 대기열에서 이어받게 한다.
  const drainEveryHours = 2;
  // 주기(120분)보다 짧게 잡는다. 더 길면 다음 실행이 대기열에 쌓였다가
  // 그 다음 실행에 밀려 cancelled 로 남는다. 동작은 정상인데 Actions 탭이
  // 취소 기록으로 뒤덮여 고장난 것처럼 보인다.
  const drainWatchMinutes = 110;

  // ── 레포 ────────────────────────────────────────────────
  console.log('\n5. 이미지 호스팅');
  console.log('   인스타그램은 "공개된 이미지 주소"만 받습니다.');
  console.log('   이 자동화를 돌릴 GitHub 레포(공개)를 그대로 쓰면 추가 가입이 없습니다.');
  console.log('   ⚠ 레포 페이지 상단에 적힌 이름을 그대로 쓰세요. 계정명에 -hash 같은 꼬리가 붙기도 합니다.');

  const cleanRepo = (raw) => {
    // 주소를 통째로 붙여넣는 경우가 많다.
    const cleaned = raw
      .trim()
      .replace(/^git@github\.com:/i, '')
      .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');

    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(cleaned)) {
      throw new Error('owner/repo 형식으로 넣어주세요. 예) mycompany-dev/cardnews');
    }
    if (cleaned !== raw.trim()) console.log(`   → ${cleaned} 로 정리했습니다.`);
    return cleaned;
  };

  // 이미 클론된 레포 안이라면 물어볼 필요가 없다. 계정명 오타(-hash 누락 같은)로
  // 이미지 업로드가 전부 404 나는 사고가 여기서 제일 많이 난다.
  const detectedRepo = await gitRemoteRepo(repoRoot);
  const imageRepo = await askValid(
    '\n레포 주소는? (owner/repo 형식)',
    detectedRepo ?? null,
    cleanRepo,
    'repo',
  );

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
  await fs.mkdir(workflowDir, { recursive: true });

  // 워크플로는 레포 루트에서 돈다. 스킬이 `.claude/skills/…` 처럼 깊이 들어가
  // 있어도 그 자리를 정확히 가리켜야 한다. 예전에는 'cardnews-autopilot' 로
  // 박혀 있어서, 레포 루트에 스킬을 둔 경우가 아니면 전 단계가 실패했다.
  const skillPath = repoRoot
    ? path.relative(repoRoot, ROOT).split(path.sep).join('/')
    : 'cardnews-autopilot';

  await fs.writeFile(
    path.join(workflowDir, 'cardnews.yml'),
    workflowYaml({
      crons: converted.map((c) => c.cron),
      localTimes: normalized,
      timeZone: timezone,
      waitMinutes: approvalMinutes,
      skillPath,
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(workflowDir, 'cardnews-drain.yml'),
    drainWorkflowYaml({
      everyHours: drainEveryHours,
      watchMinutes: drainWatchMinutes,
      skillPath,
    }),
    'utf8',
  );

  console.log('\n══════════════════════════════════════════');
  console.log('  설정 완료');
  console.log('══════════════════════════════════════════\n');
  // 경로는 짐작해서 적지 않는다. 실제로 쓴 자리를 그대로 보여준다.
  console.log(`  설정 파일    ${path.join(ROOT, 'config', 'config.json')}`);
  console.log(`  워크플로     ${path.join(workflowDir, 'cardnews.yml')}`);
  console.log(`               ${path.join(workflowDir, 'cardnews-drain.yml')}`);
  if (repoRoot) {
    console.log(`               (레포 루트: ${repoRoot})`);
  } else {
    console.log('\n  ⚠ 이 스킬이 git 레포 안에 있지 않아 워크플로를 임시 폴더에 만들었습니다.');
    console.log('    위 두 파일을 자동화용 레포의 .github/workflows/ 로 옮기셔야');
    console.log('    GitHub 이 예약 실행을 인식합니다. 레포 루트 기준입니다.');
  }
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
  .finally(() => rl?.close());
