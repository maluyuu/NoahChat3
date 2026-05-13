const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL ?? "http://localhost:8002"

interface BuildDiscordResponse {
  status: string
  count: number
}

export async function rebuildDiscordIndex(
  indexPath: string,
  guildIds: string[],
): Promise<number> {
  if (guildIds.length === 0) return 0

  const response = await fetch(`${RAG_SERVICE_URL}/index/build-discord`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      index_path: indexPath,
      guild_ids: guildIds,
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  })

  if (!response.ok) {
    throw new Error(`Discord index rebuild failed: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as BuildDiscordResponse
  if (data.status !== "ok") {
    throw new Error(`Unexpected status: ${data.status}`)
  }

  return data.count
}
