import {
  ChannelType,
  type Client,
  type Guild,
  type Message,
} from "discord.js"
import type { Persona } from "./persona-manager.ts"
import {
  DiscordMessageStore,
  type StoredDiscordMessage,
} from "./discord-message-store.ts"
import { rebuildDiscordIndex } from "./services/discord-index-client.ts"
import type { ChatAttachment } from "./llm/types.ts"

const BATCH_SIZE = 100
const DAILY_UPDATE_HOUR = Number.parseInt(process.env.DISCORD_RAG_UPDATE_HOUR ?? "3", 10)
const STALE_UPDATE_MS = 7 * 24 * 60 * 60 * 1000

interface DiscordCollectorOptions {
  label?: string
  collectGuildIdsProvider?: () => Iterable<string>
  indexGuildIdsProvider?: () => Iterable<string>
}

interface FetchableMessageChannel {
  id: string
  name?: string
  type?: ChannelType
  messages?: {
    fetch: (options: { limit: number; before?: string }) => Promise<Map<string, Message>>
  }
  threads?: {
    fetchActive?: () => Promise<{ threads: Iterable<unknown> }>
    fetchArchived?: (options: {
      type?: "public" | "private"
      limit?: number
      before?: Date
    }) => Promise<{ threads: Iterable<unknown>; hasMore?: boolean }>
  }
  isTextBased?: () => boolean
  isThread?: () => boolean
  parentId?: string | null
  parent?: { id: string; name?: string | null } | null
}

export class DiscordCollector {
  private store = new DiscordMessageStore()
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private isRunning = false
  private label: string
  private collectGuildIdsProvider?: () => Iterable<string>
  private indexGuildIdsProvider?: () => Iterable<string>

  constructor(
    private client: Client,
    private persona: Persona,
    options: DiscordCollectorOptions = {},
  ) {
    this.label = options.label ?? persona.id
    this.collectGuildIdsProvider = options.collectGuildIdsProvider
    this.indexGuildIdsProvider = options.indexGuildIdsProvider
  }

  start(): void {
    void this.collectOnStartupIfNeeded()
    this.scheduleNextDailyRun()
  }

  stop(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer)
      this.updateTimer = null
    }
    this.store.close()
  }

  getAccessibleGuildIds(): string[] {
    return [...this.getIndexGuildIds()]
  }

  private scheduleNextDailyRun(): void {
    const delay = millisecondsUntilNextDailyRun(DAILY_UPDATE_HOUR)
    const nextRun = new Date(Date.now() + delay)
    console.log(
      `[${this.label}] Discord RAG next scheduled update: ${nextRun.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
    )
    this.updateTimer = setTimeout(() => {
      void this.collectAndRebuild("daily").finally(() => this.scheduleNextDailyRun())
    }, delay)
  }

  private async collectOnStartupIfNeeded(): Promise<void> {
    const guildIds = this.getIndexGuildIds()
    const messageCount = this.store.getMessageCount(guildIds)
    const lastSuccessfulUpdateAt = this.store.getLastSuccessfulUpdateAt(this.label)
    const lastUpdateMs = lastSuccessfulUpdateAt ? lastSuccessfulUpdateAt * 1000 : 0

    if (messageCount === 0) {
      await this.collectAndRebuild("startup-empty-db")
      return
    }

    if (!lastSuccessfulUpdateAt) {
      await this.collectAndRebuild("startup-no-update-state")
      return
    }

    if (Date.now() - lastUpdateMs >= STALE_UPDATE_MS) {
      await this.collectAndRebuild("startup-stale-db")
      return
    }

    console.log(
      `[${this.label}] Discord RAG startup update skipped: ${messageCount} messages in DB, last update ${new Date(lastUpdateMs).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
    )
  }

  private async collectAndRebuild(reason: string): Promise<void> {
    if (this.isRunning) {
      console.log(`[${this.label}] Discord RAG ${reason} update skipped: another update is running`)
      return
    }
    this.isRunning = true
    try {
      const collectGuildIds = new Set(this.getCollectGuildIds())
      const indexGuildIds = this.getIndexGuildIds()
      if (collectGuildIds.size === 0) {
        console.log(
          `[${this.label}] Discord RAG ${reason} update skipped: no guilds assigned to this collector`,
        )
        return
      }
      console.log(
        `[${this.label}] Discord RAG ${reason} update started: ${collectGuildIds.size} collection guild(s), ${indexGuildIds.length} index guild(s)`,
      )
      let stored = 0
      const guilds = [...this.client.guilds.cache.values()]
        .filter((guild) => collectGuildIds.has(guild.id))
      for (const [index, guild] of guilds.entries()) {
        console.log(
          `[${this.label}] Discord RAG guild ${index + 1}/${guilds.length}: ${guild.name} (${guild.id})`,
        )
        stored += await this.collectGuild(guild)
      }
      console.log(`[${this.label}] Discord RAG collection complete: ${stored} messages scanned/stored`)
      let indexed = 0
      if (this.persona.rag.enabled) {
        console.log(`[${this.label}] Discord RAG FAISS rebuild started: ${this.persona.rag.index_path}`)
        indexed = await rebuildDiscordIndex(this.persona.rag.index_path, indexGuildIds)
      } else {
        console.log(`[${this.label}] Discord RAG FAISS rebuild skipped: RAG disabled`)
      }
      this.store.markSuccessfulUpdate(this.label)
      console.log(
        `[${this.label}] Discord RAG ${reason} update complete: ${stored} messages scanned, ${indexed} daily channel/thread units indexed`,
      )
    } catch (error) {
      console.warn(
        `[${this.label}] Discord RAG ${reason} update failed:`,
        error instanceof Error ? error.message : error,
      )
    } finally {
      this.isRunning = false
    }
  }

  private getCollectGuildIds(): string[] {
    const ids = this.collectGuildIdsProvider
      ? [...this.collectGuildIdsProvider()]
      : [...this.client.guilds.cache.keys()]
    return [...new Set(ids)].filter((id) => this.client.guilds.cache.has(id))
  }

  private getIndexGuildIds(): string[] {
    const ids = this.indexGuildIdsProvider
      ? [...this.indexGuildIdsProvider()]
      : [...this.client.guilds.cache.keys()]
    return [...new Set(ids)]
  }

  private async collectGuild(guild: Guild): Promise<number> {
    let stored = 0
    await guild.channels.fetch().catch(() => null)

    const channels = [...guild.channels.cache.values()]
    let collectableCount = 0
    let threadParentCount = 0
    for (const channel of channels) {
      if (isCollectableMessageChannel(channel)) collectableCount += 1
      if (hasThreadManager(channel)) threadParentCount += 1
    }
    console.log(
      `[${this.label}] Discord RAG ${guild.name}: ${collectableCount} message channel(s), ${threadParentCount} thread parent(s)`,
    )

    for (const channel of channels) {
      if (isCollectableMessageChannel(channel)) {
        stored += await this.collectChannel(guild.id, channel, channel)
      }
      if (hasThreadManager(channel)) {
        stored += await this.collectThreads(guild.id, channel)
      }
    }

    return stored
  }

  private async collectThreads(
    guildId: string,
    parent: FetchableMessageChannel,
  ): Promise<number> {
    if (!parent.threads) return 0

    let stored = 0
    const seen = new Set<string>()
    console.log(
      `[${this.label}] Discord RAG threads scan started: ${parent.name ?? parent.id}`,
    )

    const addThread = async (thread: unknown): Promise<void> => {
      if (!isCollectableMessageChannel(thread) || seen.has(thread.id)) return
      seen.add(thread.id)
      stored += await this.collectChannel(guildId, thread, parent)
    }

    const active = await parent.threads.fetchActive?.().catch(() => null)
    for (const thread of active?.threads ?? []) {
      await addThread(thread)
    }

    stored += await this.collectArchivedThreads(guildId, parent, "public", seen)
    stored += await this.collectArchivedThreads(guildId, parent, "private", seen)

    console.log(
      `[${this.label}] Discord RAG threads scan complete: ${parent.name ?? parent.id}, ${seen.size} thread(s), ${stored} message(s)`,
    )
    return stored
  }

  private async collectArchivedThreads(
    guildId: string,
    parent: FetchableMessageChannel,
    type: "public" | "private",
    seen: Set<string>,
  ): Promise<number> {
    if (!parent.threads?.fetchArchived) return 0

    let stored = 0
    let before: Date | undefined
    for (;;) {
      const page = await parent.threads.fetchArchived({
        type,
        limit: BATCH_SIZE,
        before,
      }).catch(() => null)
      if (!page) break
      const threads = [...page.threads]
      if (threads.length === 0) break

      for (const thread of threads) {
        if (!isCollectableMessageChannel(thread) || seen.has(thread.id)) continue
        seen.add(thread.id)
        stored += await this.collectChannel(guildId, thread, parent)
        before = getArchivePaginationDate(thread) ?? before
      }

      if (!page.hasMore) break
    }

    return stored
  }

  private async collectChannel(
    guildId: string,
    channel: FetchableMessageChannel,
    parent: FetchableMessageChannel,
  ): Promise<number> {
    let stored = 0
    let fetched = 0
    let before: string | undefined
    let pages = 0
    const label = getChannelLabel(channel, parent)
    console.log(
      `[${this.label}] Discord RAG channel scan started: ${label} (Discord API max ${BATCH_SIZE} messages/page; paging until channel history ends)`,
    )

    for (;;) {
      const batch = await channel.messages?.fetch({
        limit: BATCH_SIZE,
        before,
      }).catch(() => null)
      if (!batch || batch.size === 0) break
      pages += 1
      fetched += batch.size

      const messages = [...batch.values()].map((message) => {
        before = message.id
        return toStoredDiscordMessage(guildId, channel, parent, message)
      }).filter((message): message is StoredDiscordMessage => message !== null)

      stored += this.store.upsertMany(messages)
      if (pages === 1 || pages % 10 === 0) {
        console.log(
          `[${this.label}] Discord RAG channel progress: ${label}, ${pages} page(s), ${fetched} fetched, ${stored} stored`,
        )
      }
      if (batch.size < BATCH_SIZE) break
    }

    console.log(
      `[${this.label}] Discord RAG channel scan complete: ${label}, ${pages} page(s), ${fetched} fetched, ${stored} stored`,
    )
    return stored
  }
}

function isCollectableMessageChannel(value: unknown): value is FetchableMessageChannel {
  if (!value || typeof value !== "object") return false
  const channel = value as FetchableMessageChannel
  if (typeof channel.id !== "string") return false
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) return false
  if (typeof channel.isTextBased === "function" && !channel.isTextBased()) return false
  return typeof channel.messages?.fetch === "function"
}

function hasThreadManager(value: unknown): value is FetchableMessageChannel {
  if (!value || typeof value !== "object") return false
  const channel = value as FetchableMessageChannel
  return typeof channel.id === "string" && Boolean(channel.threads)
}

function toStoredDiscordMessage(
  guildId: string,
  channel: FetchableMessageChannel,
  parent: FetchableMessageChannel,
  message: Message,
): StoredDiscordMessage | null {
  if (!message.content.trim() && message.attachments.size === 0) return null

  const isThread = typeof channel.isThread === "function" && channel.isThread()
  const unitId = isThread ? channel.id : parent.id
  const unitName = isThread
    ? `${parent.name ?? parent.id} / ${channel.name ?? channel.id}`
    : parent.name ?? parent.id

  return {
    messageId: message.id,
    guildId,
    channelId: channel.id,
    channelName: channel.name ?? channel.id,
    unitId,
    unitName,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content,
    attachments: normalizeMessageAttachments(message),
    createdAt: Math.floor(message.createdTimestamp / 1000),
    editedAt: message.editedTimestamp ? Math.floor(message.editedTimestamp / 1000) : null,
    isBot: message.author.bot,
  }
}

function getChannelLabel(
  channel: FetchableMessageChannel,
  parent: FetchableMessageChannel,
): string {
  const isThread = typeof channel.isThread === "function" && channel.isThread()
  if (isThread) {
    return `${parent.name ?? parent.id} / ${channel.name ?? channel.id}`
  }
  return channel.name ?? channel.id
}

function normalizeMessageAttachments(message: Message): ChatAttachment[] {
  return [...message.attachments.values()].flatMap((attachment) => {
    if (!attachment.url || !attachment.name) return []

    return [{
      url: attachment.url,
      proxyUrl: attachment.proxyURL,
      filename: attachment.name,
      mimeType: attachment.contentType,
      size: attachment.size,
    }]
  })
}

function getArchivePaginationDate(thread: FetchableMessageChannel): Date | undefined {
  const timestamp = (thread as { archiveTimestamp?: number | null }).archiveTimestamp
  return typeof timestamp === "number" ? new Date(timestamp) : undefined
}

function millisecondsUntilNextDailyRun(hour: number): number {
  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  return next.getTime() - now.getTime()
}
