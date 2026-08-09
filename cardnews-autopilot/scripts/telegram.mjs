#!/usr/bin/env node
/**
 * 텔레그램 전송 · 발행 버튼 응답 대기
 *
 * 서버가 필요 없다. 초안을 보낸 뒤 같은 프로세스가 getUpdates 롱폴링으로
 * 버튼 응답을 기다리므로, 누르는 즉시 반응한다.
 *
 *   node scripts/telegram.mjs send --cards out/cards --chat 12345
 *   node scripts/telegram.mjs await --chat 12345 --minutes 30
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, fail, log, readJson, sleep, fetchWithRetry } from './lib/util.mjs';

const API = 'https://api.telegram.org';

function token() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN 환경변수가 없습니다.');
  return t;
}

async function call(method, body, { timeoutMs = 30_000 } = {}) {
  const res = await fetchWithRetry(
    `${API}/bot${token()}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { retries: 2, timeoutMs },
  );
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} 실패: ${data.description ?? res.status}`);
  }
  return data.result;
}

/** 사진 여러 장을 앨범으로 보낸다. 공개 URL 이 있으면 URL, 없으면 파일 업로드. */
export async function sendAlbum(chatId, images, caption = '') {
  const usingUrls = images.every((i) => /^https?:\/\//.test(i));

  if (usingUrls) {
    const media = images.slice(0, 10).map((url, i) => ({
      type: 'photo',
      media: url,
      ...(i === 0 && caption ? { caption: caption.slice(0, 1000) } : {}),
    }));
    return call('sendMediaGroup', { chat_id: chatId, media });
  }

  // 로컬 파일은 multipart 로 올린다.
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const media = [];
  for (const [i, file] of images.slice(0, 10).entries()) {
    const name = `photo${i}`;
    const buf = await fs.readFile(file);
    form.append(name, new Blob([buf], { type: 'image/jpeg' }), path.basename(file));
    media.push({
      type: 'photo',
      media: `attach://${name}`,
      ...(i === 0 && caption ? { caption: caption.slice(0, 1000) } : {}),
    });
  }
  form.append('media', JSON.stringify(media));

  const res = await fetchWithRetry(
    `${API}/bot${token()}/sendMediaGroup`,
    { method: 'POST', body: form },
    { retries: 1, timeoutMs: 120_000 },
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendMediaGroup 실패: ${data.description}`);
  return data.result;
}

/** 앨범에는 버튼을 못 달아서, 조작용 메시지를 따로 보낸다. */
export async function sendControls(chatId, draftId, summary) {
  return call('sendMessage', {
    chat_id: chatId,
    text: summary,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ 발행', callback_data: `pub:${draftId}` },
          { text: '🗑 취소', callback_data: `skip:${draftId}` },
        ],
      ],
    },
  });
}

export async function sendMessage(chatId, text) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/**
 * 텔레그램에 올라간 사진의 공개 주소를 얻는다.
 *
 * 인스타 API 는 "인터넷에서 접근 가능한 이미지 주소"만 받는데, 초안 미리보기로
 * 이미 텔레그램에 올린 사진을 그대로 재사용하면 별도 호스팅 없이 발행이 된다.
 *
 * ⚠ 주소에 봇 토큰이 들어간다. 그 주소를 받은 쪽(메타)은 토큰을 보게 되므로
 *   상시 운영에는 GitHub 호스팅을 쓰고, 이 경로는 연동 테스트용으로만 쓴다.
 * ⚠ 텔레그램이 사진을 재압축하므로 원본보다 화질이 조금 떨어질 수 있다.
 */
export async function photoUrls(messages) {
  const urls = [];

  for (const message of messages) {
    const sizes = message.photo ?? [];
    if (sizes.length === 0) continue;

    // PhotoSize 배열은 작은 것부터 온다. 가장 큰 걸 쓴다.
    const largest = sizes.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
    const { file_path: filePath } = await call('getFile', { file_id: largest.file_id });
    if (filePath) urls.push(`${API}/file/bot${token()}/${filePath}`);
  }

  return urls;
}

/**
 * 버튼의 로딩 표시를 끈다.
 *
 * 콜백 ID 는 몇 분이면 만료된다. 15분마다 도는 회수 잡이 볼 때는 거의 항상 만료돼
 * 있어서 이 호출은 실패하는 게 정상이다. 발행을 막으면 안 되므로 절대 던지지 않는다.
 * 사용자에게 결과를 알리는 건 메시지 편집(clearButtons)이 맡는다 — 그건 나이와 무관하다.
 */
export async function answerCallback(callbackId, text) {
  if (!callbackId) return false;
  try {
    await call('answerCallbackQuery', { callback_query_id: callbackId, text }, { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 발행 뒤 음악 안내.
 *
 * 인스타 API 로는 게시물에 음악을 붙일 수 없다 — 음악 추가는 앱 전용 기능이다.
 * 그래서 올리는 것까지만 자동으로 하고, 앱에서 15초면 끝나는 나머지를 알려 준다.
 */
export async function sendMusicHint(chatId, config, entry) {
  if (config?.music?.remind === false) return null;

  const mood = entry?.musicMood
    ? `\n\n🎧 이 소재에 어울리는 결: <b>${entry.musicMood}</b>`
    : '';

  return sendMessage(
    chatId,
    '🎵 <b>음악 붙이기</b> (앱에서 15초)\n' +
      '1. 인스타 앱 → 방금 올라온 게시물\n' +
      '2. 오른쪽 위 <b>⋯</b> → <b>수정</b> → <b>음악 추가</b>\n' +
      '3. 목록 맨 위가 지금 인기 있는 오디오다' +
      mood +
      '\n\n<i>음악은 인스타 앱에서만 붙일 수 있어 이 단계는 자동화가 안 됩니다.</i>',
  ).catch(() => null);
}

/** 버튼을 없애서 두 번 눌리는 걸 막는다. */
export async function clearButtons(chatId, messageId, note) {
  try {
    await call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: note,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch {
    /* 이미 편집됐거나 삭제된 경우 — 무시 */
  }
}

/** 콜백 하나를 {draftId, action, callbackId, messageId} 로 바꾼다. */
function parseCallback(update, chatId) {
  const cq = update.callback_query;
  if (!cq?.data) return null;
  if (chatId && String(cq.message?.chat?.id) !== String(chatId)) return null;

  const [prefix, draftId] = cq.data.split(':');
  const action = prefix === 'pub' ? 'publish' : prefix === 'skip' ? 'skip' : null;
  if (!action || !draftId) return null;

  return { draftId, action, callbackId: cq.id, messageId: cq.message?.message_id };
}

/**
 * 쌓여 있는 버튼 응답을 한 번에 걷어 온다. 어느 초안이든 상관없이 전부 돌려준다.
 *
 * 읽은 뒤 오프셋을 확정하므로 같은 응답이 다시 오지 않는다. 확정 전에 죽으면
 * 다음 실행에서 다시 읽히는데, 이미 처리한 초안은 대기 목록에 없으니 중복 발행은 안 된다.
 *
 * @returns {Promise<Array<{draftId:string, action:'publish'|'skip', callbackId:string, messageId:number}>>}
 */
export async function pollDecisions({ chatId = null, timeoutSec = 5 } = {}) {
  let updates;
  try {
    updates = await call(
      'getUpdates',
      { timeout: timeoutSec, allowed_updates: ['callback_query'] },
      { timeoutMs: (timeoutSec + 15) * 1000 },
    );
  } catch (err) {
    log(`  ! 폴링 오류: ${err.message}`);
    return [];
  }

  if (updates.length === 0) return [];

  const decisions = updates.map((u) => parseCallback(u, chatId)).filter(Boolean);

  // 마지막 것만 남기고 확정 — 같은 초안을 두 번 누른 경우 마지막 의도를 따른다.
  const latest = new Map();
  for (const d of decisions) latest.set(d.draftId, d);

  await call('getUpdates', { offset: updates.at(-1).update_id + 1, timeout: 0 }).catch(() => {});

  return [...latest.values()];
}

/**
 * 지정한 초안에 대한 발행/취소 응답을 기다린다.
 *
 * 기다리는 동안 **다른 초안**의 버튼이 눌릴 수도 있다(어제 것을 이제 누르는 경우).
 * 그 응답을 그냥 버리면 오프셋만 넘어가 영영 사라지므로, onOther 로 넘겨서
 * 호출한 쪽이 바로 처리하게 한다.
 *
 * @param {(decisions:Array<object>)=>Promise<void>} [options.onOther]
 * @returns {Promise<{decision:'publish'|'skip'|'timeout', callbackId?:string, messageId?:number}>}
 */
export async function awaitDecision(draftId, { minutes = 30, chatId = null, onOther = null } = {}) {
  const deadline = Date.now() + minutes * 60_000;
  let offset = 0;

  log(`발행 버튼 대기 중… (최대 ${minutes}분, 이후에 눌러도 회수 잡이 처리합니다)`);

  while (Date.now() < deadline) {
    const remainingSec = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
    const pollSec = Math.min(50, remainingSec);

    let updates;
    try {
      updates = await call(
        'getUpdates',
        { offset, timeout: pollSec, allowed_updates: ['callback_query'] },
        { timeoutMs: (pollSec + 15) * 1000 },
      );
    } catch (err) {
      log(`  ! 폴링 오류(재시도): ${err.message}`);
      await sleep(3000);
      continue;
    }

    let mine = null;
    const others = [];
    for (const update of updates) {
      offset = update.update_id + 1;
      const parsed = parseCallback(update, chatId);
      if (!parsed) continue;
      if (parsed.draftId === draftId) mine = parsed;
      else others.push(parsed);
    }

    if (others.length > 0 && onOther) {
      // 여기서 실패해도 내 초안 대기는 계속돼야 한다.
      await onOther(others).catch((err) => log(`  ! 다른 초안 처리 실패: ${err.message}`));
    }

    if (mine) {
      return { decision: mine.action, callbackId: mine.callbackId, messageId: mine.messageId };
    }
  }

  return { decision: 'timeout' };
}

async function main() {
  const args = parseArgs();
  const command = process.argv[2];
  const chatId = args.chat ?? process.env.TELEGRAM_CHAT_ID;
  if (!chatId) fail('--chat 또는 TELEGRAM_CHAT_ID 가 필요합니다.');

  if (command === 'send') {
    const dir = typeof args.cards === 'string' ? args.cards : 'out/cards';
    const manifest = await readJson(path.join(dir, 'manifest.json'));
    await sendAlbum(chatId, manifest.files, manifest.title);
    const draftId = String(args.draft ?? Date.now());
    await sendControls(chatId, draftId, `<b>${manifest.title}</b>\n\n${manifest.caption}`);
    log(`✔ 전송 완료 (draft ${draftId})`);
    return;
  }

  if (command === 'await') {
    const result = await awaitDecision(String(args.draft ?? ''), {
      minutes: Number(args.minutes ?? 30),
      chatId,
    });
    log(`결과: ${result.decision}`);
    process.stdout.write(JSON.stringify(result));
    return;
  }

  fail('사용법: telegram.mjs <send|await> [옵션]');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => fail(err.stack || err.message));
}
