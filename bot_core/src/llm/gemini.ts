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

const KEY_ROTATABLE_STATUS_CODES = new Set([429, 500, 503])
const KEY_ROTATABLE_PATTERNS = [
  /quota/i,
  /rate.?limit/i,
  /resource.?exhausted/i,
  /too.?many.?requests/i,
]

function isKeyRotatable(status: number, data: GeminiGenerateContentResponse): boolean {
  if (KEY_ROTATABLE_STATUS_CODES.has(status)) return true
  const message = data.error?.message ?? ""
  return KEY_ROTATABLE_PATTERNS.some((p) => p.test(message))
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini"
  private apiKeys: string[]
  private modelName: string

  constructor(apiKeys: string | string[], modelName: string) {
    this.apiKeys = Array.isArray(apiKeys) ? apiKeys : [apiKeys]
    if (this.apiKeys.length === 0) {
      throw new Error("GeminiProvider requires at least one API key")
    }
    this.modelName = modelName
  }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<string> {
    const contents = await buildContents(messages)
    if (contents.length === 0) {
      throw new Error("No valid messages provided to Gemini")
    }

    let lastError: unknown
    for (let i = 0; i < this.apiKeys.length; i++) {
      const apiKey = this.apiKeys[i]
      try {
        const response = await fetch(
          `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(this.modelName)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
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
          if (i < this.apiKeys.length - 1 && isKeyRotatable(response.status, data)) {
            console.warn(
              `[gemini] API key #${i + 1} failed (HTTP ${response.status}), trying next key`,
            )
            lastError = new Error(JSON.stringify(data))
            continue
          }
          throw new Error(JSON.stringify(data))
        }

        return extractResponseText(data)
      } catch (error) {
        if (i < this.apiKeys.length - 1) {
          console.warn(`[gemini] API key #${i + 1} threw an error, trying next key:`, error instanceof Error ? error.message : error)
          lastError = error
          continue
        }
        throw error
      }
    }

    throw lastError
  }
}
