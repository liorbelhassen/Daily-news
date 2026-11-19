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
import { distinctStories, importEdition, readSource } from '../server/ingest.js';
import { searchPersonalNews } from '../server/personal-news.js';
import { createRefresher } from '../server/refresh.js';
import { Store } from '../server/store.js';

const now = Date.now();
const edition = { id: 'sample', at: new Date(now).toISOString() };

function story(name: string, category: Article['category'], topics: string[], source = 'Example Publisher'): Article {
  const url = `https://example.com/${encodeURIComponent(name)}`;
  return { id: articleId(url), eventId: name, category, url, canonicalUrl: url, title: name, titleHe: `כתבה על ${name}`,
    publishedAt: edition.at, publicationDateVerified: true, source, region: category === 'discover' ? 'עולם' : 'קליפורניה', topics };
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
  assert.equal(applyVote(reader, 'market-slot', before.id, 1, catalog, now), true);
  assert.equal(reader.slots[0].articleId, related.id);
  assert.equal(applyVote(reader, 'market-slot', before.id, 1, catalog, now), false);
  assert.equal(reader.weights['גיוסי AI'], 1);
  assert.equal(applyVote(reader, 'market-slot', related.id, -1, catalog, now), true);
  assert.equal(reader.slots[0].articleId, different.id);
  assert.equal(reader.slots[0].categoryId, 'market');
  assert.equal(applyVote(reader, 'market-slot', different.id, -1, catalog, now), true);
  assert.equal(reader.slots[0].articleId, different.id);
  assert.equal(reader.slots[0].categoryId, 'market');
  assert.equal(undoVote(reader, catalog), true);
  assert.equal(reader.slots[0].articleId, different.id);
  assert.equal(reader.slots[0].id, 'market-slot');
  assert.ok(reader.seen.includes(before.eventId));
  assert.equal(applyVote(reader, 'market-slot', different.id, 1, catalog, now), true);
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
  assert.equal(applyVote(reader, personal.id, next.id, 1, catalog, now), true);
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
    assert.equal(applyVote(reader, slot.id, previous!, direction, catalog, now, () => 0.4), true);
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
  assert.ok(applyVote(reader, 'model-slot', current.id, -1, catalog, now));
  assert.equal(reader.slots[0].articleId, newStory.id);
});

test('full editions reserve alternates and keep a sole article visible if inventory is exhausted', () => {
  const reader = newReader();
  const first = story('first chip', 'chips', ['מעבדים']);
  const alternate = { ...story('another chip', 'chips', ['מעבדים']), publishedAt: new Date(now - 1000).toISOString() };
  const ai = story('lone model', 'ai', ['מודלים']);
  const catalog = [first, alternate, ai];
  fillEdition(reader, catalog, edition, () => 0);
  assert.deepEqual(reader.slots.map(slot => slot.categoryId), ['ai', 'chips']);
  const [aiSlot, chipSlot] = reader.slots;
  assert.equal(aiSlot.articleId, ai.id);
  assert.equal(chipSlot.articleId, first.id);
  assert.equal(applyVote(reader, chipSlot.id, first.id, -1, catalog, now), true);
  assert.equal(chipSlot.articleId, alternate.id);
  assert.equal(applyVote(reader, aiSlot.id, ai.id, 1, catalog, now), true);
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
  assert.equal(applyVote(reader, slot.id, original!, 1, catalog, now), true);
  assert.equal(slot.articleId, original);
  const stored = [...catalog, story('standby model', 'ai', ['מודלים'])];
  assert.equal(applyVote(reader, slot.id, original!, -1, stored, now), true);
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
  assert.equal(applyVote(reader, slot.id, original!, -1, catalog, now), true);
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
  assert.equal(applyVote(reader, slot.id, initial.id, 1, catalog, now), true);
  reader.custom.push({ id: 'custom', label: 'רובוטיקה רפואית', color: 'custom-0' });
  populateCategory(reader, 'custom', [...catalog, newMatch], now);
  const personal = reader.slots.find(item => item.categoryId === 'custom')!;
  assert.equal(personal.articleId, newMatch.id);
  assert.ok(undoVote(reader, catalog));
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
  for (let i = 0; i < 20; i++) assert.equal(applyVote(reader, regular.id, regular.articleId!, 1, catalog, now, deterministic), true);
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
    assert.equal(applyVote(reader, fixed.id, fixed.articleId!, 1, catalog, now, deterministic), true);
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
    const vote = db.board(readerId, 'demo', 'idle', requestId, (reader, catalog) => {
      applyVote(reader, ai.id, ai.articleId!, 1, catalog, now);
      reader.custom.push({ id: 'saved', label: 'Robotics', color: 'custom-0' });
    });
    assert.notEqual(vote.slots.find(slot => slot.id === ai.id)?.articleId, ai.articleId);
    db.close();
    db = new Store(join(dir, 'test.sqlite'));
    const reloaded = db.board(readerId, 'demo', 'idle', requestId, () => assert.fail('replayed request'));
    assert.deepEqual(reloaded, vote);
    assert.equal(db.board(other, 'demo', 'idle').hasPreferences, false);
    assert.equal(db.board(other, 'demo', 'idle').categories.some(category => category.id === 'saved'), false);
    const undone = db.board(readerId, 'demo', 'idle', randomUUID(), (reader, catalog) => { assert.ok(undoVote(reader, catalog)); });
    assert.equal(undone.slots.find(slot => slot.id === ai.id)?.articleId, ai.articleId);
    assert.equal(undone.canUndo, false);
    const votedAgain = db.board(readerId, 'demo', 'idle', randomUUID(), (reader, catalog) => {
      assert.ok(applyVote(reader, ai.id, ai.articleId!, 1, catalog, now));
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

const WEEK = 7 * 86400_000;

test('structured imports use the same inclusive seven-day publication window in every section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-news-window-'));
  const file = join(dir, 'edition.json');
  try {
    const offsets = [-WEEK - 1, -WEEK, 0, 1];
    writeFileSync(file, JSON.stringify(categories.flatMap(({ id }) => offsets.map(offset => ({
      ...story(`${id}-${offset}`, id, ['חדשות']),
      publishedAt: new Date(now + offset).toISOString(),
    })))));
    const imported = await importEdition(file, now);
    for (const { id } of categories) {
      assert.deepEqual(imported.filter(article => article.category === id).map(article => article.publishedAt),
        [new Date(now - WEEK).toISOString(), edition.at]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Atom eligibility uses publication time and excludes entries with only an update date', async t => {
  const entry = (title: string, published?: number) => `<entry><title>${title}</title>
    <link href="https://publisher.example/${title}"/><updated>${edition.at}</updated>
    ${published === undefined ? '' : `<published>${new Date(published).toISOString()}</published>`}
    </entry>`;
  t.mock.method(globalThis, 'fetch', async () => new Response(`<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom"><title>Discovery Feed</title>
    ${entry('old', now - WEEK - 1)}
    ${entry('boundary', now - WEEK)}
    ${entry('updated-only')}
    ${entry('future', now + 1)}
    </feed>`));
  const result = await readSource({ name: 'Discovery feed', url: 'https://publisher.example/atom', category: 'discover' }, now);
  assert.deepEqual(result.candidates.map(article => article.title), ['boundary']);
});

test('legacy articles need a confirmed publication date before they can appear on the live board', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-news-publication-'));
  const file = join(dir, 'edition.json');
  const db = new Store(':memory:');
  try {
    const reader = randomUUID();
    const verified = story('verified story', 'discover', ['מדע']);
    const legacy = story('legacy story', 'ai', ['מודלים']);
    const updatedOnly = story('updated only', 'policy', ['רגולציה']);
    db.saveEdition(edition, [verified, ...[legacy, updatedOnly].map(article => ({
      ...article, publicationDateVerified: undefined,
    }))]);
    assert.deepEqual(db.board(reader, 'live', 'idle').slots.map(slot => slot.articleId), [verified.id]);
    const publishedAt = new Date(now - 2 * 86400_000).toISOString();
    writeFileSync(file, JSON.stringify([{ ...legacy, publishedAt }]));
    await createRefresher(db, { EDITION_FILE: file }).run();
    assert.deepEqual(db.board(reader, 'live', 'idle').slots.map(slot => [slot.articleId, slot.article?.publishedAt]), [
      [verified.id, verified.publishedAt], [legacy.id, publishedAt],
    ]);
    assert.equal(db.catalog().length, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verified coverage from another publisher replaces a legacy copy and keeps its exposure history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-news-coverage-'));
  const file = join(dir, 'edition.json');
  const db = new Store(':memory:');
  try {
    const legacy = { ...story('California adopts statewide privacy rules', 'policy', ['רגולציה']), publicationDateVerified: undefined };
    const coverage = story('California adopts new statewide privacy rules', 'policy', ['רגולציה'], 'Second Publisher');
    db.saveEdition(edition, [legacy]);
    const returning = randomUUID();
    assert.equal(db.board(returning, 'demo', 'idle').slots[0]?.articleId, legacy.id);

    writeFileSync(file, JSON.stringify([coverage]));
    await createRefresher(db, { EDITION_FILE: file }).run();
    assert.deepEqual(db.catalog().map(({ id, eventId }) => [id, eventId]), [[coverage.id, legacy.eventId]]);
    assert.equal(db.board(randomUUID(), 'live', 'idle').slots[0]?.articleId, coverage.id);
    assert.deepEqual(db.board(returning, 'live', 'idle').slots, []);

    // One feed reuses the second publisher's event ID. Another uses the old URL with a different headline.
    const sameEvent = {
      ...story('Consumer advocates welcome new protections', 'policy', ['רגולציה']),
      eventId: coverage.eventId,
    };
    const oldUrl = {
      ...story('What the state changes mean for consumers', 'policy', ['רגולציה']),
      url: legacy.url,
    };
    writeFileSync(file, JSON.stringify([sameEvent, oldUrl]));
    await createRefresher(db, { EDITION_FILE: file }).run();
    assert.deepEqual(db.catalog().map(article => article.id), [coverage.id]);
    assert.deepEqual(db.board(returning, 'live', 'idle').slots, []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate detection compares incoming headlines with corrected publication dates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-news-corrected-date-'));
  const file = join(dir, 'edition.json');
  const db = new Store(':memory:');
  try {
    const original = story('California publishes statewide safety rules for advanced models', 'policy', ['רגולציה']);
    const duplicate = story('California publishes safety rules for advanced AI models', 'policy', ['רגולציה'], 'Second Publisher');
    const legacy = { ...original, publicationDateVerified: undefined, publishedAt: new Date(now - 6 * 86400_000).toISOString() };
    db.saveEdition(edition, [legacy]);
    writeFileSync(file, JSON.stringify([duplicate, original]));
    await createRefresher(db, { EDITION_FILE: file }).run();
    assert.deepEqual(db.catalog().map(({ id, publishedAt }) => [id, publishedAt]), [[original.id, original.publishedAt]]);
    assert.equal(db.board(randomUUID(), 'live', 'idle').slots.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live reader loses expired cards without waiting for a new edition and cannot vote them back in', t => {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const db = new Store(':memory:');
  try {
    const user = randomUUID();
    const expiring = (name: string, category: Article['category']) => ({
      ...story(name, category, ['חדשות']),
      publishedAt: new Date(now - WEEK + 1_000).toISOString(),
    });
    const ai = expiring('expiring AI', 'ai');
    const discovery = expiring('expiring discovery', 'discover');
    const archive = { ...story('archived AI', 'ai', ['חדשות']), publishedAt: new Date(now - WEEK - 1).toISOString() };
    const future = { ...story('future AI', 'ai', ['חדשות']), publishedAt: new Date(now + 5_000).toISOString() };
    db.saveEdition(edition, [ai, discovery, archive, future]);
    const before = db.board(user, 'live', 'idle');
    assert.deepEqual(before.slots.map(slot => slot.articleId), [discovery.id, ai.id]);
    const [discoverySlot, aiSlot] = before.slots;
    const nextAI = story('new AI', 'ai', ['חדשות']);
    const nextDiscovery = story('new discovery', 'discover', ['חדשות']);
    db.saveEdition({ id: 'next', at: edition.at }, [nextAI, nextDiscovery]);
    const voted = db.board(user, 'live', 'idle', randomUUID(), (reader, catalog) => {
      assert.ok(applyVote(reader, aiSlot.id, ai.id, 1, catalog, clock));
    });
    assert.equal(voted.slots.find(slot => slot.id === aiSlot.id)?.articleId, nextAI.id);
    assert.equal(voted.edition?.id, edition.id);
    clock += 1_001;
    const refreshed = db.board(user, 'live', 'idle', randomUUID(), (reader, catalog) => {
      assert.ok(reader.seen.includes(ai.eventId));
      assert.ok(reader.seen.includes(discovery.eventId));
      assert.equal(reader.weights['חדשות'], 1);
      assert.equal(applyVote(reader, discoverySlot.id, discovery.id, -1, catalog, clock), false);
      assert.ok(undoVote(reader, catalog));
    });
    assert.equal(refreshed.edition?.id, edition.id);
    assert.equal(refreshed.slots.find(slot => slot.id === discoverySlot.id)?.articleId, nextDiscovery.id);
    assert.equal(refreshed.slots.find(slot => slot.id === aiSlot.id)?.articleId, nextAI.id);
    assert.equal(refreshed.hasPreferences, false);
    clock = now + WEEK + 6_000;
    assert.deepEqual(db.board(user, 'live', 'idle').slots, []);
  } finally {
    db.close();
  }
});

test('undo restores a recent article after its voted-in replacement has expired', t => {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const db = new Store(':memory:');
  try {
    const user = randomUUID();
    const original = story('new chip', 'chips', ['מעבדים']);
    const replacement = { ...story('older chip', 'chips', ['מעבדים']), publishedAt: new Date(now - WEEK).toISOString() };
    db.saveEdition(edition, [original, replacement]);
    const [slot] = db.board(user, 'live', 'idle').slots;
    assert.equal(slot.articleId, original.id);
    const voted = db.board(user, 'live', 'idle', randomUUID(), (reader, catalog) => {
      assert.ok(applyVote(reader, slot.id, original.id, 1, catalog, clock));
    });
    assert.equal(voted.slots[0]?.articleId, replacement.id);
    clock++;
    assert.deepEqual(db.board(user, 'live', 'idle').slots, []);
    const undone = db.board(user, 'live', 'idle', randomUUID(), (reader, catalog) => {
      assert.ok(undoVote(reader, catalog));
    });
    assert.deepEqual(undone.slots.map(({ id, articleId }) => [id, articleId]), [[slot.id, original.id]]);
  } finally {
    db.close();
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
    const voted = db.board(user, 'live', 'idle', randomUUID(), (reader, catalog) => {
      assert.equal(applyVote(reader, slot.id, slot.articleId!, 1, catalog, now), true);
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

test('an arbitrary personal category searches by name, filters stale and unrelated news, and keeps its stories off built-in pages', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-news-personal-'));
  const file = join(dir, 'edition.json');
  const db = new Store(':memory:');
  const searches: string[] = [];
  const query = 'שוניות אלמוגים';
  const item = (title: string, path: string, date = now) => {
    const link = encodeURIComponent(`https://publisher.example/${path}`);
    return `<item><title>${title}</title><link>https://www.bing.com/news/apiclick.aspx?url=${link}</link>
      <pubDate>${new Date(date).toUTCString()}</pubDate><News:Source>המקור</News:Source></item>`;
  };
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'www.bing.com');
    searches.push(url.searchParams.get('q')!);
    return new Response(`<rss version="2.0" xmlns:News="https://www.bing.com"><channel><title>Test</title>
      ${item('שוניות אלמוגים משתקמות באוסטרליה', 'coral')}
      ${item('שוניות אלמוגים בקניה נזקקות להגנה', 'old', now - 8 * 86_400_000)}
      ${item('תחרות שחייה בקניה', 'irrelevant')}
      </channel></rss>`);
  });
  try {
    writeFileSync(file, '[]');
    const user = randomUUID();
    db.board(user, 'live', 'idle', randomUUID(), reader => {
      reader.custom.push({ id: 'coral', label: query, color: 'custom-0' });
    });
    const refresh = createRefresher(db, { EDITION_FILE: file, PERSONAL_NEWS_SEARCH: 'on' });
    refresh.queuePersonal(query);
    assert.equal(refresh.status(), 'running');
    // A full refresh requested during the targeted search runs as soon as that search ends.
    await refresh.run();
    assert.deepEqual(searches, [query, query]);
    const [article] = db.catalog();
    assert.equal(db.catalog().length, 1);
    assert.equal(article.url, 'https://publisher.example/coral');
    assert.equal(article.source, 'המקור');
    const personal = db.board(user, 'live', 'idle');
    assert.deepEqual(personal.slots.map(slot => slot.categoryId), ['coral']);
    assert.equal(personal.slots[0].article?.personalQueries, undefined);
    assert.deepEqual(db.board(randomUUID(), 'live', 'idle').slots, []);

    // If a configured source carries the same article, retain the original ID and exposure history.
    writeFileSync(file, JSON.stringify([{
      ...article, region: 'קליפורניה', category: 'market',
    }]));
    await refresh.run();
    assert.equal(db.catalog().length, 1);
    assert.equal(db.catalog()[0].id, article.id);
    assert.equal(db.catalog()[0].personalOnly, undefined);
    assert.deepEqual(db.board(randomUUID(), 'live', 'idle').slots.map(slot => slot.categoryId), ['market']);
    assert.deepEqual(db.board(user, 'live', 'idle').slots.map(slot => slot.categoryId), ['coral']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal search merges existing coverage of the same funding round and preserves both event IDs', async t => {
  const db = new Store(':memory:');
  const first = { ...story('Israeli startup raises $11 million Seed for AI security', 'market', ['גיוסים']),
    personalOnly: true as const, personalQueries: ['israeli startups'] };
  const second = { ...story('Israeli Startup Vero raises $11M to secure enterprise AI', 'market', ['גיוסים']),
    personalOnly: true as const, personalQueries: ['israeli technology'] };
  const item = (article: Article, summary: string) => `<item><title>${article.title}</title><description>${summary}</description>
    <link>${article.url}</link><pubDate>${new Date(now).toUTCString()}</pubDate></item>`;
  t.mock.method(globalThis, 'fetch', async () => new Response(
    `<rss version="2.0"><channel><title>Test</title>
      ${item(first, 'Vero Security is building a platform for enterprise security.')}
      ${item(second, 'Founded by two veterans, Vero Security develops technology to monitor AI tools.')}
    </channel></rss>`,
  ));
  try {
    db.saveEdition(edition, [first, second]);
    const user = randomUUID();
    db.board(user, 'live', 'idle', randomUUID(), reader => {
      reader.custom.push({ id: 'tech', label: 'Israeli startups', color: 'custom-0' });
      reader.seen.push(second.eventId);
    });
    const viewer = randomUUID();
    const before = db.board(viewer, 'live', 'idle', randomUUID(), (reader, catalog) => {
      reader.custom.push({ id: 'tech', label: 'Israeli technology', color: 'custom-0' });
      populateCategory(reader, 'tech', catalog, now);
    });
    assert.deepEqual(before.slots.map(slot => slot.articleId), [second.id]);
    const viewerOfBoth = randomUUID();
    const beforeBoth = db.board(viewerOfBoth, 'live', 'idle', randomUUID(), (reader, catalog) => {
      reader.custom.push({ id: 'tech', label: 'Israeli technology', color: 'custom-0' },
        { id: 'startups', label: 'Israeli startups', color: 'custom-1' });
      populateCategory(reader, 'tech', catalog, now);
      populateCategory(reader, 'startups', catalog, now);
    });
    assert.deepEqual(beforeBoth.slots.map(slot => slot.articleId), [second.id, first.id]);
    const refresh = createRefresher(db);
    refresh.queuePersonal('Israeli startups');
    while (refresh.status() === 'running') await new Promise(resolve => setImmediate(resolve));
    const [merged] = db.catalog();
    assert.equal(db.catalog().length, 1);
    assert.deepEqual(new Set(merged.personalQueries), new Set(['israeli startups', 'israeli technology']));
    assert.deepEqual(new Set([merged.eventId, ...(merged.alternateEventIds ?? [])].filter(id => [first.eventId, second.eventId].includes(id))),
      new Set([first.eventId, second.eventId]));
    assert.deepEqual(db.board(user, 'live', 'idle').slots, []);
    const after = db.board(viewer, 'live', 'idle');
    assert.deepEqual(after.slots.map(slot => [slot.id, slot.articleId]), [[before.slots[0].id, first.id]]);
    const afterBoth = db.board(viewerOfBoth, 'live', 'idle');
    assert.deepEqual(afterBoth.slots.map(slot => [slot.id, slot.articleId]), [[beforeBoth.slots[1].id, first.id]]);
  } finally {
    db.close();
  }
});

test('personal search keeps equal-sized funding rounds for different companies with a shared name prefix', async t => {
  const items = [
    ['Quantum Machines raises $50 million for Israeli chip control', 'Quantum Machines is expanding its chipmaking technology.'],
    ['Israeli startup Quantum Systems secures $50M to manufacture drone components', 'Quantum Systems has secured new financing.'],
  ];
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(`<rss version="2.0"><channel><title>Test</title>
      ${items.map(([title, summary], index) => `<item><title>${title}</title><description>${summary}</description>
      <link>https://publisher.example/${index}</link><pubDate>${new Date(now).toUTCString()}</pubDate></item>`).join('')}
      </channel></rss>`));
  const candidates = await searchPersonalNews('Israeli startups', now);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(article => article.alternateEventIds?.length === 1));
  assert.equal(distinctStories(candidates, []).length, 2);
});
