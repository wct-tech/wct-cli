#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import express, { Request, Response } from 'express';
import { 
  GeminiChat, 
  Config, 
  ContentGenerator, 
  createContentGenerator, 
  AuthType, 
  executeToolCall,
  GeminiClient,
  CoreToolScheduler,
  getErrorMessage,
  UnauthorizedError,
  ToolRegistry
} from '@wct-cli/wct-cli-core';
import { GenerateContentConfig, PartListUnion, PartUnion } from '@google/genai';
import * as path from 'path';
import * as fs from 'fs/promises';
import cors from 'cors';
// import { logUserPrompt } from '@google/gemini-cli-core/src/telemetry/loggers.js';
// import { UserPromptEvent } from '@google/gemini-cli-core/src/telemetry/types.js';

const app = express();
app.use(express.json());


// For Node.js/Express
app.use(cors({
  origin: '*' // Explicitly allow 'null' origin
}));
// Minimal config for demonstration; in production, load from env or config file
const config = new Config({
  sessionId: 'api-service',
  targetDir: process.cwd(),
  debugMode: false,
  model: 'gemini-2.5-pro',
  cwd: process.cwd(),
});
await config.initialize();

// Initialize authentication
//await config.refreshAuth(AuthType.USE_GEMINI);
await config.refreshAuth(AuthType.USE_IWHALECLOUD);


// Initialize tool registry
const toolRegistryPromise = config.getToolRegistry();// fix 1 createToolResgistry

let contentGeneratorPromise: Promise<ContentGenerator> | null = null;
function getContentGenerator(): Promise<ContentGenerator> {
  if (!contentGeneratorPromise) {
    contentGeneratorPromise = createContentGenerator(config.getContentGeneratorConfig());
  }
  return contentGeneratorPromise;
}

// Store chat sessions for multi-round conversations
const chatSessions = new Map<string, GeminiChat>();

// Store Gemini clients for each session
const geminiClients = new Map<string, GeminiClient>();

// Store tool schedulers for each session
const toolSchedulers = new Map<string, CoreToolScheduler>();

// Helper function to get or create Gemini client for a session
async function getGeminiClient(sessionId: string): Promise<GeminiClient> {
  let client = geminiClients.get(sessionId);
  if (!client) {
    client = new GeminiClient(config);
    await client.initialize(config.getContentGeneratorConfig());
    geminiClients.set(sessionId, client);
  }
  return client;
}

// Helper function to get or create tool scheduler for a session
function getToolScheduler(sessionId: string): CoreToolScheduler {
  let scheduler = toolSchedulers.get(sessionId);
  if (!scheduler) {
    scheduler = new CoreToolScheduler({
      toolRegistry: toolRegistryPromise,
      outputUpdateHandler: () => {}, // No live output for API
      onAllToolCallsComplete: (completedTools) => {
        // Handle completed tools - this will be called by the scheduler
        console.log(`Session ${sessionId}: ${completedTools.length} tools completed`);
      },
      onToolCallsUpdate: () => {}, // No UI updates needed
      approvalMode: config.getApprovalMode(),
      getPreferredEditor: () => undefined, // No editor for API
      config,
    });
    toolSchedulers.set(sessionId, scheduler);
  }
  return scheduler;
}

// Local implementation of mergePartListUnions
function mergePartListUnions(list: any[]): any {
  if (!Array.isArray(list) || list.length === 0) return [];
  if (list.length === 1) return list[0];
  if (list.every(Array.isArray)) return list.flat();
  if (list.every((x) => typeof x === 'object' && !Array.isArray(x))) return list;
  return list;
}

function isAtCommand(query: string): boolean {
  return typeof query === 'string' && query.trim().startsWith('@');
}

// Minimal handleAtCommand for @file reading (expects { query: string, config: Config })
async function handleAtCommand({ query, config }: { query: string, config: any }): Promise<{ processedQuery: any[]; shouldProceed: boolean }> {
  const atCommandRegex = /@([^\s\\]+(?:\\\s[^\s\\]+)*)/g;
  const parts: any[] = [];
  let lastIndex = 0;
  let match;
  let shouldProceed = true;
  while ((match = atCommandRegex.exec(query)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: query.substring(lastIndex, match.index) });
    }
    const atPath = match[0];
    const pathName = match[1];
    parts.push({ text: atPath });
    try {
      const absolutePath = path.resolve(config.getTargetDir(), pathName);
      const fileContent = await fs.readFile(absolutePath, 'utf-8');
      parts.push({ text: '\n--- Content from referenced file ---\n' });
      parts.push({ text: fileContent });
      parts.push({ text: '\n--- End of content ---\n' });
    } catch (error) {
      console.warn(`Failed to read file ${pathName}:`, error);
      parts.push({ text: `\n--- Error reading file ${pathName} ---\n` });
      shouldProceed = false;
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < query.length) {
    parts.push({ text: query.substring(lastIndex) });
  }
  return { processedQuery: parts.length > 0 ? parts : [{ text: query }], shouldProceed };
}

function parseAndFormatApiError(errorMessage: any): string {
  return String(errorMessage);
}

// Helper function to process tool calls
async function processToolCalls(
  chat: GeminiChat,
  toolCalls: any[],
  sessionId: string
): Promise<PartListUnion[]> {
  const responses: PartListUnion[] = [];

  // Await the tool registry promise here
  const toolRegistry = await toolRegistryPromise;

  for (const toolCall of toolCalls) {
    const requestInfo: any = {
      callId: toolCall.id || `${toolCall.name}-${Date.now()}`,
      name: toolCall.name,
      args: toolCall.args || {},
      isClientInitiated: false,
    };

    try {
      console.log('executing tool call:', requestInfo);
      const toolResponse = await executeToolCall(
        config,
        requestInfo,
        toolRegistry,
        undefined // no abort signal for API
      );

      if (toolResponse.error) {
        console.error(`Error executing tool ${toolCall.name}:`, toolResponse.error.message);
        responses.push([{ text: `Error executing tool ${toolCall.name}: ${toolResponse.error.message}` }]);
      } else if (toolResponse.responseParts) {
        const parts = Array.isArray(toolResponse.responseParts)
          ? toolResponse.responseParts
          : [toolResponse.responseParts];
        
        for (const part of parts) {
          if (typeof part === 'string') {
            responses.push([{ text: part }]);
          } else if (part) {
            responses.push([part]);
          }
        }
      }
    } catch (error) {
      console.error(`Error executing tool ${toolCall.name}:`, error);
      responses.push([{ text: `Error executing tool ${toolCall.name}: ${error}` }]);
    }
  }

  return responses;
}

/** 
 * @author Tianshu.Ma
 * 生成随机的prompt_id
 */
function generatePromptId(){
  return +`${(Math.random()*10000).toFixed()}${+Date.now()}`;
}
// --- New orchestrated helpers for API flow ---

async function prepareQueryForGemini(
  query: PartListUnion,
  sessionId: string,
  abortSignal: AbortSignal,
): Promise<{
  queryToSend: PartListUnion | null;
  shouldProceed: boolean;
}> {
  if (typeof query === 'string' && query.trim().length === 0) {
    return { queryToSend: null, shouldProceed: false };
  }
  let localQueryToSendToGemini: PartListUnion | null = null;
      if (typeof query === 'string') {
      const trimmedQuery = query.trim();
      // logUserPrompt(
      //   config,
      //   new UserPromptEvent(trimmedQuery.length, trimmedQuery),
      // );
      console.log(`Session ${sessionId} - User query: '${trimmedQuery}'`);
    if (isAtCommand(trimmedQuery)) {
      const atCommandResult = await handleAtCommand({ query: trimmedQuery, config });
      if (!atCommandResult.shouldProceed) {
        return { queryToSend: null, shouldProceed: false };
      }
      localQueryToSendToGemini = atCommandResult.processedQuery;
    } else {
      localQueryToSendToGemini = trimmedQuery;
    }
  } else {
    localQueryToSendToGemini = query;
  }
  if (localQueryToSendToGemini === null) {
    console.log(`Session ${sessionId} - Query processing resulted in null, not sending to Gemini.`);
    return { queryToSend: null, shouldProceed: false };
  }
  return { queryToSend: localQueryToSendToGemini, shouldProceed: true };
}

async function processGeminiStreamEvents(
  stream: AsyncIterable<any>,
  sessionId: string,
  signal: AbortSignal,
): Promise<{
  content: string;
  toolCallRequests: any[];
  thought: any;
}> {
  let geminiMessageBuffer = '';
  const toolCallRequests: any[] = [];
  let thought = null;
  for await (const event of stream) {
    if ('value' in event) {
      console.log(`Session ${sessionId}: Gemini event:`, event.type, event.value);
    } else {
      console.log(`Session ${sessionId}: Gemini event:`, event.type);
    }
    switch (event.type) {
      case 'thought':
        thought = event.value;
        break;
      case 'content':
        geminiMessageBuffer += event.value;
        break;
      case 'tool_call_request':
        toolCallRequests.push(event.value);
        break;
      case 'user_cancelled':
        break;
      case 'error':
        break;
      case 'chat_compressed':
        break;
      default:
        break;
    }
  }
  return { content: geminiMessageBuffer, toolCallRequests, thought };
}

async function handleCompletedTools(
  completedToolCalls: any[],
  sessionId: string,
  geminiClient: GeminiClient,
): Promise<PartListUnion | null> {
  const completedAndReadyToSubmitTools = completedToolCalls.filter(
    (tc) => {
      const isTerminalState = tc.status === 'success' || tc.status === 'error' || tc.status === 'cancelled';
      if (isTerminalState) {
        return tc.response?.responseParts !== undefined;
      }
      return false;
    },
  );
  const geminiTools = completedAndReadyToSubmitTools.filter(t => !t.request.isClientInitiated);
  if (geminiTools.length === 0) {
    return null;
  }
  const allToolsCancelled = geminiTools.every(tc => tc.status === 'cancelled');
  if (allToolsCancelled) {
    return null;
  }
  const responsesToSend: PartListUnion[] = geminiTools.map(
    (toolCall) => toolCall.response.responseParts,
  );
  return mergePartListUnions(responsesToSend);
}

async function submitQuery(
  query: PartListUnion,
  sessionId: string,
  abortSignal: AbortSignal,
): Promise<string> {
  const geminiClient = await getGeminiClient(sessionId);
  const scheduler = getToolScheduler(sessionId);
  const { queryToSend, shouldProceed } = await prepareQueryForGemini(
    query,
    sessionId,
    abortSignal,
  );
  if (!shouldProceed || queryToSend === null) {
    return '';
  }
  try {
    const stream = geminiClient.sendMessageStream(queryToSend, abortSignal, generatePromptId());
    const { content, toolCallRequests, thought } = await processGeminiStreamEvents(
      stream,
      sessionId,
      abortSignal,
    );
    if (toolCallRequests.length > 0) {
      console.log(`Session ${sessionId}: Scheduling ${toolCallRequests.length} tool calls`);
      scheduler.schedule(toolCallRequests, abortSignal);
      const completedTools = await new Promise<any[]>((resolve) => {
        const originalOnComplete = scheduler['onAllToolCallsComplete'];
        scheduler['onAllToolCallsComplete'] = (tools: any) => { // WARN:explicit any
          originalOnComplete?.(tools);
          resolve(tools);
        };
      });
      const toolResponse = await handleCompletedTools(completedTools, sessionId, geminiClient);
      if (toolResponse) {
        const finalStream = geminiClient.sendMessageStream(toolResponse, abortSignal, generatePromptId());
        const finalResult = await processGeminiStreamEvents(finalStream, sessionId, abortSignal);
        return finalResult.content || content;
      }
    }
    return content;
  } catch (error: unknown) {
    if (error instanceof UnauthorizedError) {
      throw new Error('Authentication error - please check your API key');
    } else {
      const errorMessage = getErrorMessage(error) || 'Unknown error';
      console.error(`Session ${sessionId}: Error -`, errorMessage);
      throw new Error(parseAndFormatApiError(errorMessage));
    }
  }
}

// --- Streaming Gemini output to client (OpenAI-compatible) ---
async function streamGeminiToClient(
  userMessage: string,
  sessionId: string,
  abortSignal: AbortSignal,
  res: Response,
  model: string
) {
  const geminiClient = await getGeminiClient(sessionId);
  const scheduler = getToolScheduler(sessionId);

  // Prepare the query
  const { queryToSend, shouldProceed } = await prepareQueryForGemini(
    userMessage,
    sessionId,
    abortSignal,
  );
  if (!shouldProceed || queryToSend === null) {
    res.write(`data: ${JSON.stringify({ error: { message: "No query to send" } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  let index = 0;
  let currentQuery = queryToSend;
  try {
    while (true) {
      const toolCallRequests: any[] = [];
      const stream = geminiClient.sendMessageStream(currentQuery, abortSignal, generatePromptId());
      for await (const event of stream) {
        if ('value' in event) {
          console.log(`Session ${sessionId}: Gemini event:`, event.type, event.value);
        } else {
          console.log(`Session ${sessionId}: Gemini event:`, event.type);
        }
        // Stream all event types in OpenAI-compatible format
        let delta;
        if (event.type === 'content') {
          delta = { content: event.value };
        } else if ('value' in event) {
          // Serialize non-content objects as JSON strings for the client
          if (typeof event.value === 'object' && event.value !== null) {
            delta = { [event.type]: JSON.stringify(event.value) };
          } else {
            delta = { [event.type]: event.value };
          }
        } else {
          // For user_cancelled and any future events without value
          delta = { [event.type]: true };
        }
        const chunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model || 'gemini',
          choices: [
            {
              index: 0,
              delta,
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (event.type === 'tool_call_request') {
          toolCallRequests.push(event.value);
        }
        index++;
      }
      if (toolCallRequests.length === 0) {
        break; // No more tool calls, finish streaming
      }
      // Run tools and prepare toolResponses for next loop
      // Use the same logic as handleCompletedTools, but inline for streaming
      scheduler.schedule(toolCallRequests, abortSignal);
      const completedTools = await new Promise<any[]>((resolve) => {
        const originalOnComplete = scheduler['onAllToolCallsComplete'];
        scheduler['onAllToolCallsComplete'] = (tools: any) => { // WARN:explicit any
          originalOnComplete?.(tools);
          resolve(tools);
        };
      });
      const completedAndReadyToSubmitTools = completedTools.filter(
        (tc) => {
          const isTerminalState = tc.status === 'success' || tc.status === 'error' || tc.status === 'cancelled';
          if (isTerminalState) {
            return tc.response?.responseParts !== undefined;
          }
          return false;
        },
      );
      const geminiTools = completedAndReadyToSubmitTools.filter(t => !t.request.isClientInitiated);
      if (geminiTools.length === 0) {
        break;
      }
      const allToolsCancelled = geminiTools.every(tc => tc.status === 'cancelled');
      if (allToolsCancelled) {
        break;
      }
      const responsesToSend: PartListUnion[] = geminiTools.map(
        (toolCall) => toolCall.response.responseParts,
      );
      // Prepare the next query as the tool responses
      // Use mergePartListUnions to flatten if needed
      currentQuery = mergePartListUnions(responsesToSend);
    }
    // End the stream
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    res.write(`data: ${JSON.stringify({ error: { message: error.message || 'Internal server error' } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// --- Update the main POST endpoint to use submitQuery or streaming ---
app.post('/v1/chat/completions', (req: Request, res: Response) => {
  (async () => {
    try {
      console.log('request:', req.body);
      const { messages, model, temperature, top_p, max_tokens, stream, session_id } = req.body;
      const systemMessage = messages.find((msg: any) => msg.role === 'system');
      if (systemMessage) {
        messages.splice(messages.indexOf(systemMessage), 1);
      }
      if (!messages || !Array.isArray(messages)) {
        const errorResp = { error: { message: 'Invalid messages array' } };
        console.error('response:', errorResp);
        return res.status(400).json(errorResp);
      }
      const sessionId = session_id || 'default';
      let chat = chatSessions.get(sessionId);
      if (!chat) {
        const contentGenerator = await getContentGenerator();
        const generationConfig: GenerateContentConfig = {
          temperature,
          topP: top_p,
          maxOutputTokens: max_tokens,
        };
        chat = new GeminiChat(config, contentGenerator, generationConfig);
        chatSessions.set(sessionId, chat);
      }
      const userMessage = messages[messages.length - 1]?.content;
      if (!userMessage) {
        const errorResp = { error: { message: 'No user message provided' } };
        console.error('response:', errorResp);
        return res.status(400).json(errorResp);
      }
      const abortController = new AbortController();
      const abortSignal = abortController.signal;

      if (stream) {
        // Streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        try {
          await streamGeminiToClient(userMessage, sessionId, abortSignal, res, model);
          console.log('response: [streaming completed]');
        } catch (streamErr: any) {
          const errorResp = { error: { message: streamErr?.message || 'Internal server error' } };
          console.error('response:', errorResp);
          if (!res.headersSent) {
            res.write(`data: ${JSON.stringify(errorResp)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.end();
          }
        }
        return;
      } else {
        // Non-streaming (existing behavior)
        try {
          const responseText = await submitQuery(userMessage, sessionId, abortSignal);
          const contentString = typeof responseText === 'string' ? responseText : JSON.stringify(responseText);
          const responseObj = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'gemini',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: contentString },
                finish_reason: 'stop',
              },
            ],
            usage: {},
            session_id: sessionId,
          };
          console.log('response:', JSON.stringify(responseObj, null, 2));
          return res.json(responseObj);
        } catch (nonStreamErr: any) {
          const errorResp = { error: { message: nonStreamErr?.message || 'Internal server error' } };
          console.error('response:', errorResp);
          if (!res.headersSent) {
            return res.status(500).json(errorResp);
          } else {
            res.end();
          }
        }
      }
    } catch (err: any) {
      const errorResp = { error: { message: err?.message || 'Internal server error' } };
      console.error('response:', errorResp);
      if (!res.headersSent) {
        return res.status(500).json(errorResp);
      } else {
        res.end();
      }
    }
  })();
});

// Endpoint to clear a chat session
app.delete('/v1/chat/sessions/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  chatSessions.delete(sessionId);
  res.json({ message: `Session ${sessionId} cleared` });
});

// Endpoint to list active sessions
app.get('/v1/chat/sessions', (req: Request, res: Response) => {
  
  const sessions = Array.from(chatSessions.keys());
  const session = chatSessions.get('5')?.getHistory()
  res.json({ sessions, session });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`OpenAI-compatible API service listening on port ${port}`);
  console.log(`Tool registry initialized with ${toolRegistryPromise.then(registry => registry.getAllTools().length)} tools`);
}); 