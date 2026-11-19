import { randomUUID } from 'node:crypto';
import { categories, type Article, type Category, type Slot } from '../shared/model.js';
import { matchesArticle } from './classification.js';

type Vote = {
  slot: Slot;
  topic: string;
  previousWeight: number;
};
export type Reader = {
  editionId: string | null;
  slots: Slot[];
  custom: Category[];
  seen: string[];
  weights: Record<string, number>;
  discoveryTopics: Record<string, number>;
  discoverySources: Record<string, number>;
  discoveryRecent: string[];
  lastVote: Vote | null;
};

export const newReader = (): Reader => ({
  editionId: null, slots: [], custom: [], seen: [], weights: {},
  discoveryTopics: {}, discoverySources: {}, discoveryRecent: [], lastVote: null,
});

type Edition = { id: string; at: string };
const DAY = 86_400_000;
const HOME_LIMIT = 20;

export function categoryIncludes(id: string, article: Article, reader: Reader) {
  const personal = reader.custom.find(category => category.id === id);
  return personal ? matchesArticle(personal.label, article) : article.category === id;
}

function withoutSeen(reader: Reader, catalog: Article[]) {
  const seen = new Set(reader.seen);
  return catalog.filter(article => !seen.has(article.eventId));
}

function remember(reader: Reader, article: Article) {
  reader.seen.push(article.eventId);
  if (article.category !== 'discover') return;
  reader.discoveryTopics[article.topics[0]] = (reader.discoveryTopics[article.topics[0]] ?? 0) + 1;
  reader.discoverySources[article.source] = (reader.discoverySources[article.source] ?? 0) + 1;
  reader.discoveryRecent = [...reader.discoveryRecent.slice(-1), article.topics[0]];
}

function freshness(article: Article, now: number) {
  return Math.exp(-Math.max(0, now - Date.parse(article.publishedAt)) / (4 * DAY));
}

const affinity = (reader: Reader, article: Article) => Math.max(-12, Math.min(12, reader.weights[article.topics[0]] ?? 0));

function bestNormal(reader: Reader, catalog: Article[], now: number, similar?: Article) {
  const score = (article: Article) => {
    let relation = 0;
    if (similar) {
      if (article.topics[0] === similar.topics[0]) relation = 100;
      else if (article.topics.some(topic => similar.topics.includes(topic))) relation = 50;
    }
    return relation + 3 * freshness(article, now) + 0.45 * affinity(reader, article) +
      Math.min(1, Math.log1p(article.popularity ?? 0) / 10);
  };
  return catalog.reduce<Article | undefined>((best, item) => !best || score(item) > score(best) ? item : best, undefined);
}

function pickDiscovery(reader: Reader, choices: Article[], now: number, random: () => number, similar?: Article) {
  if (!choices.length) return undefined;
  const domain = similar?.topics[0];
  const last = reader.discoveryRecent;
  const rotating = last.length === 2 && last[0] === last[1]
    ? choices.filter(article => article.topics[0] !== last[1]) : [];
  const related = domain ? choices.filter(article => article.topics.includes(domain)) : [];
  const pool = rotating.length ? rotating : related.length ? related : choices;
  const counts = pool.map(article => (reader.discoveryTopics[article.topics[0]] ?? 0));
  const minimum = Math.min(...counts);
  const weights = pool.map((article, index) => (0.3 + freshness(article, now)) *
    (article.topics[0] === last.at(-1) ? 0.4 : 1) /
    (1 + 2 * (counts[index] - minimum)) /
    (1 + 0.3 * (reader.discoverySources[article.source] ?? 0)));
  let pick = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (const [i, article] of pool.entries()) {
    pick -= weights[i];
    if (pick <= 0) return article;
  }
  return pool.at(-1);
}

function show(reader: Reader, slot: Slot, article: Article | undefined) {
  slot.articleId = article?.id ?? null;
  if (article) remember(reader, article);
}

function newSlot(reader: Reader, categoryId: string, article: Article, filteredOnly = false) {
  const slot: Slot = { id: randomUUID(), categoryId, discovery: categoryId === 'discover', articleId: null, filteredOnly };
  show(reader, slot, article);
  return slot;
}

function assignCategory(reader: Reader, article: Article) {
  return reader.custom.find(category => categoryIncludes(category.id, article, reader))?.id ?? article.category;
}

export function fillEdition(
  reader: Reader, catalog: Article[], edition: Edition, demo: boolean, random = Math.random,
) {
  if (reader.editionId === edition.id) return;
  const available = withoutSeen(reader, catalog);
  if (!available.length && reader.editionId) return;
  reader.editionId = edition.id;
  reader.lastVote = null;
  const now = Date.parse(edition.at);
  const normal = available.filter(article => article.category !== 'discover');
  const discovery = available.filter(article => article.category === 'discover');
  const normalCount = Math.min(demo ? 4 : (discovery.length ? 16 : HOME_LIMIT), normal.length);
  const discoveryCount = Math.min(discovery.length, Math.max(1, Math.round(normalCount / 4)));
  const selected: Slot[] = [];
  const preferred = [...categories.filter(category => category.id !== 'discover').map(category => category.id),
    ...reader.custom.map(category => category.id)];
  for (let i = 0; i < normalCount; i++) {
    const preferredCategory = preferred[i % preferred.length];
    const candidates = normal.filter(article => categoryIncludes(preferredCategory, article, reader));
    const article = bestNormal(reader, candidates.length ? candidates : normal, now)!;
    const categoryId = assignCategory(reader, article);
    selected.push(newSlot(reader, categoryId, article));
    normal.splice(normal.indexOf(article), 1);
  }
  for (let i = 0; i < discoveryCount; i++) {
    const article = pickDiscovery(reader, discovery, now, random)!;
    selected.splice(i * 5, 0, newSlot(reader, 'discover', article));
    discovery.splice(discovery.indexOf(article), 1);
  }
  reader.slots = selected;
  for (const category of reader.custom) populateCategory(reader, category.id, catalog, now);
}

export function populateCategory(reader: Reader, categoryId: string, catalog: Article[], now: number) {
  if (reader.slots.some(slot => slot.categoryId === categoryId && slot.articleId)) return;
  const articlesById = new Map(catalog.map(article => [article.id, article]));
  const existing = reader.slots.find(slot => {
    if (!slot.articleId || !categories.some(category => category.id === slot.categoryId)) return false;
    const article = articlesById.get(slot.articleId);
    return article && categoryIncludes(categoryId, article, reader);
  });
  if (existing) {
    existing.categoryId = categoryId;
    return;
  }
  const candidate = bestNormal(reader, withoutSeen(reader, catalog)
    .filter(item => categoryIncludes(categoryId, item, reader)), now);
  if (!candidate) return;
  const placeholder = reader.slots.find(slot => slot.categoryId === categoryId && !slot.articleId);
  if (placeholder) show(reader, placeholder, candidate);
  else reader.slots.push(newSlot(reader, categoryId, candidate, true));
}

export function applyVote(
  reader: Reader, slotId: string, expectedArticleId: string, vote: 1 | -1,
  stored: Article[], fresh: Article[], now: number, random = Math.random,
) {
  const slot = reader.slots.find(item => item.id === slotId && item.articleId === expectedArticleId);
  const current = stored.find(article => article.id === expectedArticleId);
  if (!slot || !current) return false;
  const topic = current.topics[0];
  const previousWeight = reader.weights[topic] ?? 0;
  reader.lastVote = { slot: { ...slot }, topic, previousWeight };
  reader.weights[topic] = previousWeight + vote;

  const unseen = withoutSeen(reader, fresh).filter(article =>
    (article.category === 'discover') === slot.discovery && (vote === 1 || article.topics[0] !== topic));
  const within = unseen.filter(article => categoryIncludes(slot.categoryId, article, reader));
  const replacement = slot.discovery
    ? pickDiscovery(reader, within, now, random, vote === 1 ? current : undefined)
    : bestNormal(reader, within.length || vote === 1 ? within : unseen, now, vote === 1 ? current : undefined);
  if (replacement && !slot.discovery && !within.includes(replacement)) {
    slot.previousCategoryIds = [...new Set([...(slot.previousCategoryIds ?? []), slot.categoryId])];
    slot.categoryId = assignCategory(reader, replacement);
  }
  show(reader, slot, replacement);
  return true;
}

export function undoVote(reader: Reader) {
  const previous = reader.lastVote;
  if (!previous) return false;
  const slot = reader.slots.find(item => item.id === previous.slot.id);
  if (!slot) return false;
  reader.slots[reader.slots.indexOf(slot)] = previous.slot;
  if (previous.previousWeight) reader.weights[previous.topic] = previous.previousWeight;
  else delete reader.weights[previous.topic];
  reader.lastVote = null;
  return true;
}

export function resetPreferences(reader: Reader) {
  reader.weights = {};
  reader.discoveryTopics = {};
  reader.discoverySources = {};
  reader.discoveryRecent = [];
  reader.lastVote = null;
}
