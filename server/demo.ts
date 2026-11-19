import { type Article, type BuiltIn } from '../shared/model.js';
import { articleId, canonicalUrl, eventTerms, storyId } from './classification.js';

type Item = [title: string, hebrew: string, source: string, url: string, region: string, ...topics: string[]];
const fixtures: Record<BuiltIn, Item[]> = {
  discover: [
    ['How the James Webb Space Telescope looks for distant worlds', 'איך טלסקופ ג׳יימס וב מחפש עולמות רחוקים?', 'NASA', 'https://science.nasa.gov/mission/webb/', 'עולם', 'חלל'],
    ['The ocean and climate', 'מה האוקיינוס מספר לנו על האקלים העולמי?', 'NOAA', 'https://www.noaa.gov/education/resource-collections/climate/ocean-and-climate', 'עולם', 'אקלים'],
    ['How does solar work?', 'איך הופכים אור שמש לחשמל?', 'U.S. Department of Energy', 'https://www.energy.gov/eere/solar/how-does-solar-work', 'ארה״ב', 'אנרגיה'],
    ['Heilbrunn Timeline of Art History', 'סיפורה של האמנות דרך חפצים מכל העולם', 'The Met', 'https://www.metmuseum.org/essays', 'עולם', 'תרבות'],
    ['How do we know the age of the universe?', 'איך מדענים מחשבים את גיל היקום?', 'NASA', 'https://science.nasa.gov/universe/', 'עולם', 'חלל'],
    ['Evolution 101', 'איך חוקרים את האבולוציה של החיים על פני כדור הארץ?', 'UC Berkeley', 'https://evolution.berkeley.edu/evolution-101/', 'עולם', 'מדע'],
    ['Heat pump systems', 'כיצד משאבת חום מחממת ומקררת את הבית?', 'U.S. Department of Energy', 'https://www.energy.gov/energysaver/heat-pump-systems', 'ארה״ב', 'טכנולוגיה שימושית', 'אנרגיה'],
    ['Coral reef ecosystems', 'מה הופך את שוניות האלמוגים לבית גידול עשיר כל כך?', 'NOAA', 'https://www.noaa.gov/education/resource-collections/marine-life/coral-reef-ecosystems', 'עולם', 'מדע', 'אקלים'],
  ],
  ai: [
    ['Introducing GPT-4.5', 'OpenAI מציגה את GPT‑4.5, מודל שפה חדש', 'OpenAI', 'https://openai.com/index/introducing-gpt-4-5/', 'קליפורניה', 'מודלים'],
    ['Introducing GPT-4.1 in the API', 'משפחת GPT‑4.1 מגיעה למפתחי יישומים', 'OpenAI', 'https://openai.com/index/gpt-4-1/', 'קליפורניה', 'מודלים'],
    ['OpenAI introduces Sora video generation', 'Sora של OpenAI מייצר וידאו מטקסט', 'OpenAI', 'https://openai.com/index/sora-is-here/', 'קליפורניה', 'וידאו', 'מוצרי AI'],
    ['Gemini 2.5', 'גוגל מציגה את Gemini 2.5 עם יכולות הסקה', 'Google', 'https://blog.google/technology/google-deepmind/gemini-model-thinking-updates-march-2025/', 'קליפורניה', 'מודלים'],
    ['DeepSeek-R1 release', 'דיפסיק מפרסמת את מודל ההסקה DeepSeek‑R1', 'DeepSeek', 'https://api-docs.deepseek.com/news/news250120', 'סין', 'מודלים'],
    ['Introducing ChatGPT search', 'חיפוש ברשת מגיע ל־ChatGPT', 'OpenAI', 'https://openai.com/index/introducing-chatgpt-search/', 'קליפורניה', 'מוצרי AI'],
  ],
  chips: [
    ['NVIDIA Rubin for high-performance computing', 'אנבידיה חושפת מעבד גרפי לסימולציות ולמחקר מדעי', 'NVIDIA', 'https://blogs.nvidia.com/blog/rubin-hpc/', 'קליפורניה', 'מעבדים'],
    ['GlobalFoundries breaks ground on new Malta semiconductor fab', 'גלובלפאונדריז מתחילה להקים מפעל שבבים במלטה שבניו יורק', 'GlobalFoundries', 'https://gf.com/news-and-events/news/globalfoundries-breaks-ground-on-first-new-semiconductor-fab-under-landmark-us-japan-initiative/', 'מדינת ניו יורק', 'ייצור שבבים'],
    ['NVIDIA Blackwell platform arrives', 'מה מציעה פלטפורמת Blackwell של אנבידיה למרכזי נתונים?', 'NVIDIA', 'https://nvidianews.nvidia.com/news/blackwell-ai-computing-platform', 'קליפורניה', 'מרכזי נתונים', 'מעבדים'],
    ['Apple introduces M4 silicon chip', 'אפל מציגה את שבב M4', 'Apple', 'https://www.apple.com/newsroom/2024/05/apple-introduces-m4-chip/', 'קליפורניה', 'מעבדים'],
  ],
  market: [
    ['Intuitive develops da Vinci surgical robotics systems', 'אינטואיטיב מפתחת מערכות כירורגיות רובוטיות מסדרת דה וינצ׳י', 'Intuitive', 'https://www.intuitive.com/en-us/products-and-services/da-vinci', 'קליפורניה', 'רובוטיקה רפואית'],
    ['Anthropic raises Series E at $61.5 billion post-money valuation', 'אנתרופיק מודיעה על סבב גיוס של 3.5 מיליארד דולר', 'Anthropic', 'https://www.anthropic.com/news/anthropic-raises-series-e-at-usd61-5b-post-money-valuation', 'קליפורניה', 'גיוסי AI', 'גיוסים'],
    ['OpenAI new funding to scale AI research', 'OpenAI מגייסת הון להרחבת מחקר הבינה המלאכותית', 'OpenAI', 'https://openai.com/index/march-funding-announcement/', 'קליפורניה', 'גיוסי AI', 'גיוסים'],
    ['Strengthening open-source security at GitHub', 'גיטהאב מרכזת כלים להגנה על פרויקטים בקוד פתוח', 'GitHub', 'https://github.com/security', 'קליפורניה', 'אבטחת תוכנה'],
    ['Microsoft completes acquisition of GitHub', 'מיקרוסופט משלימה את רכישת גיטהאב', 'Microsoft', 'https://blogs.microsoft.com/blog/2018/10/26/microsoft-completes-github-acquisition/', 'קליפורניה', 'רכישות'],
  ],
  policy: [
    ['New York governor signs RAISE Act', 'ניו יורק מסדירה את חובות הבטיחות של מפתחי מודלי AI', 'New York State', 'https://www.nysenate.gov/legislation/bills/2025/S6953/amendment/B', 'מדינת ניו יורק', 'רגולציה', 'מוצרי AI'],
    ['US Bureau of Industry and Security advanced computing export controls', 'ארה״ב מפרטת את מגבלות היצוא על שבבי מחשוב מתקדמים', 'BIS', 'https://www.bis.gov/', 'סין', 'מגבלות יצוא'],
    ['California AI Transparency Act SB 942', 'קליפורניה מחילה דרישות שקיפות על תוכן שנוצר בבינה מלאכותית', 'California Legislature', 'https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202320240SB942', 'קליפורניה', 'חקיקה מקומית', 'מוצרי AI'],
  ],
};

export function demoArticles(now: number): Article[] {
  return (Object.entries(fixtures) as [BuiltIn, Item[]][]).flatMap(([category, items]) =>
    items.map(([title, titleHe, source, link, region, ...topics], index) => {
      const url = canonicalUrl(link)!;
      const terms = eventTerms(title);
      return {
        id: articleId(url), url: link, canonicalUrl: url, eventId: storyId(terms), eventTerms: terms,
        title, titleHe, source, region, category, topics,
        publishedAt: new Date(now - index * 3_600_000).toISOString(),
      };
    }),
  );
}
