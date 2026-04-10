export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[], systemPrompt: string): Promise<string>
}

export interface LLMResponse {
  text: string
  provider: string
}
