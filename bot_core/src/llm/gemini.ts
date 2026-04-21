import type { ChatMessage, LLMProvider } from "./types.ts"
import {
  buildAttachmentSummary,
  downloadAttachment,
} from "./attachment-utils.ts"

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

interface GeminiPart {
  text?: string
  inline_data?: {
    mime_type: string
    data: string
  }
}

interface GeminiContent {
  role?: "user" | "model"
  parts: GeminiPart[]
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

async function buildContents(messages: ChatMessage[]): Promise<GeminiContent[]> {
  const contents: GeminiContent[] = []

  for (const message of messages) {
    const parts: GeminiPart[] = []
    const text = message.content.trim()
    if (text) {
      parts.push({ text })
    }

    for (const attachment of message.attachments ?? []) {
      try {
        const downloaded = await downloadAttachment(attachment)
        parts.push({
          inline_data: {
            mime_type: downloaded.mimeType,
            data: downloaded.base64Data,
          },
        })
      } catch (error) {
        parts.push({
          text: `[添付ファイルを取得できませんでした: ${buildAttachmentSummary(attachment)}]`,
        })
        console.warn(
          `[gemini] Failed to prepare attachment ${attachment.filename}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }

    if (parts.length === 0) continue
    const role = message.role === "user" ? "user" : "model"

    contents.push({
      role,
      parts,
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
    const contents = await buildContents(messages)
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
