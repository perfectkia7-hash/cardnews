#!/usr/bin/env node
/**
 * 뉴스 수집기 — Google News RSS + 직접 지정한 RSS/Atom 피드
 *
 *   node scripts/fetch-news.mjs --query "AI OR 반도체" --lang ko --region KR --out out/news.json
 *   node scripts/fetch-news.mjs --feeds "https://a.com/rss,https://b.com/feed" --hours 48
 *
 * 결과는 stdout(JSON) 과 --out 파일 양쪽으로 나간다.
 */
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import {
  ROOT,
  parseArgs,
  fail,
  log,
  readJson,
  writeJson,
  stripHtml,
  fingerprint,
  fetchWithRetry,
} from './lib/util.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

/** hl / ceid 는 형식이 서로 달라서 따로 만든다. */
function googleNewsUrl(query, { lang, region, hours }) {
  const q = hours ? `${query} when:${hours}h` : query;
  const hl = lang === 'en' ? 'en-US' : lang;
  const params = new URLSearchParams({
    q,
    hl,
    gl: region,
    ceid: `${region}:${lang}`,
  });
  return `https://news.google.com/rss/search?${params}`;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'object') return String(node['#text'] ?? '');
  return String(node);
}

/** Atom 은 link 가 배열 + rel 속성으로 온다. */
function linkOf(item) {
  const raw = item.link;
  if (typeof raw === 'string') return raw;
  for (const candidate of asArray(raw)) {
    if (typeof candidate === 'string') return candidate;
    if (candidate?.['@_href'] && candidate['@_rel'] !== 'self') return candidate['@_href'];
    if (candidate?.['#text']) return String(candidate['#text']);
  }
  return item.guid ? textOf(item.guid) : '';
}

/**
 * 피드 제목은 "Engadget - Technology News & Expert Reviews" 처럼 설명이 붙어 온다.
 * 카드에 찍히는 이름이라 브랜드명만 남긴다.
 */
function shortPublisher(name = '') {
  return String(name).split(/\s[-–—|:]\s/)[0].trim().slice(0, 24);
}

/** Google News 는 제목 끝에 " - 매체명" 을 붙인다. 분리해 둔다. */
function splitPublisher(title, fallback) {
  const match = /^(.*)\s[-–—]\s([^-–—]{2,40})$/.exec(title);
  if (match) {
    return { title: match[1].trim(), publisher: shortPublisher(fallback || match[2]) };
  }
  return { title: title.trim(), publisher: shortPublisher(fallback) };
}

/**
 * RSS 항목에 붙어 있는 대표 이미지를 찾는다.
 * 매체마다 넣는 위치가 제각각이라 알려진 자리를 순서대로 훑는다.
 */
function imageFromItem(item) {
  const fromAttr = (node) => {
    for (const candidate of asArray(node)) {
      const url = candidate?.['@_url'] ?? candidate?.['@_href'];
      const type = candidate?.['@_type'] ?? candidate?.['@_medium'] ?? '';
      if (url && !/video|audio/i.test(type)) return decodeUrl(url);
    }
    return '';
  };

  const direct =
    fromAttr(item['media:content']) ||
    fromAttr(item['media:thumbnail']) ||
    fromAttr(item.enclosure) ||
    fromAttr(item['itunes:image']);
  if (direct) return direct;

  // 본문 HTML 안에 박힌 첫 <img>
  const html = textOf(item['content:encoded']) || textOf(item.description) || textOf(item.content);
  const img = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return img ? decodeUrl(img[1]) : '';
}

function parseFeed(xml, { sourceLabel }) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'] ?? doc?.feed;
  if (!channel) return [];

  const feedTitle = textOf(channel.title);
  const items = asArray(channel.item ?? channel.entry);

  return items.map((item) => {
    const rawTitle = stripHtml(textOf(item.title));
    const explicitPublisher =
      textOf(item.source) || textOf(item['dc:source']) || (sourceLabel === 'google' ? '' : feedTitle);
    const { title, publisher } = splitPublisher(rawTitle, explicitPublisher);

    const summaryRaw =
      item.description ?? item.summary ?? item['content:encoded'] ?? item.content ?? '';

    const published =
      textOf(item.pubDate) || textOf(item.published) || textOf(item.updated) || textOf(item['dc:date']);
    const date = published ? new Date(published) : null;

    return {
      title,
      link: linkOf(item),
      publisher: publisher || '출처 미상',
      publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      summary: stripHtml(textOf(summaryRaw)).slice(0, 600),
      image: imageFromItem(item),
      fingerprint: fingerprint(title),
    };
  });
}

async function loadFeed(url, sourceLabel) {
  const res = await fetchWithRetry(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' },
  });
  if (!res.ok) {
    log(`  ! ${res.status} ${res.statusText} — ${url}`);
    return [];
  }
  const xml = await res.text();
  try {
    return parseFeed(xml, { sourceLabel });
  } catch (err) {
    log(`  ! 파싱 실패 — ${url} (${err.message})`);
    return [];
  }
}

/** 이미지 URL 은 HTML 안에 &amp; / &#038; 로 인코딩돼 있다. 되돌리지 않으면 404 가 난다. */
function decodeUrl(url = '') {
  return String(url)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** 로고·아바타·저자사진·로딩용 이미지처럼 카드 배경으로 못 쓸 주소 */
const JUNK_IMAGE =
  /avatar|logo|icon|emoji|sprite|pixel|spacer|1x1|gravatar|placeholder|badge|favicon|advert|banner|profile[-_]?pic|headshot|loader|spinner|author|byline|thumb(?:nail)?|share|subscribe/i;

/** 이미지 파일이 아닌 것(추적 픽셀, 분석 비콘)을 걸러낸다. */
function isImageUrl(url) {
  const path = url.split('?')[0];
  return /\.(?:jpe?g|png|webp|avif)$/i.test(path);
}

/**
 * 같은 사진의 다른 크기 변형을 하나로 본다.
 *   hurricane-1152x648.jpg 와 hurricane-1536x864.jpg 는 같은 사진이다.
 *   l-intro-1785851122.jpg 와 intro-1785851122.jpg 도 마찬가지다.
 */
function imageKey(url) {
  const file = (url.split('?')[0].split('/').pop() ?? '')
    .toLowerCase()
    .replace(/\.\w+$/, '')
    .replace(/[-_]\d{2,4}x\d{2,4}$/, '')
    .replace(/[-_](?:scaled|large|small|medium|thumb|full|orig(?:inal)?)$/, '');
  return file;
}

/** 한쪽 이름이 다른 쪽 이름의 꼬리인 경우(크기 접두사 차이)도 같은 사진으로 본다. */
function sameImage(a, b) {
  if (a === b) return true;
  if (a.length < 8 || b.length < 8) return false;
  return a.endsWith(b) || b.endsWith(a);
}

/** 주소에 박힌 크기로 작은 이미지를 걸러낸다. 카드 배경은 최소 700px 은 되어야 한다. */
function looksTooSmall(url) {
  const sized = /[-_](\d{2,4})x(\d{2,4})(?=\.\w+$)/.exec(url);
  if (sized) {
    const width = Number(sized[1]);
    const height = Number(sized[2]);
    if (width < 700 || height < 400) return true;
  }
  // 쿼리스트링으로 크기를 주는 CDN
  const qw = /[?&](?:w|width)=(\d{2,4})/.exec(url);
  if (qw && Number(qw[1]) < 700) return true;
  return false;
}

/**
 * 기사 본문에 들어 있는 사진을 전부 모은다.
 *
 * 한 사건을 여러 장으로 풀어내려면 사진이 여러 장 필요한데, 대표 이미지(og:image)
 * 하나로는 부족하다. 기사 본문에는 보통 사진이 여러 장 들어 있으므로 그쪽을 쓴다.
 */
function bodyImages(html, pageUrl) {
  const found = [];
  const seen = new Set();

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];

    // 지연 로딩 때문에 실제 주소가 data-src 쪽에 있는 경우가 많다.
    const srcMatch =
      /(?:data-src|data-lazy-src|data-original)=["']([^"']+)["']/i.exec(tag) ??
      /\bsrc=["']([^"']+)["']/i.exec(tag);
    if (!srcMatch) continue;

    let url = decodeUrl(srcMatch[1]);
    if (url.startsWith('data:')) continue;

    // srcset 이 있으면 가장 큰 후보를 쓴다.
    const srcset = /srcset=["']([^"']+)["']/i.exec(tag);
    if (srcset) {
      const best = srcset[1]
        .split(',')
        .map((part) => {
          const [candidate, size] = part.trim().split(/\s+/);
          return { url: candidate, width: parseInt(size ?? '0', 10) || 0 };
        })
        .sort((a, b) => b.width - a.width)[0];
      if (best?.url) url = decodeUrl(best.url);
    }

    if (JUNK_IMAGE.test(url) || looksTooSmall(url)) continue;

    // 태그에 크기가 적혀 있으면 그것도 본다.
    const width = parseInt(/\bwidth=["']?(\d+)/i.exec(tag)?.[1] ?? '0', 10);
    const height = parseInt(/\bheight=["']?(\d+)/i.exec(tag)?.[1] ?? '0', 10);
    if ((width && width < 600) || (height && height < 340)) continue;

    try {
      url = new URL(url, pageUrl).href;
    } catch {
      continue;
    }
    if (!isImageUrl(url)) continue; // 추적 픽셀·비콘 제외

    const key = imageKey(url);
    if ([...seen].some((existing) => sameImage(existing, key))) continue;
    seen.add(key);

    found.push(url);
    if (found.length >= 8) break;
  }

  return found;
}

/** 여러 곳에서 모은 이미지 목록에서 중복(같은 사진의 다른 크기)을 걷어낸다. */
function dedupeImages(urls) {
  const keys = [];
  const out = [];
  for (const url of urls.filter(Boolean)) {
    if (!isImageUrl(url)) continue;
    const key = imageKey(url);
    if (keys.some((existing) => sameImage(existing, key))) continue;
    keys.push(key);
    out.push(url);
  }
  return out;
}

/** 페이지 <head> 의 대표 이미지 태그를 순서대로 찾는다. */
function ogImage(html, pageUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      const raw = decodeUrl(match[1]);
      try {
        return new URL(raw, pageUrl).href; // 상대 경로 대비
      } catch {
        return raw;
      }
    }
  }
  return '';
}

/**
 * 기사 본문과 대표 이미지를 긁어온다. 실패해도 조용히 넘어간다 —
 * 있으면 좋은 재료일 뿐, 없다고 카드뉴스를 못 만드는 건 아니다.
 */
async function extractArticle(url) {
  try {
    const res = await fetchWithRetry(
      url,
      { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' },
      { retries: 1 },
    );
    if (!res.ok) return { text: '', image: '', images: [] };
    const html = await res.text();

    const pageUrl = res.url || url;
    const image = ogImage(html, pageUrl);

    // 대표 이미지를 맨 앞에 두고, 본문 사진을 뒤에 붙인다.
    const images = dedupeImages([image, ...bodyImages(html, pageUrl)]);

    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');

    // <article> 안쪽이 있으면 그쪽만 본다.
    const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned);
    const scope = article ? article[1] : cleaned;

    // 메뉴·구독 안내 같은 조각이 <p> 로 섞여 들어온다. 문장처럼 생긴 것만 남긴다.
    const junk =
      /skip to content|subscribers only|story text|sign in|newsletter|cookie|advertisement|저작권|무단전재/i;

    const paragraphs = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => stripHtml(m[1]))
      .filter((t) => t.length > 80 && /[.!?。]|다\.|요\./.test(t) && !junk.test(t));

    return { text: paragraphs.join(' ').slice(0, 4000), image, images };
  } catch {
    return { text: '', image: '', images: [] };
  }
}

/* ── 같은 사건을 다룬 기사 묶기 ──────────────────────────────
   카드뉴스 한 편은 사건 하나를 다루는 게 좋다. 그러려면 같은 사건을
   보도한 여러 매체 기사를 모아야 사진도 여러 장 나오고 내용도 두꺼워진다.
   ─────────────────────────────────────────────────────────── */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
  'has', 'have', 'had', 'will', 'says', 'say', 'said', 'new', 'more', 'after', 'over',
  'you', 'your', 'how', 'why', 'what', 'can', 'could', 'not', 'now', 'about', 'into',
  '그리고', '하지만', '이번', '올해', '지난', '위해', '통해', '대한', '있다', '했다', '한다', '까지', '에서',
]);

function tokenize(title = '') {
  return new Set(
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size); // 제목 길이 차이에 덜 민감하게
}

/**
 * 제목이 비슷한 기사끼리 묶는다. 큰 묶음 = 여러 매체가 다룬 큰 사건.
 * @returns {Array<{key:string, size:number, publishers:string[], indexes:number[]}>}
 */
function clusterArticles(articles, threshold = 0.42) {
  const tokens = articles.map((a) => tokenize(a.title));
  const groups = [];

  articles.forEach((article, i) => {
    const hit = groups.find((g) => g.members.some((j) => similarity(tokens[i], tokens[j]) >= threshold));
    if (hit) hit.members.push(i);
    else groups.push({ members: [i] });
  });

  return groups
    .map((g) => ({
      // 가장 많이 겹치는 단어들을 묶음 이름으로 쓴다.
      key: [...g.members.reduce((acc, j) => {
        for (const t of tokens[j]) acc.set(t, (acc.get(t) ?? 0) + 1);
        return acc;
      }, new Map())]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
        .map(([word]) => word)
        .join(' '),
      size: g.members.length,
      publishers: [...new Set(g.members.map((j) => articles[j].publisher))],
      images: g.members.filter((j) => articles[j].image).length,
      indexes: g.members,
    }))
    .sort((a, b) => b.size - a.size || b.images - a.images);
}

/** 동시 요청 수를 제한하며 순회한다. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs();

  // 프리셋을 먼저 깔고, 명령줄 인자로 덮어쓴다.
  let preset = null;
  if (typeof args.preset === 'string') {
    const all = await readJson(path.join(ROOT, 'config', 'presets.json'));
    preset = all[args.preset];
    if (!preset) {
      const names = Object.keys(all).filter((k) => !k.startsWith('_'));
      fail(`프리셋 '${args.preset}' 이 없습니다. 사용 가능: ${names.join(', ')}`);
    }
    log(`프리셋 '${args.preset}' (${preset.label}) 적용`);
  }

  const query =
    typeof args.query === 'string' ? args.query.trim() : (preset?.query ?? '');
  const feeds =
    typeof args.feeds === 'string'
      ? args.feeds.split(',').map((f) => f.trim()).filter(Boolean)
      : (preset?.feeds ?? []);

  if (!query && feeds.length === 0) {
    fail(
      '--query, --feeds, --preset 중 하나는 있어야 합니다.\n' +
        '예) --query "AI OR 반도체" --lang ko --region KR\n' +
        '예) --preset tech',
    );
  }

  const lang = typeof args.lang === 'string' ? args.lang : (preset?.lang ?? 'ko');
  const region = typeof args.region === 'string' ? args.region : (preset?.region ?? 'KR');
  const hours = Number(args.hours ?? 24);
  const limit = Number(args.limit ?? 25);
  const exclude =
    typeof args.exclude === 'string'
      ? args.exclude.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
      : [];

  // --match: 한 사건만 모을 때 쓴다.
  // --query 는 구글 뉴스 검색에만 걸리므로, 매체 RSS 로 들어온 기사까지
  // 주제로 좁히려면 이 필터가 필요하다.
  const match =
    typeof args.match === 'string'
      ? args.match.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
      : [];

  const targets = [];
  if (query) targets.push({ url: googleNewsUrl(query, { lang, region, hours }), label: 'google' });
  for (const url of feeds) targets.push({ url, label: 'custom' });

  log(`뉴스 수집 중… (소스 ${targets.length}개)`);
  const results = await Promise.all(targets.map((t) => loadFeed(t.url, t.label)));

  const cutoff = Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3600_000 : null;
  const seen = new Set();
  const articles = [];

  for (const article of results.flat()) {
    if (!article.title || !article.link) continue;
    if (seen.has(article.fingerprint)) continue;

    // 직접 지정한 피드는 when: 필터가 안 걸리므로 여기서 한 번 더 거른다.
    if (cutoff && article.publishedAt && new Date(article.publishedAt).getTime() < cutoff) continue;

    const haystack = `${article.title} ${article.summary}`.toLowerCase();
    if (exclude.some((word) => haystack.includes(word))) continue;
    if (match.length && !match.some((word) => haystack.includes(word))) continue;

    seen.add(article.fingerprint);
    articles.push(article);
  }

  // 최신순. 날짜 없는 건 뒤로.
  articles.sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bt - at;
  });

  // 자르기 전에 추출한다. 먼저 자르면 구글 뉴스 기사가 앞자리를 차지해
  // 사진이 붙는 실제 매체 기사가 후보에서 밀려난다.
  const candidates = articles.slice(0, limit * 2);

  // --full: 본문·대표 이미지를 추가로 긁는다. 구글 뉴스 링크는 JS 리다이렉트라
  // 아무것도 안 나오므로 건너뛴다 (--feeds/--preset 의 실제 매체 링크만 대상).
  if (args.full) {
    const targets = candidates.filter((a) => !a.link.includes('news.google.com')).slice(0, 24);
    if (targets.length === 0) {
      log('! --full 은 실제 매체 RSS 에만 적용됩니다. --preset 또는 --feeds 를 같이 쓰세요.');
    } else {
      log(`본문·이미지 추출 중… (${targets.length}건)`);
      await mapLimit(targets, 6, async (article) => {
        const { text, image, images } = await extractArticle(article.link);
        if (text) article.fullText = text;
        if (image && !article.image) article.image = image;
        if (images?.length) {
          // 피드에서 받은 이미지가 있으면 맨 앞에 유지한다.
          article.images = dedupeImages([article.image, ...images]);
        }
      });
      const gotText = targets.filter((a) => a.fullText).length;
      const gotImage = targets.filter((a) => a.image).length;
      const totalImages = targets.reduce((sum, a) => sum + (a.images?.length ?? (a.image ? 1 : 0)), 0);
      log(`  ✔ 본문 ${gotText}/${targets.length}건 · 대표사진 ${gotImage}건 · 총 사진 ${totalImages}장`);
    }
  }

  // 사진 없는 카드는 자동 생성 티가 확 난다. 사진 있는 기사를 앞으로 올린다.
  // (안정 정렬이라 같은 그룹 안에서는 최신순이 유지된다.)
  if (args['prefer-images']) {
    candidates.sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));
  }

  const selected = candidates.slice(0, limit);

  const payload = {
    query: query || null,
    preset: typeof args.preset === 'string' ? args.preset : null,
    feeds,
    lang,
    region,
    hours,
    fetchedAt: new Date().toISOString(),
    count: selected.length,
    articles: selected,
  };

  // --cluster: 같은 사건을 다룬 기사끼리 묶어 준다.
  // 카드뉴스 한 편은 사건 하나를 깊게 다루는 게 좋으므로, 큰 묶음을 고르면 된다.
  if (args.cluster) {
    payload.clusters = clusterArticles(selected);
    const multi = payload.clusters.filter((c) => c.size > 1);
    log(`\n주제 묶음 ${payload.clusters.length}개 (2건 이상: ${multi.length}개)`);
    for (const c of payload.clusters.slice(0, 8)) {
      log(`  [${c.size}건 · 사진 ${c.images}장] ${c.key}`);
      log(`      ${c.indexes.map((i) => `#${i}`).join(' ')}  ${c.publishers.join(', ')}`);
    }
  }

  if (typeof args.out === 'string') {
    await writeJson(args.out, payload);
    log(`✔ 기사 ${payload.count}건 → ${args.out}`);
  }

  process.stdout.write(JSON.stringify(payload, null, 2));

  if (payload.count === 0) {
    log('\n! 기사가 0건입니다. --hours 를 늘리거나 키워드를 넓혀 보세요.');
  }
}

main().catch((err) => fail(err.stack || err.message));
