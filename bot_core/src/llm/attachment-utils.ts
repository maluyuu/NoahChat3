import { Buffer } from "node:buffer"
import type { ChatAttachment } from "./types.ts"

const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_TEXT_ATTACHMENT_BYTES = 1 * 1024 * 1024
const DEFAULT_MAX_TEXT_ATTACHMENT_CHARS = 12_000

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
}

const attachmentCache = new Map<string, Promise<DownloadedAttachment>>()

export interface DownloadedAttachment {
  filename: string
  mimeType: string
  size: number
  base64Data: string
  textContent?: string
}

export function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/")
}

export function isTextLikeMimeType(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== "string") return false

  return mimeType.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/x-yaml",
    "application/yaml",
    "application/javascript",
  ].includes(mimeType)
}

export function inferMimeType(attachment: ChatAttachment): string {
  const normalized = normalizeMimeType(attachment.mimeType)
  if (normalized) return normalized

  const extension = attachment.filename.match(/\.[^./]+$/)?.[0]?.toLowerCase()
  return extension ? (MIME_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream") : "application/octet-stream"
}

export async function downloadAttachment(
  attachment: ChatAttachment,
): Promise<DownloadedAttachment> {
  const cached = attachmentCache.get(attachment.url)
  if (cached) return cached

  const request = fetchAttachment(attachment)
  attachmentCache.set(attachment.url, request)

  try {
    return await request
  } catch (error) {
    attachmentCache.delete(attachment.url)
    throw error
  }
}

export function buildAttachmentSummary(attachment: ChatAttachment): string {
  const mimeType = inferMimeType(attachment)
  return `${attachment.filename} (${mimeType})`
}

function normalizeMimeType(mimeType: string | null | undefined): string | null {
  if (typeof mimeType !== "string" || !mimeType.trim()) return null
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? null
}

async function fetchAttachment(attachment: ChatAttachment): Promise<DownloadedAttachment> {
  const errors: string[] = []

  for (const candidateUrl of [attachment.url, attachment.proxyUrl].filter(isNonEmptyString)) {
    const response = await fetch(candidateUrl, {
      headers: {
        "User-Agent": "NoahChat3Bot/1.0",
      },
    })
    if (!response.ok) {
      errors.push(`${candidateUrl}: ${response.status} ${response.statusText}`)
      continue
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const size = buffer.byteLength
    const mimeType = normalizeMimeType(response.headers.get("content-type")) ?? inferMimeType(attachment)

    if (size > DEFAULT_MAX_INLINE_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment ${attachment.filename} exceeds the inline size limit (${size} bytes)`,
      )
    }

    if (looksLikeFailedHtmlFetch(attachment, mimeType, buffer)) {
      errors.push(`${candidateUrl}: received HTML instead of ${inferMimeType(attachment)}`)
      continue
    }

    return {
      filename: attachment.filename,
      mimeType,
      size,
      base64Data: buffer.toString("base64"),
      textContent: extractTextContent(buffer, mimeType),
    }
  }

  throw new Error(`Failed to download attachment: ${errors.join(" | ")}`)
}

function extractTextContent(buffer: Buffer, mimeType: string): string | undefined {
  if (!isTextLikeMimeType(mimeType)) return undefined
  if (buffer.byteLength > DEFAULT_MAX_TEXT_ATTACHMENT_BYTES) return undefined

  return buffer
    .toString("utf-8")
    .replace(/\u0000/g, "")
    .slice(0, DEFAULT_MAX_TEXT_ATTACHMENT_CHARS)
}

function looksLikeFailedHtmlFetch(
  attachment: ChatAttachment,
  mimeType: string,
  buffer: Buffer,
): boolean {
  if (mimeType !== "text/html") return false

  const expectedMimeType = inferMimeType(attachment)
  if (!isImageMimeType(expectedMimeType) && expectedMimeType !== "application/pdf") {
    return false
  }

  const preview = buffer.toString("utf-8", 0, Math.min(buffer.byteLength, 512)).toLowerCase()
  return preview.includes("<html") || preview.includes("<!doctype html")
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0
}
