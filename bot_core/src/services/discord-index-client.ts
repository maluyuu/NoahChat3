const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL ?? "http://localhost:8002"
const REBUILD_ATTEMPTS = parsePositiveInt(process.env.RAG_INDEX_REBUILD_ATTEMPTS, 1)
const REBUILD_TIMEOUT_MS = parsePositiveInt(
  process.env.RAG_INDEX_REBUILD_TIMEOUT_MS,
  2 * 60 * 60_000,
)

interface BuildDiscordResponse {
  status: string
  count: number
}

export async function rebuildDiscordIndex(
  indexPath: string,
  guildIds: string[],
): Promise<number> {
  if (guildIds.length === 0) return 0

  let lastError: unknown
  for (let attempt = 1; attempt <= REBUILD_ATTEMPTS; attempt += 1) {
    try {
      await waitForRagHealth()
      const response = await fetch(`${RAG_SERVICE_URL}/index/build-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          index_path: indexPath,
          guild_ids: guildIds,
        }),
        signal: AbortSignal.timeout(REBUILD_TIMEOUT_MS),
      })

      if (!response.ok) {
        throw new Error(`Discord index rebuild failed: ${response.status} ${response.statusText}`)
      }

      const data = (await response.json()) as BuildDiscordResponse
      if (data.status !== "ok") {
        throw new Error(`Unexpected status: ${data.status}`)
      }

      return data.count
    } catch (error) {
      lastError = error
      if (attempt < REBUILD_ATTEMPTS) {
        console.warn(
          `[rag-client] Discord index rebuild attempt ${attempt}/${REBUILD_ATTEMPTS} failed; retrying:`,
          error instanceof Error ? error.message : error,
        )
        await sleep(10_000 * attempt)
      }
    }
  }

  throw new Error(
    `Discord index rebuild failed after ${REBUILD_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

async function waitForRagHealth(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(`${RAG_SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (response.ok) return
    } catch {
      // Retry below.
    }
    await sleep(2_000)
  }
  throw new Error("RAG service did not become healthy")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
