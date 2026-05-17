export type TavilySearchDepth = "ultra-fast" | "fast" | "basic" | "advanced"
export type TavilySearchTopic = "general" | "news" | "finance"
export type TavilyTimeRange = "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y"

export interface TavilySearchOptions {
  query: string
  topic?: TavilySearchTopic
  timeRange?: TavilyTimeRange
  maxResults?: number
  searchDepth?: TavilySearchDepth
}

export interface TavilySearchResult {
  title: string
  url: string
  content: string
  score?: number
  publishedDate?: string
}

export interface TavilySearchResponse {
  query: string
  answer?: string
  results: TavilySearchResult[]
}

interface TavilyApiResponse {
  query?: string
  answer?: string | null
  results?: Array<{
    title?: string
    url?: string
    content?: string
    score?: number
    published_date?: string
  }>
  error?: string
  detail?: unknown
}

const TAVILY_API_URL = "https://api.tavily.com/search"

export class TavilyClient {
  constructor(private readonly apiKey: string) {}

  async search(options: TavilySearchOptions): Promise<TavilySearchResponse> {
    const query = options.query.trim()
    if (!query) {
      throw new Error("Tavily search query is empty")
    }

    const response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query.slice(0, 400),
        search_depth: options.searchDepth ?? "basic",
        topic: options.topic ?? "general",
        ...(options.timeRange ? { time_range: options.timeRange } : {}),
        max_results: clampInteger(options.maxResults ?? 5, 1, 10),
        include_answer: true,
        include_raw_content: false,
        include_images: false,
      }),
    })

    const data = (await response.json()) as TavilyApiResponse
    if (!response.ok) {
      throw new Error(`Tavily search failed (${response.status}): ${JSON.stringify(data)}`)
    }

    return {
      query: data.query ?? query,
      answer: data.answer?.trim() || undefined,
      results: (data.results ?? [])
        .filter((result) => result.title && result.url)
        .map((result) => ({
          title: result.title ?? "",
          url: result.url ?? "",
          content: result.content ?? "",
          score: result.score,
          publishedDate: result.published_date,
        })),
    }
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
