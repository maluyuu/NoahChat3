import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Client as DiscordClient,
} from "discord.js"
import type { Persona } from "./persona-manager.ts"
import { DiscordCollector } from "./discord-collector.ts"

const RAG_COLLECTOR_TOKEN_ENV = "DISCORD_RAG_COLLECTOR_TOKEN"

export interface PersonaClientEntry {
  persona: Persona
  client: DiscordClient
}

export interface StartedCollectors {
  sharedClient: DiscordClient | null
  collectors: DiscordCollector[]
}

export async function startRagCollectors(
  entries: PersonaClientEntry[],
): Promise<StartedCollectors> {
  const sharedToken = process.env[RAG_COLLECTOR_TOKEN_ENV]
  const collectors: DiscordCollector[] = []
  let sharedClient: DiscordClient | null = null

  if (sharedToken) {
    sharedClient = createCollectorClient()
    try {
      await loginAndWaitReady(sharedClient, sharedToken, "rag-collector")
      const dedicatedClient = sharedClient
      console.log(
        `[rag-collector] Dedicated collector bot covers ${dedicatedClient.guilds.cache.size} guild(s)`,
      )

      for (const entry of entries) {
        const collector = new DiscordCollector(dedicatedClient, entry.persona, {
          label: `${entry.persona.id}:rag-collector`,
          collectGuildIdsProvider: () => intersectGuildIds(
            dedicatedClient.guilds.cache.keys(),
            entry.client.guilds.cache.keys(),
          ),
          indexGuildIdsProvider: () => entry.client.guilds.cache.keys(),
        })
        collectors.push(collector)
        collector.start()
      }
    } catch (error) {
      console.warn(
        "[rag-collector] Dedicated collector bot failed to start; conversation bots will collect all RAG messages:",
        error instanceof Error ? error.message : error,
      )
      sharedClient.destroy()
      sharedClient = null
    }
  } else {
    console.warn(
      `[rag-collector] ${RAG_COLLECTOR_TOKEN_ENV} is not set; conversation bots will collect all RAG messages`,
    )
  }

  for (const entry of entries) {
    const collector = new DiscordCollector(entry.client, entry.persona, {
      label: sharedClient
        ? `${entry.persona.id}:conversation-fallback`
        : `${entry.persona.id}:conversation-collector`,
      collectGuildIdsProvider: () => {
        const personaGuildIds = [...entry.client.guilds.cache.keys()]
        if (!sharedClient) return personaGuildIds

        const sharedGuildIds = new Set(sharedClient.guilds.cache.keys())
        return personaGuildIds.filter((guildId) => !sharedGuildIds.has(guildId))
      },
      indexGuildIdsProvider: () => entry.client.guilds.cache.keys(),
    })
    collectors.push(collector)
    collector.start()
  }

  return { sharedClient, collectors }
}

export function waitForClientReady(client: DiscordClient, label: string): Promise<void> {
  if (client.isReady()) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`${label} did not become ready in time`))
    }, 60_000)

    const onReady = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      client.off(Events.ClientReady, onReady)
      client.off(Events.Error, onError)
    }

    client.once(Events.ClientReady, onReady)
    client.once(Events.Error, onError)
  })
}

function createCollectorClient(): DiscordClient {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
  })
}

async function loginAndWaitReady(
  client: DiscordClient,
  token: string,
  label: string,
): Promise<void> {
  const readyPromise = waitForClientReady(client, label)
  await client.login(token)
  await readyPromise
}

function intersectGuildIds(
  left: Iterable<string>,
  right: Iterable<string>,
): string[] {
  const rightSet = new Set(right)
  return [...left].filter((guildId) => rightSet.has(guildId))
}
