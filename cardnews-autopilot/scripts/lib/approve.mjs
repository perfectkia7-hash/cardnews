import { log } from './util.mjs';
import { loadPending, removePending } from './state.mjs';
import { publishCarousel } from '../publish-ig.mjs';
import { answerCallback, clearButtons, sendMessage, sendMusicHint } from '../telegram.mjs';

/**
 * 발행/취소 결정을 실제로 처리한다. 초안 잡(tick)과 회수 잡(drain)이 같이 쓴다.
 *
 * 설계 원칙 하나: **어떤 단계가 실패해도 다음 초안 처리를 막지 않는다.**
 * 예전에는 만료된 콜백에 응답하려다 던진 예외가 잡히지 않아 회수 잡 전체가
 * 죽었고, 그래서 시간이 지난 뒤 누른 발행이 영영 처리되지 않았다.
 *
 * @returns {Promise<Array<{draftId:string, status:'published'|'skipped'|'failed'|'unknown', mediaId?:string}>>}
 */
export async function processDecisions(config, chatId, decisions) {
  if (decisions.length === 0) return [];

  const pending = await loadPending(config);
  const results = [];

  for (const decision of decisions) {
    const entry = pending.find((p) => p.draftId === decision.draftId);
    if (!entry) {
      // 이미 처리됐거나 만료된 초안. 버튼만 정리해 준다.
      await clearButtons(
        chatId,
        decision.messageId,
        '⏳ <b>만료됨</b> — 이미 처리했거나 24시간이 지난 초안입니다.',
      );
      results.push({ draftId: decision.draftId, status: 'unknown' });
      continue;
    }

    try {
      if (decision.action === 'skip') {
        await answerCallback(decision.callbackId, '취소했습니다.');
        await clearButtons(chatId, decision.messageId, '🗑 <b>취소됨</b> — 발행하지 않았습니다.');
        await removePending(config, entry.draftId);
        log(`  · ${entry.draftId} 취소`);
        results.push({ draftId: entry.draftId, status: 'skipped' });
        continue;
      }

      await answerCallback(decision.callbackId, '발행합니다…');
      await clearButtons(chatId, decision.messageId, '⏳ <b>발행 중…</b>');

      const mediaId = await publishCarousel(entry.imageUrls, entry.caption);

      await clearButtons(
        chatId,
        decision.messageId,
        `✅ <b>발행 완료</b>\n<code>media ${mediaId}</code>`,
      );
      await removePending(config, entry.draftId);
      await sendMusicHint(chatId, config, entry);

      log(`  ✔ ${entry.draftId} 발행 완료 — media ${mediaId}`);
      results.push({ draftId: entry.draftId, status: 'published', mediaId });
    } catch (err) {
      // 초안은 대기 목록에 남긴다. 원인을 고치고 다시 누르면 그대로 올라간다.
      const message = String(err.message).slice(0, 400);
      await clearButtons(
        chatId,
        decision.messageId,
        `⚠️ <b>발행 실패</b>\n<code>${message}</code>\n\n초안은 그대로 두었습니다. 고친 뒤 다시 눌러 주세요.`,
      );
      await sendMessage(chatId, `⚠️ 발행에 실패했습니다.\n<code>${message}</code>`).catch(() => {});
      log(`  ✖ ${entry.draftId} 발행 실패: ${err.message}`);
      results.push({ draftId: entry.draftId, status: 'failed' });
    }
  }

  return results;
}
