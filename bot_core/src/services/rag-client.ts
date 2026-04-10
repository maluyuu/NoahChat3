const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL ?? "http://localhost:8002"

interface SearchResponse {
  chunks: string[]
}

interface AddResponse {
  status: string
}

export async function ragSearch(
  query: string,
  indexPath: string,
  topK: number,
): Promise<string[]> {
  try {
    const response = await fetch(`${RAG_SERVICE_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, index_path: indexPath, top_k: topK }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      console.warn(`[rag-client] Search failed: ${response.status} ${response.statusText}`)
      return []
    }

    const data = (await response.json()) as SearchResponse
    return data.chunks
  } catch (error) {
    console.warn(
      "[rag-client] RAG service unavailable, continuing without context:",
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

export async function ragAdd(
  text: string,
  metadata: Record<string, string>,
  indexPath: string,
): Promise<void> {
  try {
    const response = await fetch(`${RAG_SERVICE_URL}/index/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, metadata, index_path: indexPath }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      throw new Error(`RAG add failed: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as AddResponse
    if (data.status !== "ok") {
      throw new Error(`Unexpected status: ${data.status}`)
    }
  } catch (error) {
    throw new Error(
      `[rag-client] Failed to add to index: ${error instanceof Error ? error.message : error}`,
    )
  }
}
