# 四機台藍牙運動心率

繁體中文、深色介面的純前端心率面板，支援最多四支標準 BLE 心率裝置、展示模式、每台獨立錄製、本機歷史與 CSV 匯出。所有圖片、樣式、圖示及 Chart.js 4.5.1 均隨專案提供，不需外部 CDN。網站只提供靜態檔案，沒有帳號、後端 API 或雲端心率資料服務。

- [線上使用 GitHub Pages](https://root50643.github.io/exercise-heart-rate/)
- [GitHub 原始碼](https://github.com/root50643/exercise-heart-rate)

線上版本請使用支援 Web Bluetooth 的 Chrome、Edge 或樹莓派 Chromium；點擊「搜尋並連線」選取本機附近的裝置。沒有裝置時可使用展示模式。線上網站首次載入需要網路；若要在沒有網路的環境使用，請下載專案並依下方說明啟動本機版本。

## 啟動

先下載 GitHub 專案 ZIP 並解壓縮，或執行：

```sh
git clone https://github.com/root50643/exercise-heart-rate.git
cd exercise-heart-rate
```

請使用 **同一台電腦上的 Chrome、Edge，或樹莓派的 Chromium** 開啟 **http://localhost:8000**。勿直接雙擊 HTML 檔；JavaScript 模組與本機資料庫需要穩定的網頁來源。網站入口是 `index.html`，原有的 `運動心率.html` 會導向相同入口。

### 樹莓派 5

在專案目錄執行：

```sh
sh start.sh
```

腳本會優先使用 Node.js 18 以上版本；未安裝 Node.js 時改用 Python 3。也可直接執行 `python3 server.py`。保留終端機視窗，於 Chromium 開啟 `http://localhost:8000`；按 Ctrl+C 停止服務。

也可在專案目錄執行 `python3 -m http.server 8000 --bind 127.0.0.1`，再開啟 `http://localhost:8000`。

### Windows

安裝 Node.js 18 以上或 Python 3 並加入 PATH，雙擊 `start.bat`，然後在 Chrome 或 Edge 開啟 `http://localhost:8000`。亦可在專案目錄執行 `node server.mjs` 或 `py -3 server.py`。

服務固定綁定本機 `127.0.0.1:8000`。若埠號被占用，先停止原服務再啟動；請勿改用其他埠號來尋找舊紀錄。`localhost`、`127.0.0.1`、不同埠號及不同瀏覽器各自有獨立的資料儲存區。請一律使用 `http://localhost:8000`。

## 藍牙裝置準備

1. 開啟電腦／樹莓派藍牙，讓手錶或胸帶進入「心率廣播／分享心率」模式。
2. 裝置必須公開標準 Heart Rate Service `0x180D` 及可通知的 Heart Rate Measurement `0x2A37`。僅能透過原廠手機 App 讀取的手錶，不一定支援此模式；裝置有藍牙並不代表能讀取心率。
3. 若裝置只允許單一連線，先讓原廠 App 或其他接收器中斷連接。穿戴妥當後，在對應機台按下藍牙連線，從瀏覽器選取裝置。
4. 四格分別選取四支不同裝置。同一裝置不能同時綁在兩格；作業系統、轉接器及裝置實際可並行的數量仍需實機驗證。

Web Bluetooth 需要安全來源及使用者點擊；GitHub Pages 的 HTTPS 網址及本機 `localhost` 均提供所需的安全來源。Linux／樹莓派的 Chromium 若沒有 Web Bluetooth，可檢查 `chrome://flags/#enable-experimental-web-platform-features`，啟用後重新啟動瀏覽器；也需確認目前 Chromium 發行版本包含藍牙支援。這個旗標無法讓不相容的手錶支援心率廣播。參考 [Chrome Web Bluetooth 官方文件](https://developer.chrome.com/docs/capabilities/bluetooth)。

BLE 連線發生於**開啟網頁的電腦**。在另一台電腦開啟網頁不會使用樹莓派的藍牙；GitHub Pages 也不會代替使用者的電腦連接裝置。附帶的本機伺服器僅接受本機連線。

## 畫面與操作

四張卡片固定使用根目錄的 `exercise-machine.jpg`，以四象限呈現，無需上傳圖片：

| 位置／顏色 | 機台 | 原圖區域 |
| --- | --- | --- |
| 1／藍 | 划船／上肢機台 | 右上 |
| 2／綠 | 騎自行車／下肢機台 | 左下 |
| 3／紅 | 仰臥起坐／健腹器 | 左上 |
| 4／紫 | 健走／踩步機 | 右下 |

- **即時監看：**每格獨立連線，顯示最近 60 秒曲線。等待資料、接觸不良、逾時及斷線有不同狀態。超過 10 秒未收到有效心率，隱藏舊讀值、停止心跳動畫並在曲線留下缺口；零值與損壞封包不算有效樣本。
- **開始／停止紀錄：**連線與紀錄分開控制。每次新紀錄重設最低、平均及最高心率；停止紀錄後仍可監看。平均值是該次有效紀錄樣本的算術平均，並非時間加權平均。清除圖表只移除即時曲線，不刪除樣本或變更統計。
- **參考最大心率：**可逐格設定；未設定時只顯示 BPM。每次開始紀錄時固定保存當下設定，修改設定不會改變既有歷史紀錄。區間僅作運動參考。
- **斷線恢復：**意外斷線依 1、2、4、8、16 秒間隔重試，每次連線上限 15 秒。重連期間保留該次紀錄；全部失敗則標記中斷。手動斷線會結束紀錄並取消重試。
- **展示模式：**產生四路模擬心率，畫面及紀錄皆標明「模擬」。切換模式前必須停止所有紀錄；展示模式不需要 BLE 裝置。
- **歷史紀錄：**查看各次紀錄及曲線，可匯出 CSV 或刪除單筆紀錄。CSV 使用 UTF-8 BOM，包含真實／模擬來源、機台、裝置、UTC 時間、經過秒數與 BPM，可用 Excel 開啟；文字欄位處理引號及公式字首。

## 本機資料

設定、紀錄與逐筆樣本保存在 IndexedDB，沒有上傳到伺服器。樣本與統計一併提交；寫入失敗會停止錄製並顯示提示，即時監看仍可繼續。重新載入後不會自動續錄，尚未正常結束的紀錄標記為中斷。

公開 GitHub 儲存庫與 Pages 只包含程式及靜態素材，不包含瀏覽器內的運動紀錄。`http://localhost:8000` 與 `https://root50643.github.io` 是不同來源，本機舊紀錄不會自動移轉至線上版；需要保留時，請先在原網址匯出 CSV。CSV 目前僅供匯出，不支援匯入。

瀏覽器以來源（協定、主機、埠號）區分儲存區，不以網址路徑區分。同一 GitHub 帳號下的 Pages 專案共用 `https://root50643.github.io` 來源；本專案的不同副本若沿用同一資料庫名稱，也會共用資料與分頁鎖定。

同一瀏覽器來源只允許一個分頁負責監測與錄製。第二個分頁會進入唯讀模式，可查看及匯出歷史；要在第二個分頁開始監測，先關閉原分頁再重新整理。

紀錄會保留到自行刪除或清除瀏覽器網站資料；無痕視窗、瀏覽器清理或儲存空間不足都可能影響保存。重要紀錄請先匯出 CSV。使用時保持頁面開啟，避免裝置休眠或瀏覽器凍結分頁造成資料中斷。

## 專案架構與發布

```text
index.html                    網站入口
運動心率.html                 舊網址導向入口
exercise-machine.jpg          四機台固定圖片
assets/                       畫面、藍牙、心率解析及 IndexedDB 模組
  vendor/                     固定版本 Chart.js 與其授權文字
scripts/                      靜態網站建置工具
tests/                        單元、瀏覽器與 Pages 子路徑測試
.github/workflows/pages.yml   測試及 GitHub Pages 部署
server.mjs / server.py        本機靜態伺服器
start.bat / start.sh          Windows／樹莓派啟動腳本
```

開發與 CI 使用 **Node.js 22 以上**。安裝開發依賴並產生發布檔：

```sh
npm ci
npm run build
```

建置工具將入口、機台圖片、執行時使用的 `assets/` 與 `.nojekyll` 複製至 `dist/`。GitHub Pages 只發布這個目錄；原始碼儲存庫內的測試、啟動工具、文件與測試結果不會成為網站內容。`dist/`、`node_modules/` 及 `test-results/` 不提交至 Git。

儲存庫的 **Settings → Pages → Build and deployment → Source** 使用 **GitHub Actions**。推送至 `main` 會執行 `.github/workflows/pages.yml`，安裝依賴、執行單元測試、瀏覽器整合測試及 Pages 子路徑測試，通過後發布網站；也可在 Actions 手動執行。網站的圖片、CSS、模組及舊網址導向均使用相對路徑，支援 `/exercise-heart-rate/` 專案網址。

Chart.js 4.5.1 的第三方授權保留於 `assets/vendor/Chart.js-LICENSE.md`。`exercise-machine.jpg` 為使用者提供的素材；Chart.js 的授權不涵蓋該圖片或其他專案內容。公開儲存庫不代表所有素材皆取得相同的開放授權。

## 驗證與實機驗收

單元測試不需額外套件，在專案目錄執行：

```sh
npm test
```

瀏覽器整合測試使用 Playwright，涵蓋真實 IndexedDB、頁面互動、模擬 BLE、展示模式、CSV 與不同版面。先安裝測試套件及 Chromium，保持本機服務已啟動，再執行：

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

`npm run test:browser` 預設連到 `http://localhost:8000`；可設定 `BASE_URL` 指向另一個測試服務網址。請使用本機測試服務，避免把整合測試指向公開網站，因為 Pages 不發布 `tests/`。

驗證實際發布內容與 GitHub Pages 專案子路徑：

```sh
npm run test:pages
```

此指令會建置 `dist/`，以專案子路徑啟動測試伺服器，確認入口、舊網址導向、資源載入及基本頁面操作。無需事先啟動本機服務。

測試以獨立瀏覽器環境執行，畫面截圖輸出至 `test-results/`。若已有測試工具，可選擇設定環境變數 `PLAYWRIGHT_MODULE` 為 Playwright 模組入口的絕對路徑、`PLAYWRIGHT_BROWSER_PATH` 為 Chromium 執行檔的絕對路徑；未設定時使用上述安裝的套件與瀏覽器。這些套件只用於測試，執行心率面板本身不需 `npm install`。

另有兩小時等效的 IndexedDB 耐久測試。於本機網頁的瀏覽器開發者工具 Console 執行：

```js
await (await import('/tests/endurance.browser.mjs')).runEnduranceTest()
```

測試會把四路各 7,200 筆（合計 28,800 筆）模擬資料逐批實際提交至 IndexedDB，確認每格統計、逐筆數值及時間、重新開啟後的保存結果，以及即時圖表最多 61 點。它使用隨機名稱的專屬測試資料庫，結束後刪除該測試資料庫，不會修改既有運動紀錄。測試加速資料時間，不需要等待兩小時；實際執行時間依儲存裝置而異。

可先以展示模式檢查四路資料、錄製、停止、歷史、CSV、重新整理復原與窄螢幕版面，再以實際手錶驗證：

1. 一支裝置連線、8／16 位元心率（視裝置支援）、穿戴接觸狀態及讀值更新。
2. 四支同時連線，確認各機台數據不互相混用，重複綁定會被拒絕。
3. 錄製中離開範圍或暫停廣播，確認舊值逾時消失、圖表缺口、重連後沿用原紀錄。
4. 重試耗盡、手動斷線及重新整理時，確認紀錄狀態正確、沒有自動續錄。
5. 完成一次長時間實測後匯出 CSV，對照筆數、時間、來源及統計。

自動測試與模擬資料可驗證軟體行為，不能取代樹莓派、藍牙轉接器及實際手錶的相容性與四路連線驗收。
