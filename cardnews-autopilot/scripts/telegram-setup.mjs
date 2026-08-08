#!/usr/bin/env node
/**
 * 텔레그램 연결 마법사.
 *
 * 봇 토큰만 .env 에 넣어두면, 채팅 ID 를 알아서 찾아 .env 에 채워 넣는다.
 * (브라우저로 getUpdates 를 열어 JSON 에서 숫자를 골라내는 단계를 없앤다)
 *
 *   node scripts/telegram-setup.mjs
 */
import { pathToFileURL } from 'node:url';
import { fail, sleep, fetchWithRetry } from './lib/util.mjs';
import { setEnvValue, isPlaceholder } from './lib/env.mjs';

const API = 'https://api.telegram.org';

async function call(token, method, body = {}, timeoutMs = 30_000) {
  const res = await fetchWithRetry(
    `${API}/bot${token}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { retries: 1, timeoutMs },
  );
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description ?? `${method} 실패 (${res.status})`);
  return data.result;
}

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  텔레그램 연결');
  console.log('══════════════════════════════════════════\n');

  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (isPlaceholder(token)) {
    console.log('먼저 봇을 만들고 토큰을 .env 에 넣어주세요. 1분이면 됩니다.\n');
    console.log('  1. 텔레그램에서  @BotFather  를 검색해 대화를 엽니다');
    console.log('  2. /newbot  을 보냅니다');
    console.log('  3. 봇 이름을 정합니다 (표시용, 아무거나)');
    console.log('  4. 봇 아이디를 정합니다 — 반드시 bot 으로 끝나야 합니다');
    console.log('       예)  my_cardnews_bot');
    console.log('  5. 123456789:AAE... 형태의 토큰이 나옵니다');
    console.log('  6. .env 를 열어 TELEGRAM_BOT_TOKEN= 뒤에 붙여넣습니다\n');
    console.log('그다음 이 명령을 다시 실행하세요:');
    console.log('  node scripts/telegram-setup.mjs\n');
    process.exitCode = 1;
    return;
  }

  // ── 토큰 확인 ────────────────────────────────────────────
  let me;
  try {
    me = await call(token, 'getMe');
  } catch (err) {
    fail(
      `봇 토큰이 올바르지 않습니다: ${err.message}\n` +
        '  @BotFather 에서 받은 토큰을 통째로(콜론 포함) 넣었는지 확인하세요.',
    );
  }
  console.log(`✔ 봇 확인됨 — @${me.username}\n`);

  // ── 채팅 ID 찾기 ─────────────────────────────────────────
  console.log(`텔레그램에서 @${me.username} 을 열고 아무 말이나 한 번 보내주세요.`);
  console.log('(예: 안녕)  …기다리는 중\n');

  const deadline = Date.now() + 5 * 60_000;
  let chat = null;
  let offset = 0;

  while (Date.now() < deadline && !chat) {
    let updates;
    try {
      updates = await call(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, 45_000);
    } catch {
      await sleep(2000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (message?.chat?.id) chat = message.chat; // 가장 최근 것으로 갱신
    }
  }

  if (!chat) {
    fail(
      '5분 동안 메시지가 오지 않았습니다.\n' +
        `  @${me.username} 을 검색해 대화를 시작하고 아무 말이나 보낸 뒤 다시 실행하세요.`,
    );
  }

  const who = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '';
  console.log(`✔ 채팅 확인됨 — ${who}${chat.username ? ` (@${chat.username})` : ''}`);
  console.log(`  채팅 ID: ${chat.id}\n`);

  await setEnvValue('TELEGRAM_CHAT_ID', String(chat.id));
  console.log('✔ .env 의 TELEGRAM_CHAT_ID 를 채웠습니다.\n');

  await call(token, 'sendMessage', {
    chat_id: chat.id,
    text:
      '✅ <b>연결 완료</b>\n\n' +
      '이제 이 대화로 카드뉴스 초안이 도착합니다.\n' +
      '발행 버튼을 누르면 인스타그램에 올라갑니다.',
    parse_mode: 'HTML',
  });
  console.log('텔레그램으로 확인 메시지를 보냈습니다. 확인해 보세요.\n');

  console.log('다음 단계 — 인스타그램 연동:');
  console.log('  references/setup-automation.md 의 4단계를 따라 .env 에');
  console.log('  IG_USER_ID 와 IG_ACCESS_TOKEN 을 채우세요.');
  console.log('  그다음  node scripts/doctor.mjs  로 전체 점검.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
