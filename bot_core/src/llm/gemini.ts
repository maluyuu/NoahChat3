import type { ChatMessage, LLMProvider } from "./types.ts"

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

interface GeminiContent {
  role?: "user" | "model"
  parts: Array<{ text: string }>
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
  }>
  error?: {
    code?: number
    message?: string
    status?: string
    details?: unknown[]
  }
}

function buildContents(messages: ChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = []

  for (const message of messages) {
    const text = message.content.trim()
    if (!text) continue

    const role = message.role === "user" ? "user" : "model"
    const previous = contents.at(-1)

    if (previous?.role === role) {
      const previousText = previous.parts[0]?.text
      if (typeof previousText === "string") {
        previous.parts = [{ text: `${previousText}\n\n${text}` }]
        continue
      }
    }

    contents.push({
      role,
      parts: [{ text }],
    })
  }

  while (contents[0]?.role === "model") {
    contents.shift()
  }

  return contents
}

function extractResponseText(data: GeminiGenerateContentResponse): string {
  const text = data.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n")

  if (!text) {
    throw new Error("Gemini returned an empty response")
  }

  return text
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini"
  private apiKey: string
  private modelName: string

  constructor(apiKey: string, modelName: string) {
    this.apiKey = apiKey
    this.modelName = modelName
  }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<string> {
    const contents = buildContents(messages)
    if (contents.length === 0) {
      throw new Error("No valid messages provided to Gemini")
    }

    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(this.modelName)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }],
          },
          contents,
        }),
      },
    )

    const data = (await response.json()) as GeminiGenerateContentResponse
    if (!response.ok) {
      throw new Error(JSON.stringify(data))
    }

    return extractResponseText(data)
  }
}
