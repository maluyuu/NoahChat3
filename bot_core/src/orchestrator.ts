import type { Persona } from "./persona-manager.ts"
import { SessionManager } from "./session.ts"
import { GeminiProvider } from "./llm/gemini.ts"
import { OllamaProvider } from "./llm/ollama.ts"
import { FallbackLLMClient } from "./llm/fallback-client.ts"
import { ragSearch } from "./services/rag-client.ts"
import type { ChatAttachment } from "./llm/types.ts"
import type { ChatMessage } from "./llm/types.ts"

const HISTORY_LIMIT = 20

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

    const gemini = new GeminiProvider(apiKey, persona.llm.gemini.model)
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

    // 1. 会話履歴を取得
    const history = stripHistoryAttachments(this.session.getHistory(channelId, HISTORY_LIMIT))

    // 2. RAG コンテキストを取得
    let systemPrompt = persona.llm.system_prompt
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

    // 3. 現在のユーザーメッセージを履歴に追加してLLMに渡す
    const messages = [
      ...history,
      { role: "user" as const, content: userMessage, attachments },
    ]

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
