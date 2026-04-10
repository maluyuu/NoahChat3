import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js"
import { Routes } from "discord-api-types/v10"
import type { Persona } from "./persona-manager.ts"
import { Orchestrator } from "./orchestrator.ts"

const TYPING_INTERVAL_MS = 5_000
const MAX_MESSAGE_LENGTH = 2000
const PROCESSED_MESSAGE_TTL_MS = 5 * 60_000

interface RawAuthor {
  id: string
  username?: string
  discriminator?: string
  global_name?: string | null
  bot?: boolean
}

interface RawMention {
  id: string
}

interface RawMessageCreatePacket {
  t?: string
  d?: {
    id?: string
    channel_id?: string
    guild_id?: string
    content?: string
    webhook_id?: string
    author?: RawAuthor
    mentions?: RawMention[]
  }
}

function splitMessage(text: string): string[] {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    // できるだけ改行で区切る
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

async function sendTypingLoop(
  channel: { sendTyping: () => Promise<unknown> },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await channel.sendTyping()
    } catch {
      // チャンネルアクセスエラーなどは無視
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, TYPING_INTERVAL_MS)
      signal.addEventListener("abort", () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}

async function sendTypingLoopByChannelId(
  client: Client,
  channelId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await client.rest.post(Routes.channelTyping(channelId)).catch(() => {
      // チャンネルアクセスエラーなどは無視
    })
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, TYPING_INTERVAL_MS)
      signal.addEventListener("abort", () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}

function canSendTyping(
  channel: Message["channel"],
): channel is Message["channel"] & { sendTyping: () => Promise<unknown> } {
  return typeof (channel as { sendTyping?: unknown }).sendTyping === "function"
}

function canSendMessages(
  channel: Message["channel"],
): channel is Message["channel"] & { send: (options: unknown) => Promise<unknown> } {
  return typeof (channel as { send?: unknown }).send === "function"
}

function formatAuthorTag(author: RawAuthor): string {
  if (author.global_name) return author.global_name
  if (author.username && author.discriminator && author.discriminator !== "0") {
    return `${author.username}#${author.discriminator}`
  }
  return author.username ?? author.id
}

function extractUserMessage(content: string, isDm: boolean): string {
  return isDm
    ? content.trim()
    : content.replace(/<@!?\d+>/g, "").trim()
}

async function sendResponse(
  msg: Message,
  chunks: string[],
  isDm: boolean,
): Promise<void> {
  if (chunks.length === 0) return

  if (!canSendMessages(msg.channel)) return

  if (isDm) {
    for (const chunk of chunks) {
      await msg.channel.send(chunk)
    }
    return
  }

  await msg.reply({
    content: chunks[0]!,
    allowedMentions: { repliedUser: false },
  })

  for (const chunk of chunks.slice(1)) {
    await msg.channel.send(chunk)
  }
}

async function sendResponseByChannel(
  channel: { send: (options: unknown) => Promise<unknown> },
  chunks: string[],
  isDm: boolean,
  messageId?: string,
): Promise<void> {
  if (chunks.length === 0) return

  if (isDm || !messageId) {
    for (const chunk of chunks) {
      await channel.send(chunk)
    }
    return
  }

  await channel.send({
    content: chunks[0]!,
    reply: { messageReference: messageId },
    allowedMentions: { repliedUser: false },
  })

  for (const chunk of chunks.slice(1)) {
    await channel.send(chunk)
  }
}

async function sendResponseByRest(
  client: Client,
  channelId: string,
  chunks: string[],
): Promise<void> {
  for (const chunk of chunks) {
    await client.rest.post(Routes.channelMessages(channelId), {
      body: {
        content: chunk,
        allowed_mentions: {
          parse: [],
        },
      },
    })
  }
}

export function createClientForPersona(
  persona: Persona,
  token: string,
): Client {
  const orchestrator = new Orchestrator(persona)
  const processedMessageIds = new Map<string, number>()

  function rememberMessage(messageId: string): boolean {
    const now = Date.now()
    for (const [id, timestamp] of processedMessageIds) {
      if (now - timestamp > PROCESSED_MESSAGE_TTL_MS) {
        processedMessageIds.delete(id)
      }
    }

    if (processedMessageIds.has(messageId)) {
      return true
    }

    processedMessageIds.set(messageId, now)
    return false
  }

  async function handleIncomingMessage(input: {
    messageId: string
    channelId: string
    guildId: string
    userId: string
    authorTag: string
    userMessage: string
    isDm: boolean
    message?: Message
  }): Promise<void> {
    if (rememberMessage(input.messageId)) return

    console.log(
      `[${persona.id}] Received ${input.isDm ? "DM" : "mention"} from ${input.authorTag} in channel ${input.channelId}`,
    )

    const abortController = new AbortController()
    const channel = input.message?.channel
    const typingPromise = channel && canSendTyping(channel)
      ? sendTypingLoop(channel, abortController.signal)
      : sendTypingLoopByChannelId(client, input.channelId, abortController.signal)

    try {
      const response = await orchestrator.respond(
        input.channelId,
        input.userId,
        input.userMessage,
        input.guildId,
      )

      abortController.abort()
      await typingPromise

      const chunks = splitMessage(response)
      if (input.message && canSendMessages(input.message.channel)) {
        await sendResponse(input.message, chunks, input.isDm)
      } else if (channel && canSendMessages(channel)) {
        await sendResponseByChannel(
          channel,
          chunks,
          input.isDm,
          input.isDm ? undefined : input.messageId,
        )
      } else {
        await sendResponseByRest(client, input.channelId, chunks)
      }
    } catch (error) {
      abortController.abort()
      await typingPromise
      console.error(
        `[${persona.id}] Error handling message:`,
        error instanceof Error ? error.message : error,
      )
      if (channel && canSendMessages(channel)) {
        await channel.send("エラーが発生しました。しばらくしてからもう一度お試しください。").catch(() => {
          // 送信に失敗しても継続
        })
      } else {
        await sendResponseByRest(client, input.channelId, [
          "エラーが発生しました。しばらくしてからもう一度お試しください。",
        ]).catch(() => {
          // 送信に失敗しても継続
        })
      }
    }
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
  })

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[${persona.id}] Logged in as ${readyClient.user.tag}`)
  })

  client.on("raw", (packet) => {
    if (packet.t !== "MESSAGE_CREATE") return
    const channelId = typeof packet.d?.channel_id === "string" ? packet.d.channel_id : "unknown"
    const guildId = typeof packet.d?.guild_id === "string" ? packet.d.guild_id : "dm"
    console.log(
      `[${persona.id}] Raw MESSAGE_CREATE received for channel ${channelId} (guild: ${guildId})`,
    )
  })

  client.on("raw", async (packet: RawMessageCreatePacket) => {
    if (packet.t !== "MESSAGE_CREATE") return

    const data = packet.d
    if (!data?.id || !data.channel_id || !data.author?.id) return
    if (data.author.bot || data.webhook_id) return

    const isDm = !data.guild_id
    const botId = client.user?.id ?? ""
    const isMentioned = Array.isArray(data.mentions)
      ? data.mentions.some((mention) => mention.id === botId)
      : false

    if (!isDm && !isMentioned) return

    const userMessage = extractUserMessage(data.content ?? "", isDm)
    if (!userMessage) return

    await handleIncomingMessage({
      messageId: data.id,
      channelId: data.channel_id,
      guildId: data.guild_id ?? "dm",
      userId: data.author.id,
      authorTag: formatAuthorTag(data.author),
      userMessage,
      isDm,
    })
  })

  client.on(Events.MessageCreate, async (msg: Message) => {
    // Bot 自身のメッセージは無視
    if (msg.author.bot) return

    if (msg.partial) {
      try {
        await msg.fetch()
      } catch (error) {
        console.warn(
          `[${persona.id}] Failed to fetch partial message ${msg.id}:`,
          error instanceof Error ? error.message : error,
        )
        return
      }
    }

    const isDm = msg.channel.isDMBased()
    const isMentioned = msg.mentions.users.has(client.user?.id ?? "")
    if (!isDm && !isMentioned) return

    if (!msg.channel.isTextBased()) return

    const userMessage = extractUserMessage(msg.content, isDm)

    if (!userMessage) return

    await handleIncomingMessage({
      messageId: msg.id,
      channelId: msg.channel.id,
      guildId: msg.guild?.id ?? "dm",
      userId: msg.author.id,
      authorTag: msg.author.tag,
      userMessage,
      isDm,
      message: msg,
    })
  })

  client.login(token).catch((error) => {
    console.error(
      `[${persona.id}] Login failed:`,
      error instanceof Error ? error.message : error,
    )
  })

  return client
}
