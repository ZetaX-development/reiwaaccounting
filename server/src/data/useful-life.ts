/**
 * 日本の法定耐用年数テーブル（減価償却資産の耐用年数等に関する省令 別表第一）
 * 主要品目のみ収録。詳細は国税庁の耐用年数表を参照。
 */

export interface UsefulLifeEntry {
  category: string;      // 大分類（例: "工具器具備品"）
  item: string;          // 品目（例: "パソコン・サーバ"）
  keywords: string[];    // マッチングキーワード
  years: number;         // 耐用年数
  requiresContract: boolean; // 契約書・見積書が必要か（高額設備など）
}

export const USEFUL_LIFE_TABLE: UsefulLifeEntry[] = [
  {
    category: '工具器具備品',
    item: 'パソコン・サーバ',
    keywords: ['PC', 'パソコン', 'サーバ', 'server', 'computer', 'コンピュータ', 'ノートPC', 'デスクトップ'],
    years: 4,
    requiresContract: false,
  },
  {
    category: '無形固定資産',
    item: 'パソコン用ソフトウェア',
    keywords: ['ソフトウェア', 'software', 'ライセンス', 'license', 'アプリ'],
    years: 5,
    requiresContract: false,
  },
  {
    category: '車両運搬具',
    item: '普通自動車',
    keywords: ['普通自動車', '乗用車', 'セダン', 'ミニバン', 'SUV', 'ワゴン'],
    years: 6,
    requiresContract: false,
  },
  {
    category: '車両運搬具',
    item: '軽自動車',
    keywords: ['軽自動車', '軽車両', '軽', '車両', '自動車', '車'],
    years: 4,
    requiresContract: false,
  },
  {
    category: '工具器具備品',
    item: '電話機・FAX',
    keywords: ['電話', 'FAX', 'ファックス', 'telephone', 'phone', '固定電話', 'IP電話'],
    years: 10,
    requiresContract: false,
  },
  {
    category: '工具器具備品',
    item: 'コピー機・プリンタ・複合機',
    keywords: ['コピー', 'プリンタ', '複合機', 'printer', 'copier', 'MFP', 'コピー機', 'レーザープリンタ'],
    years: 5,
    requiresContract: false,
  },
  {
    category: '建物附属設備',
    item: 'エアコン・空調設備',
    keywords: ['エアコン', '空調', '冷暖房', 'エアコン設備', '冷却設備', '暖房設備', 'HVAC'],
    years: 13,
    requiresContract: false,
  },
  {
    category: '建物附属設備',
    item: '内部造作（内装・改装）',
    keywords: ['内装', '改装', '内部造作', 'リフォーム', 'リノベーション', '間仕切り', '床工事', '天井工事', '壁工事'],
    years: 15,
    requiresContract: false,
  },
  {
    category: '機械装置',
    item: '機械装置（一般）',
    keywords: ['機械', '装置', '設備', '製造設備', '加工機', '自動機'],
    years: 10,
    requiresContract: false,
  },
  {
    category: '工具器具備品',
    item: '工具・器具・備品（一般）',
    keywords: [],  // デフォルトフォールバック用（空キーワード）
    years: 5,
    requiresContract: false,
  },
];

/** 固定資産の契約書・見積書が必要になる金額閾値（円）*/
const CONTRACT_REQUIRED_AMOUNT = 300_000;

/** 固定資産として扱う最低金額（円）*/
const FIXED_ASSET_MIN_AMOUNT = 100_000;

/**
 * 摘要テキストと金額から最適な耐用年数エントリを返す。
 *
 * - description のキーワードマッチで最適なエントリを選択
 * - マッチなしの場合、amount >= 100,000 ならデフォルト（工具器具備品 5年）を返す
 * - amount < 100,000 なら null を返す（少額資産のため固定資産不要）
 * - amount >= 300,000 の固定資産は requiresContract を true に上書き
 */
export function findUsefulLife(description: string, amount: number): UsefulLifeEntry | null {
  if (amount < FIXED_ASSET_MIN_AMOUNT) {
    return null;
  }

  // キーワードマッチング（デフォルトフォールバック用エントリを除く）
  const candidates = USEFUL_LIFE_TABLE.filter((entry) => entry.keywords.length > 0);
  for (const entry of candidates) {
    for (const keyword of entry.keywords) {
      if (description.includes(keyword)) {
        const requiresContract = amount >= CONTRACT_REQUIRED_AMOUNT;
        return { ...entry, requiresContract };
      }
    }
  }

  // マッチなし → デフォルト（工具器具備品 5年）
  const defaultEntry = USEFUL_LIFE_TABLE.find((e) => e.keywords.length === 0);
  if (!defaultEntry) return null;

  const requiresContract = amount >= CONTRACT_REQUIRED_AMOUNT;
  return { ...defaultEntry, requiresContract };
}
