export interface ChatAttachment {
  url: string
  proxyUrl?: string | null
  filename: string
  mimeType?: string | null
  size?: number
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
  attachments?: ChatAttachment[]
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[], systemPrompt: string): Promise<string>
}

export interface LLMResponse {
  text: string
  provider: string
}
