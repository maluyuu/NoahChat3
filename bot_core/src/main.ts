import { loadPersonas, resolveToken } from "./persona-manager.ts"
import { createClientForPersona } from "./gateway.ts"
import {
  startRagCollectors,
  waitForClientReady,
  type PersonaClientEntry,
} from "./rag-collector-client.ts"

async function main(): Promise<void> {
  console.log("[main] Starting Discord Bot...")

  const personas = loadPersonas()
  if (personas.length === 0) {
    console.error("[main] No personas found. Exiting.")
    process.exit(1)
  }

  console.log(`[main] Found ${personas.length} persona(s): ${personas.map((p) => p.id).join(", ")}`)

  const configuredPersonas = personas.filter((persona) => {
    if (process.env[persona.token_env]) {
      return true
    }

    console.warn(
      `[main] Skipping persona ${persona.id}: missing environment variable ${persona.token_env}`,
    )
    return false
  })

  if (configuredPersonas.length === 0) {
    console.error("[main] No personas have Discord tokens configured. Exiting.")
    process.exit(1)
  }

  const results = await Promise.allSettled(
    configuredPersonas.map(async (persona) => {
      const token = resolveToken(persona)
      const client = createClientForPersona(persona, token)
      await waitForClientReady(client, persona.id)
      return { persona, client }
    }),
  )

  const startedEntries: PersonaClientEntry[] = []
  let successCount = 0
  for (const result of results) {
    if (result.status === "fulfilled") {
      successCount++
      startedEntries.push(result.value)
    } else {
      console.error("[main] Failed to start persona:", result.reason)
    }
  }

  if (successCount === 0) {
    console.error("[main] All configured personas failed to start. Exiting.")
    process.exit(1)
  }

  console.log(`[main] ${successCount}/${configuredPersonas.length} configured persona(s) started successfully.`)
  await startRagCollectors(startedEntries)
}

main().catch((error) => {
  console.error("[main] Unhandled error:", error)
  process.exit(1)
})
