FROM python:3.12-slim

WORKDIR /app

# キャッシュディレクトリを作成
RUN mkdir -p /app/.cache /app/indices /app/history

# 依存関係のインストール
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# ソースコードをコピー
COPY main.py indexer.py retriever.py ./

# モデルキャッシュのパスを設定
ENV TRANSFORMERS_CACHE=/app/.cache
ENV HF_HOME=/app/.cache

EXPOSE 8002

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002"]
