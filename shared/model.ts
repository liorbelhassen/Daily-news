export const standardRegions = ['קליפורניה', 'מדינת ניו יורק', 'סין'] as const;
export const categories = [
  { id: 'discover', label: 'הרחבת אופקים', color: 'discover' },
  { id: 'ai', label: 'בינה מלאכותית ומוצרים', color: 'ai' },
  { id: 'chips', label: 'שבבים ותשתיות', color: 'chips' },
  { id: 'market', label: 'חברות וגיוסים', color: 'market' },
  { id: 'policy', label: 'ממשל, רגולציה וגיאופוליטיקה', color: 'policy' },
] as const;

export type BuiltIn = (typeof categories)[number]['id'];
export type Category = { id: string; label: string; color: string };
export type Article = {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  titleHe: string;
  category: BuiltIn;
  topics: string[];
  region: string;
  source: string;
  publishedAt: string;
  publicationDateVerified?: true;
  eventId: string;
  eventTerms?: string[];
  heUrl?: string;
  popularity?: number;
  keywords?: string[];
};
export type Slot = {
  id: string;
  discovery: boolean;
  categoryId: string;
  articleId: string | null;
};
export type Board = {
  slots: (Slot & { article: Article | null })[];
  categories: Category[];
  edition: { id: string; at: string } | null;
  mode: 'demo' | 'live';
  refresh: 'idle' | 'running' | 'partial' | 'error';
  canUndo: boolean;
  hasPreferences: boolean;
};
