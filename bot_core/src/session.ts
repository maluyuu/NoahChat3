import { Database } from "bun:sqlite"
import path from "node:path"
import fs from "node:fs"
import type { ChatAttachment, ChatMessage } from "./llm/types.ts"

const HISTORY_DIR = process.env.HISTORY_DIR ?? "data/history"

interface MessageRow {
  role: string
  content: string
  attachments: string
}

export class SessionManager {
  private db: Database
  private personaId: string

  constructor(personaId: string) {
    this.personaId = personaId
    fs.mkdirSync(HISTORY_DIR, { recursive: true })
    const dbPath = path.join(HISTORY_DIR, `${personaId}.db`)
    this.db = new Database(dbPath, { create: true })
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)
    const columns = this.db.query("PRAGMA table_info(messages)").all() as Array<{
      name?: string
    }>
    const hasAttachmentsColumn = columns.some((column) => column.name === "attachments")
    if (!hasAttachmentsColumn) {
      this.db.exec(
        `ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`,
      )
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_channel_created ON messages (channel_id, created_at)`,
    )
  }

  getHistory(channelId: string, limit: number): ChatMessage[] {
    const stmt = this.db.query(`
      SELECT role, content, attachments FROM (
        SELECT role, content, attachments, created_at
        FROM messages
        WHERE channel_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      ) ORDER BY created_at ASC
    `)
    const rows = stmt.all(channelId, limit) as MessageRow[]
    return rows.map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
      attachments: parseAttachments(row.attachments),
    }))
  }

  appendMessage(
    channelId: string,
    userId: string,
    role: "user" | "assistant",
    content: string,
    guildId = "dm",
    attachments: ChatAttachment[] = [],
  ): void {
    const stmt = this.db.query(`
      INSERT INTO messages (guild_id, channel_id, user_id, role, content, attachments)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    stmt.run(guildId, channelId, userId, role, content, JSON.stringify(attachments))
  }

  clearHistory(channelId: string): void {
    const stmt = this.db.query(`DELETE FROM messages WHERE channel_id = ?`)
    stmt.run(channelId)
    console.log(`[${this.personaId}] Cleared history for channel ${channelId}`)
  }

  close(): void {
    this.db.close()
  }
}

function parseAttachments(value: string): ChatAttachment[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []

      const url = typeof item.url === "string" ? item.url : ""
      const filename = typeof item.filename === "string" ? item.filename : ""
      if (!url || !filename) return []

      return [{
        url,
        proxyUrl: typeof item.proxyUrl === "string" ? item.proxyUrl : null,
        filename,
        mimeType: typeof item.mimeType === "string" ? item.mimeType : null,
        size: typeof item.size === "number" ? item.size : undefined,
      }]
    })
  } catch {
    return []
  }
}
