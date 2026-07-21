# NoahChat3

TypeScript (Bun) + Python (FastAPI) のマイクロサービス構成で動作する、複数ペルソナ対応 Discord Bot。

Discord 上で複数の Bot（ペルソナ）を同時に運用し、それぞれが独立した会話履歴（SQLite）と RAG 検索（FAISS）を持ちながら、Gemini をプライマリ、Ollama をフォールバックとする LLM 基盤で応答します。

## 特徴

- **マルチペルソナ**: `bot_core/personas/*.yaml` を追加するだけで Bot を増やせる
- **LLM フォールバック**: Gemini → Ollama へ自動フォールバック（コンテンツポリシー違反時は即エラー）
- **RAG**: FAISS によるドキュメント検索・Discord 過去メッセージのインクリメンタルインデックス構築
- **添付ファイル対応**: 画像・PDF などを会話履歴に保存し、後続ターンでも参照
- **Web検索**: Tavily API を使った Gemini の web_search tool 連携（任意）
- **Apple Silicon Mac / Raspberry Pi 5 対応**: NVIDIA GPU・Windows 固有構成を前提にしない同一 `compose.yaml`

## 構成

```
bot_core/            Discord Bot コア（TypeScript / Bun）
services/rag/         RAG サービス（Python / FastAPI / FAISS）
data/                 FAISS インデックス・会話履歴 SQLite DB
scripts/              ローカル一括起動スクリプト
compose.yaml          Docker Compose 定義
```

詳細なアーキテクチャ・環境変数一覧・ペルソナ追加手順は [CLAUDE.md](./CLAUDE.md) を参照してください。

## クイックスタート

```bash
cp .env.example .env
# .env を編集してトークン・APIキーを設定

bun run start   # ローカル一括起動（Docker不要、初回は依存関係を自動インストール）
```

Docker Compose で起動する場合:

```bash
docker compose up --build
```

セットアップの詳細手順（Discord Bot の作成、環境変数、ペルソナ設定、トラブルシューティング）は [SETUP.md](./SETUP.md) を参照してください。

## 必要環境

- Bun v1.x
- Python 3.11+
- Docker Desktop / Docker Engine + Compose v2（任意）

