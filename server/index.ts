import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cron from 'node-cron';
import { categories } from '../shared/model.js';
import { applyVote, populateCategory, resetPreferences, undoVote } from './board.js';
import { cleanLabel, normalize } from './classification.js';
import { demoArticles } from './demo.js';
import { createRefresher, EDITION_SCHEDULE, TIME_ZONE } from './refresh.js';
import { Store } from './store.js';

const mode = process.env.NEWS_MODE ?? 'demo';
if (mode !== 'demo' && mode !== 'live') throw new Error('NEWS_MODE must be demo or live.');
const store = new Store(process.env.DATABASE_PATH ?? `data/daily-news-${mode}.sqlite`);
const refresher = createRefresher(store);
const data = { mode, refresh: refresher.status } as const;
if (mode === 'demo') {
  const edition = store.edition();
  if (!edition || edition.id === 'demo-v1' || edition.id === 'demo-v2') {
    const now = Date.now();
    store.saveEdition({ id: 'demo-v3', at: new Date(now).toISOString() }, demoArticles(now));
  }
}
const scheduler = mode === 'live' ? cron.schedule(EDITION_SCHEDULE, () => refresher.run(), {
  timezone: TIME_ZONE, noOverlap: true,
}) : undefined;

const app = express();
app.disable('x-powered-by');
app.use('/api', express.json({ limit: '8kb' }));
app.use('/api', (_request, response, next) => {
  response.set('Cache-Control', 'private, no-store');
  next();
});

const cookie = 'daily_news_reader';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readerId(request: Request, response: Response) {
  const existing = request.headers.cookie?.match(/(?:^|;\s*)daily_news_reader=([^;]*)/)?.[1];
  if (existing && uuid.test(existing)) return existing;
  const id = randomUUID();
  const secure = request.secure || request.get('x-forwarded-proto') === 'https' || process.env.PUBLIC_ORIGIN?.startsWith('https:');
  response.cookie(cookie, id, { httpOnly: true, sameSite: 'lax', secure, maxAge: 365 * 86400_000 });
  return id;
}

function sameOrigin(request: Request) {
  const site = request.get('sec-fetch-site');
  if (site === 'same-origin') return true;
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = request.get('origin');
  if (!origin) return true;
  return [process.env.PUBLIC_ORIGIN, `http://${request.get('host')}`, `https://${request.get('host')}`].includes(origin);
}

app.get('/api/board', (request, response) => {
  response.json(store.board(readerId(request, response), data.mode, data.refresh()));
});

app.post('/api/board/:command', (request, response) => {
  if (!sameOrigin(request) || !request.is('application/json')) {
    response.status(403).json({ error: 'לא ניתן לבצע את הפעולה ממקור אחר.' });
    return;
  }
  const id = readerId(request, response);
  const input = request.body ?? {};
  const { requestId } = input;
  if (typeof requestId !== 'string' || !uuid.test(requestId)) {
    response.status(400).json({ error: 'בקשה לא תקינה.' });
    return;
  }
  const save = (change: NonNullable<Parameters<Store['board']>[4]>) =>
    store.board(id, data.mode, data.refresh(), requestId, change);
  const invalid = (error: string) => { response.status(400).json({ error }); };
  switch (request.params.command) {
    case 'vote': {
      const { slotId, articleId, vote } = input;
      if (typeof slotId !== 'string' || !uuid.test(slotId) || typeof articleId !== 'string' ||
        !/^[a-f0-9]{24}$/.test(articleId) || (vote !== 1 && vote !== -1)) {
        invalid('ההצבעה אינה תקינה.');
        return;
      }
      response.json(save((reader, catalog, now) => {
        applyVote(reader, slotId, articleId, vote, catalog, now);
      }));
      return;
    }
    case 'undo':
      response.json(save((reader, catalog) => { undoVote(reader, catalog); }));
      return;
    case 'reset':
      response.json(save(resetPreferences));
      return;
    case 'category': {
      const label = typeof input.label === 'string' ? cleanLabel(input.label) : '';
      if (!normalize(label).match(/[\p{L}\p{N}]/u) || label.length > 70 ||
        /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(label)) {
        invalid('יש להזין שם קטגוריה באורך של עד 70 תווים.');
        return;
      }
      response.json(save((reader, catalog, now) => {
        if ([...categories, ...reader.custom].some(category => normalize(category.label) === normalize(label)) ||
          reader.custom.length >= 30) return;
        const color = `custom-${reader.custom.length % 5}`;
        const category = { id: randomUUID(), label, color };
        reader.custom.push(category);
        populateCategory(reader, category.id, catalog, now);
      }));
      return;
    }
    default:
      response.status(404).json({ error: 'הפעולה לא נמצאה.' });
  }
});

app.use('/api', (_request, response) => response.status(404).json({ error: 'הבקשה לא נמצאה.' }));
app.use(express.static(resolve('dist'), { index: 'index.html' }));
app.use((error: Error & { status?: number }, _request: Request, response: Response, _next: NextFunction) => {
  if (!error.status || error.status >= 500) console.error('Daily-news request failed:', error.message);
  response.status(error.status ?? 500).json({ error: 'לא הצלחנו להשלים את הבקשה.' });
});

const port = Number(process.env.PORT ?? 3000);
const http = app.listen(port, '0.0.0.0', () => {
  console.info(`Daily-news is listening on port ${port} in ${mode} mode.`);
  if (mode === 'live') void refresher.run();
});
function shutdown() {
  scheduler?.stop();
  http.close(() => { store.close(); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
