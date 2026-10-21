# 資料契約與來源驗證

## v0.1 匯入

介面選 JSON 檔，內容為非空陣列，每次最多 100,000 筆，HTTP 大小上限 30 MB。以下是欄位示意，**數字為合成資料，不是真實行情，不應作為投資依據**：

```json
[
  { "code": "9999", "name": "欄位示意", "market": "TWSE", "date": "2026-10-14", "open": 100, "high": 102, "low": 99, "close": 101, "volume": 100000 }
]
```

market 為 TWSE 或 TPEX；日期是 Asia/Taipei 的完整交易日，格式 YYYY-MM-DD；價格為新台幣正數；volume 為股數，非張數、非成交金額。高價不低於開收低，低價不高於開收。相同市場、代碼、日期不得有衝突內容。每檔至少 60 筆才計算，歷史不足不補造；本版不自動補交易日。原始成交價格與公司行動需自行確認，目前無還原權息及上市主檔驗證；遇價格結構改變應暫停使用相關輸出。

v0.5.0 起另由後端取得下列官方公開資料；手動匯入的來源仍由使用者自行保有紀錄。不得將第三方數據未經授權再散布。

## 官方來源與驗證界線

- 證交所 OpenAPI：https://openapi.twse.com.tw/ ，規格：https://openapi.twse.com.tw/v1/swagger.json 。2026-10-16 已實測接入收盤與月歷史資料，詳見下方 v0.5.0；不代表完整盤中或全市場技術涵蓋。
- 櫃買中心官方入口：https://www.tpex.org.tw/ 。入口頁曾讀取失敗；2026-10-16 已實測 JSON 端點，詳見下方。再利用授權仍需按用途確認。
- 官方交易制度：https://www.twse.com.tw/zh/products/system/trading.html 。一般盤 09:00～13:30，實際排程需另驗交易日曆與例外。

每個來源正式串接前逐項驗證：文件與使用條款、涵蓋股票、延遲、時間戳意義、單位、缺漏、頻率限制、歷史深度、內外盤定義、保存與再利用權限、免費條件。無法驗證的欄位保持缺漏，不宣稱全市場中午分析。

## v0.2 AI 查詢資料

AI 網路查詢保存模型回覆及引用 URL，並不自動轉換成 Bar 或匯入行情資料庫；沒有引用的網路查詢記為失敗。模型可能誤讀來源，引用存在不保證數據正確。使用者勾選附加研究時，只提供最新一筆帶日期的收盤研究，不代表資料是即時的。問題與勾選的研究會送給 OpenAI；登入憑證不放入模型輸入，成交紀錄不自動附加。AI 與日 K 研究分開保存，不能把網路摘要當成可回測的盤中原始行情。


## v0.5.0 已實測接入來源（2026-10-16）

- 上市快照：https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL ，回傳 JSON 陣列與民國日期，成交量為股。www 主站同名端點本次即使 response=json 仍回 CSV，因此未採用。
- 上櫃快照：https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes ，成交量 TradingShares 為股。
- 公司與產業：https://openapi.twse.com.tw/v1/opendata/t187ap03_L 及 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O 。只納入公司主檔可對應的四位普通股，排除 ETF 與權證。
- 上市月歷史：https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo=2330 。依動態月份與代碼生成 URL，查核 stat/fields/data。
- 上櫃月歷史：https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=6488&date=2026/09/01&response=json 。欄位為成交張數，乘 1000 轉股，原資料僅有千股精度；量比同用此口徑。
- 盤中：https://mis.twse.com.tw/stock/api/getStockInfo.jsp ，查證券 ex_ch、d、t、z 及 a/b。z 無值時僅使用有自身時間的 trade.z/trade.t，明示最近成交；不以昨日收盤補值。不解析未核對單位的盤中成交量或內外盤。

資料日期以回傳為準，官方公開端點未提供本工具可承諾的服務 SLA。個人本機研究，不提供資料再散布。尚未完成全部使用條件、頻率上限與商用再利用授權審查，不宣稱可作商業行情服務。快取及每次 query.marketResearch 保留資料日期、來源與錯誤，不混入匯入 Bar 或舊回測資料。股票池僅為價量初選，AI 結果仍需實際檢查；沒有上漲或成交保證。

## v0.8.0 盤中資料與固定分類

2026-10-16 唯讀實測官方盤中 API HTTP 200，回傳 o/h/l/v。新增開高低、原始累計量及價量快照時間；v 單位未獨立核對，標記 source-unverified，禁止換算、跨來源相加或當成日線量比。價格需為正且符合高低範圍；缺值保留缺資料。成交自身時間與價量快照時間分開保存。

market-evidence-0.2.0 新增 selection（規則版本、分類時間、技術通過及各分類數量、優先代碼與限制）和各股 assessment（狀態、原因、排名與是否優先）。舊版欄位可缺省，不重新分類既有紀錄。日線量比定義為最後一日成交量除以前20個有效日均量；盤中 v 不參與。classification 不代表交易資格、已確認休市或可成交。

## v0.9.0 虛擬帳本

同一database.json新增可缺省paper欄位，不複製或改寫原交易。包含版本、初始現金、現金、啟用狀態、每日快照及持倉／已出清紀錄。query與schedule新增可缺省paperTrade欄位；未勾選不操作，失敗AI不模擬買進。模型不接收帳本。

官方年度日曆：https://www.twse.com.tw/holidaySchedule/holidaySchedule?response=json&queryYear=2026 ，2026-10-16實測HTTP200、stat=ok、queryYear及日期／名稱／說明欄位。當日臨時公告與公司行動仍待後續處理。成本及滑價為固定模擬假設；初始100000不是帳號真實資產。

## v0.9.1 開市證據

官方指數：https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw%7Cotc_o00.tw&json=1&delay=0 ，2026-10-16唯讀實測HTTP200，rtcode=0000，tse/t00及otc/o00均有當日d、t、正值z。年度日曆與指數只做查核，不傳入買進成交假設。query新增可缺省marketCheck（日期、open/closed/unknown、原因、查核時間與來源），新增market_closed／market_unknown狀態；舊紀錄不回填。

## v0.10.0 趨勢決策與驗證資料

Query新增trendMode、trendDecision（經schema驗證的AI代碼／理由／總結）、trendDecisionError及feedbackIds。模型價格不當作成交價；只用官方資料包或新取得參考價。JSON區塊驗證後獨立保存，正文移除，錯誤則保留未解析文字並禁止建立正式部位。

paper新版本paper-trend-0.2.0，PaperDay保存mode=trend_11、origin=schedule、decision與review；Position保存entryBasis、entryObservedAt與evaluation（目標日11時、觀察時間、原始價、漲跌、方向、正確／錯誤／持平／未驗證及原因）。估價或遲到樣本不納正式命中率。舊版可缺省所有新欄位，保留舊規則，不回填。

### 回溯假想買進
PaperDay.retrospective 保存 recordedAt、originalState、reason；PaperPosition.retrospectiveAt 記錄補記時間。openedAt 為原分析基準時間，不代表實際成交；價格取原日快照，quantity 為整數模擬股數（1000股=1張）。補記樣本一律不納正式命中率，原查詢與快照不變。

### 每日歷史紀錄保存與顯示
每日名單累積於 paper.days，新增日期不會清除舊資料；/api/state 回傳完整 paper 帳本，與查詢紀錄最新50筆的顯示限制分開。介面預設收合，標題顯示發布時間與股票中文名稱，依發布時間由新到舊排列。資料保存在各自電腦，刪除或重設資料目錄後不保留。

### 0.10.3 保存資料核對
新產生的 PaperReview.audit 可含 version=snapshot-audit-0.1.0、integrity、checks、observations、hypotheses、limitations。核對保存快照雜湊、時間、欄位及衍生乖離，並非官方原始數據獨立驗證；不宣稱完整指標重算。已完成的舊review不覆寫；新版從後續檢驗開始保存audit。此欄位隨既有review傳入下一次趨勢AI，不額外於11時呼叫AI。

### 產業強弱摘要
MarketResearch.sectorOverview（sector-snapshot-0.1.0）保存最新有效快照日期、同日涵蓋檔數與排除舊日檔數，各官方產業的總家數、有效漲跌家數、等權平均／中位數、上漲比例及漲幅靠前代表股。不是官方類股指數，尚無完整產業5／20日序列；小樣本不當作廣泛強勢。快照附欄位供AI與查詢紀錄顯示，不增加付費資料或券商串接。
