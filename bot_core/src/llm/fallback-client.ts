import type { ChatMessage, LLMProvider, LLMResponse } from "./types.ts"

const NON_RETRIABLE_PATTERNS = [
  /content policy/i,
  /safety/i,
  /harmful/i,
  /violat/i,
]

function isNonRetriable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // HTTP 400 系エラー
  if (/\b4[0-9]{2}\b/.test(message)) return true
  // コンテンツポリシー違反
  return NON_RETRIABLE_PATTERNS.some((pattern) => pattern.test(message))
}

export class FallbackLLMClient {
  constructor(
    private primary: LLMProvider,
    private fallback: LLMProvider,
    private personaId: string,
  ) {}

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<LLMResponse> {
    try {
      const text = await this.primary.chat(messages, systemPrompt)
      return { text, provider: this.primary.name }
    } catch (primaryError) {
      if (isNonRetriable(primaryError)) {
        throw primaryError
      }

      console.warn(
        `[${this.personaId}] Primary LLM (${this.primary.name}) failed, falling back to ${this.fallback.name}:`,
        primaryError instanceof Error ? primaryError.message : primaryError,
      )

      const text = await this.fallback.chat(messages, systemPrompt)
      return { text, provider: this.fallback.name }
    }
  }
}
