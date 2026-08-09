#!/usr/bin/env node
/**
 * 자격증명 발급 안내 마법사 — 막히는 지점을 하나씩 넘겨 준다.
 *
 *   node scripts/onboard.mjs
 *
 * 이 스킬에서 사람 손이 꼭 필요한 건 네 가지뿐이다. 계정 로그인과 토큰 발급은
 * 대신 해줄 수 없기 때문이다. 나머지는 전부 자동인데, 정작 이 네 가지에서
 * 사람들이 막혀 포기한다. 그래서 한 단계씩 붙잡고 간다.
 *
 * 하는 일
 *   - 필요한 사이트를 순서에 맞춰 열어 준다 (윈도우/맥/리눅스 알아서)
 *   - 어느 화면에서 무슨 버튼을 누르는지 화면 순서대로 알려준다
 *   - 받은 값을 **그 자리에서 검증한다.** 틀렸으면 왜 틀렸는지 말해 준다
 *   - .env 에 저장하고, 마지막에 GitHub Secrets 에 넣을 목록을 정리해 준다
 *
 * 설치 파일을 대신 내려받아 실행하지는 않는다. 공식 다운로드 페이지를 열어
 * 주는 데까지만 한다 — 받아서 실행하는 건 악성코드가 쓰는 방식이라, 제품이
 * 그렇게 동작하면 안 된다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, log, exists, fail } from './lib/util.mjs';
import { setEnvValue, isPlaceholder } from './lib/env.mjs';

const rl = readline.createInterface({ input: stdin, output: stdout });

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const line = () => console.log(C.dim('─'.repeat(58)));

/** 브라우저로 주소를 연다. 운영체제마다 명령이 다르다. */
function openUrl(url) {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

async function pause(message = '다 하셨으면 엔터를 눌러 주세요') {
  await rl.question(C.dim(`\n  ${message} `));
}

/** 엔터=예. n 을 치면 아니오. */
async function confirm(message) {
  const answer = (await rl.question(`\n  ${message} ${C.dim('[엔터=예 / n=아니오]')} `)).trim();
  return !/^n/i.test(answer);
}

async function askValue(label) {
  return (await rl.question(`\n  ${C.cyan(label)}\n  > `)).trim();
}

/** 열어 줄지 물어보고 연다. */
async function offerOpen(label, url) {
  if (!(await confirm(`${label} 열어 드릴까요?`))) {
    console.log(C.dim(`  건너뜁니다. 직접 여실 주소: ${url}`));
    return;
  }
  const ok = openUrl(url);
  console.log(ok ? C.dim(`  브라우저를 열었습니다 → ${url}`) : C.yellow(`  직접 열어 주세요: ${url}`));
}

/* ── 검증 ─────────────────────────────────────────────── */

async function checkTelegramToken(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.description ?? '토큰이 올바르지 않습니다.');
  return `@${data.result.username}`;
}

async function findChatId(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.description ?? '조회에 실패했습니다.');
  for (const update of [...(data.result ?? [])].reverse()) {
    const id = update.message?.chat?.id ?? update.channel_post?.chat?.id;
    if (id) return String(id);
  }
  return null;
}

async function checkRepo(slug) {
  const res = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) {
    throw new Error('그런 레포를 찾지 못했습니다. 계정명에 꼬리(-hash 등)가 붙지 않았는지 확인하세요.');
  }
  if (!res.ok) throw new Error(`GitHub 조회 실패 (${res.status})`);
  const data = await res.json();
  if (data.private) {
    throw new Error('비공개 레포입니다. 인스타가 공개 이미지 주소만 받으므로 Public 으로 바꿔 주세요.');
  }
  return data.full_name;
}

/**
 * Claude 토큰을 실제로 써 본다.
 *
 * 형식만 봐서는 알 수 없다. 잘못된 토큰이어도 저장은 되고, 며칠 뒤 새벽
 * 자동 실행에서야 "인증 실패" 로 터진다. 그때는 원인을 짚기 어렵다.
 * 아주 작은 요청 하나를 실제로 보내 지금 확인한다.
 */
async function checkClaudeToken(token) {
  const { isAvailable, generate } = await import('./lib/claude-cli.mjs');
  if (!(await isAvailable())) {
    throw new Error(
      'claude 명령을 찾지 못해 확인을 건너뜁니다.\n' +
        '     설치: npm install -g @anthropic-ai/claude-code (설치 후 터미널 재시작)',
    );
  }

  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  try {
    await generate({
      prompt: '연결 확인용이다. ok 에 1을 넣어 제출해라.',
      systemPrompt: '너는 값을 반환하는 도구다. 설명 없이 결과만 낸다.',
      schema: { type: 'object', properties: { ok: { type: 'integer' } }, required: ['ok'] },
      timeoutMs: 120_000,
    });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
  }
}

async function checkInstagram(token) {
  const res = await fetch(
    `https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${token}`,
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  if (!data.user_id) throw new Error('계정 ID 를 받지 못했습니다. 토큰을 다시 발급해 주세요.');
  return data;
}

/* ── 단계 ─────────────────────────────────────────────── */

const STEPS = [
  {
    id: 'telegram',
    title: '텔레그램 봇',
    minutes: 5,
    keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    async run() {
      console.log(`
  카드뉴스 초안을 받고 ${C.bold('발행 버튼')}을 누를 창구입니다.
  봇을 하나 만들어야 하는데, 텔레그램 앱 안에서 대화로 만듭니다.`);

      if (await confirm('텔레그램 앱이 설치돼 있나요?')) {
        console.log(C.dim('  좋습니다. 다음으로 갑니다.'));
      } else {
        const url =
          process.platform === 'win32' || process.platform === 'darwin'
            ? 'https://desktop.telegram.org'
            : 'https://telegram.org/apps';
        await offerOpen('공식 다운로드 페이지를', url);
        console.log(C.dim('  설치하고 로그인까지 마친 뒤 돌아와 주세요.'));
        await pause();
      }

      console.log(`
  ${C.bold('봇 만들기')}
    1. 텔레그램 검색창에 ${C.cyan('@BotFather')} 를 칩니다
       ${C.dim('— 이름 옆에 파란 체크(✓)가 있는 계정이 진짜입니다. 사칭이 많습니다')}
    2. 대화를 열고 ${C.cyan('/newbot')} 이라고 보냅니다
    3. 봇 ${C.bold('이름')}을 물어봅니다 — 아무거나 (예: 내 카드뉴스)
    4. 봇 ${C.bold('아이디')}를 물어봅니다 — ${C.yellow('반드시 bot 으로 끝나야 합니다')}
       ${C.dim('예: my_cardnews_bot')}
    5. ${C.cyan('123456789:AAE...')} 형태의 긴 문자열이 나옵니다`);

      let token = '';
      while (true) {
        token = await askValue('그 문자열을 그대로 붙여넣어 주세요');
        if (!token) continue;
        try {
          const name = await checkTelegramToken(token);
          console.log(C.green(`  ✔ 확인했습니다 — ${name}`));
          break;
        } catch (err) {
          console.log(C.red(`  ✖ ${err.message}`));
          console.log(C.dim('  BotFather 가 준 줄을 통째로 복사하셨는지 확인해 주세요.'));
        }
      }
      await setEnvValue('TELEGRAM_BOT_TOKEN', token);

      console.log(`
  ${C.bold('채팅 ID 찾기')} ${C.dim('— 이건 자동으로 찾습니다')}
    방금 만든 봇과의 대화창을 열고 ${C.cyan('아무 말이나 한 번')} 보내 주세요.
    ${C.dim('(이걸 안 하면 봇이 나에게 메시지를 못 보냅니다)')}`);

      while (true) {
        await pause('보내셨으면 엔터');
        const id = await findChatId(token);
        if (id) {
          await setEnvValue('TELEGRAM_CHAT_ID', id);
          console.log(C.green(`  ✔ 채팅 ID 를 찾았습니다 — ${id}`));
          await fetch(
            `https://api.telegram.org/bot${token}/sendMessage?chat_id=${id}` +
              `&text=${encodeURIComponent('연결됐습니다. 여기로 카드뉴스 초안이 옵니다.')}`,
          ).catch(() => {});
          console.log(C.dim('  텔레그램으로 확인 메시지를 보냈습니다.'));
          break;
        }
        console.log(C.red('  ✖ 아직 메시지가 안 보입니다.'));
        console.log(C.dim('  봇과의 대화창이 맞는지 확인하고 한 번 더 보내 주세요.'));
      }
    },
  },

  {
    id: 'claude',
    title: 'Claude 토큰',
    minutes: 2,
    keys: ['CLAUDE_CODE_OAUTH_TOKEN'],
    async run() {
      console.log(`
  사람이 없는 새벽에도 원고를 써야 하므로 모델을 부를 수단이 하나 필요합니다.
  ${C.bold('Claude 구독(Pro/Max)이 있으면 추가 요금이 0원')}입니다.

  ${C.bold('발급 방법')}
    ${C.yellow('새 터미널 창')}을 하나 열고 아래를 실행하세요.
    ${C.dim('(이 창에서 실행하면 마법사가 멈춥니다)')}

      ${C.cyan('claude setup-token')}

    브라우저로 로그인하면 토큰이 나옵니다. 유효기간은 1년입니다.

  ${C.dim('· claude 명령을 못 찾는다고 나오면: npm install -g @anthropic-ai/claude-code')}
  ${C.dim('  설치 후에도 안 되면 터미널을 껐다 켜세요.')}
  ${C.dim('· 구독이 없으시면 이 단계를 건너뛰고 나중에 ANTHROPIC_API_KEY 를 쓰셔도 됩니다.')}`);

      const token = await askValue('나온 토큰을 붙여넣어 주세요 (건너뛰려면 그냥 엔터)');
      if (!token) {
        console.log(C.yellow('  건너뜁니다. 나중에 넣으셔도 됩니다.'));
        return;
      }
      await setEnvValue('CLAUDE_CODE_OAUTH_TOKEN', token);
      console.log(C.green('  ✔ 저장했습니다.'));

      if (await confirm('토큰이 실제로 되는지 확인해 볼까요? (20~30초)')) {
        console.log(C.dim('  아주 작은 요청 하나를 보내는 중…'));
        try {
          await checkClaudeToken(token);
          console.log(C.green('  ✔ 잘 됩니다. 자동 실행 때 이 토큰으로 원고를 씁니다.'));
        } catch (err) {
          console.log(C.red(`  ✖ ${err.message}`));
          console.log(C.dim('  토큰을 다시 발급해 이 단계를 한 번 더 실행해 주세요.'));
          console.log(C.dim('  (지금 저장은 해두었으니 나중에 고치셔도 됩니다)'));
        }
      } else {
        console.log(C.dim('  건너뜁니다. 첫 자동 실행 때 확인됩니다.'));
      }
    },
  },

  {
    id: 'github',
    title: 'GitHub 레포',
    minutes: 5,
    keys: ['IMAGE_REPO'],
    async run() {
      console.log(`
  두 가지를 한 번에 해결합니다 — ${C.bold('예약 실행')}과 ${C.bold('이미지 저장소')}.
  인스타가 "인터넷에 공개된 이미지 주소"만 받기 때문에 저장소가 필요합니다.

  ${C.bold('만들기')}
    1. 아래 페이지에서 레포를 하나 만듭니다 (이름은 아무거나, 예: cardnews)
    2. ${C.yellow('반드시 Public 으로 만드세요')}
       ${C.dim('— 인스타가 공개 주소만 받고, 공개 레포는 실행 시간이 무제한 무료입니다')}
       ${C.dim('— 토큰은 레포에 안 들어갑니다. Secrets 에 따로 넣으므로 공개해도 안전합니다')}`);

      await offerOpen('레포 만드는 페이지를', 'https://github.com/new');
      await pause('만드셨으면 엔터');

      console.log(`
  ${C.dim('레포 페이지 주소창에 보이는 이름을 그대로 쓰세요.')}
  ${C.dim('계정명에 -hash 같은 꼬리가 붙는 경우가 있는데, 빠뜨리면 이미지가 전부 깨집니다.')}`);

      while (true) {
        const raw = await askValue('레포 주소를 넣어 주세요 (owner/repo 또는 전체 주소)');
        const slug = raw
          .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
          .replace(/\.git$/i, '')
          .replace(/\/+$/, '')
          .trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
          console.log(C.red('  ✖ owner/repo 형식으로 넣어 주세요.'));
          continue;
        }
        try {
          const full = await checkRepo(slug);
          console.log(C.green(`  ✔ 확인했습니다 — ${full} (Public)`));
          await setEnvValue('IMAGE_REPO', full);
          break;
        } catch (err) {
          console.log(C.red(`  ✖ ${err.message}`));
        }
      }
    },
  },

  {
    id: 'instagram',
    title: '인스타그램',
    minutes: 30,
    keys: ['IG_ACCESS_TOKEN', 'IG_USER_ID'],
    async run() {
      console.log(`
  ${C.yellow('여기가 제일 오래 걸립니다. 20~40분 잡으세요.')}
  천천히 하시면 됩니다. 막히면 그 화면을 캡처해서 Claude 에게 보여주세요.

  ${C.bold('① 계정을 프로페셔널로')}
    인스타 앱 → 프로필 → 메뉴 → 설정 → 계정 유형 및 도구
    → ${C.cyan('프로페셔널 계정으로 전환')}
    ${C.dim('비즈니스든 크리에이터든 상관없습니다.')}`);
      await pause('바꾸셨으면 엔터');

      console.log(`
  ${C.bold('② Meta 개발자 등록 + 앱 만들기')}
    1. 우상단 ${C.cyan('시작하기')} 로 개발자 등록
       ${C.dim('안 넘어가면 페이스북 계정에 휴대폰·이메일 인증이 안 된 것입니다.')}
       ${C.dim('사업자 등록은 필요 없습니다.')}
    2. 내 앱 → ${C.cyan('앱 만들기')}
    3. 용도는 ${C.cyan('기타')} → 유형은 ${C.cyan('비즈니스')}
    4. 사용 사례를 고르라고 하면 ${C.bold('Instagram 관련')}으로 고릅니다`);

      await offerOpen('Meta 개발자 페이지를', 'https://developers.facebook.com');
      await pause('앱을 만드셨으면 엔터');

      console.log(`
  ${C.bold('③ Instagram 제품 추가')}
    1. 앱 대시보드 → 제품 추가 → ${C.cyan('Instagram')} → 설정
    2. ${C.cyan('Instagram API 설정 (Instagram 로그인 사용)')} 을 고릅니다
       ${C.dim('페이스북 페이지 연결이 필요 없어서 단계가 적습니다.')}

  ${C.bold('④ 내 계정을 테스터로 등록')} ${C.yellow('← 여기서 가장 많이 막힙니다')}
    개발 모드에서는 ${C.bold('앱에 등록된 계정만')} 인증됩니다. 내 계정도 등록해야 합니다.

    1. 왼쪽 메뉴 → 앱 역할 → 역할 → ${C.cyan('사용자 추가')}
    2. 창을 내려서 ${C.cyan('Instagram 테스터')} 를 고릅니다
    3. 본인 인스타 사용자 이름을 넣고 초대를 보냅니다
    4. ${C.yellow('인스타 앱에서 초대를 수락합니다')}
       ${C.dim('설정 → 앱 및 웹사이트 → 테스터 초대 → 수락')}
       ${C.dim('4번을 빼먹어서 계속 막히는 경우가 제일 많습니다.')}`);
      await pause('수락까지 하셨으면 엔터');

      console.log(`
  ${C.bold('⑤ 권한과 토큰')}
    필요한 권한 두 가지가 붙어 있어야 합니다.
      ${C.cyan('instagram_business_basic')}
      ${C.cyan('instagram_business_content_publish')}
    ${C.dim('목록에 없으면 사용 사례가 안 붙은 것입니다 — 사용 사례에서 Instagram 을 추가하세요.')}

    Instagram → API 설정 화면에서 ${C.cyan('액세스 토큰 생성')} 을 누르고
    인스타 계정으로 로그인해 권한을 승인하면 긴 문자열이 나옵니다.
    ${C.dim('권한을 나중에 추가했다면 토큰을 반드시 다시 발급하세요. 예전 토큰엔 새 권한이 없습니다.')}`);

      while (true) {
        const token = await askValue('나온 토큰을 붙여넣어 주세요');
        if (!token) continue;
        try {
          const me = await checkInstagram(token);
          await setEnvValue('IG_ACCESS_TOKEN', token);
          await setEnvValue('IG_USER_ID', String(me.user_id));
          await setEnvValue('IG_API_BASE', 'https://graph.instagram.com');
          console.log(C.green(`  ✔ 확인했습니다 — @${me.username}`));
          console.log(C.dim(`  계정 ID(${me.user_id})도 자동으로 채웠습니다.`));
          break;
        } catch (err) {
          console.log(C.red(`  ✖ ${err.message}`));
          console.log(C.dim('  테스터 초대를 수락하셨는지, 권한 두 개가 붙었는지 확인해 주세요.'));
        }
      }

      console.log(C.yellow('\n  ⚠ 이 토큰은 60일 뒤 만료됩니다.'));
      console.log(C.dim('    만료 10일 전에 텔레그램으로 알려드립니다.'));
      console.log(C.dim('    갱신은 node scripts/refresh-token.mjs 한 줄이면 됩니다.'));
    },
  },
];

/* ── 진행 ─────────────────────────────────────────────── */

function done(step) {
  return step.keys.every((k) => process.env[k] && !isPlaceholder(process.env[k]));
}

async function ensureEnv() {
  const file = path.join(ROOT, '.env');
  if (await exists(file)) return;
  const example = path.join(ROOT, '.env.example');
  if (!(await exists(example))) fail('.env.example 이 없습니다. 압축을 다시 풀어 주세요.');
  await fs.copyFile(example, file);
  console.log(C.dim('  .env 파일을 만들었습니다.'));
}

async function main() {
  // 사람이 직접 앉아서 답해야 하는 마법사다. 파이프로 실행되면 readline 이
  // 입력을 통째로 삼키고 닫혀서 첫 질문에서 죽는다. Claude 가 대신 돌리려다
  // 그렇게 되는 일이 있어서, 그때는 이유를 알려주고 곱게 멈춘다.
  if (!stdin.isTTY) {
    console.log(`
  이 마법사는 터미널에서 직접 실행해야 합니다.

    ${C.cyan('node scripts/onboard.mjs')}

  ${C.dim('윈도우는 PowerShell, 맥은 터미널을 열고 스킬 폴더에서 실행하세요.')}
  ${C.dim('로그인과 토큰 발급이 필요해 사람이 앉아서 진행해야 합니다.')}
`);
    return;
  }

  console.clear();
  console.log(`
${C.bold('  카드뉴스 오토파일럿 — 세팅 도우미')}
`);
  line();
  console.log(`
  자동으로 굴러가게 하려면 ${C.bold('네 가지')} 값이 필요합니다.
  계정 로그인과 토큰 발급은 대신 해드릴 수 없어서, 대신 ${C.bold('한 단계씩')}
  화면 순서를 알려드리고 ${C.bold('받은 값이 맞는지 그 자리에서 확인')}해 드립니다.

  사이트는 알아서 열어 드립니다. 중간에 그만두셔도 됩니다 —
  다시 실행하면 ${C.bold('한 곳부터 이어서')} 갑니다.
`);
  line();

  await ensureEnv();
  // .env 를 방금 만들었을 수 있으므로 다시 읽는다.
  const fresh = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
  for (const l of fresh.split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l.trim());
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }

  console.log('\n  진행 상황\n');
  STEPS.forEach((s, i) => {
    const mark = done(s) ? C.green('✔') : C.dim('○');
    console.log(`   ${mark} ${i + 1}. ${s.title} ${C.dim(`· 약 ${s.minutes}분`)}`);
  });

  for (const [i, step] of STEPS.entries()) {
    if (done(step)) {
      console.log(`\n${C.green(`  ✔ ${i + 1}. ${step.title}`)} ${C.dim('— 이미 끝났습니다. 건너뜁니다.')}`);
      continue;
    }

    console.log('');
    line();
    console.log(`  ${C.bold(`${i + 1}. ${step.title}`)}  ${C.dim(`약 ${step.minutes}분`)}`);
    line();

    if (!(await confirm('지금 진행할까요?'))) {
      console.log(C.yellow('  건너뜁니다. 다시 실행하면 여기서부터 이어집니다.'));
      continue;
    }
    await step.run();
    console.log(C.green(`\n  ✔ ${step.title} 완료`));
  }

  console.log('');
  line();
  console.log(`  ${C.bold('마지막 — GitHub Secrets 에 등록')}`);
  line();
  console.log(`
  받은 값들은 ${C.cyan('.env')} 에 저장했습니다. 이건 내 PC 에서 시험할 때 쓰는 것이고,
  ${C.bold('매일 자동으로 돌게 하려면 GitHub 에도 같은 값을 넣어야 합니다.')}
  이 화면만은 직접 붙여넣으셔야 합니다.

  레포 → ${C.cyan('Settings → Secrets and variables → Actions → New repository secret')}
`);
  const secrets = [
    ['TELEGRAM_BOT_TOKEN', '텔레그램 봇 토큰'],
    ['TELEGRAM_CHAT_ID', '내 채팅 ID'],
    ['IG_USER_ID', '인스타 계정 ID'],
    ['IG_ACCESS_TOKEN', '인스타 액세스 토큰'],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'Claude 토큰 (없으면 ANTHROPIC_API_KEY)'],
  ];
  for (const [key, desc] of secrets) {
    const has = process.env[key] && !isPlaceholder(process.env[key]);
    console.log(`   ${has ? C.green('✔') : C.yellow('○')} ${key.padEnd(24)} ${C.dim(desc)}`);
  }
  console.log(`
  ${C.yellow('※ GITHUB_TOKEN 은 등록하지 마세요.')} GitHub 이 자동으로 넣어줍니다.
`);

  const repo = process.env.IMAGE_REPO;
  if (repo) {
    await offerOpen('Secrets 등록 페이지를', `https://github.com/${repo}/settings/secrets/actions`);
  }

  console.log(`
${C.bold('  다음으로 하실 것')}

   1. 위 값들을 Secrets 에 등록
   2. Claude Code 에게 ${C.cyan('"자동 모드 세팅해줘"')} 라고 말하기
      ${C.dim('— 설정 파일과 예약 스케줄을 대신 만들어 드립니다')}
   3. 레포에 커밋해서 push
   4. Actions 탭 → cardnews → Run workflow 로 시험 실행

  ${C.dim('무엇이 빠졌는지 확인하려면:')}  ${C.cyan('node scripts/doctor.mjs')}
`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .catch((err) => fail(err.stack || err.message))
    .finally(() => rl.close());
}
