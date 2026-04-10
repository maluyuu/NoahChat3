import { Database } from "bun:sqlite"
import path from "node:path"
import fs from "node:fs"
import type { ChatMessage } from "./llm/types.ts"

const HISTORY_DIR = process.env.HISTORY_DIR ?? "data/history"

interface MessageRow {
  role: string
  content: string
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
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_channel_created ON messages (channel_id, created_at)`,
    )
  }

  getHistory(channelId: string, limit: number): ChatMessage[] {
    const stmt = this.db.query(`
      SELECT role, content FROM (
        SELECT role, content, created_at
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
    }))
  }

  appendMessage(
    channelId: string,
    userId: string,
    role: "user" | "assistant",
    content: string,
    guildId = "dm",
  ): void {
    const stmt = this.db.query(`
      INSERT INTO messages (guild_id, channel_id, user_id, role, content)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(guildId, channelId, userId, role, content)
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
