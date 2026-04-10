FROM oven/bun:1-alpine

WORKDIR /app

# better-sqlite3 のネイティブビルドに必要なツールを追加
RUN apk add --no-cache python3 make g++ \
    && ln -sf /usr/bin/python3 /usr/bin/python

ENV PYTHON=/usr/bin/python3

# 依存関係のインストール（キャッシュ効率のため先にコピー）
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# ソースコードをコピー
COPY src/ ./src/
COPY tsconfig.json ./

# personas は volume でマウントされるため、デフォルトの空ディレクトリを作成
RUN mkdir -p personas data/history data/faiss_indices

CMD ["bun", "run", "src/main.ts"]
