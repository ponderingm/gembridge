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

1. ブラウザ (`http://<pi-ip>:3005`) でGoogleにログインし、Tampermonkeyを設定してください。
2. コンテナ内のChromiumで `https://gemini.google.com` にアクセスし、Googleアカウントでログインします。
3. Chromeウェブストアから **Tampermonkey** をインストールします。
4. Tampermonkeyのダッシュボードを開き、`userscript.js` の内容を新規スクリプトとして登録します。
   - **注意**: UserScript内のAPI URLは `http://gemini-api:8000` のままで問題ありません（Docker内部ネットワークを使用するため）。

## 使用方法

### 画像生成リクエスト

APIサーバーに対してPOSTリクエストを送信します。

```bash
curl -X POST "http://<raspberry-pi-ip>:8000/api/job" \
     -H "Content-Type: application/json" \
     -d '{"prompt": "A futuristic city with flying cars, cyberpunk style"}'
```

### 動作確認

1. APIにリクエストを送ると、`gemini-api` がジョブをキューに入れます。
2. `gemini-browser` 内のUserScriptがジョブを検知し、Geminiにプロンプトを入力します。
3. 画像が生成されると（※現状のスクリプトは画像検出ロジックが未完成です）、Discordに画像が送信されます。

## 開発者向け情報

- **APIドキュメント**: `http://<raspberry-pi-ip>:8000/docs`
- **ログ確認**: `docker compose logs -f`
