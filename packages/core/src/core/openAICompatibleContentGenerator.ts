import { GenerateContentResponse, FinishReason } from '@google/genai';
import type {
  CountTokensResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  Content,
  Part,
  ContentListUnion,
  PartUnion,
} from '@google/genai';
import OpenAI from 'openai';
import type { ContentGenerator } from './contentGenerator.js';
import { jsonrepair } from 'jsonrepair';

import { reportError } from '../utils/errorReporting.js';

export function baseURL(): string {
  return (
    process.env['WCT_CLI_BASE_URL'] || 'https://lab.iwhalecloud.com/gpt-proxy'
  );
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  model_max_tokens?: number;
}
/**
 * Helper function to convert ContentListUnion to Content[]
 */
function toContents(contents: ContentListUnion): Content[] {
  if (Array.isArray(contents)) {
    // it's a Content[] or a PartUnion[]
    return contents.map(toContent);
  }
  // it's a Content or a PartUnion
  return [toContent(contents)];
}

function toContent(content: Content | PartUnion): Content {
  if (Array.isArray(content)) {
    // This shouldn't happen in our context, but handle it
    throw new Error('Array content not supported in this context');
  }
  if (typeof content === 'string') {
    // it's a string
    return {
      role: 'user',
      parts: [{ text: content }],
    };
  }
  if (typeof content === 'object' && content !== null && 'parts' in content) {
    // it's a Content
    return content;
  }
  // it's a Part
  return {
    role: 'user',
    parts: [content as Part],
  };
}

export class OpenAICompatibleContentGenerator implements ContentGenerator {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({
      apiKey,
      baseURL: baseURL(),
    });
  }

  private convertToOpenAIMessages(
    contents: Content[],
    request: GenerateContentParameters,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (request.config?.systemInstruction) {
      const systemInstruction = request.config.systemInstruction;
      let systemText = '';

      if (Array.isArray(systemInstruction)) {
        systemText = systemInstruction
          .map((content) => {
            if (typeof content === 'string') return content;
            if ('parts' in content) {
              const contentObj = content as Content;
              return (
                contentObj.parts
                  ?.map((p: Part) =>
                    typeof p === 'string' ? p : 'text' in p ? p.text : '',
                  )
                  .join('\n') || ''
              );
            }
            return '';
          })
          .join('\n');
      } else if (typeof systemInstruction === 'string') {
        systemText = systemInstruction;
      } else if (
        typeof systemInstruction === 'object' &&
        'parts' in systemInstruction
      ) {
        const systemContent = systemInstruction as Content;
        systemText =
          systemContent.parts
            ?.map((p: Part) =>
              typeof p === 'string' ? p : 'text' in p ? p.text : '',
            )
            .join('\n') || '';
      }

      if (systemText) {
        messages.push({
          role: 'system' as const,
          content: systemText,
        });
      }
    }
    for (const [index, content] of contents.entries()) {
      const role =
        content.role === 'model'
          ? 'assistant'
          : (content.role as 'system' | 'user');
      const parts = content.parts || [];
      const textParts = parts.filter(
        (part: Part): part is { text: string } =>
          typeof part === 'object' && part !== null && 'text' in part,
      );
      if (textParts.length > 0) {
        const combinedText = textParts
          .map((part: { text: string }) => part.text)
          .join('\n');
        messages.push({
          role,
          content: combinedText,
        });
      }

      const functionResponseParts = parts.filter(
        (
          part: Part,
        ): part is {
          functionResponse: {
            id: string;
            name: string;
            response: { output?: string; error?: string };
          };
        } =>
          typeof part === 'object' &&
          part !== null &&
          'functionResponse' in part &&
          part.functionResponse !== undefined &&
          typeof part.functionResponse.id === 'string' &&
          typeof part.functionResponse.name === 'string' &&
          part.functionResponse.name.length > 0 &&
          part.functionResponse.response !== undefined &&
          (typeof part.functionResponse.response['output'] === 'string' ||
            typeof part.functionResponse.response['error'] === 'string'),
      );

      if (functionResponseParts.length > 0) {
        functionResponseParts.forEach((part) => {
          messages.push({
            tool_call_id: part.functionResponse.id,
            role: 'tool',
            name: part.functionResponse.name || 'unknown_function',
            content: part.functionResponse.response.error
              ? `Error: ${part.functionResponse.response.error}`
              : part.functionResponse.response.output,
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
        });
      }
      const functionCallParts = parts.filter(
        (
          part: Part,
        ): part is {
          functionCall: { name: string; args: Record<string, unknown> };
        } =>
          typeof part === 'object' &&
          part !== null &&
          'functionCall' in part &&
          part.functionCall !== undefined &&
          typeof part.functionCall.name === 'string' &&
          part.functionCall.args !== undefined,
      );

      if (functionCallParts.length > 0) {
        if (role === 'user') {
          throw new Error('Function calls cannot come from user role');
        }
        messages.push({
          role: 'assistant', // Force assistant role for tool calls
          content: '',
          tool_calls: functionCallParts.map((part, idx) => {
            let tool_id = undefined;
            if (index + 1 < contents.length) {
              tool_id =
                (
                  contents[index + 1].parts as unknown as Array<{
                    functionResponse: {
                      id: string;
                      name: string;
                      response: { output?: string; error?: string };
                    };
                  }>
                )?.[idx]?.functionResponse?.id || '';
            }
            return {
              id: tool_id || `call_${Math.random().toString(36).slice(2)}`,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args),
              },
            };
          }),
        });
      }
      const inlineDataParts = parts.filter(
        (
          part: Part,
        ): part is {
          inlineData: { data: string; mimeType: string };
        } =>
          typeof part === 'object' &&
          part !== null &&
          'inlineData' in part &&
          part.inlineData !== undefined &&
          typeof part.inlineData.data === 'string' &&
          part.inlineData.mimeType !== undefined,
      );

      if (inlineDataParts.length > 0) {
        inlineDataParts.forEach((part) => {
          messages.push({
            role: 'user', // Force assistant role for tool calls
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
                },
              },
            ],
          });
        });
      }

      if (
        textParts.length === 0 &&
        functionCallParts.length === 0 &&
        functionResponseParts.length === 0
      ) {
        throw new Error(
          `Content parts not processed: ${JSON.stringify(content, null, 2)}`,
        );
      }
    }

    return messages;
  }

  private convertToGeminiResponse(
    openaiResponse: OpenAI.Chat.Completions.ChatCompletion,
  ): GenerateContentResponse {
    const choice = openaiResponse.choices[0];
    const response = new GenerateContentResponse();

    const parts: Part[] = [];

    // Handle text content
    if (choice.message.content) {
      parts.push({ text: choice.message.content });
    }

    // Handle tool calls
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type === 'function') {
          let args: Record<string, unknown> = {};
          if (toolCall.function.arguments) {
            args = JSON.parse(jsonrepair(toolCall.function.arguments));
          }

          parts.push({
            functionCall: {
              id: toolCall.id,
              name: toolCall.function.name,
              args,
            },
          });
        }
      }
    }

    response.responseId = openaiResponse.id;
    response.createTime = openaiResponse.created
      ? openaiResponse.created.toString()
      : new Date().getTime().toString();

    response.candidates = [
      {
        content: {
          parts,
          role: 'model' as const,
        },
        finishReason: this.mapFinishReason(choice.finish_reason || 'stop'),
        index: 0,
        safetyRatings: [],
      },
    ];

    response.modelVersion = openaiResponse.model;
    response.promptFeedback = { safetyRatings: [] };

    // Add usage metadata if available
    if (openaiResponse.usage) {
      const usage = openaiResponse.usage;

      const promptTokens = usage.prompt_tokens || 0;
      const completionTokens = usage.completion_tokens || 0;
      const totalTokens = usage.total_tokens || 0;
      const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;

      // If we only have total tokens but no breakdown, estimate the split
      // Typically input is ~70% and output is ~30% for most conversations
      let finalPromptTokens = promptTokens;
      let finalCompletionTokens = completionTokens;

      if (totalTokens > 0 && promptTokens === 0 && completionTokens === 0) {
        // Estimate: assume 70% input, 30% output
        finalPromptTokens = Math.round(totalTokens * 0.7);
        finalCompletionTokens = Math.round(totalTokens * 0.3);
      }

      response.usageMetadata = {
        promptTokenCount: finalPromptTokens,
        candidatesTokenCount: finalCompletionTokens,
        totalTokenCount: totalTokens,
        cachedContentTokenCount: cachedTokens,
      };
    }
    return response;
  }

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const contentsArray = toContents(request.contents);
    const messages = this.convertToOpenAIMessages(contentsArray, request);
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined =
      request.config?.tools?.flatMap((tool) => {
        if ('functionDeclarations' in tool) {
          return (
            tool.functionDeclarations?.map((func) => {
              if (!func.name) {
                throw new Error('Function declaration must have a name');
              }
              return {
                type: 'function',
                function: {
                  name: func.name,
                  description: func.description || '',
                  parameters: ((func.parameters ||
                    func.parametersJsonSchema) as Record<string, unknown>) || {
                    type: 'object',
                    properties: '',
                  },
                },
              };
            }) || []
          );
        }
        return [];
      });

    let params = {
      model: request.model,
      messages,
      stream: true,
      temperature: request.config?.temperature,
      max_tokens: request.config?.maxOutputTokens,
      top_p: request.config?.topP,
      tools,
    };
    params = {
      ...params,
      top_p: 0.95,
      temperature: 0.6,
    };
    const stream = await this.openai.chat.completions.create({
      ...params,
      stream: true,
    });

    const toolCallMap = new Map<
      number,
      {
        name: string;
        arguments: string;
      }
    >();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const that = this;
    const tryRepair = (str: string) => {
      try {
        return JSON.parse(jsonrepair(str));
      } catch (error) {
        reportError(
          error,
          'Error when talking to OpenAI-compatible API',
          { params, str },
          'OpenAICompatible.parseToolCallArguments',
        );
        throw error;
      }
    };
    const generator =
      async function* (): AsyncGenerator<GenerateContentResponse> {
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (choice?.delta?.content) {
            const geminiResponse = new GenerateContentResponse();
            geminiResponse.candidates = [
              {
                content: {
                  parts: [{ text: choice.delta.content }],
                  role: 'model',
                },
                finishReason: choice.finish_reason
                  ? that.mapFinishReason(choice.finish_reason)
                  : FinishReason.FINISH_REASON_UNSPECIFIED,
                index: 0,
                safetyRatings: [],
              },
            ];
            yield geminiResponse;
          }
          // Handle tool call deltas
          if (choice?.delta?.tool_calls) {
            // console.log(
            //   'RAW toolCalls delta: ',
            //   JSON.stringify(choice.delta.tool_calls, null, 2),
            // );
            for (const toolCall of choice.delta.tool_calls) {
              const idx = toolCall.index;
              const isNewEntry = !toolCallMap.has(idx);
              const current = toolCallMap.get(idx) || {
                name: '',
                arguments: '',
              };

              // Update name if provided
              if (toolCall.function?.name) {
                console.log(
                  `Updating name for index ${idx} from "${current.name}" to "${toolCall.function.name}"`,
                );
                current.name = toolCall.function.name;
              } else if (isNewEntry) {
                // If it's a new entry and no name is provided in the delta,
                // try to infer the name from the last known tool call in the map.
                // This handles cases where OpenAI streams arguments for subsequent calls
                // without repeating the function name.
                let inferredName = '';
                if (toolCallMap.size > 0) {
                  // Find the highest index less than the current one that has a name.
                  for (let i = idx - 1; i >= 0; i--) {
                    if (toolCallMap.has(i) && toolCallMap.get(i)!.name) {
                      inferredName = toolCallMap.get(i)!.name;
                      console.log(
                        `Inferred name "${inferredName}" for new index ${idx} from previous index ${i}.`,
                      );
                      break;
                    }
                  }
                  // Fallback: if no preceding index has a name, take the name from the very first entry.
                  // This is a common case where all parallel calls are to the same function.
                  if (!inferredName && toolCallMap.has(0)) {
                    inferredName = toolCallMap.get(0)!.name;
                    console.log(
                      `Inferred name "${inferredName}" for new index ${idx} from index 0 as a fallback.`,
                    );
                  }
                }
                if (inferredName) {
                  current.name = inferredName;
                } else {
                  console.log(
                    `No name field in delta for new index ${idx} and could not infer name. Name remains "${current.name}".`,
                  );
                }
              } else {
                console.log(
                  `No name field in delta for existing index ${idx}. Name remains "${current.name}".`,
                );
              }

              // Accumulate arguments
              if (toolCall.function?.arguments) {
                // console.log(`Accumulating arguments for index ${idx}. Adding: "${toolCall.function.arguments}"`);
                current.arguments += toolCall.function.arguments;
              }

              toolCallMap.set(idx, current);
              // console.log(
              //   `Updated state for index ${idx}:`,
              //   JSON.stringify(toolCallMap.get(idx), null, 2),
              // );
            }
            console.log(
              'Full toolCallMap state after processing all deltas in this chunk:',
              JSON.stringify(Array.from(toolCallMap.entries()), null, 2),
            );
          }
          // Flush completed tool calls on finish
          if (choice?.finish_reason === 'tool_calls' && toolCallMap.size > 0) {
            // console.log(`Finish reason is 'tool_calls'. Flushing toolCallMap. Final map state:`, JSON.stringify(Array.from(toolCallMap.entries()), null, 2));
            const geminiResponse = new GenerateContentResponse();
            const parts = Array.from(toolCallMap.entries()).map(
              ([_index, toolCall]) => {
                console.log(
                  `Creating functionCall part for index ${_index}: name="${toolCall.name}", args="${toolCall.arguments}"`,
                );
                return {
                  functionCall: {
                    name: toolCall.name,
                    args: toolCall.arguments
                      ? tryRepair(toolCall.arguments)
                      : {},
                  },
                };
              },
            );
            // console.log('Generated parts for Gemini response:', JSON.stringify(parts, null, 2));
            geminiResponse.candidates = [
              {
                content: {
                  parts,
                  role: 'model',
                },
                finishReason: choice.finish_reason
                  ? that.mapFinishReason(choice.finish_reason)
                  : FinishReason.FINISH_REASON_UNSPECIFIED,
                index: 0,
                safetyRatings: [],
              },
            ];
            yield geminiResponse;
            toolCallMap.clear(); // Reset for next tool calls
          }

          if (choice?.finish_reason) {
            const geminiResponse = new GenerateContentResponse();
            geminiResponse.candidates = [
              {
                content: {
                  parts: [],
                  role: 'model',
                },
                finishReason: choice.finish_reason
                  ? that.mapFinishReason(choice.finish_reason)
                  : FinishReason.FINISH_REASON_UNSPECIFIED,
                index: 0,
                safetyRatings: [],
              },
            ];
            yield geminiResponse;
          }
          if (chunk.usage) {
            const geminiResponse = new GenerateContentResponse();
            const usage = chunk.usage;

            const promptTokens = usage.prompt_tokens || 0;
            const completionTokens = usage.completion_tokens || 0;
            const totalTokens = usage.total_tokens || 0;
            const cachedTokens =
              usage.prompt_tokens_details?.cached_tokens || 0;

            // If we only have total tokens but no breakdown, estimate the split
            // Typically input is ~70% and output is ~30% for most conversations
            let finalPromptTokens = promptTokens;
            let finalCompletionTokens = completionTokens;

            if (
              totalTokens > 0 &&
              promptTokens === 0 &&
              completionTokens === 0
            ) {
              // Estimate: assume 70% input, 30% output
              finalPromptTokens = Math.round(totalTokens * 0.7);
              finalCompletionTokens = Math.round(totalTokens * 0.3);
            }

            geminiResponse.usageMetadata = {
              promptTokenCount: finalPromptTokens,
              candidatesTokenCount: finalCompletionTokens,
              totalTokenCount: totalTokens,
              cachedContentTokenCount: cachedTokens,
            };
            geminiResponse.candidates = [
              {
                content: {
                  parts: [],
                  role: 'model',
                },
                finishReason: FinishReason.STOP,
                index: 0,
                safetyRatings: [],
              },
            ];
            yield geminiResponse;
            return;
          }
        }
      };

    return generator();
  }

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const contentsArray = toContents(request.contents);
    const messages = this.convertToOpenAIMessages(contentsArray, request);

    const tools = undefined;

    const completion = await this.openai.chat.completions.create({
      model: request.model,
      messages,
      stream: false,
      temperature: request.config?.temperature,
      max_tokens: request.config?.maxOutputTokens,
      top_p: request.config?.topP,
      tools,
    });

    return this.convertToGeminiResponse(completion);
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const contentsArray = toContents(request.contents);

    // We'll estimate based on the text length (rough approximation: 4 chars per token)
    const messages = this.convertToOpenAIMessages(contentsArray, request);
    const totalText = messages.map((m) => m.content).join(' ');
    const estimatedTokens = Math.ceil(totalText.length / 4);

    return {
      totalTokens: estimatedTokens,
    };
  }

  private mapFinishReason(openaiReason: string | null): FinishReason {
    if (!openaiReason) return FinishReason.FINISH_REASON_UNSPECIFIED;
    const mapping: Record<string, FinishReason> = {
      stop: FinishReason.STOP,
      length: FinishReason.MAX_TOKENS,
      content_filter: FinishReason.SAFETY,
      function_call: FinishReason.STOP,
      tool_calls: FinishReason.STOP,
    };
    return mapping[openaiReason] || FinishReason.FINISH_REASON_UNSPECIFIED;
  }
  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('TODO: add support for embedding content');
  }
}
