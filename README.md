# Gemini Web Bridge

Raspberry Pi上のDockerコンテナ群として動作する「自律型Gemini画像生成システム」です。
外部からの指示をAPIで受け、コンテナ内のブラウザを自動操作して画像を生成し、結果をDiscordに通知します。

## システム構成

- **gemini-api**: FastAPIサーバー。ジョブ管理とDiscord通知を担当。
- **gemini-browser**: Chromiumブラウザ + KasmVNC。TampermonkeyスクリプトでGeminiを操作。

## セットアップ手順

### 1. 環境設定

`.env` ファイルを編集し、Discord Webhook URLを設定してください。

```bash
cp .env.example .env
# .env を編集して DISCORD_WEBHOOK_URL を設定
```

### 2. コンテナ起動

```bash
docker compose up -d --build
```

### 3. ブラウザ設定 (初回のみ)

1. ブラウザで `https://<raspberry-pi-ip>:3006` にアクセスします。（警告が出ますが「詳細設定」から「進む」を選択して無視してください）
2. コンテナ内のChromiumで `https://gemini.google.com` にアクセスし、Googleアカウントでログインします。
3. Chromeウェブストアから **Tampermonkey** をインストールします。
4. Tampermonkeyのダッシュボードを開き、`userscript.js` の内容を新規スクリプトとして登録します。
   - **注意**: UserScript内のAPI URLは `http://gemini-api:8000` のままで問題ありません（Docker内部ネットワークを使用するため）。

## 🖥️ WebUI

`docker compose up` 起動後、LAN 内ブラウザから以下の URL にアクセスすることで WebUI を利用できます。

```
http://<your-server-ip>:8005/ui
```

> ローカルで動かしている場合は `http://localhost:8005/ui` でもアクセス可能です。

### 機能一覧

| タブ | 説明 |
|------|------|
| **T2I** | テキストから画像を生成します。プロンプトとモードを入力して「生成する」を押してください。 |
| **I2I** | 参照画像を元に画像を生成します。プロンプト・モード・参照画像（必須）を指定してください。 |
| **Multimodal** | プロンプトと任意の参照画像を組み合わせて画像を生成します。 |

### 使い方

1. ブラウザで `http://<ip>:8005/ui` を開く。
2. 上部タブで生成モード（T2I / I2I / Multimodal）を選択する。
3. プロンプトを入力し、モード（high-speed / thinking / pro）を選択する。
4. I2I / Multimodal の場合は参照画像を添付する。
5. 「生成する」ボタンを押すと、画面下部にジョブ ID・ステータス・詳細が表示される。
6. 生成が完了すると画像がページ内に表示され、ダウンロードリンクも表示される。

---

## 🚀 Usage

### 1. Internal API Access (Docker Network)
This system is designed to be used by other containers within the same Docker network (e.g., managed by Coolify).
Access the API using the service name `gemini-api` on port `8000`.

**Base URL:** `http://gemini-api:8000`

### 2. API Endpoints

#### 画像生成ジョブの登録
`POST /api/job`
`Content-Type: application/json`

**パラメータ:**
- `prompt` (string, required): 画像生成のプロンプト。
- `mode` (string, optional): "high-speed" (デフォルト) または "thinking"。
- `image_data` (string, optional): アップロードする画像のBase64エンコード文字列。

**リクエスト例 (基本):**
```json
{
  "prompt": "cybergirl, 8k, best quality",
  "mode": "high-speed"
}
```

**リクエスト例 (画像アップロードあり):**
※ `image_data` がある場合、自動的に「添付の人物と同一性を保ったまま画像を生成してください」という指示がプロンプトに追加されます。
```json
{
  "prompt": "wearing kimono",
  "mode": "high-speed",
  "image_data": "iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg=="
}
```
**Response:**
```json
{
  "job_id": "1",
  "status": "queued"
}
```

#### Poll Job Status ( & Get Image)
**GET** `/api/job?job_id={job_id}`

**Response (Processing):**
```json
{
  "id": "1",
  "status": "processing",
  "detailed_status": "Generating Image", // Detailed progress: Navigating, Inputting, Generating, etc.
  ...
}
```

**Response (Completed):**
```json
{
  "id": "1",
  "status": "completed",
  "result_url": "/images/1.png",
  "image": "<Base64 Encoded Image Data>" 
}
```
*Note: The `image` field contains the full Base64 string of the generated PNG, allowing you to retrieve the image directly without a second request.*

### 3. Integration Example (Python)
**Best Practice:** Do not hardcode the URL. Use an Environment Variable.

```python
import os
import requests
import time
import base64

# Read from Environment Variable (Configure this in Coolify/Docker)
# Example: "http://192.168.50.194:8005/api/job" or "http://gemini-api:8000/api/job"
API_URL = os.getenv("GEMINI_API_URL", "http://localhost:8005/api/job")

# 1. Submit Job
response = requests.post(API_URL, json={"prompt": "A cat"})
job_id = response.json()["job_id"]

# 2. Poll for Completion
while True:
    status_url = f"{API_URL}?job_id={job_id}" # Note: Adjust if base URL differs
    status_res = requests.get(status_url).json()
    
    if status_res["status"] == "completed":
        # 3. Decode Image
        image_data = base64.b64decode(status_res["image"])
        with open("result.png", "wb") as f:
            f.write(image_data)
        break
    time.sleep(5)
```

### 4. Networking Guide
- **Same Stack**: Use `http://gemini-api:8000` (Service Name).
- **Different Stack (Coolify)**: Use the Host IP `http://192.168.x.x:8005`.
    - *Tip: Set this as an Environment Variable (`GEMINI_API_URL`) in your client app's Coolify settings.*

## 🛠️ Development & Debugging

### Accessing the Browser
To debug the automation or sign in to Google:
- **URL:** `https://<your-server-ip>:3006`
- **User:** `kasm_user`
- **Password:** `password`

### Logs
Check logs to see the automation progress:
```bash
docker compose logs -f gemini-api
```

### Local Testing Procedure (API Only)
You can run a parallel testing API server on port **8006** without conflicting with the production instance (8005). The test browser container is NOT started to save resources.

1. **Start Test API**:
   ```bash
   ./run_test.sh
   # API: http://localhost:8006
   ```
2. **Connect Existing Browser**:
   - Access your existing browser (e.g. at port 3016).
   - Update the Userscript `API_BASE` to pointing to the test server:
     ```javascript
     const API_BASE = "http://<host-ip>:8006/api"; // Use Host IP, not localhost if in container
     ```
   - *Note:* If running Userscript inside a container, `localhost` refers to the container itself. You must use the host's IP address.
3. **Stop Test API**:
   ```bash
   ./stop_test.sh
   ```


## 更新履歴

### v1.2.1 (2025-12-05)
- **信頼性向上**:
  - サーバー側: `asyncio.Lock` 導入による競合状態の解消と、スタックしたジョブの自動リセット機能（2分タイムアウト）を追加。
  - クライアント側: `setInterval` を再帰的 `setTimeout` に変更し、ポーリングの重複を防止。また、キャッシュバスティング（`?t=timestamp`）を追加して確実に最新のジョブを取得するように改善。

### v1.2.2 (2025-12-05)
- **再ログイン通知機能**:
  - Userscriptが `accounts.google.com` への遷移を検知した場合、Discordに「再ログインが必要です」と通知を送る機能を追加（通知抑制機能付き）。

### v1.3.0 (2025-12-05)
- **タイムアウト処理の強化**:
  - **サーバー側**: Userscript（ブラウザ）からのポーリングが一定時間（10秒＝ポーリング間隔の2倍）途絶えた場合、ジョブを「エラー（Worker timeout）」として扱う処理を追加。
  - **クライアント側**: 画像生成処理中もハートビート（`busy=true`）を送信し続けるように変更し、サーバー側での誤検知を防止。
- **開発環境**:
  - Coolify環境とのポート競合を避けるため、デフォルトのポート設定を変更（API: 8006, Browser: 3015/3016）。

### v2.0.0 (2025-12-07)
- **詳細な進捗管理機能**:
  - `/api/progress` エンドポイントを追加し、ジョブステータスに `detailed_status` を追加。
  - Userscriptから各ステップ（入力開始、生成中、ダウンロード中など）ごとに進捗を報告するように変更。
- **エラー通知の強化**:
  - サーバー側で10秒以上Userscriptの応答がない場合、Discordに「Worker timeout」通知を即座に送信するように変更。
  - Userscriptのエラー報告時に、発生元のURLを含めるように改善。
- **信頼性改善**:
  - Geminiの読み込み遅延に対応するため、Userscriptの要素待機時間を20秒から60秒に延長。

### v2.1.0 (2025-12-08)
- **モデル選択機能**:
  - **思考モード (Thinking Mode)** と **高速モード (High Speed Mode)** の切り替えに対応。
  - APIに `mode` パラメータを追加（デフォルト: `high-speed`）。
  - UserscriptがGemini UI上の「高速モード」「思考モード」を認識して自動で切り替えを実行。

### v2.1.1 (2025-12-08)
- **Userscript修正**:
  - モード選択メニューの検出ロジックを改善（ボタン以外の要素や、メニュー展開後の確実なクリック処理を追加）。
  - バージョンを `2.1.1` に更新。

### v2.1.2 (2025-12-08)
- **バグ修正**:
  - Userscriptでエラー（タイムアウト等）が発生した場合、サーバー上のジョブが「失敗 (failed)」としてマークされるように修正。
  - 無限再試行ループ（ゾンビジョブのループ）を解消。
  - バージョンを `2.1.2` に更新。

### v2.2.0 (2025-12-08)
- **新機能 (画像アップロード)**:
  - API経由でBase64形式の画像データを送信し、Userscript側でGemini Chatにペースト（アップロード）する機能を追加。
  - **自動プロンプト調整**: 画像付きリクエストの場合、自動的に「添付の人物と同一性を保ったまま画像を生成してください」という指示をプロンプトに追加するようにサーバー側で処理。
  - `JobRequest` モデルと `processJob` ロジックを拡張。
  - 処理フロー: モード切替 → 画像ペースト(待機) → プロンプト入力 → 送信。
