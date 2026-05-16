export interface RuleTemplate {
  title: string;
  detail: string;
  severity: 'high' | 'mid' | 'low';
}

export const ruleTemplates: Record<string, RuleTemplate[]> = {
  '広告制作': [
    {
      title: '広告費は過去6回の消費税区分を優先',
      detail: '同一仕入先の直近6回の処理を優先採用する',
      severity: 'mid',
    },
    {
      title: '役員名義カードは証憑必須',
      detail: '役員カード明細は領収書添付を必須化',
      severity: 'high',
    },
    {
      title: '外注デザイナー費は源泉対象を確認',
      detail: '個人名が摘要にある外注費は源泉判定対象',
      severity: 'high',
    },
  ],
  '飲食': [
    {
      title: '軽減税率の混在を重点確認',
      detail: '同一仕入先で 8% / 10% が混在する場合は要確認',
      severity: 'high',
    },
    {
      title: '現金売上は日報添付を必須',
      detail: 'レジ日報がない日の現金売上は計上保留',
      severity: 'high',
    },
    {
      title: '食材仕入は仕入先別に消費税区分を保持',
      detail: '同一仕入先の税区分が前月と異なる場合に警告',
      severity: 'mid',
    },
  ],
  'EC': [
    {
      title: '決済手数料の自動仕訳は別科目化',
      detail: 'カード/PayPay/Stripe の手数料を「支払手数料」に振替',
      severity: 'mid',
    },
    {
      title: '在庫の月末調整を必須化',
      detail: '棚卸資産の期末調整漏れを検出',
      severity: 'high',
    },
  ],
  '不動産': [
    {
      title: '家賃収入は契約期間で按分',
      detail: '前受家賃の振替を月次で実行',
      severity: 'mid',
    },
    {
      title: '修繕費 vs 資本的支出の判定',
      detail: '20万円超の修繕は資本的支出候補',
      severity: 'high',
    },
  ],
  '建設・工事': [
    {
      title: '工事別原価は案件コード必須',
      detail: '案件コード未設定の外注/材料費を検出',
      severity: 'high',
    },
    {
      title: '買掛金残高の長期滞留を検出',
      detail: '90日超の買掛金を警告',
      severity: 'mid',
    },
    {
      title: '資産計上・少額減価償却資産の判定',
      detail: '工具器具備品の取得原価で要確認',
      severity: 'high',
    },
  ],
  '医療': [
    {
      title: '医療材料は部門別に配賦',
      detail: '一括計上を部門別に按分',
      severity: 'mid',
    },
    {
      title: '保険収入と自費収入を区分',
      detail: '診療収入の混在を検出',
      severity: 'high',
    },
    {
      title: 'リース契約は月額と残債を確認',
      detail: 'リース料の前月差異を警告',
      severity: 'mid',
    },
  ],
  'その他': [
    {
      title: '前月比 ±15% を超える勘定科目を確認',
      detail: '一般的な異常値検出',
      severity: 'mid',
    },
  ],
};
