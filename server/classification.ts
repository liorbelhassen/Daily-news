import { createHash } from 'node:crypto';
import { decodeHTML } from 'entities';
import { standardRegions, type Article, type BuiltIn } from '../shared/model.js';

const lexicon = {
  'גיוסי AI': ['ai startup funding', 'ai funding', 'artificial intelligence funding', 'גיוסי בינה מלאכותית'],
  'גיוסים': ['funding', 'raises', 'raised', 'financing', 'series a', 'series b', 'series c', 'venture capital', 'גיוס', 'מימון'],
  'הנפקות': ['ipo', 'initial public offering', 'goes public', 'הנפקה'],
  'רכישות': ['acquisition', 'acquires', 'merger', 'to buy', 'רכישה', 'מיזוג'],
  'תעסוקה': ['layoffs', 'job cuts', 'new jobs', 'פיטורים', 'משרות'],
  'מודלים': ['large language model', 'llm', 'language model', 'ai model', 'gpt', 'claude', 'gemini', 'qwen', 'מודל שפה', 'מודלים'],
  'וידאו': ['video generation', 'text to video', 'יצירת וידאו', 'מחולל וידאו'],
  'מוצרי AI': ['ai assistant', 'ai agent', 'artificial intelligence', 'ai', 'בינה מלאכותית', 'סוכני בינה מלאכותית'],
  'רובוטיקה רפואית': ['medical robotics', 'medical robot', 'surgical robotics', 'surgical robot', 'robot assisted surgery', 'רובוט כירורגי', 'ניתוח רובוטי'],
  'סייבר לתשתיות קריטיות': ['critical infrastructure cybersecurity', 'critical infrastructure cyber', 'industrial cybersecurity', 'ics security', 'ot security', 'אבטחת מערכות תעשייתיות'],
  'מעבדים': ['gpu', 'processor', 'semiconductor', 'ai chip', 'ai chips', 'שבב', 'מעבד'],
  'ייצור שבבים': ['chip fabrication', 'chip manufacturing', 'semiconductor fab', 'foundry', 'מפעל שבבים', 'ייצור שבבים'],
  'מרכזי נתונים': ['data center', 'datacenter', 'data centre', 'מרכז נתונים', 'מרכזי נתונים'],
  'רגולציה': ['regulation', 'regulator', 'antitrust', 'legislation', 'governor', 'lawsuit', 'policy', 'רגולציה', 'חקיקה', 'הגבלים עסקיים'],
  'מגבלות יצוא': ['export controls', 'export restrictions', 'sanctions', 'trade restrictions', 'מגבלות יצוא', 'סנקציות'],
  'חלל': ['space', 'nasa', 'telescope', 'planet', 'exoplanet', 'astronomy', 'חלל', 'טלסקופ', 'אסטרונומיה'],
  'אקלים': ['climate', 'warming', 'ocean', 'emissions', 'אקלים', 'פליטות'],
  'אנרגיה': ['energy', 'battery', 'solar', 'wind power', 'electricity', 'אנרגיה', 'חשמל'],
  'תרבות': ['culture', 'art', 'museum', 'archaeology', 'תרבות', 'מוזיאון', 'אמנות'],
  'מדע': ['science', 'research', 'scientists', 'discovery', 'biology', 'physics', 'מדע', 'מחקר'],
  'טכנולוגיה שימושית': ['applied technology', 'assistive technology', 'how to', 'practical tech', 'טכנולוגיה שימושית'],
};

const categoryTopics = {
  policy: ['רגולציה', 'מגבלות יצוא'],
  market: ['גיוסים', 'גיוסי AI', 'הנפקות', 'רכישות', 'תעסוקה'],
  chips: ['מעבדים', 'ייצור שבבים', 'מרכזי נתונים'],
  ai: ['מודלים', 'וידאו', 'מוצרי AI'],
} satisfies Record<Exclude<BuiltIn, 'discover'>, string[]>;

const discoveryTopics = ['חלל', 'אקלים', 'אנרגיה', 'תרבות', 'מדע', 'טכנולוגיה שימושית'];
const regionTerms = [
  { region: standardRegions[1], aliases: ['new york', 'nyc', 'manhattan', 'brooklyn', 'albany', 'syracuse', 'queens', 'buffalo', 'rochester', 'long island', 'ניו יורק', 'מנהטן', 'ברוקלין'] },
  { region: standardRegions[2], aliases: ['china', 'chinese', 'beijing', 'shanghai', 'shenzhen', 'hangzhou', 'wuhan', 'hong kong', 'guangzhou', 'sichuan', 'alibaba', 'bytedance', 'tencent', 'huawei', 'deepseek', 'סין', 'סינית', 'בייג׳ינג'] },
  { region: standardRegions[0], aliases: ['california', 'san francisco', 'silicon valley', 'los angeles', 'san jose', 'santa clara', 'palo alto', 'mountain view', 'menlo park', 'sunnyvale', 'cupertino', 'oakland', 'san diego', 'קליפורניה', 'עמק הסיליקון'] },
];

export const plain = (value: string) => decodeHTML(value.replace(/<[^>]+>/g, ' '))
  .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

export const cleanLabel = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ');
export const normalize = (text: string) => text.normalize('NFKD').toLowerCase()
  .replace(/[\u0591-\u05c7\u0300-\u036f]/g, '').replace(/['’״׳]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const includesPhrase = (normalized: string, phrase: string) =>
  ` ${normalized} `.includes(` ${normalize(phrase)} `);
const stableId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

function variants(text: string) {
  const normalized = normalize(text);
  const singular = (value: string) => value.replace(/\b(\w{4,})s\b/g, '$1');
  return [normalized, singular(normalized).replace(/(^| )([והבכלמ])(?=[א-ת]{3,}(?: |$))/g, '$1')];
}

export function matchesPhrase(text: string, phrase: string) {
  const textVariants = variants(text);
  return variants(phrase).some(value => value && textVariants.some(candidate => includesPhrase(candidate, value)));
}

const hasTopic = (text: string, topic: string, aliases: readonly string[]) =>
  [topic, ...aliases].some(alias => matchesPhrase(text, alias));

export function matchesQuery(query: string, subject: string) {
  const parts = normalize(query).split(' ').filter(word => word.length > 1);
  if (!parts.length) return false;
  if (matchesPhrase(subject, query)) return true;
  for (const [topic, aliases] of Object.entries(lexicon)) {
    if ([topic, ...aliases].some(alias => variants(alias).includes(normalize(query))) &&
      hasTopic(subject, topic, aliases)) return true;
  }
  if (parts.length > 1 && parts.every(part => matchesPhrase(subject, part))) return true;
  return false;
}

export function matchesArticle(query: string, article: Article) {
  return (article.personalQueries?.includes(normalize(query)) ?? false) ||
    (!article.personalOnly && article.category !== 'discover' && standardRegions.some(region => region === article.region) &&
      matchesQuery(query, [article.title, article.titleHe, ...article.topics, ...(article.keywords ?? [])].join(' ')));
}

export function englishTopic(query: string) {
  const key = normalize(query);
  const topic = Object.entries(lexicon).find(([label, aliases]) =>
    [label, ...aliases].some(alias => normalize(alias) === key));
  return topic?.[1].find(alias => /^[a-z]/i.test(alias));
}

export function regionOf(title: string, description: string, fallback?: string) {
  for (const text of [title, description]) {
    const normalized = normalize(text);
    const regions = regionTerms.filter(({ aliases }) => aliases.some(alias => includesPhrase(normalized, alias)));
    if (regions.some(({ region }) => region === fallback)) return fallback;
    if (regions.length === 1) return regions[0].region;
    if (regions.length > 1) return undefined;
  }
  return fallback;
}

export function classify(title: string, metadata: string, suggestion?: BuiltIn, customMatch = false) {
  const topicsFor = (text: string) => Object.entries(lexicon).filter(([topic, words]) => hasTopic(text, topic, words))
    .map(([topic]) => topic);
  const headlineTopics = topicsFor(title);
  const topics = [...new Set([...headlineTopics, ...topicsFor(metadata)])];
  if (suggestion === 'discover') {
    const domain = [headlineTopics, topics].map(set => discoveryTopics.find(topic => set.includes(topic))).find(Boolean) ?? 'מדע';
    return { category: suggestion, topics: [domain, ...topics.filter(topic => topic !== domain)] };
  }
  const detect = (set: string[]) => (Object.keys(categoryTopics) as (keyof typeof categoryTopics)[])
    .find(category => categoryTopics[category].some(topic => set.includes(topic)));
  const category = detect(headlineTopics) ?? suggestion ?? detect(topics) ?? (customMatch ? 'market' : undefined);
  if (!category) return null;
  if (topics.includes('מוצרי AI') && topics.includes('גיוסים')) topics.unshift('גיוסי AI');
  const primary = headlineTopics.find(topic => categoryTopics[category].includes(topic)) ??
    topics.find(topic => categoryTopics[category].includes(topic));
  const ordered = [...new Set([...(primary ? [primary] : []), ...topics])];
  return { category, topics: ordered.length ? ordered : [normalize(title).split(' ').slice(0, 3).join(' ')] };
}

export function canonicalUrl(value: string) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    url.hostname = url.hostname.replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid|mc_cid|mc_eid|ref)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return null;
  }
}

const stopWords = new Set('the this that from with about into after than what when where how will your their says announces announced launches launched unveils introduces report reports new latest breaking first also more our has have over opens begins cuts around reveals for and of one its are was amid'.split(' '));
const phases: [string, RegExp][] = [
  ['approval', /\b(approves?|approved|approval|clears?|authoriz\w+|אישור|אישרה)\b/u],
  ['settlement', /\b(settles?|settlement|dismisses|dismissed)\b/],
  ['filing', /\b(files?|filed|filing|sues|lawsuit|proposes?)\b/],
  ['completion', /\b(completes?|completed|closes?|finalizes?|closed)\b/],
  ['launch', /\b(launch\w*|releas\w*|unveil\w*|introduc\w*|debut\w*|announc\w*)\b/],
];

export function eventTerms(title: string): string[] {
  const normalized = normalize(title.replace(/(?<=\d)\.(?=\d)/g, 'x'));
  const phase = phases.find(([, pattern]) => pattern.test(normalized))?.[0] ?? 'general';
  const words = normalized.split(' ').filter(word => word.length >= 3 && !stopWords.has(word) &&
    !phases.some(([, expression]) => expression.test(word)) && !/^\d{4}$/.test(word))
    .map(word => word.replace(/(\w{4,})s$/, '$1'));
  return [phase, ...new Set(words)];
}

export function storyId(terms: string[]) {
  return stableId([terms[0], ...terms.slice(1).sort()].join(' '));
}

export const articleId = (url: string) => stableId(url);

function sharesIdentifier(left: string, right: string, leftAliases?: string[], rightAliases?: string[]) {
  return left === right || leftAliases?.includes(right) ||
    rightAliases?.some(alias => alias === left || leftAliases?.includes(alias));
}

export function sameStory(left: Omit<Article, 'titleHe'>, right: Omit<Article, 'titleHe'>) {
  if (sharesIdentifier(left.eventId, right.eventId, left.alternateEventIds, right.alternateEventIds) ||
    sharesIdentifier(left.id, right.id, left.alternateIds, right.alternateIds)) return true;
  const [leftPhase, ...leftWords] = left.eventTerms ?? eventTerms(left.title);
  const [rightPhase, ...rightWords] = right.eventTerms ?? eventTerms(right.title);
  if (leftPhase !== rightPhase && leftPhase !== 'general' && rightPhase !== 'general') return false;
  if (Math.abs(Date.parse(left.publishedAt) - Date.parse(right.publishedAt)) > 4 * 86400_000) return false;
  const version = /^\d+x\d+(?:x\d+)*$/;
  const leftVersions = leftWords.filter(word => version.test(word));
  const rightVersions = rightWords.filter(word => version.test(word));
  if (leftVersions.length && rightVersions.length && !leftVersions.some(word => rightVersions.includes(word))) return false;
  const [smaller, larger] = [leftWords, rightWords].sort((a, b) => a.length - b.length);
  const shared = smaller.filter(term => larger.includes(term)).length;
  return shared >= 3 && shared / smaller.length >= 0.72 && shared / (smaller.length + larger.length - shared) >= 0.46;
}
