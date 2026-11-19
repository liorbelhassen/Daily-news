import { randomUUID } from 'node:crypto';
import type { Article, Board } from '../shared/model.js';
import { normalize, sameStory } from './classification.js';
import { distinctStories, importEdition, isFresh, readSource, sourcesFrom, translateTitles, type Candidate } from './ingest.js';
import { searchPersonalNews } from './personal-news.js';
import type { Store } from './store.js';

export const TIME_ZONE = 'Asia/Jerusalem';
export const EDITION_SCHEDULE = '0 8,14,20 * * *';
const SEARCH_QUERY_LIMIT = 30;
const AUTOMATIC_SEARCH_INTERVAL = 60_000;

export function createRefresher(store: Store, env: NodeJS.ProcessEnv = process.env) {
  let status: Board['refresh'] = 'idle';
  let inFlight: Promise<void> | undefined;
  let targetedRun = false;
  let fullRefreshQueued = false;
  const searchEnabled = env.PERSONAL_NEWS_SEARCH !== 'off' &&
    (env.PERSONAL_NEWS_SEARCH === 'on' || !env.EDITION_FILE || Boolean(env.SOURCES_FILE));
  const queued = new Map<string, string>();
  let nextAutomaticSearch = 0;
  let timer: NodeJS.Timeout | undefined;
  let searchOffset = 0;

  async function collect(onlyQueries?: string[]) {
    status = 'running';
    const now = Date.now();
    const queries = onlyQueries ?? store.personalQueries();
    const existing = store.catalog();
    let failures = 0;
    const report = (source: string, error: unknown) => {
      failures++;
      console.warn(`Daily-news could not refresh ${source}:`, (error as Error).message);
    };

    const imported = !onlyQueries && env.EDITION_FILE ? await importEdition(env.EDITION_FILE, now).catch(error => {
      report('edition file', error);
      return [];
    }) : [];
    // An edition file can be the sole source. An explicit sources file combines it with RSS.
    const sources = onlyQueries || (env.EDITION_FILE && !env.SOURCES_FILE) ? [] : await sourcesFrom(env.SOURCES_FILE);
    const fetched = await Promise.all(sources.map(source => readSource(source, now, queries).catch(error => {
      report(source.name, error);
      return { scanned: 0, candidates: [] as Candidate[] };
    })));
    const raw = fetched.flatMap(result => result.candidates);
    const labels = searchEnabled ? [...new Map(queries.map(label => [normalize(label), label])).values()] : [];
    const offset = onlyQueries ? 0 : searchOffset % (labels.length || 1);
    const selected = [...labels.slice(offset), ...labels.slice(0, offset)].slice(0, SEARCH_QUERY_LIMIT);
    if (!onlyQueries) searchOffset = offset + selected.length;
    const personalResults: Candidate[] = [];
    for (let index = 0; index < selected.length; index += 4) {
      const batch = selected.slice(index, index + 4);
      personalResults.push(...(await Promise.all(batch.map(async label => {
        queued.delete(normalize(label));
        return searchPersonalNews(label, now).catch(error => {
          report('personal news search', error);
          return [];
        });
      }))).flat());
    }
    const byId = new Map(raw.map(article => [article.id, article]));
    const importedById = new Map(imported.map(article => [article.id, article]));
    const searchById = new Map(personalResults.map(article => [article.id, article]));
    const verified = existing.filter(article => article.publicationDateVerified);
    const legacy = new Set(existing.filter(article => !article.publicationDateVerified));
    const updates = new Map<string, Article>();
    for (const article of existing) {
      const observed = byId.get(article.id);
      const confirmed = importedById.get(article.id) ?? observed ?? searchById.get(article.id);
      const keywords = [...new Set([...(article.keywords ?? []), ...(observed?.keywords ?? [])])];
      if (article.personalOnly) {
        const standard = importedById.get(article.id) ?? observed ??
          [...imported, ...raw].find(candidate => sameStory(article, candidate));
        if (standard) {
          const updated: Article = { ...article, category: standard.category, region: standard.region,
            topics: standard.topics, keywords, personalOnly: undefined };
          if (standard.id !== article.id) updated.alternateIds = [...new Set([...(article.alternateIds ?? []), standard.id])];
          if (standard.eventId !== article.eventId) {
            updated.alternateEventIds = [...new Set([...(article.alternateEventIds ?? []), standard.eventId])];
          }
          Object.assign(article, updated);
          updates.set(article.id, article);
          continue;
        }
      }
      if (legacy.has(article) && confirmed) {
        const corrected: Article = { ...article, keywords, publishedAt: confirmed.publishedAt, publicationDateVerified: true };
        if (!verified.some(other => sameStory(corrected, other))) {
          updates.set(article.id, corrected);
          verified.push(corrected);
          legacy.delete(article);
          continue;
        }
      }
      if (keywords.length > (article.keywords?.length ?? 0)) {
        article.keywords = keywords;
        updates.set(article.id, article);
      }
    }
    const importedNew = distinctStories(imported, verified);
    const fresh = distinctStories(raw, [...verified, ...importedNew]).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const verifiedById = new Map(verified.map(article => [article.id, article]));
    const retained: Candidate[] = [...verified, ...importedNew, ...fresh];
    const superseded = new Set<string>();
    const personal: Candidate[] = [];
    for (const result of personalResults) {
      const matches = retained.filter(article => sameStory(result, article));
      const recent = matches.filter(article => isFresh(Date.parse(article.publishedAt), now));
      const match = recent.find(article => verifiedById.has(article.id) && !article.personalOnly) ??
        recent.find(article => verifiedById.has(article.id)) ?? recent[0];
      if (!match) {
        // Preserve prior exposure history if a different publisher offers a fresh copy.
        if (matches.some(article => article.id === result.id || article.eventId === result.eventId)) continue;
        mergeSearchMetadata(result, matches);
        retained.push(result);
        personal.push(result);
      } else {
        const duplicates = recent.filter(article => article !== match && article.personalOnly);
        for (const duplicate of duplicates) {
          superseded.add(duplicate.id);
          retained.splice(retained.indexOf(duplicate), 1);
        }
        const saved = verifiedById.get(match.id);
        if (mergeSearchMetadata(match, [result, ...duplicates]) && saved) updates.set(saved.id, saved);
      }
    }
    // Start with candidates from each configured publisher before filling the rest of the batch.
    const represented = [...new Set(fresh.map(article => article.source))].flatMap(source =>
      fresh.filter(article => article.source === source).slice(0, 3));
    const personalFirst = selected.flatMap(label =>
      personal.filter(article => article.personalQueries?.includes(normalize(label))).slice(0, 3));
    const pending = [...new Set([...represented, ...personalFirst, ...fresh, ...personal])]
      .filter(article => !superseded.has(article.id)).slice(0, 96);
    const translator = env.TRANSLATION_BASE_URL && env.TRANSLATION_MODEL
      ? { url: env.TRANSLATION_BASE_URL, model: env.TRANSLATION_MODEL, apiKey: env.TRANSLATION_API_KEY }
      : undefined;
    let translated: Article[] = [];
    for (let index = 0; index < pending.length; index += 12) {
      const batch = pending.slice(index, index + 12);
      try {
        translated.push(...await translateTitles(batch, translator));
      } catch (error) {
        report('Hebrew headline translator', error);
        translated.push(...await translateTitles(batch));
        // Keep already completed batches. Retry the rest at the next scheduled refresh.
        break;
      }
    }
    if (translated.length < pending.length && failures === 0) report('headline translation',
      new Error('Configure TRANSLATION_BASE_URL and TRANSLATION_MODEL or provide verified Hebrew headlines.'));
    // Retain both publishers' identifiers when verified coverage takes over a legacy event.
    const unconfirmed = [...legacy];
    const legacyEvents = new Map(unconfirmed.map(article => [article.eventId, article]));
    const articles = [...importedNew, ...translated].map(article => {
      const previous = legacyEvents.get(article.eventId) ?? unconfirmed.find(other => sameStory(article, other));
      if (!previous) return article;
      return {
        ...article,
        eventId: previous.eventId,
        alternateIds: [...new Set([...(previous.alternateIds ?? []), previous.id, ...(article.alternateIds ?? [])])],
        alternateEventIds: [...new Set([...(previous.alternateEventIds ?? []), article.eventId, ...(article.alternateEventIds ?? [])])],
      };
    });
    const changes = store.saveEdition({ id: randomUUID(), at: new Date(now).toISOString() },
      articles, [...updates.values()], superseded);
    status = failures ? (store.edition() ? 'partial' : 'error') : 'idle';
    console.info(`Daily-news refresh: ${sources.length} RSS feeds, ${selected.length} news searches, ${changes} records saved.`);
  }

  function start(onlyQueries?: string[]) {
    targetedRun = Boolean(onlyQueries);
    inFlight = collect(onlyQueries).catch(error => {
      status = store.edition() ? 'partial' : 'error';
      console.warn('Daily-news refresh failed:', (error as Error).message);
    }).finally(() => {
      inFlight = undefined;
      if (fullRefreshQueued) {
        fullRefreshQueued = false;
        return start();
      }
      schedulePersonal();
    });
    return inFlight;
  }

  function schedulePersonal() {
    if (inFlight || timer || !queued.size) return;
    const delay = nextAutomaticSearch - Date.now();
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        schedulePersonal();
      }, delay).unref();
      return;
    }
    nextAutomaticSearch = Date.now() + AUTOMATIC_SEARCH_INTERVAL;
    void start([...queued.values()].slice(0, SEARCH_QUERY_LIMIT));
  }

  function queuePersonal(label: string) {
    if (!searchEnabled) return;
    queued.set(normalize(label), label);
    schedulePersonal();
  }

  function run() {
    if (!inFlight) return start();
    if (targetedRun) fullRefreshQueued = true;
    return inFlight;
  }

  return { run, queuePersonal, status: () => status };
}

function mergeSearchMetadata(article: Candidate, matches: Candidate[]) {
  const related = [article, ...matches];
  const personalQueries = [...new Set(related.flatMap(item => item.personalQueries ?? []))];
  const alternateIds = [...new Set(related.flatMap(item => [item.id, ...(item.alternateIds ?? [])]))]
    .filter(id => id !== article.id);
  const alternateEventIds = [...new Set(related.flatMap(item => [item.eventId, ...(item.alternateEventIds ?? [])]))]
    .filter(id => id !== article.eventId);
  if (personalQueries.length === (article.personalQueries?.length ?? 0) &&
    alternateIds.length === (article.alternateIds?.length ?? 0) &&
    alternateEventIds.length === (article.alternateEventIds?.length ?? 0)) return false;
  Object.assign(article, { personalQueries, alternateIds, alternateEventIds });
  return true;
}
