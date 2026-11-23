# Portable Tool Schema Subset

Pi validates a tool's arguments locally with pi-schema, and the same schema travels to the provider that runs the model. Providers disagree on JSON Schema support. A schema built from this subset compiles on every major provider: OpenAI, Anthropic, Gemini, Mistral, Cohere, AWS Bedrock, DeepSeek, xAI, OpenRouter, Together, Fireworks, Groq, Cerebras, vLLM, llama.cpp, Ollama, and LM Studio.

A keyword pi validates locally can still fail at the provider. When the two conflict, build from this subset and enforce the rule in `execute`.

Compiled from provider documentation, November 2026.

## Safe keywords

| Keyword | Rule |
|---|---|
| `type` | `string`, `integer`, `number`, `boolean`, `object`, `array` |
| `properties` | Plain objects only |
| `required` | List every property, including optional ones (see nullability) |
| `additionalProperties` | `false` on every object |
| `description` | The one annotation every provider treats as model-facing |
| `enum` | Unique string literals |
| `items` | One schema object, never an array |
| `anyOf` | Object schemas, below the root |
| `$defs` / `$ref` | Root-level `$defs`, pointers like `#/$defs/Name`, non-recursive |

Use nothing else. Unsupported keywords reject the whole request on strict providers (OpenAI, xAI) and vanish without warning elsewhere (Gemini declarations, llama.cpp).

## Rules

- **Required everything.** Strict modes (OpenAI, Groq, DeepSeek, Cerebras) reject optional fields. Model an optional argument as nullable and keep it in `required`.
- **Nullability.** Emit `{"anyOf": [{"type": "<T>"}, {"type": "null"}]}`. Cap unions at 16 per tool. Anthropic compiles schemas into grammars and errors past its budget of 24 optional and 16 union parameters per request.
- **Depth.** Nest at most 3 levels. Treat 5 as the hard cap. Deep nesting plus optionality breaks Anthropic's grammar compiler.
- **Closed objects.** `additionalProperties: false` everywhere. Model a key-value map as an array of `{key, value}` objects.
- **Unions.** `anyOf` of complete object schemas, never at the root. `oneOf`, `allOf`, and `not` fail somewhere on every path.
- **References.** Keep `$defs` at the root. Allow one level of self-reference at most. No external refs, no nested `$defs`.
- **No value constraints in the wire schema.** Omit `minimum`, `maximum`, `pattern`, `minLength`, `maxLength`, `format`, `minItems`, `maxItems`, `default`, and `examples`. Enforce them in `execute` and state them in the description.
- **Describe.** Put meaning in `description` on the tool and on each property. Express machine-readable structure with `enum` instead of `pattern`.

## Provider transforms

Reach for these only at a provider boundary:

| Provider | Transform |
|---|---|
| Gemini | `type` is a single OpenAPI string. Nullability uses `nullable: true`. Refs spell `ref`/`defs` without `$`. Enum values are strings even for integer enums. |
| OpenAI, xAI | Accept `"type": ["string", "null"]` directly. |
| DeepSeek | Documents `$defs` spelled `$def`. |
| Anthropic | Enum and const casing can drift. Property order puts required fields first. |

## Failure shapes

- **Hard error.** OpenAI, xAI, and Cerebras strict modes return 400 on unsupported keywords and root unions. Anthropic returns "Schema is too complex for compilation" or times out at 180 seconds.
- **Silent drop.** Gemini declarations ignore attributes outside their documented list. llama.cpp skips unsupported keywords silently. The Anthropic SDK strips range and length keywords into descriptions.
- **Best effort.** Groq and Bedrock outside strict mode, and Together, accept any schema and enforce nothing.

Valid JSON Schema still fails provider compilation. Test schema compilation per provider, not just correctness.

## Reference shape

```json
{
  "type": "object",
  "properties": {
    "city": {
      "type": "string",
      "description": "City name, e.g. 'Paris'"
    },
    "unit": {
      "type": "string",
      "enum": ["celsius", "fahrenheit"],
      "description": "Temperature unit"
    },
    "station_id": {
      "description": "Optional station override",
      "anyOf": [{ "type": "string" }, { "type": "null" }]
    }
  },
  "required": ["city", "unit", "station_id"],
  "additionalProperties": false
}
```
