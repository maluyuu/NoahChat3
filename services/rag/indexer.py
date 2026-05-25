"""FAISS インデックスの構築・管理モジュール"""
from __future__ import annotations

import json
import os
import platform
import sqlite3
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

FAISS_SUFFIX = ".faiss"
META_SUFFIX = ".json"
ENCODE_BATCH_SIZE = os.environ.get("RAG_ENCODE_BATCH_SIZE", "auto")
MAX_EMBED_TEXT_CHARS = int(os.environ.get("RAG_MAX_EMBED_TEXT_CHARS", "12000"))


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

    def build_from_discord_db(
        self,
        db_path: str,
        index_path: str,
        guild_ids: list[str],
        timezone: str = "Asia/Tokyo",
    ) -> int:
        self._ensure_dir(index_path)
        if not guild_ids or not os.path.exists(db_path):
            self._save_empty(index_path)
            return 0

        placeholders = ",".join("?" for _ in guild_ids)
        query = f"""
            SELECT
              guild_id, unit_id, unit_name, author_tag, content, attachments,
              created_at, edited_at
            FROM discord_messages
            WHERE guild_id IN ({placeholders})
            ORDER BY guild_id, unit_id, created_at ASC
        """

        tz = ZoneInfo(timezone)
        units: dict[tuple[str, str, str], dict[str, Any]] = {}
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            for row in conn.execute(query, guild_ids):
                day = _local_day(int(row["created_at"]), tz)
                key = (row["guild_id"], row["unit_id"], day)
                unit = units.setdefault(
                    key,
                    {
                        "guild_id": row["guild_id"],
                        "unit_id": row["unit_id"],
                        "unit_name": row["unit_name"],
                        "date": day,
                        "lines": [],
                        "message_count": 0,
                        "max_message_updated_at": 0,
                    },
                )
                unit["message_count"] += 1
                updated_at = int(row["edited_at"] or row["created_at"])
                unit["max_message_updated_at"] = max(unit["max_message_updated_at"], updated_at)
                content = str(row["content"] or "").strip()
                attachment_text = _format_attachments(str(row["attachments"] or "[]"))
                if not content and not attachment_text:
                    continue
                timestamp = _local_time(int(row["created_at"]), tz)
                body = content if content else attachment_text
                if content and attachment_text:
                    body = f"{content} {attachment_text}"
                unit["lines"].append(f"[{timestamp}] {row['author_tag']}: {body}")

        items: list[dict[str, Any]] = []
        for unit in units.values():
            if not unit["lines"]:
                continue
            header = f"Discord履歴: {unit['unit_name']} / {unit['date']}"
            text = header + "\n" + "\n".join(unit["lines"])
            items.append({
                "text": text,
                "guild_id": unit["guild_id"],
                "unit_id": unit["unit_id"],
                "unit_name": unit["unit_name"],
                "date": unit["date"],
                "chunk_id": _discord_chunk_id(unit["guild_id"], unit["unit_id"], unit["date"]),
                "message_count": unit["message_count"],
                "max_message_updated_at": unit["max_message_updated_at"],
                "source": "discord",
            })

        return self.build_from_items_incremental(items, index_path)

    def build_from_items_incremental(self, items: list[dict[str, Any]], index_path: str) -> int:
        self._ensure_dir(index_path)
        if not items:
            self._save_empty(index_path)
            return 0

        previous = self._load_existing(index_path)
        if previous is None:
            return self.build_from_items(items, index_path)

        old_index, old_meta = previous
        old_items = {
            key: (position, meta)
            for position, meta in enumerate(old_meta)
            if position < old_index.ntotal
            if (key := _item_identity(meta)) is not None
        }

        vectors: list[np.ndarray | None] = []
        to_encode: list[tuple[int, str]] = []
        reused = 0

        for item in items:
            key = _item_identity(item)
            old_item = old_items.get(key) if key else None
            if old_item is not None and _can_reuse_vector(item, old_item[1]):
                vectors.append(_reconstruct_vector(old_index, old_item[0]))
                reused += 1
            else:
                vectors.append(None)
                to_encode.append((len(vectors) - 1, str(item["text"])))

        batch_size = _resolve_encode_batch_size(self.model)
        device = _model_device(self.model)
        print(
            f"[rag] Incremental Discord index for {index_path}: "
            f"{reused} reused, {len(to_encode)} encoded, {len(items)} total "
            f"(device={device}, batch_size={batch_size}, max_chars={MAX_EMBED_TEXT_CHARS})",
            flush=True,
        )

        for start in range(0, len(to_encode), batch_size):
            batch_items = to_encode[start:start + batch_size]
            batch = [_embedding_text(text) for _, text in batch_items]
            embeddings: np.ndarray = self.model.encode(
                batch,
                convert_to_numpy=True,
                show_progress_bar=False,
                batch_size=batch_size,
            )
            for (position, _), embedding in zip(batch_items, embeddings, strict=True):
                vectors[position] = embedding.astype(np.float32)
            print(
                f"[rag] Encoded incremental {min(start + batch_size, len(to_encode))}/{len(to_encode)} items",
                flush=True,
            )

        resolved_vectors = [vector for vector in vectors if vector is not None]
        if not resolved_vectors:
            self._save_empty(index_path)
            return 0

        embeddings = np.vstack(resolved_vectors).astype(np.float32)
        index = faiss.IndexFlatL2(embeddings.shape[1])
        index.add(embeddings)
        self._save(index, items, index_path)
        return len(items)

    def build_from_items(self, items: list[dict[str, Any]], index_path: str) -> int:
        self._ensure_dir(index_path)
        if not items:
            self._save_empty(index_path)
            return 0

        texts = [str(item["text"]) for item in items]
        index: faiss.Index | None = None
        batch_size = _resolve_encode_batch_size(self.model)
        device = _model_device(self.model)
        print(
            f"[rag] Encoding {len(texts)} items for {index_path} "
            f"(device={device}, batch_size={batch_size}, max_chars={MAX_EMBED_TEXT_CHARS})",
            flush=True,
        )
        for start in range(0, len(texts), batch_size):
            batch = [_embedding_text(text) for text in texts[start:start + batch_size]]
            embeddings: np.ndarray = self.model.encode(
                batch,
                convert_to_numpy=True,
                show_progress_bar=False,
                batch_size=batch_size,
            )
            if index is None:
                index = faiss.IndexFlatL2(embeddings.shape[1])
            index.add(embeddings.astype(np.float32))
            print(
                f"[rag] Encoded {min(start + batch_size, len(texts))}/{len(texts)} items",
                flush=True,
            )

        if index is None:
            self._save_empty(index_path)
            return 0

        self._save(index, items, index_path)
        return len(items)

    def _save(self, index: faiss.Index, meta_list: list[dict[str, Any]], index_path: str) -> None:
        faiss.write_index(index, self._faiss_path(index_path))
        with open(self._meta_path(index_path), "w", encoding="utf-8") as f:
            json.dump(meta_list, f, ensure_ascii=False, indent=2)

    def _save_empty(self, index_path: str) -> None:
        dim = self.model.get_sentence_embedding_dimension()
        if dim is None:
            dim = self.model.encode([""], convert_to_numpy=True).shape[1]
        self._save(faiss.IndexFlatL2(dim), [], index_path)

    def _load_existing(self, index_path: str) -> tuple[faiss.Index, list[dict[str, Any]]] | None:
        faiss_file = self._faiss_path(index_path)
        meta_file = self._meta_path(index_path)
        if not os.path.exists(faiss_file) or not os.path.exists(meta_file):
            return None

        try:
            index = faiss.read_index(faiss_file)
            with open(meta_file, encoding="utf-8") as f:
                metadata = json.load(f)
            if not isinstance(metadata, list):
                return None
            return index, metadata
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"[rag] Existing index could not be loaded; rebuilding: {exc}", flush=True)
            return None


def _local_day(timestamp: int, timezone: ZoneInfo) -> str:
    return _dt(timestamp, timezone).strftime("%Y-%m-%d")


def _local_time(timestamp: int, timezone: ZoneInfo) -> str:
    return _dt(timestamp, timezone).strftime("%H:%M")


def _dt(timestamp: int, timezone: ZoneInfo):
    from datetime import datetime
    return datetime.fromtimestamp(timestamp, timezone)


def _format_attachments(raw: str) -> str:
    try:
        attachments = json.loads(raw)
    except json.JSONDecodeError:
        return ""
    if not isinstance(attachments, list) or not attachments:
        return ""

    names = []
    for item in attachments:
        if not isinstance(item, dict):
            continue
        filename = item.get("filename")
        if isinstance(filename, str) and filename:
            names.append(filename)
    return "添付: " + ", ".join(names) if names else ""


def _discord_chunk_id(guild_id: str, unit_id: str, day: str) -> str:
    return f"discord:{guild_id}:{unit_id}:{day}"


def _item_identity(item: dict[str, Any]) -> str | None:
    chunk_id = item.get("chunk_id")
    if isinstance(chunk_id, str) and chunk_id:
        return chunk_id

    if item.get("source") != "discord":
        return None
    guild_id = item.get("guild_id")
    unit_id = item.get("unit_id")
    day = item.get("date")
    if all(isinstance(value, str) and value for value in [guild_id, unit_id, day]):
        return _discord_chunk_id(str(guild_id), str(unit_id), str(day))
    return None


def _can_reuse_vector(new_item: dict[str, Any], old_item: dict[str, Any]) -> bool:
    if old_item.get("text") == new_item.get("text"):
        return True
    return (
        old_item.get("message_count") == new_item.get("message_count")
        and old_item.get("max_message_updated_at") == new_item.get("max_message_updated_at")
    )


def _reconstruct_vector(index: faiss.Index, position: int) -> np.ndarray:
    vector = index.reconstruct(position)
    return np.asarray(vector, dtype=np.float32)


def _embedding_text(text: str) -> str:
    if MAX_EMBED_TEXT_CHARS <= 0 or len(text) <= MAX_EMBED_TEXT_CHARS:
        return text
    return text[:MAX_EMBED_TEXT_CHARS] + "\n...[embedding text truncated]"


def _resolve_encode_batch_size(model: SentenceTransformer) -> int:
    requested = ENCODE_BATCH_SIZE.strip().lower()
    if requested != "auto":
        try:
            return max(1, int(requested))
        except ValueError:
            print(f"[rag] Invalid RAG_ENCODE_BATCH_SIZE={ENCODE_BATCH_SIZE!r}; using auto", flush=True)

    device = _model_device(model)
    if device == "mps":
        return 16

    machine = platform.machine().lower()
    if machine in {"aarch64", "arm64"}:
        return 2

    return 4


def _model_device(model: SentenceTransformer) -> str:
    device = getattr(model, "device", "cpu")
    return str(device).split(":", maxsplit=1)[0]
