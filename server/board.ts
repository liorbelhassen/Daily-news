import { randomUUID } from 'node:crypto';
import { categories, type Article, type Category, type Slot } from '../shared/model.js';
import { matchesArticle } from './classification.js';

type Vote = {
  slot: Slot;
  topic: string;
  previousWeight: number;
};
export type Reader = {
  layoutVersion?: number;
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
const CATEGORY_SIZE = 6;
export const LAYOUT_VERSION = 2;

export function categoryIncludes(id: string, article: Article, reader: Reader) {
  const personal = reader.custom.find(category => category.id === id);
  return personal ? matchesArticle(personal.label, article) : article.category === id;
}

function candidatePool(reader: Reader, choices: Article[], freshIds: Set<string>) {
  const history = new Map(reader.seen.map((event, index) => [event, index]));
  const unseen = choices.filter(article => !history.has(article.eventId));
  const recent = unseen.filter(article => freshIds.has(article.id));
  if (recent.length) return recent;
  if (unseen.length) return unseen;

  // Rank only the least recently displayed stories when the available list is exhausted.
  return [...choices].sort((a, b) => history.get(a.eventId)! - history.get(b.eventId)!)
    .slice(0, Math.ceil(choices.length / 2));
}

function remember(reader: Reader, article: Article) {
  const lastShown = reader.seen.indexOf(article.eventId);
  if (lastShown !== -1) reader.seen.splice(lastShown, 1);
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

function show(reader: Reader, slot: Slot, article: Article) {
  slot.articleId = article.id;
  remember(reader, article);
}

function newSlot(reader: Reader, categoryId: string, article: Article) {
  const slot: Slot = { id: randomUUID(), categoryId, discovery: categoryId === 'discover', articleId: null };
  show(reader, slot, article);
  return slot;
}

export function fillEdition(
  reader: Reader, catalog: Article[], edition: Edition, random = Math.random, fresh = catalog,
) {
  if (reader.editionId === edition.id && reader.layoutVersion === LAYOUT_VERSION) return;
  if (!catalog.length) return;
  reader.layoutVersion = LAYOUT_VERSION;
  reader.editionId = edition.id;
  reader.lastVote = null;
  reader.slots = [];
  const now = Date.parse(edition.at);
  for (const category of [...categories, ...reader.custom]) {
    populateCategory(reader, category.id, catalog, now, fresh, random);
  }
}

export function populateCategory(
  reader: Reader, categoryId: string, catalog: Article[], now: number, fresh = catalog, random = Math.random,
) {
  const available = catalog.filter(article => categoryIncludes(categoryId, article, reader));
  const freshIds = new Set(fresh.map(article => article.id));
  // Keep an alternate in smaller pools when possible, while showing all six if the page can be filled exactly.
  const reserve = available.length > 1 && available.length < CATEGORY_SIZE ? 1 : 0;
  const limit = Math.min(CATEGORY_SIZE, available.length - reserve);
  for (let i = 0; i < limit; i++) {
    const pool = candidatePool(reader, available, freshIds);
    const article = categoryId === 'discover'
      ? pickDiscovery(reader, pool, now, random)!
      : bestNormal(reader, pool, now)!;
    reader.slots.push(newSlot(reader, categoryId, article));
    available.splice(available.indexOf(article), 1);
  }
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

  const shown = new Set(reader.slots.filter(item => item.categoryId === slot.categoryId).map(item => item.articleId));
  const choices = stored.filter(article => !shown.has(article.id) && categoryIncludes(slot.categoryId, article, reader));
  const different = vote === -1 ? choices.filter(article => article.topics[0] !== topic) : [];
  const pool = candidatePool(reader, different.length ? different : choices, new Set(fresh.map(article => article.id)));
  const similar = vote === 1 ? current : undefined;
  const replacement = slot.discovery ? pickDiscovery(reader, pool, now, random, similar) : bestNormal(reader, pool, now, similar);
  if (replacement) show(reader, slot, replacement);
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
