import { randomUUID } from 'node:crypto';
import type { Article, Board } from '../shared/model.js';
import { sameStory } from './classification.js';
import { distinctStories, importEdition, readSource, sourcesFrom, translateTitles, type Candidate } from './ingest.js';
import type { Store } from './store.js';

export const TIME_ZONE = 'Asia/Jerusalem';
export const EDITION_SCHEDULE = '0 8,14,20 * * *';

export function createRefresher(store: Store, env: NodeJS.ProcessEnv = process.env) {
  let status: Board['refresh'] = 'idle';
  let inFlight: Promise<void> | undefined;

  async function collect() {
    status = 'running';
    const now = Date.now();
    const queries = store.personalQueries();
    const existing = store.catalog();
    let failures = 0;
    const report = (source: string, error: unknown) => {
      failures++;
      console.warn(`Daily-news could not refresh ${source}:`, (error as Error).message);
    };

    const imported = env.EDITION_FILE ? await importEdition(env.EDITION_FILE, now).catch(error => {
      report('edition file', error);
      return [];
    }) : [];
    // An edition file can be the sole source. An explicit sources file combines it with RSS.
    const sources = env.EDITION_FILE && !env.SOURCES_FILE ? [] : await sourcesFrom(env.SOURCES_FILE);
    const fetched = await Promise.all(sources.map(source => readSource(source, now, queries).catch(error => {
      report(source.name, error);
      return { scanned: 0, candidates: [] as Candidate[] };
    })));
    const raw = fetched.flatMap(result => result.candidates);
    const byId = new Map(raw.map(article => [article.id, article]));
    const importedById = new Map(imported.map(article => [article.id, article]));
    const verified = existing.filter(article => article.publicationDateVerified);
    const legacy = new Set(existing.filter(article => !article.publicationDateVerified));
    const updates: Article[] = [];
    for (const article of existing) {
      const observed = byId.get(article.id);
      const confirmed = importedById.get(article.id) ?? observed;
      const keywords = [...new Set([...(article.keywords ?? []), ...(observed?.keywords ?? [])])];
      if (legacy.has(article) && confirmed) {
        const corrected: Article = { ...article, keywords, publishedAt: confirmed.publishedAt, publicationDateVerified: true };
        if (!verified.some(other => sameStory(corrected, other))) {
          updates.push(corrected);
          verified.push(corrected);
          legacy.delete(article);
          continue;
        }
      }
      if (keywords.length > (article.keywords?.length ?? 0)) updates.push({ ...article, keywords });
    }
    const importedNew = distinctStories(imported, verified);
    const fresh = distinctStories(raw, [...verified, ...importedNew]).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    // Start with candidates from each configured publisher before filling the rest of the batch.
    const represented = [...new Set(fresh.map(article => article.source))].flatMap(source =>
      fresh.filter(article => article.source === source).slice(0, 3));
    const pending = [...new Set([...represented, ...fresh])].slice(0, 96);
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
    // A new source can supply verified coverage for a legacy event. Reuse its history key.
    const legacyEvents = new Set([...legacy].map(article => article.eventId));
    const articles = [...importedNew, ...translated].map(article => {
      if (legacyEvents.has(article.eventId)) return article;
      for (const other of legacy) {
        if (sameStory(article, other)) return { ...article, eventId: other.eventId };
      }
      return article;
    });
    const changes = store.saveEdition({ id: randomUUID(), at: new Date(now).toISOString() }, articles, updates);
    status = failures ? (store.edition() ? 'partial' : 'error') : 'idle';
    console.info(`Daily-news refresh: ${sources.length} RSS feeds, ${fresh.length} new candidates, ${changes} records saved.`);
  }

  function run() {
    if (!inFlight) inFlight = collect().catch(error => {
      status = store.edition() ? 'partial' : 'error';
      console.warn('Daily-news refresh failed:', (error as Error).message);
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  return { run, status: () => status };
}
