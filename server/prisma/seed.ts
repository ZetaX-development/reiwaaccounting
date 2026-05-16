import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type SeedReceiptStatus = 'matched' | 'missing' | 'partial' | 'na';
type SeedTaskStatus = 'urgent' | 'open' | 'done';
type SeedRecordStatus = 'attached' | 'missing' | 'candidate';
type SeedMatchingStatus = 'matched' | 'open' | 'urgent' | 'done';

interface SeedClient {
  externalKey: string;
  name: string;
  industry: string;
  vendor: 'freee' | 'mf' | 'both';
  vendorSource: 'freee' | 'mf';
  ownerLabel: string;
  progress: number;
  tasksOpen: number;
  risk: number;
  receipt: number;
  missing: number;
  diff: number;
  matches: number;
  chatMessage: string;
  messageDraft: string;
  contactPrimary: 'email' | 'slack' | 'chatwork' | 'line_works';
  contactEndpoints: Record<string, string | null>;
  fiscalYearStart: Date;
  fiscalYearEnd: Date;
  rules: { title: string; severity: 'high' | 'mid' | 'low' }[];
  entries: {
    account: string;
    description: string;
    amount: number;
    taxClass: string;
    note: string;
    status: SeedTaskStatus;
    score: number;
    receiptStatus: SeedReceiptStatus;
  }[];
  receipts: {
    vendorRef: string;
    status: SeedRecordStatus;
    note: string;
    score: number;
  }[];
  matchings: {
    invoiceRef: string;
    invoiceAmount: number;
    paidAmount: number;
    diffNote: string;
    status: SeedMatchingStatus;
    score: number;
  }[];
  monthlyChecks: {
    title: string;
    note: string;
    detail: string;
    status: SeedTaskStatus;
    score: number;
  }[];
  trendData: {
    account: string;
    prev3: number[];
    curr: number;
    changePct: number;
    flag: 'ok' | 'alert';
  }[];
  tasks: {
    title: string;
    note: string;
    category: string;
    status: SeedTaskStatus;
    score: number;
  }[];
}

const seedData: SeedClient[] = [
  {
    externalKey: 'aoyama-design',
    name: '青山デザイン株式会社',
    industry: '広告制作',
    vendor: 'mf',
    vendorSource: 'mf',
    ownerLabel: '担当: 鈴木 / 締切 5月10日',
    progress: 87,
    tasksOpen: 6,
    risk: 2,
    receipt: 91,
    missing: 3,
    diff: 2,
    matches: 24,
    chatMessage:
      '青山デザインは今月も順調ですね！広告費の消費税区分だけ先方に確認を取れば、ほぼクローズできそうです。カード明細の証憑も早めに催促しましょう。',
    messageDraft:
      '青山デザイン株式会社 ご担当者様\n\n5月月次確認のため、以下の資料をご共有ください。\n・4月分カード明細に紐づく領収書3件\n・請求INV-0421の入金差額に関する補足\n\n確認後、月次処理を進めます。よろしくお願いいたします。',
    contactPrimary: 'email',
    contactEndpoints: { email: 'aoyama@example.com', slack: null, chatwork: null, line_works: null },
    fiscalYearStart: new Date('2025-04-01'),
    fiscalYearEnd: new Date('2026-03-31'),
    rules: [
      { title: '広告費は過去6回の消費税区分を優先', severity: 'mid' },
      { title: '資産計上・少額減価償却資産の判定候補を検出', severity: 'mid' },
      { title: '役員名義カードは証憑必須', severity: 'high' },
    ],
    entries: [
      { account: '広告宣伝費', description: 'Meta広告 220,000円', amount: 220000, taxClass: '課税仕入10%', note: '前月は対象外', status: 'urgent', score: 82, receiptStatus: 'missing' },
      { account: '旅費交通費', description: '新幹線 EX予約 18,420円', amount: 18420, taxClass: '課税仕入10%', note: '証憑一致', status: 'done', score: 94, receiptStatus: 'matched' },
      { account: '外注費', description: '個人デザイナー 385,000円', amount: 385000, taxClass: '源泉確認', note: '摘要に個人名', status: 'open', score: 69, receiptStatus: 'partial' },
      { account: '消耗品費', description: 'PC周辺機器 42,800円', amount: 42800, taxClass: '課税仕入10%', note: '過去処理一致', status: 'done', score: 96, receiptStatus: 'matched' },
    ],
    receipts: [
      { vendorRef: 'カード明細 4/12', status: 'missing', note: '顧問先依頼待ち', score: 76 },
      { vendorRef: 'EX予約', status: 'attached', note: '自動紐付け可能', score: 94 },
      { vendorRef: 'Adobe', status: 'attached', note: '取引に紐付け済み', score: 98 },
      { vendorRef: '備品購入', status: 'candidate', note: '金額一致、日付差異', score: 72 },
    ],
    matchings: [
      { invoiceRef: 'INV-0421', invoiceAmount: 330000, paidAmount: 326700, diffNote: '振込手数料候補', status: 'open', score: 88 },
      { invoiceRef: 'INV-0422', invoiceAmount: 550000, paidAmount: 550000, diffNote: '完全一致', status: 'done', score: 99 },
      { invoiceRef: 'INV-0425', invoiceAmount: 198000, paidAmount: 0, diffNote: '未入金', status: 'urgent', score: 61 },
    ],
    monthlyChecks: [
      { title: '売掛金残高', note: '前月比 +32%', detail: '増加率が高い', status: 'open', score: 71 },
      { title: '預金残高', note: '帳簿残高と銀行明細を照合', detail: '月末残高一致', status: 'done', score: 97 },
      { title: '仮払金', note: '前月から繰越 2件', detail: '内容確認が必要', status: 'open', score: 74 },
      { title: '役員貸付金', note: '変動なし', detail: '問題なし', status: 'done', score: 96 },
      { title: '外注費', note: '源泉対象候補あり', detail: '確認が必要', status: 'urgent', score: 69 },
    ],
    trendData: [
      { account: '売上高', prev3: [4200000, 4800000, 5100000], curr: 5400000, changePct: 5.9, flag: 'ok' },
      { account: '広告宣伝費', prev3: [180000, 195000, 210000], curr: 350000, changePct: 66.7, flag: 'alert' },
      { account: '外注費', prev3: [280000, 310000, 290000], curr: 385000, changePct: 32.8, flag: 'alert' },
      { account: '売掛金', prev3: [1200000, 1350000, 1420000], curr: 1880000, changePct: 32.4, flag: 'alert' },
      { account: '旅費交通費', prev3: [42000, 38000, 45000], curr: 48000, changePct: 6.7, flag: 'ok' },
      { account: '消耗品費', prev3: [32000, 28000, 35000], curr: 43000, changePct: 22.9, flag: 'ok' },
    ],
    tasks: [
      { title: '広告費 220,000円の消費税区分を確認', note: '過去ルールと異なる候補を検出', category: 'AI仕訳候補', status: 'urgent', score: 82 },
      { title: '4月分カード明細の証憑が不足', note: '顧問先への依頼文を作成済み', category: '証憑', status: 'urgent', score: 76 },
      { title: '請求INV-0421と入金額に差異', note: '振込手数料の可能性あり', category: '消込', status: 'open', score: 88 },
      { title: '外注費 385,000円の源泉対象確認', note: '摘要に個人名を検出', category: '月次チェック', status: 'open', score: 69 },
      { title: '旅費交通費の領収書候補を承認', note: 'Drive内に一致候補あり', category: '証憑', status: 'done', score: 93 },
      { title: '売掛金残高の前月差異確認', note: '増加率がルール閾値を超過', category: '月次チェック', status: 'open', score: 71 },
    ],
  },
  {
    externalKey: 'shibuya-cafe',
    name: '渋谷カフェ合同会社',
    industry: '飲食',
    vendor: 'freee',
    vendorSource: 'freee',
    ownerLabel: '担当: 田中 / 締切 5月12日',
    progress: 64,
    tasksOpen: 14,
    risk: 4,
    receipt: 74,
    missing: 9,
    diff: 5,
    matches: 18,
    chatMessage:
      '渋谷カフェは軽減税率の混在が複数あって要注意です。レジ日報の不足分を先に押さえましょう。現金残高も前月比で増えているので確認が必要です。',
    messageDraft:
      '渋谷カフェ合同会社 ご担当者様\n\n5月月次処理にあたり、レジ日報とカード売上明細の不足分をご共有ください。軽減税率の確認が必要な仕入が複数ありますので、納品書もあわせてお願いいたします。',
    contactPrimary: 'chatwork',
    contactEndpoints: { email: 'shibuya@example.com', slack: null, chatwork: '0000001', line_works: null },
    fiscalYearStart: new Date('2025-10-01'),
    fiscalYearEnd: new Date('2026-09-30'),
    rules: [
      { title: '飲食店は軽減税率の混在を重点確認', severity: 'high' },
      { title: '現金売上は日報添付を必須', severity: 'high' },
      { title: '食材仕入は仕入先別に消費税区分を保持', severity: 'mid' },
    ],
    entries: [
      { account: '仕入高', description: '食品卸 86,400円', amount: 86400, taxClass: '軽減税率8%候補', note: '同一仕入先で混在', status: 'urgent', score: 73, receiptStatus: 'partial' },
      { account: '売上高', description: 'Uber Eats 124,800円', amount: 124800, taxClass: '課税売上10%', note: '手数料控除あり', status: 'open', score: 81, receiptStatus: 'matched' },
      { account: '水道光熱費', description: '東京電力 45,300円', amount: 45300, taxClass: '課税仕入10%', note: '過去処理一致', status: 'done', score: 95, receiptStatus: 'matched' },
    ],
    receipts: [
      { vendorRef: 'レジ日報 5/12', status: 'missing', note: '依頼文作成済み', score: 66 },
      { vendorRef: '食品卸納品書', status: 'candidate', note: '税率確認待ち', score: 71 },
      { vendorRef: '電気料金', status: 'attached', note: '取引に紐付け済み', score: 95 },
    ],
    matchings: [
      { invoiceRef: 'カード売上 5/08', invoiceAmount: 168000, paidAmount: 162960, diffNote: '手数料候補', status: 'open', score: 84 },
      { invoiceRef: 'Uber Eats', invoiceAmount: 124800, paidAmount: 118560, diffNote: '手数料控除', status: 'done', score: 92 },
    ],
    monthlyChecks: [
      { title: '現金残高', note: '前月比 +18%', detail: '日報確認', status: 'open', score: 68 },
      { title: '軽減税率取引', note: '14件', detail: '税率混在', status: 'urgent', score: 73 },
    ],
    trendData: [
      { account: '売上高', prev3: [3800000, 4100000, 3900000], curr: 4300000, changePct: 10.3, flag: 'ok' },
      { account: '仕入高', prev3: [1400000, 1520000, 1480000], curr: 1720000, changePct: 16.2, flag: 'alert' },
      { account: '現金残高', prev3: [320000, 380000, 420000], curr: 496000, changePct: 18.1, flag: 'alert' },
      { account: '消耗品費', prev3: [28000, 32000, 30000], curr: 35000, changePct: 16.7, flag: 'ok' },
    ],
    tasks: [
      { title: '軽減税率の候補を確認', note: '同一仕入先で消費税区分が混在', category: 'AI仕訳候補', status: 'urgent', score: 73 },
      { title: '5月12日分レジ日報が不足', note: '売上取引に紐付け不可', category: '証憑', status: 'urgent', score: 66 },
      { title: 'カード売上の入金差異', note: '決済手数料候補', category: '消込', status: 'open', score: 84 },
      { title: '現金残高が前月比で増加', note: '現金売上の締め確認', category: '月次チェック', status: 'open', score: 68 },
    ],
  },
  {
    externalKey: 'nihonbashi-kogyo',
    name: '日本橋工業株式会社',
    industry: '建設・工事',
    vendor: 'both',
    vendorSource: 'mf',
    ownerLabel: '担当: 佐藤 / 締切 5月15日',
    progress: 42,
    tasksOpen: 25,
    risk: 7,
    receipt: 58,
    missing: 16,
    diff: 8,
    matches: 39,
    chatMessage:
      '日本橋工業は今月も案件コード未設定が多いです。まず資産計上候補の請求書を押さえて、その後案件コードの一括整理を優先しましょう。買掛金の滞留も気になります。',
    messageDraft:
      '日本橋工業株式会社 ご担当者様\n\n月次処理のため、工具器具備品の請求書、工事別の納品書、未入金先の確認資料をご共有ください。案件コードが未設定の取引もあります。',
    contactPrimary: 'email',
    contactEndpoints: { email: 'nihonbashi@example.com', slack: 'C0123456789', chatwork: null, line_works: null },
    fiscalYearStart: new Date('2025-07-01'),
    fiscalYearEnd: new Date('2026-06-30'),
    rules: [
      { title: '資産計上・少額減価償却資産の判定候補を検出', severity: 'high' },
      { title: '工事別原価は案件コード必須', severity: 'high' },
      { title: '買掛金残高の長期滞留を検出', severity: 'mid' },
    ],
    entries: [
      { account: '工具器具備品', description: '測定器 248,000円', amount: 248000, taxClass: '資産計上候補', note: '少額減価償却資産の適用可否を確認', status: 'urgent', score: 65, receiptStatus: 'missing' },
      { account: '外注費', description: '現場応援 660,000円', amount: 660000, taxClass: '案件コード未設定', note: '原価未割当', status: 'urgent', score: 58, receiptStatus: 'partial' },
      { account: '材料費', description: '鋼材 1,120,000円', amount: 1120000, taxClass: '課税仕入10%', note: '請求書候補あり', status: 'open', score: 79, receiptStatus: 'partial' },
    ],
    receipts: [
      { vendorRef: '測定器請求書', status: 'missing', note: '固定資産判定に必要', score: 65 },
      { vendorRef: '鋼材納品書', status: 'candidate', note: '案件コード確認', score: 72 },
    ],
    matchings: [
      { invoiceRef: '工事A-041', invoiceAmount: 1980000, paidAmount: 0, diffNote: '未入金', status: 'urgent', score: 62 },
      { invoiceRef: '工事B-033', invoiceAmount: 880000, paidAmount: 879450, diffNote: '手数料候補', status: 'open', score: 83 },
    ],
    monthlyChecks: [
      { title: '買掛金滞留', note: '90日超 3件', detail: '支払予定確認', status: 'urgent', score: 60 },
      { title: '案件コード', note: '未設定 8件', detail: '原価集計不可', status: 'urgent', score: 58 },
      { title: '試算表', note: '売上総利益率が前月比 -6pt', detail: '原価計上時期を確認', status: 'open', score: 72 },
      { title: '未払金', note: '期末未払計上候補 4件', detail: '請求書到着済み', status: 'open', score: 76 },
    ],
    trendData: [
      { account: '売上高', prev3: [18000000, 22000000, 19500000], curr: 16800000, changePct: -13.8, flag: 'alert' },
      { account: '外注費', prev3: [4200000, 5100000, 4800000], curr: 6600000, changePct: 37.5, flag: 'alert' },
      { account: '売上総利益率', prev3: [28.0, 27.5, 29.0], curr: 23.0, changePct: -6.0, flag: 'alert' },
      { account: '買掛金', prev3: [3200000, 3800000, 4100000], curr: 5400000, changePct: 31.7, flag: 'alert' },
      { account: '材料費', prev3: [6800000, 7200000, 6900000], curr: 7800000, changePct: 13.0, flag: 'ok' },
    ],
    tasks: [
      { title: '資産計上候補を確認', note: '工具器具備品または少額減価償却資産の可能性', category: 'AI仕訳候補', status: 'urgent', score: 65 },
      { title: '案件コード未設定の外注費', note: '工事別原価に未割当', category: '月次チェック', status: 'urgent', score: 58 },
      { title: '納品書と請求書の紐付け待ち', note: '候補が複数あり', category: '証憑', status: 'open', score: 64 },
      { title: '売掛金の未消込', note: '前月から残っている入金待ち', category: '消込', status: 'urgent', score: 62 },
    ],
  },
  {
    externalKey: 'yokohama-medical',
    name: '横浜メディカル株式会社',
    industry: '医療',
    vendor: 'mf',
    vendorSource: 'mf',
    ownerLabel: '担当: 高橋 / 締切 5月11日',
    progress: 78,
    tasksOpen: 9,
    risk: 3,
    receipt: 86,
    missing: 5,
    diff: 3,
    matches: 31,
    chatMessage:
      '横浜メディカルは保険収入と自費収入の区分が今月の重点です。リース契約の更新資料さえ入手できれば、かなり進みますよ！部門配賦も忘れずに。',
    messageDraft:
      '横浜メディカル株式会社 ご担当者様\n\n保険収入の明細、自費診療の集計表、リース契約の更新資料をご共有ください。部門別配賦の確認が必要な取引があります。',
    contactPrimary: 'line_works',
    contactEndpoints: { email: 'yokohama@example.com', slack: null, chatwork: null, line_works: 'lw-channel-uuid' },
    fiscalYearStart: new Date('2025-04-01'),
    fiscalYearEnd: new Date('2026-03-31'),
    rules: [
      { title: '医療材料は部門別に配賦', severity: 'mid' },
      { title: '保険収入と自費収入を区分', severity: 'high' },
      { title: 'リース契約は月額と残債を確認', severity: 'mid' },
    ],
    entries: [
      { account: '売上高', description: '診療収入 2,420,000円', amount: 2420000, taxClass: '区分確認', note: '保険/自費混在', status: 'urgent', score: 74, receiptStatus: 'partial' },
      { account: 'リース料', description: '医療機器 132,000円', amount: 132000, taxClass: '契約更新確認', note: '前月差異', status: 'open', score: 70, receiptStatus: 'missing' },
      { account: '材料費', description: '医療材料 520,000円', amount: 520000, taxClass: '部門配賦', note: '一括計上', status: 'open', score: 77, receiptStatus: 'matched' },
    ],
    receipts: [
      { vendorRef: '保険収入明細', status: 'candidate', note: '売上に紐付け待ち', score: 80 },
      { vendorRef: 'リース契約', status: 'missing', note: '月額変更確認', score: 70 },
    ],
    matchings: [
      { invoiceRef: '保険入金', invoiceAmount: 2420000, paidAmount: 2420000, diffNote: '一致', status: 'done', score: 98 },
      { invoiceRef: '自費診療', invoiceAmount: 318000, paidAmount: 315600, diffNote: '決済手数料候補', status: 'open', score: 86 },
    ],
    monthlyChecks: [
      { title: '部門別材料費', note: '未配賦 6件', detail: '確認必要', status: 'open', score: 77 },
      { title: 'リース債務', note: '前月差異', detail: '契約更新確認', status: 'open', score: 70 },
    ],
    trendData: [
      { account: '診療収入', prev3: [2100000, 2250000, 2380000], curr: 2420000, changePct: 1.7, flag: 'ok' },
      { account: '保険収入', prev3: [1680000, 1800000, 1900000], curr: 1930000, changePct: 1.6, flag: 'ok' },
      { account: '材料費', prev3: [420000, 450000, 490000], curr: 520000, changePct: 6.1, flag: 'ok' },
      { account: 'リース料', prev3: [118000, 118000, 118000], curr: 132000, changePct: 11.9, flag: 'alert' },
    ],
    tasks: [
      { title: '保険収入と自費収入の区分', note: '摘要から混在を検出', category: 'AI仕訳候補', status: 'urgent', score: 74 },
      { title: 'リース契約更新資料が不足', note: '月額変更の可能性', category: '証憑', status: 'open', score: 70 },
      { title: '部門別配賦の確認', note: '医療材料費が一括計上', category: '月次チェック', status: 'open', score: 77 },
    ],
  },
];

const receiptPolicies: Array<{
  account: string;
  requiresReceipt: boolean;
  requiresApproval: boolean;
  exemptUnder?: number;
  notes?: string;
}> = [
  { account: '広告宣伝費', requiresReceipt: true, requiresApproval: false },
  { account: '旅費交通費', requiresReceipt: true, requiresApproval: false, exemptUnder: 3000 },
  { account: '消耗品費', requiresReceipt: true, requiresApproval: false },
  { account: '通信費', requiresReceipt: false, requiresApproval: false },
  { account: '外注費', requiresReceipt: true, requiresApproval: true, notes: '源泉対象判定が必要' },
  { account: '会議費', requiresReceipt: true, requiresApproval: false },
  { account: '租税公課', requiresReceipt: false, requiresApproval: false },
  { account: '工具器具備品', requiresReceipt: true, requiresApproval: true, notes: '固定資産判定' },
  { account: '材料費', requiresReceipt: true, requiresApproval: false },
  { account: '仕入高', requiresReceipt: true, requiresApproval: false },
  { account: 'リース料', requiresReceipt: true, requiresApproval: false },
  { account: '水道光熱費', requiresReceipt: true, requiresApproval: false },
  { account: '売上高', requiresReceipt: false, requiresApproval: false },
];

async function run() {
  for (const p of receiptPolicies) {
    await prisma.receiptPolicy.upsert({
      where: { account: p.account },
      create: p,
      update: p,
    });
  }

  for (const c of seedData) {
    const client = await prisma.client.upsert({
      where: { id: c.externalKey },
      update: {
        name: c.name,
        industry: c.industry,
        vendor: c.vendor,
        ownerLabel: c.ownerLabel,
        progress: c.progress,
        tasksOpen: c.tasksOpen,
        risk: c.risk,
        receipt: c.receipt,
        missing: c.missing,
        diff: c.diff,
        matches: c.matches,
        chatMessage: c.chatMessage,
        messageDraft: c.messageDraft,
        contactPrimary: c.contactPrimary,
        contactEndpoints: c.contactEndpoints,
        fiscalYearStart: c.fiscalYearStart,
        fiscalYearEnd: c.fiscalYearEnd,
      },
      create: {
        id: c.externalKey,
        name: c.name,
        industry: c.industry,
        vendor: c.vendor,
        ownerLabel: c.ownerLabel,
        progress: c.progress,
        tasksOpen: c.tasksOpen,
        risk: c.risk,
        receipt: c.receipt,
        missing: c.missing,
        diff: c.diff,
        matches: c.matches,
        chatMessage: c.chatMessage,
        messageDraft: c.messageDraft,
        contactPrimary: c.contactPrimary,
        contactEndpoints: c.contactEndpoints,
        fiscalYearStart: c.fiscalYearStart,
        fiscalYearEnd: c.fiscalYearEnd,
      },
    });

    // Replace child collections to keep seed idempotent
    await prisma.entry.deleteMany({ where: { clientId: client.id } });
    await prisma.receipt.deleteMany({ where: { clientId: client.id } });
    await prisma.matching.deleteMany({ where: { clientId: client.id } });
    await prisma.monthlyCheck.deleteMany({ where: { clientId: client.id } });
    await prisma.trendDatum.deleteMany({ where: { clientId: client.id } });
    await prisma.task.deleteMany({ where: { clientId: client.id } });
    await prisma.rule.deleteMany({ where: { clientId: client.id } });
    await prisma.vendorSync.deleteMany({ where: { clientId: client.id } });

    let entryIdx = 0;
    for (const e of c.entries) {
      entryIdx += 1;
      await prisma.entry.create({
        data: {
          clientId: client.id,
          source: c.vendorSource,
          sourceEntryId: `seed-${c.externalKey}-entry-${entryIdx}`,
          account: e.account,
          description: e.description,
          amount: e.amount,
          taxClass: e.taxClass,
          occurredAt: new Date('2026-04-15'),
          receiptStatus: e.receiptStatus,
          score: e.score,
        },
      });
    }

    let recIdx = 0;
    for (const r of c.receipts) {
      recIdx += 1;
      await prisma.receipt.create({
        data: {
          clientId: client.id,
          source: c.vendorSource,
          sourceReceiptId: `seed-${c.externalKey}-rec-${recIdx}`,
          status: r.status,
          vendorRef: r.vendorRef,
          occurredAt: new Date('2026-04-15'),
        },
      });
    }

    for (const m of c.matchings) {
      await prisma.matching.create({
        data: {
          clientId: client.id,
          source: c.vendorSource,
          invoiceRef: m.invoiceRef,
          invoiceAmount: m.invoiceAmount,
          paidAmount: m.paidAmount,
          diffNote: m.diffNote,
          status: m.status,
          occurredAt: new Date('2026-04-30'),
        },
      });
    }

    for (const mc of c.monthlyChecks) {
      await prisma.monthlyCheck.create({
        data: {
          clientId: client.id,
          title: mc.title,
          note: mc.note,
          detail: mc.detail,
          status: mc.status,
          score: mc.score,
        },
      });
    }

    for (const t of c.trendData) {
      await prisma.trendDatum.create({
        data: {
          clientId: client.id,
          account: t.account,
          prev3: t.prev3,
          curr: t.curr,
          changePct: t.changePct,
          flag: t.flag,
        },
      });
    }

    for (const ru of c.rules) {
      await prisma.rule.create({
        data: {
          clientId: client.id,
          type: 'template',
          industry: c.industry,
          title: ru.title,
          severity: ru.severity,
          createdBy: 'seed',
        },
      });
    }

    for (const tk of c.tasks) {
      await prisma.task.create({
        data: {
          clientId: client.id,
          title: tk.title,
          note: tk.note,
          category: tk.category,
          status: tk.status,
          score: tk.score,
          stage: tk.status === 'done' ? 'approved' : 'awaiting_approval',
          assignee: c.ownerLabel.split(' / ')[0].replace('担当: ', ''),
          approver: '畠山',
        },
      });
    }

    await prisma.vendorSync.create({
      data: {
        clientId: client.id,
        vendor: c.vendorSource,
        lastSync: new Date(),
        status: 'ok',
        count: c.entries.length,
      },
    });
  }

  console.log(`Seed complete. clients=${seedData.length}`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
