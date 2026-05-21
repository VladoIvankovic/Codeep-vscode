# Choose your model — including self-hosted

Run **Codeep: Select Provider & Model** (or click the model name in the status
bar) to switch between providers and models without leaving the editor.

### Use your own OpenAI-compatible endpoint

Codeep works with **vLLM, LiteLLM, LM Studio, and text-generation-webui**. Point
it at your server with two settings:

- **`codeep.baseUrl`** → `http://localhost:8000/v1`
- **`codeep.provider`** → `custom` (no API key) or `openai`
- **`codeep.model`** → a model your server serves (e.g. `qwen3-coder-30b`)

For hosted providers, run **Codeep: Set API Key** instead and pick your provider.
