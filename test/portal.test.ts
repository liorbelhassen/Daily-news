import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { categories, type Article } from '../shared/model.js';
import { applyVote, fillEdition, newReader, populateCategory, resetPreferences, undoVote } from '../server/board.js';
import { articleId, canonicalUrl, eventTerms, matchesArticle, normalize, storyId } from '../server/classification.js';
import { demoArticles } from '../server/demo.js';
import { distinctStories, importEdition } from '../server/ingest.js';
import { createRefresher } from '../server/refresh.js';
import { Store } from '../server/store.js';

const now = Date.now();
const edition = { id: 'sample', at: new Date(now).toISOString() };

function story(name: string, category: Article['category'], topics: string[], source = 'Example Publisher'): Article {
  const url = `https://example.com/${encodeURIComponent(name)}`;
  return { id: articleId(url), eventId: name, category, url, canonicalUrl: url, title: name, titleHe: `כתבה על ${name}`,
    publishedAt: edition.at, source, region: category === 'discover' ? 'עולם' : 'קליפורניה', topics };
}

test('plus prefers its subtopic and minus never recycles an already shown topic', () => {
  const before = story('before', 'market', ['גיוסי AI', 'גיוסים']);
  const related = story('another fundraising', 'market', ['גיוסי AI', 'גיוסים']);
  const different = story('different', 'market', ['רכישות']);
  const elsewhere = story('elsewhere', 'chips', ['מעבדים']);
  const catalog = [before, related, different, elsewhere];
  const reader = newReader();
  reader.slots = [{ id: 'market-slot', categoryId: 'market', discovery: false, articleId: before.id }];
  reader.seen = [before.eventId];
  assert.equal(applyVote(reader, 'market-slot', before.id, 1, catalog, catalog, now), true);
  assert.equal(reader.slots[0].articleId, related.id);
  assert.equal(applyVote(reader, 'market-slot', before.id, 1, catalog, catalog, now), false);
  assert.equal(reader.weights['גיוסי AI'], 1);
  assert.equal(applyVote(reader, 'market-slot', related.id, -1, catalog, catalog, now), true);
  assert.equal(reader.slots[0].articleId, different.id);
  assert.equal(reader.slots[0].categoryId, 'market');
  assert.equal(applyVote(reader, 'market-slot', different.id, -1, catalog, catalog, now), true);
  assert.equal(reader.slots[0].articleId, different.id);
  assert.equal(reader.slots[0].categoryId, 'market');
  assert.equal(undoVote(reader), true);
  assert.equal(reader.slots[0].articleId, different.id);
  assert.equal(reader.slots[0].id, 'market-slot');
  assert.ok(reader.seen.includes(before.eventId));
  assert.equal(applyVote(reader, 'market-slot', different.id, 1, catalog, catalog, now), true);
  assert.equal(reader.slots[0].articleId, different.id);
  resetPreferences(reader);
  assert.deepEqual(reader.weights, {});
  assert.equal(reader.seen.length, 3);
});

test('personal queries match bilingual synonyms in the geographic scope, and plus stays in the selected category', () => {
  const first = story('robot assisted surgery', 'market', ['גיוסים']);
  const next = story('a surgical robot', 'market', ['רובוטיקה רפואית']);
  const alternate = story('a new surgical robot', 'ai', ['רובוטיקה רפואית']);
  const outOfScope = { ...story('medical robotics in Munich', 'market', ['רובוטיקה רפואית']), region: 'גרמניה' };
  const unrelated = story('unrelated fundraise', 'market', ['גיוסים']);
  const catalog = [first, unrelated, next, alternate, outOfScope];
  const reader = newReader();
  reader.custom = [{ id: 'custom', label: 'רובוטיקה רפואית', color: 'custom-0' },
    { id: 'unmatched', label: 'צלילה באיסלנד', color: 'custom-1' }];
  reader.slots = [{ id: 'story-slot', categoryId: 'market', discovery: false, articleId: first.id }];
  reader.seen = [first.eventId];
  assert.equal(normalize('  Surgical   ROBOTICS '), 'surgical robotics');
  assert.equal(matchesArticle('surgical robotics', first), true);
  assert.equal(matchesArticle('רובוטיקה רפואית', outOfScope), false);
  populateCategory(reader, 'custom', catalog, now);
  populateCategory(reader, 'unmatched', catalog, now);
  assert.equal(reader.slots.length, 2);
  const personal = reader.slots.find(slot => slot.categoryId === 'custom')!;
  assert.equal(personal.articleId, next.id);
  assert.equal(applyVote(reader, personal.id, next.id, 1, catalog, catalog, now), true);
  assert.equal(personal.articleId, alternate.id);
  assert.equal(personal.categoryId, 'custom');
});

test('consecutive votes on different cards never resurface a story, even after the demo catalog runs out', () => {
  const catalog = demoArticles(now);
  const reader = newReader();
  fillEdition(reader, catalog, edition, () => 0);
  assert.equal(reader.slots.length, 30);
  for (const category of categories) {
    assert.equal(reader.slots.filter(slot => slot.categoryId === category.id).length, 6);
  }
  const slotIds = reader.slots.map(slot => slot.id);
  const slotCount = slotIds.length;
  const byId = new Map(catalog.map(article => [article.id, article]));
  let replacements = 0;
  for (let index = 0; index < 240; index++) {
    // Vote on adjacent cards in the same category before moving to the next page.
    const position = (index + 12) % slotCount;
    const slot = reader.slots[position];
    const previous = slot.articleId;
    const otherIds = reader.slots.filter(other => other !== slot).map(other => other.articleId);
    const seen = new Set(reader.seen);
    const direction = Math.floor(index / slotCount) % 2 ? -1 : 1;
    assert.equal(applyVote(reader, slot.id, previous!, direction, catalog, catalog, now, () => 0.4), true);
    assert.ok(slot.articleId);
    if (index < 2) assert.notEqual(slot.articleId, previous);
    if (slot.articleId !== previous) {
      assert.ok(!seen.has(byId.get(slot.articleId)!.eventId));
      replacements++;
    }
    const visible = reader.slots.filter(other => other.categoryId === slot.categoryId);
    assert.equal(new Set(visible.map(other => byId.get(other.articleId!)!.eventId)).size, 6);
    assert.equal(byId.get(slot.articleId)!.category, slot.categoryId);
    assert.deepEqual(reader.slots.map(other => other.id), slotIds);
    assert.deepEqual(reader.slots.filter(other => other !== slot).map(other => other.articleId), otherIds);
  }
  assert.equal(replacements, catalog.length - slotCount);
});

test('minus uses an unseen same-topic story over a seen event with another headline', () => {
  const current = story('current model', 'ai', ['מודלים']);
  const previouslyShown = story('older product', 'ai', ['מוצרים']);
  const duplicate = { ...story('older product covered elsewhere', 'ai', ['מוצרים']), eventId: previouslyShown.eventId };
  const newStory = story('unseen model', 'ai', ['מודלים']);
  const reader = newReader();
  reader.slots = [{ id: 'model-slot', categoryId: 'ai', discovery: false, articleId: current.id }];
  reader.seen = [current.eventId, previouslyShown.eventId];
  const catalog = [current, duplicate, newStory];
  assert.ok(applyVote(reader, 'model-slot', current.id, -1, catalog, catalog, now));
  assert.equal(reader.slots[0].articleId, newStory.id);
});

test('full editions reserve alternates, recover older sections, and keep a sole article visible if inventory is exhausted', () => {
  const reader = newReader();
  const oldDate = new Date(now - 30 * 86400_000).toISOString();
  const first = story('first chip', 'chips', ['מעבדים']);
  const archive = { ...story('older chip', 'chips', ['מעבדים']), publishedAt: oldDate };
  const ai = { ...story('lone archived model', 'ai', ['מודלים']), publishedAt: oldDate };
  const catalog = [first, archive, ai];
  fillEdition(reader, catalog, edition, () => 0, [first]);
  assert.deepEqual(reader.slots.map(slot => slot.categoryId), ['ai', 'chips']);
  const [aiSlot, chipSlot] = reader.slots;
  assert.equal(aiSlot.articleId, ai.id);
  assert.equal(chipSlot.articleId, first.id);
  assert.equal(applyVote(reader, chipSlot.id, first.id, -1, catalog, [first], now), true);
  assert.equal(chipSlot.articleId, archive.id);
  assert.equal(applyVote(reader, aiSlot.id, ai.id, 1, catalog, [first], now), true);
  assert.equal(aiSlot.articleId, ai.id);
  assert.equal(reader.slots.length, 2);
});

test('exactly six matching stories fill the page even when there is no spare', () => {
  const reader = newReader();
  const catalog = Array.from({ length: 6 }, (_, i) => story(`model ${i}`, 'ai', ['מודלים']));
  fillEdition(reader, catalog, edition);
  assert.equal(reader.slots.length, 6);
  const [slot] = reader.slots;
  const original = slot.articleId;
  assert.equal(applyVote(reader, slot.id, original!, 1, catalog, catalog, now), true);
  assert.equal(slot.articleId, original);
  const stored = [...catalog, story('standby model', 'ai', ['מודלים'])];
  assert.equal(applyVote(reader, slot.id, original!, -1, stored, stored, now), true);
  assert.equal(slot.articleId, stored[6].id);
  assert.equal(reader.slots.length, 6);
});

test('a personal category uses the full matching catalog and keeps its cards on topic', () => {
  const reader = newReader();
  const matching = Array.from({ length: 20 }, (_, i) =>
    story(`surgical robot ${i}`, i % 2 ? 'market' : 'ai', ['רובוטיקה רפואית']));
  const unrelated = Array.from({ length: 6 }, (_, i) => story(`company acquisition ${i}`, 'market', ['רכישות']));
  const catalog = [...matching, ...unrelated];
  reader.custom.push({ id: 'custom', label: 'רובוטיקה רפואית', color: 'custom-0' });
  fillEdition(reader, catalog, edition, () => 0);
  const personal = reader.slots.filter(slot => slot.categoryId === 'custom');
  const builtIn = reader.slots.filter(slot => slot.categoryId !== 'custom').map(slot => slot.articleId);
  const [slot] = personal;
  const original = slot.articleId;
  assert.equal(applyVote(reader, slot.id, original!, -1, catalog, catalog, now), true);
  assert.notEqual(slot.articleId, original);
  assert.equal(new Set(personal.map(item => item.articleId)).size, 6);
  assert.ok(personal.every(item => matching.some(article => article.id === item.articleId)));
  assert.deepEqual(reader.slots.filter(item => item.categoryId !== 'custom').map(item => item.articleId), builtIn);
});

test('undo restores the voted category slot without touching a newly created personal page', () => {
  const reader = newReader();
  const initial = story('robot assisted surgery', 'market', ['רובוטיקה רפואית']);
  const replacement = story('company acquisition', 'market', ['רכישות']);
  const newMatch = story('new surgical robot', 'market', ['רובוטיקה רפואית']);
  const catalog = [initial, replacement];
  fillEdition(reader, catalog, edition);
  const [slot] = reader.slots;
  assert.equal(applyVote(reader, slot.id, initial.id, 1, catalog, catalog, now), true);
  reader.custom.push({ id: 'custom', label: 'רובוטיקה רפואית', color: 'custom-0' });
  populateCategory(reader, 'custom', [...catalog, newMatch], now);
  const personal = reader.slots.find(item => item.categoryId === 'custom')!;
  assert.equal(personal.articleId, newMatch.id);
  assert.ok(undoVote(reader));
  assert.equal(reader.slots.length, 2);
  assert.equal(reader.slots[0].articleId, initial.id);
  assert.equal(reader.slots[1], personal);
});

test('after 20 votes in one field, discovery keeps its six cards and rotates across domains and sources', () => {
  const normal = Array.from({ length: 60 }, (_, i) => story(`model ${i}`, 'ai', ['מודלים']));
  const domains = ['חלל', 'אקלים', 'אנרגיה', 'תרבות', 'מדע', 'טכנולוגיה שימושית'];
  const discovery = Array.from({ length: 40 }, (_, i) =>
    story(`discovery ${i}`, 'discover', [domains[Math.floor(i / 2) % domains.length]], `Publisher ${i % 5}`));
  const catalog = [...normal, ...discovery];
  const reader = newReader();
  const deterministic = () => 0.42;
  fillEdition(reader, catalog, edition, deterministic);
  assert.equal(reader.slots.length, 12);
  assert.equal(reader.slots.filter(slot => slot.discovery).length, 6);
  const regular = reader.slots.find(slot => !slot.discovery)!;
  const slotIds = reader.slots.map(slot => slot.id);
  const initialDiscovery = reader.slots.filter(slot => slot.discovery).map(slot => slot.articleId);
  for (let i = 0; i < 20; i++) assert.equal(applyVote(reader, regular.id, regular.articleId!, 1, catalog, catalog, now, deterministic), true);
  assert.equal(reader.weights['מודלים'], 20);
  assert.deepEqual(reader.slots.filter(slot => slot.discovery).map(slot => slot.articleId), initialDiscovery);
  const nextReaderEdition = { id: 'next', at: edition.at };
  fillEdition(reader, catalog, nextReaderEdition, deterministic);
  assert.equal(reader.slots.filter(slot => slot.discovery).length, 6);
  const fixed = reader.slots.find(slot => slot.discovery)!;
  assert.ok(fixed.articleId);
  assert.deepEqual(reader.slots.map(slot => slot.id), slotIds);
  const exposures = new Set<string>();
  const sources = new Set<string>();
  for (let i = 0; i < 20; i++) {
    assert.equal(applyVote(reader, fixed.id, fixed.articleId!, 1, catalog, catalog, now, deterministic), true);
    assert.equal(fixed.categoryId, 'discover');
    const article = discovery.find(item => item.id === fixed.articleId)!;
    assert.ok(article);
    exposures.add(article.topics[0]);
    sources.add(article.source);
  }
  assert.ok(exposures.size >= 5, [...exposures].join(', '));
  assert.ok(sources.size >= 3, [...sources].join(', '));
  assert.equal(new Set(reader.seen).size, reader.seen.length);
});

test('canonical URLs and cross-publisher headlines are deduplicated; a new material phase can appear', () => {
  const canonical = canonicalUrl('https://www.example.com/news/?utm_source=test&edition=us#header');
  assert.equal(canonical, 'https://example.com/news?edition=us');
  const fromTitle = (title: string) => {
    const terms = eventTerms(title);
    return { ...story(title, 'policy', ['רגולציה']), eventTerms: terms, eventId: storyId(terms) };
  };
  const filing = fromTitle('New York files lawsuit against Acme over chatbot privacy');
  const variation = fromTitle('Acme chatbot privacy lawsuit filed by New York');
  const settlement = fromTitle('New York settles Acme chatbot privacy lawsuit');
  const gpt = fromTitle('OpenAI introduces GPT-4.5 to ChatGPT users');
  const laterGpt = fromTitle('OpenAI introduces GPT-4.6 to ChatGPT users');
  assert.deepEqual(distinctStories([filing, variation, settlement, gpt, laterGpt], []), [filing, settlement, gpt, laterGpt]);
});

test('SQLite persists isolated readers, personal categories, idempotency keys and undo across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-news-store-'));
  let db = new Store(join(dir, 'test.sqlite'));
  try {
    db.saveEdition(edition, demoArticles(now));
    const readerId = randomUUID();
    const other = randomUUID();
    const original = db.board(readerId, 'demo', 'idle');
    const ai = original.slots.find(slot => slot.categoryId === 'ai')!;
    const requestId = randomUUID();
    const vote = db.board(readerId, 'demo', 'idle', requestId, (reader, catalog, fresh) => {
      applyVote(reader, ai.id, ai.articleId!, 1, catalog, fresh, now);
      reader.custom.push({ id: 'saved', label: 'Robotics', color: 'custom-0' });
    });
    assert.notEqual(vote.slots.find(slot => slot.id === ai.id)?.articleId, ai.articleId);
    db.close();
    db = new Store(join(dir, 'test.sqlite'));
    const reloaded = db.board(readerId, 'demo', 'idle', requestId, () => assert.fail('replayed request'));
    assert.deepEqual(reloaded, vote);
    assert.equal(db.board(other, 'demo', 'idle').hasPreferences, false);
    assert.equal(db.board(other, 'demo', 'idle').categories.some(category => category.id === 'saved'), false);
    const undone = db.board(readerId, 'demo', 'idle', randomUUID(), reader => { assert.ok(undoVote(reader)); });
    assert.equal(undone.slots.find(slot => slot.id === ai.id)?.articleId, ai.articleId);
    assert.equal(undone.canUndo, false);
    const votedAgain = db.board(readerId, 'demo', 'idle', randomUUID(), (reader, catalog, fresh) => {
      assert.ok(applyVote(reader, ai.id, ai.articleId!, 1, catalog, fresh, now));
    });
    const nextArticle = votedAgain.slots.find(slot => slot.id === ai.id)?.articleId;
    assert.notEqual(nextArticle, ai.articleId);
    assert.notEqual(nextArticle, vote.slots.find(slot => slot.id === ai.id)?.articleId);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trusted structured editions require explicit verification for alternate Hebrew links and popularity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-news-import-'));
  const file = join(dir, 'edition.json');
  const first = story('first', 'market', ['גיוסים']);
  const second = story('second', 'market', ['תעסוקה']);
  try {
    writeFileSync(file, JSON.stringify([
      { ...first, heUrl: 'https://example.com/he/a', popularity: 10 },
      { ...second, heUrl: 'https://example.com/he/b', heVerified: true, popularity: 10, popularityVerified: true },
    ]));
    const [a, b] = await importEdition(file, now);
    assert.equal(a.heUrl, undefined);
    assert.equal(a.popularity, undefined);
    assert.equal(b.heUrl, 'https://example.com/he/b');
    assert.equal(b.popularity, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a vote arriving during a scheduled refresh finishes in the still-visible edition', () => {
  const db = new Store(':memory:');
  try {
    const user = randomUUID();
    const first = story('first model', 'ai', ['מודלים']);
    const next = story('second model', 'ai', ['מודלים']);
    const reserve = story('model reserve', 'ai', ['מודלים']);
    const standby = story('model standby', 'ai', ['מודלים']);
    db.saveEdition(edition, [first]);
    const before = db.board(user, 'live', 'idle');
    const slot = before.slots[0];
    const secondEdition = { id: 'next edition', at: edition.at };
    db.saveEdition(secondEdition, [next, reserve, standby]);
    const voted = db.board(user, 'live', 'idle', randomUUID(), (reader, catalog, fresh) => {
      assert.equal(applyVote(reader, slot.id, slot.articleId!, 1, catalog, fresh, now), true);
    });
    assert.equal(voted.edition?.id, edition.id);
    assert.equal(voted.slots[0].id, slot.id);
    assert.equal(voted.slots[0].articleId, next.id);
    const refreshed = db.board(user, 'live', 'idle');
    assert.equal(refreshed.edition?.id, secondEdition.id);
    assert.deepEqual(refreshed.slots.map(item => item.articleId), [next.id, reserve.id]);
    assert.equal(refreshed.slots[0].id, slot.id);
  } finally {
    db.close();
  }
});

test('upgrading an existing reader refills exhausted slots and keeps saved preferences and categories', () => {
  const db = new Store(':memory:');
  try {
    const readerId = randomUUID();
    db.saveEdition(edition, demoArticles(now));
    db.board(readerId, 'demo', 'idle', randomUUID(), reader => {
      reader.layoutVersion = 1;
      reader.slots = reader.slots.filter((slot, index) => index % 6 === 0);
      const catalog = demoArticles(now);
      reader.seen = reader.slots.map(slot => catalog.find(article => article.id === slot.articleId)!.eventId);
      reader.weights['חלל'] = 2;
      reader.custom.push({ id: 'test-robotics', label: 'רובוטיקה רפואית', color: 'custom-0' });
    });
    const recovered = db.board(readerId, 'demo', 'idle');
    const builtIn = recovered.slots.filter(slot => categories.some(category => category.id === slot.categoryId));
    assert.equal(builtIn.length, 30);
    assert.ok(builtIn.every(slot => slot.article));
    assert.ok(recovered.hasPreferences);
    assert.ok(recovered.categories.some(category => category.id === 'test-robotics'));
  } finally {
    db.close();
  }
});

test('RSS refresh translates headlines, scopes by region and retains the last edition on source failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-news-feed-'));
  const file = join(dir, 'sources.json');
  const db = new Store(':memory:');
  let broken = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const titles = JSON.parse(body.messages[1].content);
      assert.equal(titles.length, 1);
      assert.equal(titles[0].title, 'Brooklyn startup raises funding to build robots');
      assert.equal(request.headers.authorization, 'Bearer mock-key');
      const content = JSON.stringify({ [titles[0].id]: 'סטארטאפ מברוקלין מגייס הון לפיתוח רובוטים' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    } else if (request.url === '/main' && !broken) {
      const item = (title: string, slug: string) => `<item><title>${title}</title>
        <link>https://publisher.example/${slug}</link><pubDate>${new Date(now).toUTCString()}</pubDate>
        <description>This feed synopsis is not stored with the article.</description></item>`;
      response.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fake feed</title>
        ${item('Brooklyn startup raises funding to build robots', 'brooklyn')}
        ${item('Berlin startup raises funding to build robots', 'berlin')}</channel></rss>`);
    } else {
      response.statusCode = 503;
      response.end('Temporarily unavailable');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  writeFileSync(file, JSON.stringify([{ name: 'Test Feed', url: `${url}/main` }, { name: 'Broken Feed', url: `${url}/broken` }]));
  const refresh = createRefresher(db, { SOURCES_FILE: file, TRANSLATION_BASE_URL: `${url}/v1`,
    TRANSLATION_API_KEY: 'mock-key', TRANSLATION_MODEL: 'test' });
  try {
    await refresh.run();
    assert.equal(refresh.status(), 'partial');
    assert.equal(db.catalog().length, 1);
    assert.equal(db.catalog()[0].region, 'מדינת ניו יורק');
    assert.equal(db.catalog()[0].titleHe, 'סטארטאפ מברוקלין מגייס הון לפיתוח רובוטים');
    assert.ok(!JSON.stringify(db.catalog()).includes('synopsis'));
    const successful = db.edition();
    assert.ok(successful);
    broken = true;
    await refresh.run();
    assert.deepEqual(db.edition(), successful);
    assert.equal(db.catalog().length, 1);
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
