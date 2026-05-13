# NoahChat3 セットアップガイド

## 目次

1. [前提条件](#1-前提条件)
2. [Discord Bot の準備](#2-discord-bot-の準備)
3. [環境変数の設定](#3-環境変数の設定)
4. [ペルソナの設定](#4-ペルソナの設定)
5. [起動方法](#5-起動方法)
6. [RAG インデックスの管理](#6-rag-インデックスの管理)
7. [トラブルシューティング](#7-トラブルシューティング)

---

## 1. 前提条件

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Bun | v1.x 以上 | ローカル一括起動 / Bot Core |
| Python | 3.11 以上 | RAG サービス |
| Docker Desktop (または Docker Engine + Compose v2) | 任意 | Docker Compose 利用時のみ |

### 対応環境

このプロジェクトは NVIDIA GPU と Windows 固有構成を前提にしていません。Apple Silicon Mac と Raspberry Pi 5 8GB RAM では同じ `compose.yaml` を使い、各ホストの native architecture でビルドしてください。

RAG の `RAG_DEVICE=auto` は次のように動きます。

- Apple Silicon Mac のローカルPython実行: PyTorch MPS が利用可能なら `mps`
- Docker Desktop on Mac: コンテナからMPSを利用できないため `cpu`
- Raspberry Pi 5: `cpu`、かつCPUスレッド数を控えめに自動調整

Raspberry Pi 5 でメモリが厳しい場合は `.env` で次のように下げてください。

```env
RAG_TORCH_NUM_THREADS=1
RAG_ENCODE_BATCH_SIZE=1
RAG_MAX_EMBED_TEXT_CHARS=6000
```

---

## 2. Discord Bot の準備

ペルソナごとに Discord Bot を1つ作成する必要があります。

### 2-1. Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) を開く
2. **New Application** をクリックし、Bot 名を入力
3. 左メニューの **Bot** を選択
4. **Reset Token** をクリックしてトークンを発行・コピー（後で `.env` に貼る）

### 2-2. インテントの有効化

Bot ページの **Privileged Gateway Intents** セクションで以下を **ON** にする：

- `SERVER MEMBERS INTENT`（任意）
- **`MESSAGE CONTENT INTENT`** ← **必須。これがないとメッセージを読めない**

### 2-3. サーバーへの招待

1. 左メニューの **OAuth2 > URL Generator** を選択
2. **Scopes**: `bot` にチェック
3. **Bot Permissions**: `Send Messages`, `Read Messages/View Channels`, `Read Message History` にチェック
4. 生成された URL をブラウザで開き、Bot を招待するサーバーを選択

---

## 3. 環境変数の設定

`.env.example` をコピーして `.env` を作成します。

```bash
cp .env.example .env
```

`.env` を編集して各値を設定します：

```env
# ペルソナごとの Discord Bot トークン（ペルソナの token_env に合わせた変数名）
DISCORD_TOKEN_EXAMPLE=your_discord_bot_token_here

# RAG用メッセージ収集専用 Bot トークン（任意）
DISCORD_RAG_COLLECTOR_TOKEN=your_collector_bot_token_here

# Google Gemini API キー（必須）
# https://aistudio.google.com/app/apikey から取得
GEMINI_API_KEY=your_gemini_api_key_here

# Ollama サーバーの URL（任意 / フォールバック用）
# Docker 内から Mac ローカルの Ollama を参照する場合は host.docker.internal を使う
OLLAMA_BASE_URL=http://host.docker.internal:11434

# RAG サービスの URL（Docker Compose 利用時は変更不要）
RAG_SERVICE_URL=http://rag:8002
```

> **補足**: `DISCORD_TOKEN_EXAMPLE` の変数名はペルソナ YAML の `token_env` フィールドと一致させる必要があります。ペルソナを追加するたびに対応する変数も追加してください。
>
> Discord 添付画像を Ollama にも渡す場合は、`llm.ollama.model` に `gemma3`、`llava`、`qwen2.5vl` などの vision 対応モデルを設定してください。テキスト専用モデルでは画像入力を扱えません。

### 全環境変数一覧

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `DISCORD_TOKEN_<ID>` | ✅ | — | ペルソナの Discord Bot トークン |
| `DISCORD_RAG_COLLECTOR_TOKEN` | — | — | RAG用メッセージ収集専用 Discord Bot トークン |
| `GEMINI_API_KEY` | ✅ | — | Google Gemini API キー |
| `OLLAMA_BASE_URL` | — | `http://localhost:11434` | Ollama サーバーの URL |
| `RAG_SERVICE_URL` | — | `http://localhost:8002` | RAG サービスの URL |
| `PERSONAS_DIR` | — | `personas` | ペルソナ YAML ディレクトリのパス |
| `HISTORY_DIR` | — | `data/history` | 会話履歴 SQLite DB の保存先 |
| `TRANSFORMERS_CACHE` | — | `/app/.cache` | HuggingFace モデルキャッシュパス（RAG サービス） |
| `RAG_DEVICE` | — | `auto` | RAG 埋め込みモデルの実行デバイス。MacローカルではMPS、Docker/PiではCPUを自動選択 |
| `RAG_TORCH_NUM_THREADS` | — | `auto` | RAG のCPUスレッド数 |
| `RAG_ENCODE_BATCH_SIZE` | — | `auto` | RAG再構築時の埋め込みバッチサイズ。MPSでは大きめ、Pi/CPUでは控えめに自動調整 |
| `RAG_MAX_EMBED_TEXT_CHARS` | — | `12000` | 1検索単位あたり埋め込みへ渡す最大文字数 |
| `RAG_INDEX_REBUILD_TIMEOUT_MS` | — | `7200000` | Discord履歴FAISS再構築リクエストのタイムアウト |
| `RAG_INDEX_REBUILD_ATTEMPTS` | — | `1` | Discord履歴FAISS再構築リクエストの試行回数 |

---

## 4. ペルソナの設定

ペルソナは `bot_core/personas/` ディレクトリ内の YAML ファイルで定義します。1ファイル = 1 Bot です。

### 4-1. YAML ファイルの作成

```bash
cp bot_core/personas/example.yaml bot_core/personas/mybot.yaml
```

### 4-2. YAML フィールド詳細

```yaml
# ---- 必須フィールド ----

id: mybot                        # 一意な識別子。ログ出力やDBのキーになる
token_env: DISCORD_TOKEN_MYBOT   # .env に記載した変数名（トークン値を直書きしない）
display_name: "My Bot"           # ログ上の表示名

# ---- LLM 設定 ----

llm:
  system_prompt: |
    あなたは...（Bot のキャラクターや役割を記述する）

  gemini:
    model: gemini-2.5-flash      # 使用する Gemini モデル（プライマリ）

  ollama:
    model: qwen2.5:7b            # 使用する Ollama モデル（フォールバック）
    base_url: ~                  # null = OLLAMA_BASE_URL 環境変数を使用
                                 # 個別に指定する場合: http://your-server:11434

# ---- RAG 設定 ----

rag:
  index_path: data/faiss_indices/mybot.index  # FAISSインデックスの保存パス
  top_k: 5                       # 検索で取得するチャンク数
  enabled: true                  # false にすると RAG を使わずに応答

# ---- MCP 設定（現在は空リストで問題なし）----

mcp:
  auto_approve: []
  require_confirm: []
```

### 4-3. フォールバック挙動

```
Gemini API 呼び出し
    ↓ 失敗（5xx / タイムアウト）
Ollama にフォールバック（警告ログ出力）

※ 400 系エラー・コンテンツポリシー違反の場合はフォールバックしない
※ RAG サービスが応答しない場合は空コンテキストで LLM 呼び出しを継続
```

### 4-4. 環境変数への Discord トークン追加

```env
# .env に追加
DISCORD_TOKEN_MYBOT=your_new_bot_token_here
```

---

## 5. 起動方法

### 方法 A: ローカル一括起動（推奨 / Docker不要）

リポジトリ直下で次の1コマンドを実行します。初回は Python venv 作成、RAG 依存関係のインストール、`bot_core` の `bun install` も自動で行います。

```bash
bun run start
```

このコマンドは以下をまとめて行います。

- `.env` を読み込み
- RAG サービスを `http://localhost:8002` で起動
- RAG の healthcheck 完了後に Discord Bot を起動
- `data/history` と `data/faiss_indices` をリポジトリ直下に統一

停止は `Ctrl+C` です。

### 方法 B: Docker Compose

すべてのサービスを一括起動します。

```bash
# 初回ビルドと起動（RAG のモデルダウンロードで数分かかる場合あり）
docker compose up --build

# バックグラウンドで起動
docker compose up --build -d

# ログを確認
docker compose logs -f bot_core
docker compose logs -f rag

# 停止
docker compose down
```

#### ペルソナ追加後の再起動

```bash
docker compose restart bot_core
```

> ペルソナ YAML は `bot_core/personas/` がコンテナにマウントされているため、**再ビルド不要**でファイルを追加・編集できます。

#### サービス構成

```
localhost:8002  ←→  rag         (FastAPI + FAISS)
                ←→  bot_core    (Discord Bot / TypeScript)
```

### 方法 C: ローカル個別起動（開発時）

RAG サービスと Bot Core を別々のターミナルで起動します。

**ターミナル 1 — RAG サービス**

```bash
cd services/rag
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8002 --reload
```

**ターミナル 2 — Bot Core**

```bash
cd bot_core
bun install
bun run src/main.ts
```

> ローカル起動時は `.env` の `RAG_SERVICE_URL` を `http://localhost:8002` に変更してください。

---

## 6. RAG インデックスの管理

RAG（Retrieval-Augmented Generation）を使うと、Bot が独自の知識ベースを参照して回答できます。  
埋め込みモデルには `cl-nagoya/ruri-v3-30m`（日本語対応）を使用しています。

### Discord履歴の自動収集

`DISCORD_RAG_COLLECTOR_TOKEN` を設定すると、RAG用メッセージ収集専用Botが参加しているサーバーではそのBotが履歴を収集します。収集専用Botが参加していないサーバーでは、そのサーバーに参加している会話用Botがfallbackとして収集します。

検索対象は引き続き各ペルソナの会話用Botが参加しているサーバーだけです。収集専用Botが他のサーバーに参加していても、ペルソナBotが参加していないサーバーの履歴はそのペルソナのRAGインデックスには入りません。

### テキストを1件追加

```bash
curl -X POST http://localhost:8002/index/add \
  -H "Content-Type: application/json" \
  -d '{
    "text": "追加したいテキスト",
    "metadata": {"source": "manual"},
    "index_path": "data/faiss_indices/mybot.index"
  }'
```

### ディレクトリ内のファイルからまとめて構築

```bash
curl -X POST http://localhost:8002/index/build \
  -H "Content-Type: application/json" \
  -d '{
    "source_dir": "/path/to/docs",
    "index_path": "data/faiss_indices/mybot.index"
  }'
```

### 検索テスト

```bash
curl -X POST http://localhost:8002/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "検索したいキーワード",
    "index_path": "data/faiss_indices/mybot.index",
    "top_k": 5
  }'
```

### ヘルスチェック

```bash
curl http://localhost:8002/health
# → {"status":"ok"}
```

> インデックスファイルは `data/faiss_indices/` に保存されます。  
> Docker Compose ではこのディレクトリがホスト側にマウントされているため、コンテナを再起動してもデータは保持されます。

---

## 7. トラブルシューティング

### Bot がメッセージに応答しない

1. DM で送っているか、サーバー内なら `@BotName` でメンションしているか確認
2. Developer Portal で **MESSAGE CONTENT INTENT** が ON になっているか確認
3. ログに `Logged in as` が出力されているか確認
4. ログに `Received DM` または `Received mention` が出るか確認

```bash
docker compose logs bot_core | grep -E "Logged in|Received (DM|mention)"
```

### `GEMINI_API_KEY is not set` エラー

- `.env` に `GEMINI_API_KEY` が設定されているか確認
- `compose.yaml` に `env_file: .env` が含まれているか確認

### RAG サービスが起動しない / 遅い

- 初回起動時は埋め込みモデル（約 100 MB）のダウンロードが発生するため数分かかる
- ログでダウンロード状況を確認：

```bash
docker compose logs -f rag
```

### 8002番ポートが使用中 / 古いRAGを止めたい

ローカル一括起動 (`bun run start`) は、`http://localhost:8002/health` が応答する場合は既存のRAGサービスを再利用します。RAG側のコードや環境変数を変更した後は、8002番ポートで動いている古いRAGプロセスを止めてから再起動してください。

まず使用中のプロセスを確認します。

```bash
lsof -nP -iTCP:8002 -sTCP:LISTEN
```

表示された `PID` を指定して停止します。

```bash
kill <PID>
```

終了しない場合だけ強制終了します。

```bash
kill -9 <PID>
```

Docker Composeで起動したRAGを止める場合は、プロセスを直接killせずComposeで止めます。

```bash
docker compose stop rag
```

停止後、ローカル一括起動をやり直します。

```bash
bun run start
```

### ペルソナが読み込まれない

- YAML ファイルが `bot_core/personas/` に配置されているか確認
- YAML の構文エラーはログに表示される：

```bash
docker compose logs bot_core | grep "persona-manager"
```

- `token_env` に指定した変数名が `.env` に存在するか確認

### 会話履歴をリセットしたい

SQLite DB は `data/history/` に `<persona_id>.db` という名前で保存されています。

```bash
rm data/history/mybot.db
```

---

## 付録: ディレクトリ構成

```
/
├── bot_core/
│   ├── src/
│   │   ├── main.ts              # エントリーポイント — 全ペルソナを起動
│   │   ├── gateway.ts           # Discord クライアント・イベント処理
│   │   ├── persona-manager.ts   # YAML 読み込み + Zod バリデーション
│   │   ├── orchestrator.ts      # RAG + LLM + セッション統合
│   │   ├── session.ts           # SQLite による会話履歴管理
│   │   ├── llm/
│   │   │   ├── gemini.ts        # Gemini API プロバイダー
│   │   │   ├── ollama.ts        # Ollama REST API プロバイダー
│   │   │   └── fallback-client.ts  # Gemini → Ollama フォールバック
│   │   └── services/
│   │       └── rag-client.ts    # RAG サービスへの HTTP クライアント
│   └── personas/                # ← ペルソナ YAML をここに追加
│
├── services/rag/                # RAG サービス (Python + FastAPI + FAISS)
│
├── data/
│   ├── faiss_indices/           # FAISS インデックスファイル
│   └── history/                 # SQLite 会話履歴 DB
│
├── compose.yaml
├── .env.example                 # ← これをコピーして .env を作成
└── .env                         # ← 実際の認証情報（Git 管理外）
```
