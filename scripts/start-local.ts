import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"

const ROOT = path.resolve(import.meta.dir, "..")
const RAG_DIR = path.join(ROOT, "services", "rag")
const BOT_DIR = path.join(ROOT, "bot_core")
const HOST_PYTHON = findCommand(["python3.12", "python3.11", "python3", "python"])
const PYTHON_TAG = getPythonTag(HOST_PYTHON)
const VENV_DIR = path.join(ROOT, ".venv", `rag-${PYTHON_TAG}`)
const RAG_PORT = process.env.RAG_PORT ?? "8002"
const RAG_URL = `http://localhost:${RAG_PORT}`

const isWindows = process.platform === "win32"
const venvPython = path.join(VENV_DIR, isWindows ? "Scripts/python.exe" : "bin/python")

const children = new Set<ChildProcess>()

async function main(): Promise<void> {
  loadDotEnv(path.join(ROOT, ".env"))
  prepareEnvironment()

  console.log("[local] Preparing Python RAG environment")
  ensurePythonVenv()
  installRagDependencies()

  console.log("[local] Preparing bot_core dependencies")
  installBotDependencies()

  const rag = await startOrReuseRag()

  console.log("[local] Starting bot_core")
  const bot = spawnManaged("bun", ["run", "src/main.ts"], {
    cwd: BOT_DIR,
    env: process.env,
    label: "bot",
  })

  const watchedProcesses = rag ? [rag, bot] : [bot]
  const exited = await waitForAnyExit(watchedProcesses)
  console.log(`[local] ${exited.label} exited; shutting down`)
  shutdown(exited.code)
}

async function startOrReuseRag(): Promise<ChildProcess | null> {
  const healthUrl = `${RAG_URL}/health`
  if (await isHealthy(healthUrl)) {
    console.log(`[local] Reusing existing RAG service: ${healthUrl}`)
    return null
  }

  console.log("[local] Starting RAG service")
  const rag = spawnManaged(
    venvPython,
    ["-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", RAG_PORT],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PYTHONPATH: RAG_DIR,
      },
      label: "rag",
    },
  )

  await waitForHealth(healthUrl, 180_000)
  return rag
}

function prepareEnvironment(): void {
  process.env.RAG_SERVICE_URL = normalizeLocalUrl(process.env.RAG_SERVICE_URL)
  process.env.DISCORD_MESSAGE_DB = normalizeLocalPath(
    process.env.DISCORD_MESSAGE_DB,
    path.join(ROOT, "data", "history", "discord_messages.db"),
  )
  process.env.HISTORY_DIR = normalizeLocalPath(
    process.env.HISTORY_DIR,
    path.join(ROOT, "data", "history"),
  )
  process.env.PERSONAS_DIR = normalizeLocalPath(
    process.env.PERSONAS_DIR,
    path.join(ROOT, "bot_core", "personas"),
  )
  process.env.TRANSFORMERS_CACHE ??= path.join(ROOT, ".cache", "huggingface")
  process.env.HF_HOME ??= process.env.TRANSFORMERS_CACHE
  process.env.RAG_DEVICE ??= "auto"
  process.env.RAG_TORCH_NUM_THREADS ??= "auto"
  process.env.RAG_ENCODE_BATCH_SIZE ??= "auto"
  process.env.RAG_MAX_EMBED_TEXT_CHARS ??= "12000"
  process.env.PYTORCH_ENABLE_MPS_FALLBACK ??= "1"
  process.env.TOKENIZERS_PARALLELISM ??= "false"

  mkdirSync(path.join(ROOT, "data", "history"), { recursive: true })
  mkdirSync(path.join(ROOT, "data", "faiss_indices"), { recursive: true })
  mkdirSync(process.env.TRANSFORMERS_CACHE, { recursive: true })
}

function normalizeLocalUrl(value: string | undefined): string {
  if (!value || value.includes("://rag:")) return RAG_URL
  return value
}

function normalizeLocalPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  if (value === "/app" || value.startsWith("/app/")) return fallback
  if (path.isAbsolute(value)) return value
  return path.join(ROOT, value)
}

function ensurePythonVenv(): void {
  if (existsSync(venvPython)) return

  runOrThrow(HOST_PYTHON, ["-m", "venv", VENV_DIR], { cwd: ROOT })
}

function installRagDependencies(): void {
  const marker = path.join(VENV_DIR, ".requirements-installed")
  const requirements = path.join(RAG_DIR, "requirements.txt")
  const requirementsHash = sha256(readFileSync(requirements, "utf-8"))
  if (existsSync(marker) && readFileSync(marker, "utf-8") === requirementsHash) return

  runOrThrow(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], { cwd: ROOT })
  runOrThrow(venvPython, ["-m", "pip", "install", "-r", requirements], { cwd: ROOT })
  writeFileSync(marker, requirementsHash)
}

function installBotDependencies(): void {
  if (existsSync(path.join(BOT_DIR, "node_modules"))) return
  runOrThrow("bun", ["install", "--frozen-lockfile"], { cwd: BOT_DIR })
}

function spawnManaged(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    label: string
  },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { localLabel?: string }
  child.localLabel = options.label
  children.add(child)

  child.stdout?.on("data", (chunk) => prefixOutput(options.label, chunk))
  child.stderr?.on("data", (chunk) => prefixOutput(options.label, chunk))
  child.on("exit", (code, signal) => {
    children.delete(child)
    if (code !== 0 && signal === null) {
      console.error(`[local] ${options.label} exited with code ${code}`)
      shutdown(code ?? 1)
    }
  })

  return child
}

function prefixOutput(label: string, chunk: Buffer): void {
  const text = chunk.toString()
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) console.log(`[${label}] ${line}`)
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        console.log(`[local] RAG service is healthy: ${url}`)
        return
      }
    } catch {
      // Service is still starting.
    }
    await sleep(1_000)
  }
  throw new Error(`RAG service did not become healthy within ${timeoutMs}ms`)
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

function waitForAnyExit(
  processes: Array<ChildProcess & { localLabel?: string }>,
): Promise<{ label: string; code: number }> {
  return new Promise((resolve) => {
    for (const child of processes) {
      child.on("exit", (code, signal) => {
        resolve({
          label: child.localLabel ?? "process",
          code: signal ? 1 : code ?? 0,
        })
      })
    }
  })
}

function runOrThrow(command: string, args: string[], options: { cwd: string }): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`)
  }
}

function findCommand(candidates: string[]): string {
  for (const command of candidates) {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" })
    if (result.status === 0) return command
  }
  throw new Error(`None of these commands were found: ${candidates.join(", ")}`)
}

function getPythonTag(command: string): string {
  const result = spawnSync(command, ["-c", "import sys; print(f'py{sys.version_info.major}{sys.version_info.minor}')"], {
    encoding: "utf-8",
  })
  if (result.status !== 0) {
    throw new Error(`Failed to inspect Python version for ${command}`)
  }
  return result.stdout.trim()
}

function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) return

  const content = readFileSync(filePath, "utf-8")
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue

    const [, key, rawValue] = match
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = unquoteEnvValue(rawValue ?? "")
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function shutdown(code: number): void {
  for (const child of children) {
    child.kill("SIGTERM")
  }
  process.exit(code)
}

process.on("SIGINT", () => shutdown(130))
process.on("SIGTERM", () => shutdown(143))

main().catch((error) => {
  console.error("[local] Startup failed:", error instanceof Error ? error.message : error)
  shutdown(1)
})
