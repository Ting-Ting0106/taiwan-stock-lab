import type { MarketResearch } from './market';
export interface TrendDecision {version:'ai-trend-0.1.0';selected:{market:'TWSE'|'TPEX';code:string;reason:string}[];summary:string}
export interface TrendEvaluation {version:'trend-review-0.1.0';targetDate:string;targetTime:'11:00';observedAt:string;quoteAt:string;entryPrice:number;exitPrice:number;changePercent:number;direction:'up'|'down'|'flat';verdict:'correct'|'wrong'|'flat'|'unverified';onTime:boolean;note:string}
export interface PaperReview {version:'trend-review-0.1.0';evaluatedAt:string;status:'completed'|'partial';sampleCount:number;verifiedCount:number;correctCount:number;findings:string[];suggestions:string[]}
export interface PaperPosition {
 retrospectiveAt?:string;
 mode?:'trend_11';entryBasis?:'observed'|'analysis_snapshot'|'previous_close';entryObservedAt?:string;evaluation?:TrendEvaluation;
 buyQuote?:MarketResearch['stocks'][number]['quote'];sellQuote?:MarketResearch['stocks'][number]['quote'];buySource?:string;sellSource?:string;
 plannedExitDate?:string;calendarSource?:string;id:string;code:string;name:string;market:'TWSE'|'TPEX';queryId:string;openedAt:string;quoteAt:string;quantity:number;buyPrice:number;buyFee:number;cost:number;mark?:number;markedAt?:string;closedAt?:string;sellPrice?:number;sellFee?:number;proceeds?:number;pnl?:number;exitReason?:string;issue?:string;
}
export interface PaperDay {retrospective?:{recordedAt:string;originalState:string;reason:string};mode?:'trend_11';origin?:'schedule';decision?:TrendDecision;review?:PaperReview;plannedExitDate?:string;calendarSource?:string;id:string;date:string;queryId:string;strategy:string;publishedAt:string;model:string;prompt:string;snapshotHash:string;snapshot:MarketResearch;selected:string[];state:'recorded'|'zero'|'missed'|'processed'|'data_missing';notes:string[]}
export interface PaperAccount {version:'paper-next-session-0.1.0'|'paper-trend-0.2.0';initialCash:number;cash:number;enabled:boolean;positions:PaperPosition[];days:PaperDay[];lastCheckedAt?:string;error?:string}
export const paperAssumptions=[
 '初始虛擬資金10萬元，AI結構化名單最多3檔；只有12:00正式排程能建立部位，手動查詢不占名單。',
 '採假想成交，不等待進場區間、買賣價差或盤口；虛擬單位可有小數，不代表真實股數。',
 '優先取發布後可取得的當日最近成交；失敗時用分析快照，仍缺則用已知收盤估價，標示來源及時間。',
 '分析快照或前日收盤估價的樣本不納入正式方向命中率；不捏造即時價格。',
 '可用現金按剩餘名額分配，最多3檔、不借款；模擬成本買方0.2%、賣方0.5%，不另加價格滑價。',
 '下一預定交易日11:00起檢驗並結算；11:00～11:05首個有效最近成交作基準，不要求雙邊報價。',
 '缺11時資料則等待；遲到價格標記延遲，不當作準時11時回測或命中率樣本。',
 'AI偏多且有合法參考價格與可用資金時，直接記錄假想買進，不保證真實成交或上漲。',
 '11時產生結果及改進建議，下一次12時AI參考；不依單日輸贏自動改公式或舊結果。',
 '舊帳本保留版本與結果，不重設資金、不回填已結束查詢。服務須持續開啟。'
];
