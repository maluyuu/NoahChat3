"""RAG Service — FastAPI アプリケーション"""
from __future__ import annotations

import os
import platform
from contextlib import asynccontextmanager
from typing import Any

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

from indexer import FaissIndexer
from retriever import FaissRetriever

MODEL_NAME = "cl-nagoya/ruri-v3-30m"
CACHE_DIR = os.environ.get("TRANSFORMERS_CACHE", "/app/.cache")
RAG_DEVICE = os.environ.get("RAG_DEVICE", "auto")
RAG_TORCH_NUM_THREADS = os.environ.get("RAG_TORCH_NUM_THREADS", "auto")
DISCORD_MESSAGE_DB = os.environ.get("DISCORD_MESSAGE_DB", "/app/history/discord_messages.db")
DISCORD_RAG_TIMEZONE = os.environ.get("DISCORD_RAG_TIMEZONE", "Asia/Tokyo")

# グローバル変数（起動時に初期化）
_model: SentenceTransformer | None = None
_indexer: FaissIndexer | None = None
_retriever: FaissRetriever | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[type-arg]
    global _model, _indexer, _retriever
    device = resolve_rag_device(RAG_DEVICE)
    torch_threads = resolve_torch_threads(RAG_TORCH_NUM_THREADS, device)
    configure_torch_threads(torch_threads)
    print(
        f"[rag] Loading embedding model: {MODEL_NAME} "
        f"(requested_device={RAG_DEVICE}, device={device}, torch_threads={torch_threads})",
        flush=True,
    )
    model_kwargs = {"cache_folder": CACHE_DIR, "device": device}
    _model = SentenceTransformer(MODEL_NAME, **model_kwargs)
    _indexer = FaissIndexer(_model)
    _retriever = FaissRetriever(_model)
    print("[rag] Model loaded successfully")
    yield
    print("[rag] Shutting down")


app = FastAPI(title="RAG Service", lifespan=lifespan)


def resolve_rag_device(requested_device: str) -> str:
    normalized = requested_device.strip().lower()
    if normalized and normalized != "auto":
        return normalized

    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
    except Exception as exc:
        print(f"[rag] MPS detection failed, falling back to CPU: {exc}", flush=True)

    return "cpu"


def resolve_torch_threads(requested_threads: str, device: str) -> int:
    if requested_threads.strip().lower() != "auto":
        try:
            return max(0, int(requested_threads))
        except ValueError:
            print(
                f"[rag] Invalid RAG_TORCH_NUM_THREADS={requested_threads!r}; using auto",
                flush=True,
            )

    if device == "mps":
        return 2

    machine = platform.machine().lower()
    system = platform.system().lower()
    cpu_count = os.cpu_count() or 2
    if system == "linux" and machine in {"aarch64", "arm64"}:
        return min(2, cpu_count)

    return min(4, cpu_count)


def configure_torch_threads(num_threads: int) -> None:
    if num_threads <= 0:
        return
    try:
        import torch
        torch.set_num_threads(num_threads)
        torch.set_num_interop_threads(max(1, min(num_threads, 2)))
    except Exception as exc:
        print(f"[rag] Failed to configure torch threads: {exc}", flush=True)


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
    filters: dict[str, Any] = {}


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


class DiscordIndexBuildRequest(BaseModel):
    index_path: str
    guild_ids: list[str]
    db_path: str | None = None
    timezone: str | None = None


class HealthResponse(BaseModel):
    status: str


# ---- エンドポイント ----

@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    try:
        chunks = get_retriever().search(req.query, req.index_path, req.top_k, req.filters)
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


@app.post("/index/build-discord", response_model=IndexBuildResponse)
def index_build_discord(req: DiscordIndexBuildRequest) -> IndexBuildResponse:
    try:
        count = get_indexer().build_from_discord_db(
            req.db_path or DISCORD_MESSAGE_DB,
            req.index_path,
            req.guild_ids,
            req.timezone or DISCORD_RAG_TIMEZONE,
        )
        return IndexBuildResponse(status="ok", count=count)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
