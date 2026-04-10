import fs from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

// ---- Zod スキーマ ----

const GeminiConfigSchema = z.object({
  model: z.string().default("gemini-2.5-flash"),
})

const OllamaConfigSchema = z.object({
  model: z.string().default("qwen2.5:7b"),
  base_url: z.string().nullable().optional(),
})

const LLMConfigSchema = z.object({
  system_prompt: z.string(),
  gemini: GeminiConfigSchema.default({}),
  ollama: OllamaConfigSchema.default({}),
})

const RagConfigSchema = z.object({
  index_path: z.string(),
  top_k: z.number().int().positive().default(5),
  enabled: z.boolean().default(true),
})

const McpConfigSchema = z.object({
  auto_approve: z.array(z.string()).default([]),
  require_confirm: z.array(z.string()).default([]),
})

export const PersonaSchema = z.object({
  id: z.string().min(1),
  token_env: z.string().min(1),
  display_name: z.string().min(1),
  llm: LLMConfigSchema,
  rag: RagConfigSchema,
  mcp: McpConfigSchema.default({}),
})

export type Persona = z.infer<typeof PersonaSchema>

// ---- ローダー ----

const PERSONAS_DIR = process.env.PERSONAS_DIR ?? "personas"

export function loadPersonas(): Persona[] {
  const dir = PERSONAS_DIR
  if (!fs.existsSync(dir)) {
    console.warn(`[persona-manager] Personas directory not found: ${dir}`)
    return []
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))

  const personas: Persona[] = []
  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      const raw = fs.readFileSync(filePath, "utf-8")
      const parsed = parseYaml(raw) as unknown
      const result = PersonaSchema.safeParse(parsed)
      if (!result.success) {
        console.error(
          `[persona-manager] Invalid persona file ${file}:`,
          result.error.format(),
        )
        continue
      }
      personas.push(result.data)
      console.log(`[persona-manager] Loaded persona: ${result.data.id} (${result.data.display_name})`)
    } catch (error) {
      console.error(
        `[persona-manager] Failed to parse ${file}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  return personas
}

export function resolveToken(persona: Persona): string {
  const token = process.env[persona.token_env]
  if (!token) {
    throw new Error(
      `[${persona.id}] Discord token not found in environment variable: ${persona.token_env}`,
    )
  }
  return token
}
