"""FAISS インデックスからの検索モジュール"""
from __future__ import annotations

import json
import os
from typing import Any

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

FAISS_SUFFIX = ".faiss"
META_SUFFIX = ".json"


class FaissRetriever:
    def __init__(self, model: SentenceTransformer) -> None:
        self.model = model

    def search(self, query: str, index_path: str, top_k: int) -> list[str]:
        faiss_file = index_path + FAISS_SUFFIX
        meta_file = index_path + META_SUFFIX

        if not os.path.exists(faiss_file) or not os.path.exists(meta_file):
            return []

        index = faiss.read_index(faiss_file)
        with open(meta_file, encoding="utf-8") as f:
            meta_list: list[dict[str, Any]] = json.load(f)

        if index.ntotal == 0:
            return []

        query_embedding: np.ndarray = self.model.encode([query], convert_to_numpy=True)
        k = min(top_k, index.ntotal)
        _distances, indices = index.search(query_embedding.astype(np.float32), k)

        results: list[str] = []
        for idx in indices[0]:
            if idx < 0 or idx >= len(meta_list):
                continue
            text = meta_list[idx].get("text", "")
            if text:
                results.append(text)

        return results
