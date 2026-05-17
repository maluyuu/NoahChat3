import {
  createPartFromFunctionResponse,
  FunctionCallingConfigMode,
  GoogleGenAI,
  Type,
} from "@google/genai"
import type {
  Content,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
} from "@google/genai"
import type { ChatMessage, LLMProvider } from "./types.ts"
import {
  buildAttachmentSummary,
  downloadAttachment,
} from "./attachment-utils.ts"
import {
  TavilyClient,
  type TavilySearchDepth,
  type TavilySearchOptions,
  type TavilySearchTopic,
  type TavilyTimeRange,
} from "../services/tavily-client.ts"

interface GeminiProviderOptions {
  webSearch?: {
    enabled: boolean
    maxResults: number
    searchDepth: TavilySearchDepth
  }
}

const WEB_SEARCH_TOOL_NAME = "web_search"
const MAX_TOOL_ROUNDS = 2

const WEB_SEARCH_SYSTEM_INSTRUCTION = `
必要な場合のみ ${WEB_SEARCH_TOOL_NAME} tool を使ってWeb検索できます。
最新情報、時間依存の情報、知らない固有名詞、事実確認が必要な情報だけ検索してください。
検索結果を使った場合は、回答中に参照したURLを簡潔に含めてください。
検索しなくても答えられる場合は tool を使わずに通常どおり回答してください。`.trim()

const WEB_SEARCH_DECLARATION: FunctionDeclaration = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    "Search the web with Tavily when current, source-backed, or unfamiliar information is needed. Do not use for ordinary conversation or stable knowledge.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: "A concise search query under 400 characters.",
      },
      topic: {
        type: Type.STRING,
        enum: ["general", "news", "finance"],
        description: "Use news for recent events, finance for market-related queries, otherwise general.",
      },
      time_range: {
        type: Type.STRING,
        enum: ["day", "week", "month", "year"],
        description: "Optional recency filter for time-sensitive searches.",
      },
    },
    required: ["query"],
  },
}

async function buildContents(messages: ChatMessage[]): Promise<Content[]> {
  const contents: Content[] = []

  for (const message of messages) {
    const parts: Part[] = []
    const text = message.content.trim()
    if (text) {
      parts.push({ text })
    }

    for (const attachment of message.attachments ?? []) {
      try {
        const downloaded = await downloadAttachment(attachment)
        parts.push({
          inlineData: {
            mimeType: downloaded.mimeType,
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

function extractResponseText(response: GenerateContentResponse): string {
  const text = response.text?.trim()
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

function isKeyRotatable(error: unknown): boolean {
  const status = getErrorStatus(error)
  if (status && KEY_ROTATABLE_STATUS_CODES.has(status)) return true
  const message = error instanceof Error ? error.message : String(error)
  return KEY_ROTATABLE_PATTERNS.some((p) => p.test(message))
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : undefined
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini"
  private apiKeys: string[]
  private modelName: string
  private webSearch: GeminiProviderOptions["webSearch"]
  private tavilyClient: TavilyClient | null

  constructor(apiKeys: string | string[], modelName: string, options: GeminiProviderOptions = {}) {
    this.apiKeys = Array.isArray(apiKeys) ? apiKeys : [apiKeys]
    if (this.apiKeys.length === 0) {
      throw new Error("GeminiProvider requires at least one API key")
    }
    this.modelName = modelName
    this.webSearch = options.webSearch

    const tavilyApiKey = process.env.TAVILY_API_KEY
    this.tavilyClient = tavilyApiKey ? new TavilyClient(tavilyApiKey) : null
    if (this.webSearch?.enabled && !this.tavilyClient) {
      console.warn("[gemini] Web search is enabled but TAVILY_API_KEY is not set; web_search tool disabled")
    }
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
        const ai = new GoogleGenAI({ apiKey })
        return await this.generateWithTools(ai, contents, systemPrompt)
      } catch (error) {
        if (i < this.apiKeys.length - 1 && isKeyRotatable(error)) {
          console.warn(
            `[gemini] API key #${i + 1} failed, trying next key:`,
            error instanceof Error ? error.message : error,
          )
          lastError = error
          continue
        }
        throw error
      }
    }

    throw lastError
  }

  private async generateWithTools(
    ai: GoogleGenAI,
    initialContents: Content[],
    systemPrompt: string,
  ): Promise<string> {
    const toolsEnabled = this.isWebSearchAvailable()
    const config = {
      systemInstruction: toolsEnabled
        ? `${systemPrompt}\n\n---\n${WEB_SEARCH_SYSTEM_INSTRUCTION}`
        : systemPrompt,
      ...(toolsEnabled
        ? {
          tools: [{ functionDeclarations: [WEB_SEARCH_DECLARATION] }],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.AUTO,
            },
          },
        }
        : {}),
    }

    const contents = [...initialContents]
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await ai.models.generateContent({
        model: this.modelName,
        contents,
        config,
      })

      const functionCalls = response.functionCalls ?? []
      if (functionCalls.length === 0) {
        return extractResponseText(response)
      }

      if (round === MAX_TOOL_ROUNDS) {
        throw new Error("Gemini exceeded the maximum web_search tool rounds")
      }

      const modelContent = response.candidates?.[0]?.content
      if (modelContent) {
        contents.push(modelContent)
      }

      const responseParts = await Promise.all(
        functionCalls.map((functionCall) => this.executeFunctionCall(functionCall)),
      )
      contents.push({
        role: "user",
        parts: responseParts,
      })
    }

    throw new Error("Gemini failed to produce a final response")
  }

  private isWebSearchAvailable(): boolean {
    return this.webSearch?.enabled === true && this.tavilyClient !== null
  }

  private async executeFunctionCall(functionCall: FunctionCall): Promise<Part> {
    const name = functionCall.name ?? ""
    if (name !== WEB_SEARCH_TOOL_NAME) {
      return createPartFromFunctionResponse(functionCall.id ?? "", name, {
        error: `Unknown function: ${name || "(missing name)"}`,
      })
    }

    try {
      const result = await this.runWebSearch(functionCall.args ?? {})
      return createPartFromFunctionResponse(functionCall.id ?? "", WEB_SEARCH_TOOL_NAME, {
        output: result,
      })
    } catch (error) {
      return createPartFromFunctionResponse(functionCall.id ?? "", WEB_SEARCH_TOOL_NAME, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async runWebSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.tavilyClient || !this.webSearch) {
      throw new Error("web_search tool is disabled")
    }

    const query = typeof args.query === "string" ? args.query.trim() : ""
    if (!query) {
      throw new Error("web_search requires a non-empty query")
    }

    const topic = parseEnum<TavilySearchTopic>(args.topic, ["general", "news", "finance"])
    const timeRange = parseEnum<TavilyTimeRange>(args.time_range, ["day", "week", "month", "year"])
    const options: TavilySearchOptions = {
      query,
      topic,
      timeRange,
      maxResults: this.webSearch.maxResults,
      searchDepth: this.webSearch.searchDepth,
    }

    const response = await this.tavilyClient.search(options)
    return {
      query: response.query,
      answer: response.answer,
      results: response.results.map((result) => ({
        title: result.title,
        url: result.url,
        content: result.content,
        score: result.score,
        publishedDate: result.publishedDate,
      })),
    }
  }
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined
  return allowed.includes(value as T) ? value as T : undefined
}
