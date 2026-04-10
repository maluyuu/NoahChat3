"""FAISS インデックスの構築・管理モジュール"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

FAISS_SUFFIX = ".faiss"
META_SUFFIX = ".json"


class FaissIndexer:
    def __init__(self, model: SentenceTransformer) -> None:
        self.model = model

    def _faiss_path(self, index_path: str) -> str:
        return index_path + FAISS_SUFFIX

    def _meta_path(self, index_path: str) -> str:
        return index_path + META_SUFFIX

    def _ensure_dir(self, index_path: str) -> None:
        os.makedirs(Path(index_path).parent, exist_ok=True)

    def _load_or_create(self, index_path: str, dim: int) -> tuple[faiss.Index, list[dict[str, Any]]]:
        faiss_file = self._faiss_path(index_path)
        meta_file = self._meta_path(index_path)

        if os.path.exists(faiss_file) and os.path.exists(meta_file):
            index = faiss.read_index(faiss_file)
            with open(meta_file, encoding="utf-8") as f:
                metadata = json.load(f)
        else:
            index = faiss.IndexFlatL2(dim)
            metadata = []

        return index, metadata

    def add(self, text: str, metadata: dict[str, Any], index_path: str) -> None:
        self._ensure_dir(index_path)
        embedding: np.ndarray = self.model.encode([text], convert_to_numpy=True)
        dim = embedding.shape[1]

        index, meta_list = self._load_or_create(index_path, dim)
        index.add(embedding.astype(np.float32))
        meta_list.append({"text": text, **metadata})

        self._save(index, meta_list, index_path)

    def build_from_dir(self, source_dir: str, index_path: str) -> int:
        self._ensure_dir(index_path)
        texts: list[str] = []
        for root, _, files in os.walk(source_dir):
            for filename in sorted(files):
                filepath = os.path.join(root, filename)
                try:
                    with open(filepath, encoding="utf-8") as f:
                        content = f.read().strip()
                    if content:
                        texts.append(content)
                except (UnicodeDecodeError, OSError):
                    continue

        if not texts:
            return 0

        embeddings: np.ndarray = self.model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
        dim = embeddings.shape[1]
        index = faiss.IndexFlatL2(dim)
        index.add(embeddings.astype(np.float32))
        meta_list = [{"text": t} for t in texts]

        self._save(index, meta_list, index_path)
        return len(texts)

    def _save(self, index: faiss.Index, meta_list: list[dict[str, Any]], index_path: str) -> None:
        faiss.write_index(index, self._faiss_path(index_path))
        with open(self._meta_path(index_path), "w", encoding="utf-8") as f:
            json.dump(meta_list, f, ensure_ascii=False, indent=2)
