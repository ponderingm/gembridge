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

## 🚀 Usage

### 1. Internal API Access (Docker Network)
This system is designed to be used by other containers within the same Docker network (e.g., managed by Coolify).
Access the API using the service name `gemini-api` on port `8000`.

**Base URL:** `http://gemini-api:8000`

### 2. API Endpoints

#### Create a Job
**POST** `/api/job`
```json
{
  "prompt": "A futuristic city, digital art"
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
Here is how another container in the same network can request an image:

```python
import requests
import time
import base64

API_URL = "http://gemini-api:8000/api/job"

# 1. Submit Job
response = requests.post(API_URL, json={"prompt": "A cat"})
job_id = response.json()["job_id"]

# 2. Poll for Completion
while True:
    status_res = requests.get(f"{API_URL}?job_id={job_id}").json()
    if status_res["status"] == "completed":
        # 3. Decode Image
        image_data = base64.b64decode(status_res["image"])
        with open("result.png", "wb") as f:
            f.write(image_data)
        break
    time.sleep(5)
```

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
