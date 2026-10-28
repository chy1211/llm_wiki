import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => realFs)

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")
    const targetPath = systemPrompt.match(
      /source summary page at \*\*(wiki\/sources\/[^*]+)\*\*/,
    )?.[1]
    if (!targetPath) {
      cb.onToken("## Analysis\nConfiguration source.")
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }
    cb.onToken([
      `---FILE: ${targetPath}---`,
      "---",
      'title: "Source: config.yaml"',
      'sources: ["config.yaml"]',
      "---",
      "",
      "# Source: config.yaml",
      "---END FILE---",
    ].join("\n"))
    cb.onDone({ finishReason: "stop", truncated: false })
  }),
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import {
  autoIngest,
  computeIngestAnalysisMaxTokens,
  computeIngestGenerationMaxTokens,
  computeIngestReviewMaxTokens,
} from "./ingest"
import { streamChat } from "./llm-client"

const mockStreamChat = vi.mocked(streamChat)

const baseConfig: LlmConfig = {
  provider: "openai",
  apiKey: "k",
  model: "gpt-5",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
}

describe("per-provider maxOutputTokens", () => {
  it("overrides the derived analysis, generation and review caps when set", () => {
    expect(computeIngestAnalysisMaxTokens(128_000, 50_000)).toBe(50_000)
    expect(computeIngestGenerationMaxTokens(128_000, 50_000)).toBe(50_000)
    // Review stays half of generation, clamped to 4096..16384.
    expect(computeIngestReviewMaxTokens(128_000, 50_000)).toBe(16_384)
    expect(computeIngestReviewMaxTokens(128_000, 6_000)).toBe(4_096)
  })

  it.each([undefined, 0, -1, Number.NaN])("keeps the upstream derived caps when unset (%s)", (value) => {
    expect(computeIngestAnalysisMaxTokens(128_000, value)).toBe(9_600)
    expect(computeIngestGenerationMaxTokens(128_000, value)).toBe(16_384)
    expect(computeIngestReviewMaxTokens(128_000, value)).toBe(8_192)
    expect(computeIngestAnalysisMaxTokens(1_000_000, value)).toBe(32_768)
    expect(computeIngestReviewMaxTokens(1_000_000, value)).toBe(16_384)
  })

  it("survives the preset resolver and drops non-positive values", () => {
    const preset = { id: "openai", label: "OpenAI", provider: "openai" } as never
    expect(resolveConfig(preset, { maxOutputTokens: 50_000 }, baseConfig).maxOutputTokens).toBe(50_000)
    expect(resolveConfig(preset, { maxOutputTokens: 0 }, baseConfig).maxOutputTokens).toBeUndefined()
    expect(resolveConfig(preset, {}, baseConfig).maxOutputTokens).toBeUndefined()
  })
})

describe("autoIngest max_tokens with per-provider maxOutputTokens", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    mockStreamChat.mockClear()
    tmp = await createTempProject("max-output-tokens")
    await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n")
    await writeFileRaw(`${tmp.path}/schema.md`, "# Schema\n")
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(`${tmp.path}/raw/sources/config.yaml`, "name: alpha\n")
    useReviewStore.setState({ items: [] })
    useActivityStore.setState({ items: [] })
    useWikiStore.setState({
      project: { id: "max-output-tokens", name: "max-output-tokens", path: tmp.path },
      fileTree: [],
      outputLanguage: "auto",
    })
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  async function ingestMaxTokens(config: LlmConfig): Promise<{ analysis: unknown; generation: unknown }> {
    if (!tmp) throw new Error("missing temp project")
    await autoIngest(tmp.path, `${tmp.path}/raw/sources/config.yaml`, config)
    const calls = mockStreamChat.mock.calls.map(([, messages, , , options]) => ({
      system: String(messages?.[0]?.content ?? ""),
      maxTokens: options?.max_tokens,
    }))
    const generation = calls.filter((call) => call.system.includes("source summary page at **"))
    const analysis = calls.filter((call) => !call.system.includes("source summary page at **"))
    expect(generation).toHaveLength(1)
    expect(analysis).toHaveLength(1)
    return { analysis: analysis[0].maxTokens, generation: generation[0].maxTokens }
  }

  it("uses the configured value for both analysis and generation", async () => {
    expect(await ingestMaxTokens({ ...baseConfig, maxOutputTokens: 50_000 }))
      .toEqual({ analysis: 50_000, generation: 50_000 })
  })

  it("falls back to the upstream derived values when unset", async () => {
    expect(await ingestMaxTokens(baseConfig)).toEqual({
      analysis: computeIngestAnalysisMaxTokens(128_000),
      generation: computeIngestGenerationMaxTokens(128_000),
    })
    expect(computeIngestAnalysisMaxTokens(128_000)).toBe(9_600)
    expect(computeIngestGenerationMaxTokens(128_000)).toBe(16_384)
  })
})
