import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { categories as builtIns, type Board, type Category } from '../shared/model.js';
import './styles.css';

type Command = 'vote' | 'undo' | 'reset' | 'category' | 'refresh';
type CardSlot = Board['slots'][number];
const defaultStatus = '+ עוד בנושא הזה · − פחות בנושא הזה';
const dateFormat = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});
const articleDate = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'medium' });

function makeRequestId() {
  // getRandomValues is also available when running on a local network over HTTP.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return Array.from(bytes, (byte, index) => ([4, 6, 8, 10].includes(index) ? '-' : '') +
    byte.toString(16).padStart(2, '0')).join('');
}

async function requestBoard(path = '', data?: object): Promise<Board> {
  const response = await fetch(`/api/board${path}`, data ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'לא הצלחנו לטעון את הלוח.');
  return result;
}

function Card({ slot, category, featured, pending, locked, live, vote }: {
  slot: CardSlot;
  category: Category;
  featured: boolean;
  pending: boolean;
  locked: boolean;
  live: boolean;
  vote: (slot: CardSlot, direction: 1 | -1) => void;
}) {
  const card = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const article = slot.article;
  const ready = Boolean(article && !pending);
  useEffect(() => {
    if (!pending && restoreFocus.current) {
      if (!article && document.activeElement === document.body) card.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [article, pending]);

  return (
    <article
      ref={card}
      tabIndex={-1}
      className={`story theme-${category.color}${featured ? ' featured' : ''}${!article ? ' empty-slot' : ''}`}
      aria-busy={pending}
      aria-labelledby={`title-${slot.id}`}
      data-slot-id={slot.id}
    >
      {featured && <span className="feature-mark" aria-hidden="true">✦</span>}
      <div className="story-category">{slot.discovery && <span aria-hidden="true">✦</span>}{category.label}</div>
      <div className="story-copy">
        <h3 id={`title-${slot.id}`}>
          {pending ? 'מחפשים כתבה נוספת…' : article?.titleHe ?? 'אין כרגע כתבה נוספת'}
        </h3>
        {ready && article && (
          <p className="metadata">
            <bdi>{article.region}</bdi><span aria-hidden="true">·</span><bdi>{article.source}</bdi>
            {slot.discovery && <><span aria-hidden="true">·</span><bdi>{article.topics[0]}</bdi></>}
            {live && <><span aria-hidden="true">·</span>
              <time dateTime={article.publishedAt}>{articleDate.format(new Date(article.publishedAt))}</time></>}
          </p>
        )}
        {pending && <div className="loading-line" aria-hidden="true" />}
      </div>
      {article && (
        <div className="story-actions">
          <div className={`source-links${ready ? '' : ' temporarily-hidden'}`}>
            <a href={article.url} target="_blank" rel="noopener noreferrer">
              לכתבה <span aria-hidden="true">↖</span>
            </a>
            {article.heUrl && <a href={article.heUrl} target="_blank" rel="noopener noreferrer">קריאה בעברית</a>}
          </div>
          <div className="votes">
            {([1, -1] as const).map(direction => {
              const label = direction === 1 ? 'עוד בנושא הזה' : 'פחות בנושא הזה';
              return (
                <button key={direction} type="button" aria-label={label} title={label} aria-disabled={locked}
                  onClick={event => {
                    if (locked || event.detail > 1) return;
                    restoreFocus.current = document.activeElement === event.currentTarget;
                    vote(slot, direction);
                  }}>
                  {direction === 1 ? '+' : '−'}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [filter, setFilter] = useState<string>(builtIns[0].id);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [formError, setFormError] = useState('');
  const formInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const hasBoard = useRef(false);
  const collecting = board?.refresh === 'running';
  const refreshing = collecting || pending === 'refresh';

  async function loadBoard() {
    if (lock.current) return;
    const call = ++generation.current;
    try {
      const next = await requestBoard();
      if (call !== generation.current) return;
      setBoard(next);
      hasBoard.current = true;
      setError('');
    } catch {
      if (call === generation.current && !hasBoard.current) setError('לא הצלחנו לטעון את הכותרות.');
    }
  }

  useEffect(() => {
    void loadBoard();
    const timer = window.setInterval(loadBoard, collecting ? 3_000 : 20_000);
    return () => {
      window.clearInterval(timer);
      generation.current++;
    };
  }, [collecting]);

  useEffect(() => {
    if (formOpen) formInput.current?.focus();
  }, [formOpen]);

  async function mutate(
    command: Command, data: object, busySlot: string,
    done: (next: Board) => void, fail = (message: string) => setNotice(message),
  ) {
    if (lock.current) return;
    lock.current = true;
    generation.current++;
    setPending(busySlot);
    try {
      const requestId = makeRequestId();
      const next = await requestBoard(`/${command}`, { ...data, requestId });
      setBoard(next);
      done(next);
    } catch (error) {
      fail(error instanceof Error && error.message !== 'Failed to fetch'
        ? error.message : 'לא ניתן להשלים את הפעולה כרגע. נסו שוב.');
    } finally {
      lock.current = false;
      setPending(null);
    }
  }

  function refreshNews() {
    if (lock.current || refreshing) return;
    setNotice('');
    setRefreshRequested(false);
    void mutate('refresh', {}, 'refresh', () => setRefreshRequested(true));
  }

  function vote(slot: CardSlot, direction: 1 | -1) {
    if (!slot.article) return;
    setNotice('מחפשים כתבה נוספת…');
    void mutate('vote', {
      slotId: slot.id, articleId: slot.article.id, vote: direction,
    }, slot.id, next => {
      const replacement = next.slots.find(item => item.id === slot.id)?.article;
      setNotice(replacement?.id === slot.article?.id ? 'אין כרגע כתבה שטרם הוצגה בקטגוריה הזו. הכתבה הנוכחית נשארה במשבצת.' :
        replacement ? 'כתבה חדשה הופיעה באותה משבצת.' : 'אין כרגע כתבה נוספת מתאימה.');
    });
  }

  function createCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = name.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!label) {
      setFormError('יש להזין שם קטגוריה.');
      return;
    }
    setFormError('');
    void mutate('category', { label }, 'category', next => {
      const created = next.categories.find(category => !board?.categories.some(previous => previous.id === category.id));
      if (!created) {
        setFormError(next.categories.length >= builtIns.length + 30
          ? 'אפשר לשמור עד 30 קטגוריות אישיות.' : 'כבר קיימת קטגוריה בשם הזה.');
        formInput.current?.focus();
        return;
      }
      setFilter(created.id);
      setFormOpen(false);
      setName('');
      setNotice(`הקטגוריה ״${created.label}״ נוספה.`);
      requestAnimationFrame(() => document.getElementById(`filter-${created.id}`)?.focus({ preventScroll: true }));
    }, setFormError);
  }

  const allCategories = board?.categories ?? builtIns;
  const currentCategory = allCategories.find(category => category.id === filter) ?? builtIns[0];
  const visible = board?.slots.filter(slot => slot.categoryId === currentCategory.id) ?? [];
  // The feature belongs to the discovery slot, even while its article is being replaced.
  const featuredId = currentCategory.id === 'discover' ? visible[0]?.id : undefined;

  function setCategory(id: string) {
    if (lock.current) return;
    setFilter(id);
    setNotice('');
  }

  return (
    <main className="board">
      <header className="masthead">
        <p className="kicker"><span aria-hidden="true">✦</span> מהדורת טכנולוגיה אישית</p>
        <div className="brand">
          <h1>כותרות הטק<span aria-hidden="true">.</span></h1>
          <p className="coverage">קליפורניה · מדינת ניו יורק · סין</p>
        </div>
        {board?.mode === 'live' && (
          <button className="refresh-news" type="button" onClick={refreshNews}
            aria-disabled={pending !== null || refreshing}>
            <span aria-hidden="true">↻</span> {refreshing ? 'מרעננים…' : 'רענון חדשות'}
          </button>
        )}
        {board && <div className="edition">
          {board.mode === 'demo' && <span className="demo-label"><span aria-hidden="true" /> נתוני דוגמה</span>}
          {board.edition && (
            <span className="edition-time">
              {board.mode === 'demo' ? 'מהדורת הדגמה' : 'המהדורה האחרונה'}
              <time dateTime={board.edition.at}>{dateFormat.format(new Date(board.edition.at))}</time>
            </span>
          )}
        </div>}
      </header>

      <nav className="filters" aria-label="קטגוריות">
        {allCategories.map(category => (
          <button id={`filter-${category.id}`} key={category.id} type="button" className={`theme-${category.color}`}
            aria-pressed={currentCategory.id === category.id} onClick={() => setCategory(category.id)}>
            <span className="filter-dot" aria-hidden="true" /><bdi>{category.label}</bdi>
          </button>
        ))}
        <button ref={addButton} type="button" className="add-category" aria-expanded={formOpen} aria-controls="new-category"
          aria-disabled={!board || pending !== null} onClick={() => { if (board && !lock.current) setFormOpen(value => !value); }}>
          <span aria-hidden="true">+</span> הוספת קטגוריה
        </button>
      </nav>

      <form className="category-form" id="new-category" hidden={!formOpen} onSubmit={createCategory}
        onKeyDown={event => {
          if (event.key === 'Escape' && !lock.current) {
            setFormOpen(false);
            addButton.current?.focus();
          }
        }}>
        <label htmlFor="category">שם קטגוריה חדשה</label>
        <div className="form-controls">
          <input id="category" ref={formInput} dir="auto" maxLength={70} value={name}
            onChange={event => { setName(event.target.value); setFormError(''); }}
            placeholder="למשל רובוטיקה רפואית" aria-invalid={Boolean(formError)}
            aria-describedby={formError ? 'category-error' : undefined} />
          <button type="submit" disabled={pending !== null}>הוספה</button>
        </div>
        {formError && <p id="category-error" role="alert">{formError}</p>}
      </form>

      <section aria-labelledby="feed-heading">
        <div className="feed-heading">
          <h2 id="feed-heading">{currentCategory.label}</h2>
          <div className="preferences">
            <button type="button" aria-disabled={!board?.canUndo || pending !== null} onClick={() => {
              if (board?.canUndo) void mutate('undo', {}, 'undo', () => { setNotice('ההצבעה האחרונה בוטלה.'); });
            }}>ביטול הצבעה</button>
            <button type="button" aria-disabled={!board?.hasPreferences || pending !== null} onClick={() => {
              if (board?.hasPreferences && !lock.current && window.confirm('לאפס את ההעדפות שנשמרו?')) {
                void mutate('reset', {}, 'reset', () => { setNotice('ההעדפות אופסו.'); });
              }
            }}>איפוס העדפות</button>
          </div>
        </div>
        <div className="feedback" role="status" aria-live="polite">
          {notice || (refreshing ? 'בודקים את מקורות החדשות…' :
            refreshRequested && board?.refresh === 'idle' ? 'בדיקת מקורות החדשות הסתיימה.' : defaultStatus)}
        </div>

        {board?.refresh === 'partial' && <p className="refresh-message">חלק מהמקורות לא התעדכנו. הכותרות שנאספו עדיין זמינות.</p>}
        {board?.refresh === 'error' && <p className="refresh-message">עדכון המקורות לא הושלם. אפשר לנסות שוב עם ״רענון חדשות״.</p>}
        {error ? <div className="board-state" role="alert">
          <p>{error}</p><button type="button" onClick={() => void loadBoard()}>ניסיון נוסף</button>
        </div> : !board || (board.refresh === 'running' && !board.edition) ? (
          <div className="board-state" role="status">טוענים כותרות…</div>
        ) : visible.length ? (
          <div className="stories">
            {visible.map(slot => <Card key={slot.id} slot={slot}
              category={currentCategory}
              featured={slot.id === featuredId} pending={pending === slot.id} locked={pending !== null}
              live={board.mode === 'live'} vote={vote} />)}
          </div>
        ) : (
          <div className="board-state">
            <p>עדיין אין ידיעות זמינות בקטגוריה הזו</p>
            <span>{refreshing ? 'מחפשים ידיעות מתאימות במקורות…' : 'ידיעות מתאימות יופיעו כאן כשיימצאו.'}</span>
          </div>
        )}
      </section>

      <footer className="translation-help">
        <span className="help-icon" aria-hidden="true">?</span>
        <p>לקריאה בעברית, פתחו את המקור ובחרו בתרגום לעברית בתפריט הדפדפן, כשהאפשרות זמינה.</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
