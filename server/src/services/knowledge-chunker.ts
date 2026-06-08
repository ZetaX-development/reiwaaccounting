export interface ParsedChunk {
  source: string;
  page: string;
  title: string;
  content: string;
  accounts: string[];
  taxClass: string | null;
  tags: string[];
}

const EXCLUDE_TITLE_KEYWORDS = ['はじめに', '本書の特徴', '目次', '索引', '章扉', '科目一覧'];
const NON_ACCOUNT_CELLS = new Set(['借方', '貸方', '金額', '日付', '']);

interface Section {
  startPage: string;
  endPage: string;
  title: string;
  bodyLines: string[];
}

function normalizeAccount(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s*※.*$/, '').replace(/（.*?）/g, '').trim();
  if (NON_ACCOUNT_CELLS.has(cleaned)) return null;
  if (/^[-—–\s]*$/.test(cleaned)) return null; // 区切り線
  if (cleaned.includes('---')) return null;
  if (/[\d/]/.test(cleaned)) return null; // 金額・日付（4/5 等）・数字を含むセルは科目ではない
  if (cleaned.includes('金額')) return null; // 'Aの金額' 等のヘッダ
  if (cleaned.length === 0 || cleaned.length > 20) return null;
  return cleaned;
}

function extractAccounts(title: string, content: string): string[] {
  const set = new Set<string>();
  const titleMatch = /\d+-\d+\s+([^（(\[［\s]+)/.exec(title);
  if (titleMatch?.[1]) set.add(titleMatch[1]);
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    // 列レイアウト（借方/貸方の位置）が表ごとに違うため全セルを走査し、
    // 科目名らしいセルだけを残す（日付・金額・ヘッダはフィルタで除外）。
    for (const cell of line.split('|')) {
      const acc = normalizeAccount(cell.trim());
      if (acc) set.add(acc);
    }
  }
  return [...set];
}

function extractTaxClass(content: string): string | null {
  const m = /消費税区分[：:]\s*\*{0,2}([^（(*\n]+?)\*{0,2}\s*(?:[（(]|$)/m.exec(content);
  return m?.[1] ? m[1].trim() : null;
}

function extractTags(title: string): string[] {
  const tags: string[] = [];
  if (title.includes('個人')) tags.push('個人');
  if (title.includes('法人')) tags.push('法人');
  return tags;
}

function toChunk(s: Section, source: string): ParsedChunk {
  const page =
    s.startPage === s.endPage ? s.startPage : `${s.startPage}-${s.endPage.replace(/^p\./, '')}`;
  const content = s.bodyLines.join('\n').trim();
  return {
    source,
    page,
    title: s.title,
    content,
    accounts: extractAccounts(s.title, content),
    taxClass: extractTaxClass(content),
    tags: extractTags(s.title),
  };
}

export function chunkKnowledgeMarkdown(markdown: string, source: string): ParsedChunk[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const text = heading[1]!;
      const hasTitle = text.includes('｜');
      const pageToken = (hasTitle ? text.split('｜')[0]! : text).trim();
      const title = hasTitle ? text.split('｜').slice(1).join('｜').trim() : '';

      if (hasTitle || current === null) {
        current = { startPage: pageToken, endPage: pageToken, title, bodyLines: [] };
        sections.push(current);
      } else {
        current.endPage = pageToken; // 継続ページ（次頁に続く）
      }
      continue;
    }
    if (current) current.bodyLines.push(line);
  }

  return sections
    .filter((s) => s.title && !EXCLUDE_TITLE_KEYWORDS.some((kw) => s.title.includes(kw)))
    .map((s) => toChunk(s, source));
}
