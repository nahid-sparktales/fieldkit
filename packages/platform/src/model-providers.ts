import { z } from "zod";

export const ModelProvider = z.enum([
  "openai",
  "anthropic",
  "kimi",
  "openrouter",
  "deepseek",
  "vllm",
  "openai_compatible",
]);
export type ModelProviderId = z.infer<typeof ModelProvider>;
export const EmbeddingProvider = z.enum([
  "openai",
  "openrouter",
  "vllm",
  "openai_compatible",
]);
export const MODEL_PROVIDERS: Record<
  ModelProviderId,
  {
    name: string;
    baseUrl: string;
    format: "schema" | "json";
    description: string;
  }
> = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    format: "schema",
    description: "Responses and knowledge embeddings with your own API key.",
  },
  anthropic: {
    name: "Claude / Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    format: "schema",
    description: "Claude responses, FAQ drafting, and support assistance.",
  },
  kimi: {
    name: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    format: "json",
    description: "Kimi models through the Moonshot Platform API.",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    format: "schema",
    description:
      "Choose supported response and embedding models through OpenRouter.",
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    format: "json",
    description: "DeepSeek models through their direct API.",
  },
  vllm: {
    name: "vLLM",
    baseUrl: "",
    format: "schema",
    description: "Connect your self-hosted OpenAI-compatible model server.",
  },
  openai_compatible: {
    name: "OpenAI-compatible",
    baseUrl: "",
    format: "schema",
    description: "Other providers serving Chat Completions or embeddings.",
  },
};
export type EmbeddingConfig = {
  provider: z.infer<typeof EmbeddingProvider>;
  model: string;
  dimensions: number;
  key: string;
};
