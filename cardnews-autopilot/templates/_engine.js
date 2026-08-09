/* ============================================================
   카드 덱 공용 엔진 — 5개 템플릿이 모두 이 파일을 쓴다.
   디자인은 각 템플릿의 <style> 만 고치면 되고, 이 파일은 건드릴 일이 없다.
   ============================================================ */

/**
 * 줄바꿈(\n)을 <br> 로, `**강조**` 를 <strong> 으로 바꾸면서 HTML 은 이스케이프한다.
 *
 * 카피 규칙(references/copywriting.md)이 숫자·인용·핵심 구절을 `**` 로 감싸라고
 * 지시한다. 여기서 변환하지 않으면 카드에 별표가 그대로 찍힌다.
 *
 * 순서가 중요하다 — 먼저 이스케이프하고, 그 다음에 태그를 만든다.
 * 반대로 하면 본문에 들어온 `<script>` 가 살아난다.
 */
function textToHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .split('\n')
    .join('<br>');
}

/**
 * .fit 영역은 높이가 고정되어 있다. 글이 넘치면 폰트 크기를 조금씩 줄여
 * 안에 들어올 때까지 맞춘다. 내부 글자는 em 단위라 같이 줄어든다.
 *
 * .fit 이 flex + justify-content:center 라 넘친 내용이 위아래로 잘리고,
 * 이때 scrollHeight 는 clientHeight 와 같아져 버린다. 그래서 실제 높이를
 * 재려면 자식들을 래퍼로 묶어 그 높이를 봐야 한다.
 */
function fitCard(card) {
  const zone = card.querySelector('.fit');
  if (!zone) return;

  let inner = zone.querySelector(':scope > .fit-inner');
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'fit-inner';
    inner.style.width = '100%';
    inner.style.display = 'flow-root'; // 자식 margin 이 래퍼 밖으로 새지 않게
    while (zone.firstChild) inner.appendChild(zone.firstChild);
    zone.appendChild(inner);
  }

  const available = zone.clientHeight;
  const base = parseFloat(getComputedStyle(zone).fontSize) || 100;
  const min = base * 0.55;
  let size = base;

  while (inner.getBoundingClientRect().height > available && size > min) {
    size -= base * 0.025;
    zone.style.fontSize = `${size}px`;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.defaultAccent  템플릿 기본 강조색
 * @param {(card: object, deck: object) => string} opts.body  카드 내부 HTML 생성기
 */
function renderDeck(opts) {
  const deck = window.__DECK__ || { cards: [], brand: {} };
  const brand = deck.brand || {};
  const root = document.getElementById('deck');

  if (brand.accent) {
    document.documentElement.style.setProperty('--accent', brand.accent);
  } else if (opts.defaultAccent) {
    document.documentElement.style.setProperty('--accent', opts.defaultAccent);
  }

  for (const card of deck.cards) {
    const el = document.createElement('div');
    const extra = opts.cardClass ? opts.cardClass(card, { brand }) : '';
    el.className = `card ${card.kind}${extra ? ` ${extra}` : ''}`;
    el.innerHTML = opts.body(card, { brand });
    root.appendChild(el);
  }

  // 레이아웃이 확정된 뒤에 맞춰야 scrollHeight 가 정확하다.
  for (const card of root.querySelectorAll('.card')) fitCard(card);
}

/** 템플릿들이 공통으로 쓰는 조각들 */
const parts = {
  /** 하단 바: 계정 핸들 + 페이지 표시 */
  footer(card, brand) {
    const handle = brand.handle ? `<span class="handle">${textToHtml(brand.handle)}</span>` : '<span></span>';
    const page =
      card.kind === 'cover' ? '<span class="swipe">밀어서 보기 →</span>' : `<span class="page">${card.index} / ${card.total}</span>`;
    return `<div class="foot">${handle}${page}</div>`;
  },

  /** 본문 카드의 출처 한 줄 */
  source(card) {
    return card.source ? `<div class="src">${textToHtml(card.source)}</div>` : '';
  },

  headline(card) {
    return `<h1 class="headline">${textToHtml(card.headline)}</h1>`;
  },

  body(card) {
    return card.body ? `<p class="body">${textToHtml(card.body)}</p>` : '';
  },
};
