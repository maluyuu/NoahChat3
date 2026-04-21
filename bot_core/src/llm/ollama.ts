import type { ChatMessage, LLMProvider } from "./types.ts"
import {
  buildAttachmentSummary,
  downloadAttachment,
  isImageMimeType,
} from "./attachment-utils.ts"

interface OllamaChatRequest {
  model: string
  messages: Array<{ role: string; content: string; images?: string[] }>
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
    const preparedMessages = await Promise.all(
      messages.map((message) => buildOllamaMessage(message)),
    )
    const hasImages = preparedMessages.some((message) => (message.images?.length ?? 0) > 0)
    if (hasImages && !isLikelyVisionModel(this.modelName)) {
      console.warn(
        `[ollama] Model ${this.modelName} may not support image inputs. Use a vision-capable model such as gemma3, llava, or a VL variant.`,
      )
    }

    const ollamaMessages: Array<{ role: string; content: string; images?: string[] }> = [
      { role: "system", content: systemPrompt },
      ...preparedMessages.filter((message) => message.content || message.images?.length),
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

async function buildOllamaMessage(
  message: ChatMessage,
): Promise<{ role: string; content: string; images?: string[] }> {
  const contentSections: string[] = []
  const images: string[] = []

  const text = message.content.trim()
  if (text) {
    contentSections.push(text)
  }

  for (const attachment of message.attachments ?? []) {
    try {
      const downloaded = await downloadAttachment(attachment)
      if (isImageMimeType(downloaded.mimeType)) {
        images.push(downloaded.base64Data)
        continue
      }

      if (downloaded.textContent) {
        contentSections.push(
          `[添付ファイル: ${buildAttachmentSummary(attachment)}]\n${downloaded.textContent}`,
        )
        continue
      }

      contentSections.push(
        `[添付ファイル: ${buildAttachmentSummary(attachment)}。この形式は Ollama にはバイナリのまま渡せないため、メタデータのみ共有します。]`,
      )
    } catch (error) {
      contentSections.push(
        `[添付ファイルを取得できませんでした: ${buildAttachmentSummary(attachment)}]`,
      )
      console.warn(
        `[ollama] Failed to prepare attachment ${attachment.filename}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  const content = contentSections.join("\n\n").trim() || (images.length > 0 ? "添付画像を確認してください。" : "")
  return images.length > 0
    ? { role: message.role, content, images }
    : { role: message.role, content }
}

function isLikelyVisionModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase()
  return [
    "vision",
    "vl",
    "llava",
    "bakllava",
    "gemma3",
    "moondream",
    "minicpm-v",
  ].some((token) => normalized.includes(token))
}
