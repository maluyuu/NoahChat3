import type { Persona } from "./persona-manager.ts"
import { SessionManager } from "./session.ts"
import { GeminiProvider } from "./llm/gemini.ts"
import { OllamaProvider } from "./llm/ollama.ts"
import { FallbackLLMClient } from "./llm/fallback-client.ts"
import { ragSearch } from "./services/rag-client.ts"
import type { ChatAttachment } from "./llm/types.ts"
import type { ChatMessage } from "./llm/types.ts"

const HISTORY_LIMIT = 8
const DEFAULT_TIMEZONE = "Asia/Tokyo"

export class Orchestrator {
  private session: SessionManager
  private llmClient: FallbackLLMClient
  private persona: Persona

  constructor(persona: Persona) {
    this.persona = persona
    this.session = new SessionManager(persona.id)

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error(`[${persona.id}] GEMINI_API_KEY is not set`)
    }
    const apiKeys = [apiKey, process.env.GEMINI_API_KEY_SECONDARY].filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    )

    const gemini = new GeminiProvider(apiKeys, persona.llm.gemini.model, {
      webSearch: {
        enabled: persona.llm.web_search.enabled,
        maxResults: persona.llm.web_search.max_results,
        searchDepth: persona.llm.web_search.search_depth,
      },
    })
    const ollama = new OllamaProvider(
      persona.llm.ollama.model,
      persona.llm.ollama.base_url ?? undefined,
    )
    this.llmClient = new FallbackLLMClient(gemini, ollama, persona.id)
  }

  async respond(
    channelId: string,
    userId: string,
    userMessage: string,
    guildId = "dm",
    attachments: ChatAttachment[] = [],
    searchableGuildIds: string[] = [],
  ): Promise<string> {
    const { persona } = this

    // 1. 会話履歴を取得（直近だけに絞る）
    const history = stripHistoryAttachments(this.session.getHistory(channelId, HISTORY_LIMIT))

    // 2. RAG コンテキストを取得
    let systemPrompt = `${persona.llm.system_prompt}\n\n---\n${buildCurrentTimeContext()}`
    if (persona.rag.enabled && searchableGuildIds.length > 0) {
      try {
        const chunks = await ragSearch(
          userMessage,
          persona.rag.index_path,
          persona.rag.top_k,
          searchableGuildIds,
        )
        if (chunks.length > 0) {
          const ragContext = chunks.join("\n\n")
          systemPrompt += `\n---\n以下は参考情報です：\n${ragContext}`
        }
      } catch (error) {
        console.warn(
          `[${persona.id}] RAG search failed, continuing without context:`,
          error instanceof Error ? error.message : error,
        )
      }
    }

    // 会話履歴は参考情報に留め、最新メッセージを最優先にする
    if (history.length > 0) {
      systemPrompt += "\n\n---\n以下は最近の会話履歴です。必要最小限だけ参照し、最後に届いた【最新メッセージ】に主に返答してください。過去の話題を勝手に継続しすぎないでください。"
    }

    // 3. 現在のユーザーメッセージを履歴に追加してLLMに渡す
    // LLM 向けには最新メッセージを明示するラベルを付与する（DB保存は元のまま）
    const currentMessageContent = history.length > 0
      ? `【最新メッセージ】\n${userMessage}`
      : userMessage
    const messages = history.length > 0
      ? [
          ...history.slice(-4),
          { role: "user" as const, content: currentMessageContent, attachments },
        ]
      : [{ role: "user" as const, content: currentMessageContent, attachments }]

    // 4. LLM に応答を生成させる
    const llmResponse = await this.llmClient.chat(messages, systemPrompt)
    console.log(`[${persona.id}] Response generated via ${llmResponse.provider}`)

    // 5. 会話履歴を永続化
    this.session.appendMessage(channelId, userId, "user", userMessage, guildId, attachments)
    this.session.appendMessage(channelId, "bot", "assistant", llmResponse.text, guildId)

    return llmResponse.text
  }

  clearHistory(channelId: string): void {
    this.session.clearHistory(channelId)
  }

  destroy(): void {
    this.session.close()
  }
}

function stripHistoryAttachments(history: ChatMessage[]): ChatMessage[] {
  return history.map((message) => {
    const attachments = message.attachments ?? []
    if (attachments.length === 0) return message

    const attachmentSummary = attachments
      .map((attachment) => attachment.filename)
      .filter(Boolean)
      .join(", ")

    const suffix = attachmentSummary
      ? `\n[過去の添付ファイル: ${attachmentSummary}]`
      : "\n[過去の添付ファイルあり]"

    return {
      ...message,
      content: `${message.content}${suffix}`.trim(),
      attachments: [],
    }
  })
}

function buildCurrentTimeContext(now = new Date()): string {
  const requestedTimezone = process.env.BOT_TIMEZONE ?? process.env.TZ ?? DEFAULT_TIMEZONE
  const timezone = isValidTimezone(requestedTimezone) ? requestedTimezone : DEFAULT_TIMEZONE
  const formatted = new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now)

  return [
    "現在日時情報:",
    `- 現在日時: ${formatted}`,
    `- タイムゾーン: ${timezone}`,
    `- ISO時刻: ${now.toISOString()}`,
    "日時に関する質問では、この現在日時情報を基準にしてください。",
  ].join("\n")
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("ja-JP", { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}
