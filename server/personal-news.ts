import { articleId, canonicalUrl, classify, englishTopic, eventTerms, matchesPhrase, matchesQuery, normalize,
  plain, regionOf, storyId } from './classification.js';
import { isFresh, readFeed, type Candidate } from './ingest.js';

const profiles = [
  {
    labels: ['כלכלת אירופה', 'כלכלה אירופית', 'כלכלת גוש האירו', 'European economy', 'EU economy', 'eurozone economy'],
    english: ['eurozone economy', 'Europe economy GDP inflation trade ECB'],
    region: 'אירופה',
    signals: [
      ['אירופה', 'אירופית', 'גוש האירו', 'האיחוד האירופי', 'europe', 'european', 'eu', 'eurozone', 'euro zone'],
      ['כלכלה', 'כלכלת', 'כלכלית', 'תמ ג', 'צמיחה', 'אינפלציה', 'ריבית', 'כלכלי', 'בורסות', 'סחר',
        'economy', 'economic', 'gdp', 'growth', 'inflation', 'interest rate', 'trade', 'bond yields', 'output', 'public finances'],
    ],
  },
  {
    labels: ['הייטק ישראלי', 'היי טק ישראלי', 'טכנולוגיה ישראלית', 'Israeli high tech', 'Israeli technology', 'Israeli startups'],
    english: ['Israeli startups'],
    region: 'ישראל',
    signals: [
      ['ישראל', 'ישראלי', 'ישראלית', 'ישראליות', 'ישראלים', 'תל אביב', 'israel', 'israeli', 'tel aviv'],
      ['הייטק', 'היי טק', 'סטארטאפ', 'סטארטאפיסט', 'סטארט אפ', 'הזנק', 'שבבים', 'חברות תוכנה',
        'startup', 'start up', 'high tech', 'hi tech', 'technology', 'deep tech', 'venture capital', 'chipmaking'],
    ],
  },
];

function publisherLink(link: string) {
  try {
    const url = new URL(link);
    if (url.hostname !== 'www.bing.com' && url.hostname !== 'bing.com') return url.href;
    return url.pathname === '/news/apiclick.aspx' ? url.searchParams.get('url') : null;
  } catch {
    return null;
  }
}

function relatedEvents(title: string, summary: string, published: number) {
  const ids: string[] = [];
  const amount = title.match(/\$\s*([\d.]+)\s*(m(?:illion)?|b(?:illion)?)\b/i);
  const month = new Date(published).toISOString().slice(0, 7);
  if (amount && /\b(?:raises?|raised|secures?|secured|funding|fundraise|seed)\b/i.test(title)) {
    // The subject of a funding headline may be named only in the search snippet.
    const named = title.match(/\b([A-Z][\w-]+(?: [A-Z][\w-]+){0,2}) (?:raises?|raised|secures?|secured)\b/)?.[1];
    const snippet = summary.match(/(?:^|[,.]\s+)([A-Z][\w-]+(?: [A-Z][\w-]+){0,2}) (?:is|has|raises?|raised|develops?|builds?|secured)\b/)?.[1];
    const company = snippet && (!named || snippet.startsWith(named + ' ')) ? snippet : named;
    if (company) {
      ids.push(storyId(['funding round', normalize(company), amount[1], amount[2].toLowerCase()[0], month]));
    }
  }
  const headline = normalize(title);
  const description = normalize(summary);
  if (/\b(?:eu|euro zone|eurozone|european union)\b/.test(headline) &&
    /\b(?:european commission|eu raises|brussels raises|outlook commission)\b/.test(`${headline} ${description}`) &&
    /\b(?:forecasts?|outlook|growth)\b/.test(headline)) {
    // The Commission issues macroeconomic forecast releases a few times per year.
    ids.push(storyId(['european commission economic forecast', month]));
  }
  return ids;
}

export async function searchPersonalNews(label: string, now: number): Promise<Candidate[]> {
  const query = normalize(label);
  const profile = profiles.find(item => item.labels.some(alias => normalize(alias) === query));
  const alternate = /[א-ת]/.test(label) ? englishTopic(label) : undefined;
  const alternatives = profile?.english ?? (alternate ? [alternate] : []);
  const terms = [label, ...alternatives.filter(term => normalize(term) !== query)];
  const results = await Promise.allSettled(terms.map(async term => {
    const url = new URL('https://www.bing.com/news/search');
    url.search = new URLSearchParams({ q: term, format: 'rss', mkt: /[א-ת]/.test(term) ? 'he-IL' : 'en-GB',
      qft: 'interval="8"' }).toString();
    const feed = await readFeed(url.href);
    return feed.items.slice(0, 18).flatMap((item): Candidate[] => {
      const title = plain(item.title ?? '').slice(0, 360);
      const summary = plain(item.contentSnippet ?? '').slice(0, 450);
      const link = publisherLink(item.link ?? '');
      const canonical = link && canonicalUrl(link);
      // Search results carry RSS pubDate. A syndication copy may not have the publisher's date or URL.
      const published = Date.parse(item.pubDate ?? '');
      if (!link || !canonical || !title || !isFresh(published, now)) return [];
      const hostname = new URL(canonical).hostname;
      const publisher = plain(item.publisher ?? '').slice(0, 120);
      if (hostname === 'msn.com' || / on (?:MSN|Yahoo|AOL)$/i.test(publisher)) return [];
      const subject = `${title} ${summary}`;
      if (!matchesQuery(label, subject) &&
        !profile?.signals.every(aliases => aliases.some(alias => matchesPhrase(subject, alias)))) return [];
      const classification = classify(title, summary, undefined, true)!;
      const event = eventTerms(title);
      return [{
        ...classification, id: articleId(canonical), eventId: storyId(event), eventTerms: event,
        title, url: new URL(link).href, canonicalUrl: canonical, source: publisher || hostname,
        region: profile?.region ?? regionOf(title, summary) ?? 'עולם',
        publishedAt: new Date(published).toISOString(), publicationDateVerified: true,
        personalOnly: true, personalQueries: [query], alternateEventIds: relatedEvents(title, summary, published),
      }];
    });
  }));
  const answered = results.filter(result => result.status === 'fulfilled');
  if (!answered.length) throw new Error('News search is currently unavailable.');
  const byId = new Map(answered.flatMap(result => result.value).map(article => [article.id, article]));
  return [...byId.values()];
}
