"""RAG Service — FastAPI アプリケーション"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

from indexer import FaissIndexer
from retriever import FaissRetriever

MODEL_NAME = "cl-nagoya/ruri-v3-30m"
CACHE_DIR = os.environ.get("TRANSFORMERS_CACHE", "/app/.cache")

# グローバル変数（起動時に初期化）
_model: SentenceTransformer | None = None
_indexer: FaissIndexer | None = None
_retriever: FaissRetriever | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[type-arg]
    global _model, _indexer, _retriever
    print(f"[rag] Loading embedding model: {MODEL_NAME}")
    _model = SentenceTransformer(MODEL_NAME, cache_folder=CACHE_DIR)
    _indexer = FaissIndexer(_model)
    _retriever = FaissRetriever(_model)
    print("[rag] Model loaded successfully")
    yield
    print("[rag] Shutting down")


app = FastAPI(title="RAG Service", lifespan=lifespan)


def get_indexer() -> FaissIndexer:
    if _indexer is None:
        raise RuntimeError("Indexer not initialized")
    return _indexer


def get_retriever() -> FaissRetriever:
    if _retriever is None:
        raise RuntimeError("Retriever not initialized")
    return _retriever


# ---- リクエスト/レスポンス スキーマ ----

class SearchRequest(BaseModel):
    query: str
    index_path: str
    top_k: int = 5


class SearchResponse(BaseModel):
    chunks: list[str]


class IndexAddRequest(BaseModel):
    text: str
    metadata: dict[str, Any] = {}
    index_path: str


class IndexAddResponse(BaseModel):
    status: str


class IndexBuildRequest(BaseModel):
    source_dir: str
    index_path: str


class IndexBuildResponse(BaseModel):
    status: str
    count: int


class HealthResponse(BaseModel):
    status: str


# ---- エンドポイント ----

@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    try:
        chunks = get_retriever().search(req.query, req.index_path, req.top_k)
        return SearchResponse(chunks=chunks)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/index/add", response_model=IndexAddResponse)
def index_add(req: IndexAddRequest) -> IndexAddResponse:
    try:
        get_indexer().add(req.text, req.metadata, req.index_path)
        return IndexAddResponse(status="ok")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/index/build", response_model=IndexBuildResponse)
def index_build(req: IndexBuildRequest) -> IndexBuildResponse:
    try:
        count = get_indexer().build_from_dir(req.source_dir, req.index_path)
        return IndexBuildResponse(status="ok", count=count)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
