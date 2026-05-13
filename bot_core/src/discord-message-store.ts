import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import type { ChatAttachment } from "./llm/types.ts"

const HISTORY_DIR = process.env.HISTORY_DIR ?? "data/history"
const DISCORD_MESSAGE_DB = process.env.DISCORD_MESSAGE_DB
  ?? path.join(HISTORY_DIR, "discord_messages.db")

export interface StoredDiscordMessage {
  messageId: string
  guildId: string
  channelId: string
  channelName: string
  unitId: string
  unitName: string
  authorId: string
  authorTag: string
  content: string
  attachments: ChatAttachment[]
  createdAt: number
  editedAt: number | null
  isBot: boolean
}

export class DiscordMessageStore {
  private db: Database

  constructor(dbPath = DISCORD_MESSAGE_DB) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discord_messages (
        message_id   TEXT PRIMARY KEY,
        guild_id     TEXT NOT NULL,
        channel_id   TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        unit_id      TEXT NOT NULL,
        unit_name    TEXT NOT NULL,
        author_id    TEXT NOT NULL,
        author_tag   TEXT NOT NULL,
        content      TEXT NOT NULL,
        attachments  TEXT NOT NULL DEFAULT '[]',
        created_at   INTEGER NOT NULL,
        edited_at    INTEGER,
        is_bot       INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_discord_messages_guild_unit_day
      ON discord_messages (guild_id, unit_id, created_at)
    `)
  }

  upsertMany(messages: StoredDiscordMessage[]): number {
    if (messages.length === 0) return 0

    const stmt = this.db.query(`
      INSERT INTO discord_messages (
        message_id, guild_id, channel_id, channel_name, unit_id, unit_name,
        author_id, author_tag, content, attachments, created_at, edited_at, is_bot
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        guild_id = excluded.guild_id,
        channel_id = excluded.channel_id,
        channel_name = excluded.channel_name,
        unit_id = excluded.unit_id,
        unit_name = excluded.unit_name,
        author_id = excluded.author_id,
        author_tag = excluded.author_tag,
        content = excluded.content,
        attachments = excluded.attachments,
        created_at = excluded.created_at,
        edited_at = excluded.edited_at,
        is_bot = excluded.is_bot
    `)

    const insert = this.db.transaction((rows: StoredDiscordMessage[]) => {
      for (const row of rows) {
        stmt.run(
          row.messageId,
          row.guildId,
          row.channelId,
          row.channelName,
          row.unitId,
          row.unitName,
          row.authorId,
          row.authorTag,
          row.content,
          JSON.stringify(row.attachments),
          row.createdAt,
          row.editedAt,
          row.isBot ? 1 : 0,
        )
      }
    })
    insert(messages)
    return messages.length
  }

  close(): void {
    this.db.close()
  }
}
