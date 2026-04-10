import type { ChatMessage, LLMProvider } from "./types.ts"

interface OllamaChatRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  stream: boolean
}

interface OllamaChatResponse {
  message: {
    role: string
    content: string
  }
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama"
  private baseUrl: string
  private modelName: string

  constructor(modelName: string, baseUrl?: string) {
    this.modelName = modelName
    this.baseUrl = baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
  }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<string> {
    const ollamaMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      ...messages.map((msg) => ({ role: msg.role, content: msg.content })),
    ]

    const body: OllamaChatRequest = {
      model: this.modelName,
      messages: ollamaMessages,
      stream: false,
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as OllamaChatResponse
    return data.message.content
  }
}
