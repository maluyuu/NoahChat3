# NoahChat3 — Discord Bot (Multi-Persona)

TypeScript (Bun) + Python (FastAPI) のマイクロサービス構成で動作する、複数ペルソナ対応 Discord Bot。

---

## プロジェクト構成

```
/
├── bot_core/                  # Discord Bot コア (TypeScript + Bun)
│   ├── src/
│   │   ├── main.ts            # エントリーポイント — ペルソナ一括起動
│   │   ├── gateway.ts         # Discord クライアント作成・イベント処理
│   │   ├── persona-manager.ts # YAML 読み込み + Zod バリデーション
│   │   ├── orchestrator.ts    # RAG + LLM + セッション統合
│   │   ├── session.ts         # SQLite による会話履歴管理
│   │   ├── llm/
│   │   │   ├── types.ts       # 共通型定義 (ChatMessage, LLMProvider, LLMResponse)
│   │   │   ├── gemini.ts      # Gemini API プロバイダー
│   │   │   ├── ollama.ts      # Ollama REST API プロバイダー
│   │   │   └── fallback-client.ts  # Gemini → Ollama フォールバック
│   │   └── services/
│   │       └── rag-client.ts  # RAG サービスへの HTTP クライアント
│   ├── personas/              # ペルソナ YAML ファイル置き場
│   │   └── example.yaml
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
│
├── services/
│   └── rag/                   # RAG サービス (Python + FastAPI + FAISS)
│       ├── main.py            # FastAPI アプリ + エンドポイント
│       ├── indexer.py         # FAISS インデックス構築
│       ├── retriever.py       # FAISS 類似検索
│       ├── requirements.txt
│       └── Dockerfile
│
├── data/
│   ├── faiss_indices/         # FAISS インデックスファイル (*.faiss + *.json)
│   └── history/               # SQLite 会話履歴 DB (ペルソナごと)
│
├── compose.yaml
├── .env.example
└── CLAUDE.md                  # このファイル
```

---

## ローカル開発起動手順

### 前提条件

- Docker Desktop (または Docker Engine + Compose v2)
- Bun v1.x（ローカル開発時）
- Python 3.12+（ローカル開発時）

### 1. 環境変数ファイルを作成

```bash
cp .env.example .env
# .env を編集してトークン・APIキーを設定
```

### 2. Docker Compose で起動

```bash
# 初回ビルド＆起動（RAG モデルダウンロードに数分かかる場合あり）
docker compose up --build

# バックグラウンドで起動
docker compose up --build -d

# ログ確認
docker compose logs -f bot_core
docker compose logs -f rag
```

### 3. ローカルで個別起動（開発時）

```bash
# RAG サービス
cd services/rag
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8002 --reload

# Bot Core（別ターミナル）
cd bot_core
bun install
bun run src/main.ts
```

---

## 環境変数一覧

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `DISCORD_TOKEN_<ID>` | ✅ | — | 各ペルソナの Discord Bot トークン（ペルソナ YAML の `token_env` で参照） |
| `GEMINI_API_KEY` | ✅ | — | Google Gemini API キー |
| `OLLAMA_BASE_URL` | — | `http://localhost:11434` | Ollama サーバーの URL |
| `RAG_SERVICE_URL` | — | `http://localhost:8002` | RAG サービスの URL（Docker 内では `http://rag:8002`） |
| `PERSONAS_DIR` | — | `personas` | ペルソナ YAML ディレクトリのパス |
| `HISTORY_DIR` | — | `data/history` | 会話履歴 SQLite DB の保存先 |
| `TRANSFORMERS_CACHE` | — | `/app/.cache` | Hugging Face モデルキャッシュパス（RAG サービス） |

---

## ペルソナ追加手順

1. `bot_core/personas/` に新しい YAML ファイルを作成

```yaml
id: mybot                          # 一意なID（ファイル名と合わせると管理しやすい）
token_env: DISCORD_TOKEN_MYBOT     # 環境変数名（値ではない）
display_name: "My Bot"

llm:
  system_prompt: |
    あなたは...
  gemini:
    model: gemini-2.5-flash
  ollama:
    model: qwen2.5:7b
    base_url: ~                    # null = OLLAMA_BASE_URL 環境変数を使用

rag:
  index_path: data/faiss_indices/mybot.index
  top_k: 5
  enabled: true

mcp:
  auto_approve: []
  require_confirm: []
```

2. `.env` に Discord トークンを追加

```env
DISCORD_TOKEN_MYBOT=your_token_here
```

3. Bot を再起動

```bash
docker compose restart bot_core
# または開発時: Ctrl+C して再起動
```

---

## RAG インデックスの管理

### テキストを追加

```bash
curl -X POST http://localhost:8002/index/add \
  -H "Content-Type: application/json" \
  -d '{"text": "追加するテキスト", "metadata": {"source": "manual"}, "index_path": "data/faiss_indices/mybot.index"}'
```

### ディレクトリからビルド

```bash
curl -X POST http://localhost:8002/index/build \
  -H "Content-Type: application/json" \
  -d '{"source_dir": "/path/to/docs", "index_path": "data/faiss_indices/mybot.index"}'
```

### 検索テスト

```bash
curl -X POST http://localhost:8002/search \
  -H "Content-Type: application/json" \
  -d '{"query": "検索クエリ", "index_path": "data/faiss_indices/mybot.index", "top_k": 5}'
```

---

## アーキテクチャ概要

```
Discord --DM / メンション--> gateway.ts
                          |
                          v
                    orchestrator.ts
                    /           \
              session.ts      rag-client.ts
          (SQLite履歴)        (HTTP → RAG Service)
                    \
              FallbackLLMClient
              /               \
        GeminiProvider    OllamaProvider
        (プライマリ)       (フォールバック)
```

### フォールバック挙動

- Gemini が失敗 → Ollama にフォールバック（`warn` ログ出力）
- HTTP 400 系エラーまたはコンテンツポリシー違反の場合はフォールバックせず即エラー
- RAG サービスが応答しない場合は空コンテキストで継続（Bot は動作継続）

### 添付ファイル対応

- Discord の添付ファイルは会話履歴に保存され、後続ターンでも参照されます
- Gemini には画像や PDF などの添付を `inline_data` として送信します
- Ollama には画像添付を `images` として送信します。PDF など画像以外の添付は、テキスト抽出できるものだけ本文へ展開し、それ以外はメタデータのみ共有します
- Ollama で画像添付を扱うには、`gemma3` や `llava` などの vision 対応モデルを `personas/*.yaml` の `llm.ollama.model` に設定してください

---

## トラブルシューティング

**Bot がメッセージに応答しない**
- DM で送るか、サーバー内で Bot にメンション（`@BotName`）しているか確認
- Discord Developer Portal でインテント (`MESSAGE CONTENT INTENT`) が有効か確認
- ログに `Logged in as` が出力されているか確認
- `docker compose logs -f bot_core` で `Received DM` または `Received mention` が出るか確認

**RAG サービスが起動しない**
- モデルのダウンロードに時間がかかる場合あり（初回は特に）
- `docker compose logs rag` でエラーを確認

**`GEMINI_API_KEY is not set` エラー**
- `.env` ファイルに `GEMINI_API_KEY` が設定されているか確認
- Docker Compose の場合は `env_file: .env` が `compose.yaml` に含まれているか確認
