# Model providers

FieldKit uses the workspace's response provider for support decisions, answer previews, FAQ assistance, whole-library FAQ review, and all five inbox assistant tasks. A workflow agent step can override the response provider and model. Knowledge embeddings have a separate provider, model, and dimension setting.

## Connect and select

1. In **Connections**, choose the provider and enter its API key. vLLM and the generic compatible option also need an API base URL. Keys are encrypted on the server.
2. Optionally enter an exact model ID to validate. Connection checks read account/model metadata; they do not generate text or embeddings. A listed model still needs to support the request format below.
3. In **Settings**, choose the response provider and its model ID, then the embedding provider, embedding model, dimensions, and monthly token budget. Connecting a provider does not change the active workspace settings.
4. Add knowledge and run **Test answer** or **Test workflow**. These tests use the configured providers and consume their quota. Generated FAQs remain private until reviewed and approved.

| Connection | Responses | Embeddings |
| --- | --- | --- |
| OpenAI | Responses API with structured output | OpenAI Embeddings API |
| Claude / Anthropic | Native Messages API with JSON schema output | Choose a separate embedding connection |
| Kimi / Moonshot | Chat Completions with JSON object output, using the international Moonshot endpoint | Choose a separate embedding connection |
| OpenRouter | Chat Completions with JSON schema; routing requires parameter support | An available embedding model |
| DeepSeek | Chat Completions with JSON object output | Choose a separate embedding connection |
| vLLM | Compatible Chat Completions; JSON schema or JSON object | A served embedding model |
| OpenAI-compatible | Compatible Chat Completions; JSON schema or JSON object | Compatible Embeddings API |

Use exact model IDs from the provider, including prefixes such as `openai/` where required by OpenRouter. Claude models must support structured outputs. Reasoning models must finish a complete JSON answer within the per-request token and time limits. Unsupported formats, refusals, truncated output, and invalid schemas fail clearly; the agent hands off instead of inventing a response or retrying with another provider.

The defaults remain OpenAI `gpt-5.4-mini`, `text-embedding-3-small`, 1536 dimensions, and a workspace budget of 1,000,000 tokens per month. Existing installations retain these settings and their current knowledge vectors.

## Embeddings and reindexing

Claude, Kimi, or DeepSeek can answer using knowledge embedded by OpenAI, OpenRouter, or a local embedding server. Dimensions must match the embedding model's output (32–4096 supported). Changing the embedding provider, model, dimensions, or selected custom server queues a full knowledge reindex. Retrieval only compares vectors from the exact same configuration. Sources become available again as indexing finishes; inspect **Knowledge** for progress or errors. Rebuilding unchanged content preserves its existing public-article publication state. Changing only the response model needs no reindex.

FieldKit stores one connection per provider per workspace. To run separate local response and embedding servers, use **vLLM** for one and **OpenAI-compatible** for the other, each with its own base URL and model ID. Any embeddings-only server must expose a compatible `/models` catalog and `/embeddings` endpoint.

## Local vLLM and other private endpoints

Public custom endpoints require HTTPS and public network addresses. An installation operator can explicitly allow private model servers in `.env`:

```dotenv
FIELDKIT_MODEL_ENDPOINTS=http://vllm:8000/v1,http://embeddings:8000/v1
```

Restart both app and worker after changing this setting. Enter the exact same base URL in Connections. The URL must be reachable from both processes; inside Docker, `localhost` refers to that container, so use a reachable service name or host address. This setting does not start a model server. Operate vLLM separately with the desired models and compatible output support.

API keys may be empty for these custom connections when the model server requires no authentication. Destinations cannot contain credentials, queries, or fragments. Requests use fixed model API routes, size limits, timeouts, and no redirects. The allowlist applies only to model connections; document imports and custom business actions retain their public-HTTPS restrictions.

## Usage and verification

Each request records its provider, model, and reported token usage. Reported usage is recorded even when FieldKit rejects a generated result. Missing usage or an uncertain failed request retains a conservative budget reservation. The workspace budget covers response, FAQ, staff-assistance, and embedding calls across all providers; it is a token limit, not a currency limit. Provider billing remains separate. Model calls have a 45-second timeout and no automatic retry or provider fallback.

OpenAI response requests set `store:false`. Other providers follow their own retention settings. Only connect providers permitted to receive the selected documents, conversation text, and account context.

Adapters are covered by deterministic contract tests, including a real local HTTP transport test. This is not live vendor certification. Run the opt-in `npm run test:live` evaluation against a dedicated workspace configured with each provider/model, then record evidence separately in the [release gates](verification.md).

Provider references: [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Kimi Chat Completions](https://platform.kimi.com/docs/api/chat), [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [OpenRouter embeddings](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request), [DeepSeek API](https://api-docs.deepseek.com/), [vLLM compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/).
