#!/usr/bin/env node
/* eslint-disable @typescript-eslint/array-type */
 

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 设置环境变量，禁用遥测
process.env['GEMINI_CLI_TELEMETRY_DISABLED'] = '1';

import express, { Request, Response } from 'express';
import {
  GeminiChat,
  Config,
  AuthType,
  ContentGenerator,
  createContentGenerator,
  createContentGeneratorConfig,
  ServerGeminiStreamEvent,
  ToolCallRequestInfo,
  ThoughtSummary,
  GeminiClient,
  CoreToolScheduler,
  getErrorMessage,
  UnauthorizedError,
  CompletedToolCall,
  ApprovalMode,
  ConfigParameters,
} from '@wct-cli/wct-cli-core';
import { GenerateContentConfig, PartListUnion } from '@google/genai';
import * as path from 'path';
import * as fs from 'fs/promises';
import cors from 'cors';
// import { GeminiClient } from '@google/gemini-cli-core/src/core/client';
// import { CoreToolScheduler } from '@google/gemini-cli-core/src/core/coreToolScheduler';
// import {
//   getErrorMessage,
//   UnauthorizedError,
// } from '@google/gemini-cli-core/src/utils/errors';
// import { logUserPrompt } from '@google/gemini-cli-core/src/telemetry/loggers.js';
// import { UserPromptEvent } from '@google/gemini-cli-core/src/telemetry/types.js';
import { loadSettings } from '../config/settings.js';
import { fileURLToPath } from 'url';
import { loadCliConfig, parseArguments } from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());


// For Node.js/Express
app.use(cors({
  origin: '*' // Explicitly allow 'null' origin
}));
const loadGeminiConfigCli = async ( project_path: string ) => {
  try {
    const settings = loadSettings(project_path);
    const argv = await parseArguments();
    const configCli = await loadCliConfig(settings.merged, [], 'api-service', argv);
    return configCli;
  } catch (error) {
    console.error('加载workSpace配置失败：', error)
    return {}
  }
}

// 默认配置
const DEFAULT_CONFIG:ConfigParameters = {
  sessionId: 'api-service',
  targetDir: process.cwd(),
  debugMode: false,
  model: 'gemini-2.5-flash', // 默认模型
  cwd: process.cwd(),
  approvalMode: ApprovalMode.YOLO,
};

// 创建配置对象，支持自定义项目路径
async function createConfig(projectPath?: string, model?: string): Promise<Config> {
  let targetDir = projectPath || process.cwd();

  // 修复Windows路径问题，如果提供了项目路径
  if (projectPath && path.isAbsolute(projectPath)) {
    targetDir = projectPath;
  } else if (projectPath) {
    targetDir = path.resolve(process.cwd(), projectPath);
  }
  const configCli = await loadGeminiConfigCli(targetDir);

  console.log(`创建配置对象，项目路径: ${targetDir}, 模型: ${model}`);
  return new Config({
    ...configCli,
    ...DEFAULT_CONFIG,
    model: model || DEFAULT_CONFIG.model,
    targetDir,
    cwd: targetDir,
  });
}

// 添加工具调用超时处理函数
function executeToolWithTimeout(
  scheduler: CoreToolScheduler, 
  toolCallRequests: ToolCallRequestInfo[], 
  abortController: AbortController,
  timeoutMs: number = 60000
): Promise<{
  status: string;
  request: { isClientInitiated: boolean };
  response?: { responseParts: PartListUnion };
}[]> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.warn(`工具执行超时，已运行 ${timeoutMs}ms`);
      reject(new Error(`工具执行超时，已运行 ${timeoutMs}ms`));
      abortController.abort();
    }, timeoutMs);
    
    // 启动工具执行
    scheduler.schedule(toolCallRequests, abortController.signal);
    
    
    // 替换完成回调
    const originalOnComplete = scheduler['onAllToolCallsComplete'];
    scheduler['onAllToolCallsComplete'] = async (
      tools: CompletedToolCall[], // type定义
    ) => {
      clearTimeout(timeoutId);
      const toolNames = tools.map((tool) => tool.request.name).join(', ');
      console.log(`工具调用 [${toolNames}] 已完成`);
      await originalOnComplete?.(tools);
      resolve(tools);
    };
  });
}

// 初始化默认配置
const globalConfig = await createConfig();
await globalConfig.initialize();
globalConfig.setFlashFallbackHandler(async()=>true);

// 初始化工具注册表
const toolRegistryPromise = globalConfig.getToolRegistry();

// 设置环境变量，启用OpenAI模式
process.env['USE_OPENAI'] = 'true';
process.env['OPENAI_API_URL'] = process.env['OPENAI_API_URL'] || process.env['PROXY_API_URL'] || 'https://lab.iwhalecloud.com/gpt-proxy/v1';
process.env['OPENAI_API_KEY'] = process.env['OPENAI_API_KEY'] || process.env['THIRD_PARTY_API_KEY'];

// 如果使用OpenAI，默认禁用遥测
if (process.env['USE_OPENAI'] === 'true') {
  process.env['GEMINI_CLI_TELEMETRY_DISABLED'] = '1';
}

// 初始化认证
await globalConfig.refreshAuth(AuthType.USE_IWHALECLOUD);

const contentGeneratorCache = new Map<string, Promise<ContentGenerator>>();
async function getContentGenerator(config: Config, apiKey?: string): Promise<ContentGenerator> {
  const authType = apiKey ? AuthType.USE_IWHALECLOUD : AuthType.USE_IWHALECLOUD;
  
  const cgConfig = await createContentGeneratorConfig(config, authType, apiKey);
  const key = JSON.stringify(cgConfig);
  
  if (!contentGeneratorCache.has(key)) {
    contentGeneratorCache.set(key, createContentGenerator(cgConfig, config));
  }
  return contentGeneratorCache.get(key)!;
}

// 存储聊天会话
const chatSessions = new Map<string, GeminiChat>();

// 存储Gemini客户端
const geminiClients = new Map<string, GeminiClient>();

// 存储工具调度器
const toolSchedulers = new Map<string, CoreToolScheduler>();

// 获取或创建Gemini客户端
async function getGeminiClient(sessionId: string, config: Config, apiKey?: string): Promise<GeminiClient> {
  const clientKey = `${sessionId}-${config.getTargetDir()}-${apiKey || ''}`;
  let client = geminiClients.get(clientKey);
  if (!client) {
    client = new GeminiClient(config);
    // 使用传入的API Key创建内容生成器配置
    const contentGeneratorConfig = await createContentGeneratorConfig(
      config, 
      AuthType.USE_IWHALECLOUD,
      apiKey
    );
    await client.initialize(contentGeneratorConfig);
    geminiClients.set(clientKey, client);
  }
  return client;
}

// 获取或创建工具调度器
function getToolScheduler(sessionId: string, config: Config): CoreToolScheduler {
  const schedulerKey = `${sessionId}-${config.getTargetDir()}`;
  let scheduler = toolSchedulers.get(schedulerKey);
  if (!scheduler) {
    scheduler = new CoreToolScheduler({
      toolRegistry: config.getToolRegistry(), // 修复tool调用可以跳出当前目录的问题
      outputUpdateHandler: () => {}, // No live output for API
      onAllToolCallsComplete: async (completedTools) => {
        // Handle completed tools - this will be called by the scheduler
        console.log(`Session ${sessionId}: ${completedTools.length} tools completed`);
      },
      onToolCallsUpdate: () => {}, // No UI updates needed
      getPreferredEditor: () => undefined, // No editor for API
      config,
      onEditorClose: () => {}, // No editor for API
    });
    toolSchedulers.set(schedulerKey, scheduler);
  }
  return scheduler;
}

// 合并部分列表联合
function mergePartListUnions(list: PartListUnion[]): PartListUnion {
    if (!Array.isArray(list) || list.length === 0) return [];
    if (list.length === 1) return list[0];
    return list.flat();
}

// 检查是否是@命令
function isAtCommand(query: string): boolean {
  return typeof query === 'string' && query.trim().startsWith('@');
}

// 处理@命令，用于文件读取
async function handleAtCommand({ query, config }: { query: string, config: Config }): Promise<{ processedQuery: PartListUnion; shouldProceed: boolean }> {
  const atCommandRegex = /@([^\s\\]+(?:\\\s[^\s\\]+)*)/g;
  const parts: {text: string}[] = [];
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

// 解析和格式化API错误
function parseAndFormatApiError(errorMessage: string): string {
  return String(errorMessage);
}

// 格式化错误为指定的格式 {errMessage, errDetail}
function formatError(errMessage: string, errDetail?: unknown): { error_message: string; error_detail: unknown } {
  return {
    error_message: errMessage,
    error_detail: errDetail || null
  };
}

// 准备查询
async function prepareQueryForGemini(
  query: PartListUnion,
  sessionId: string,
  config: Config,
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

// 处理Gemini流事件
async function processGeminiStreamEvents(
  stream: AsyncIterable<ServerGeminiStreamEvent>,
  sessionId: string,
): Promise<{
  content: string;
  toolCallRequests: ToolCallRequestInfo[];
  thought: ThoughtSummary | null;
}> {
  let geminiMessageBuffer = '';
  const toolCallRequests: ToolCallRequestInfo[] = [];
  let thought: ThoughtSummary | null = null;
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
        geminiMessageBuffer += event.value || '';
        break;
      case 'tool_call_request':
        if (event.value) {
          toolCallRequests.push(event.value);
        }
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

// 处理完成的工具
async function handleCompletedTools(
  completedToolCalls: {
    status: string;
    request: { isClientInitiated: boolean };
    response?: { responseParts: PartListUnion };
  }[],
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
    (toolCall) => toolCall.response?.responseParts || [],
  );
  return mergePartListUnions(responsesToSend);
}

// 添加诊断函数，检查请求流程中的模型选择
function debugModelSelection(model: string, config: Config): void {
  console.log(`[DEBUG] 模型选择诊断:`);
  console.log(`  1. 请求指定模型: ${model || '(未指定)'}`);
  console.log(`  2. 配置实例中的模型: ${config.getModel()}`);
  console.log(`  3. 环境变量中的API URL: ${process.env['OPENAI_API_URL'] || '(未设置)'}`);
  console.log(`  4. USE_OPENAI环境变量: ${process.env['USE_OPENAI'] || '(未设置)'}`);
}

// 提交查询
async function submitQuery(
  query: PartListUnion,
  sessionId: string,
  abortController: AbortController,
  config: Config,
  apiKey?: string,
): Promise<string> {
  const geminiClient = await getGeminiClient(sessionId, config, apiKey);
  const scheduler = getToolScheduler(sessionId, config);
  // 诊断模型选择
  debugModelSelection(config.getModel(), config);
  
  const { queryToSend, shouldProceed } = await prepareQueryForGemini(
    query,
    sessionId,
    config,
  );
  if (!shouldProceed || queryToSend === null) {
    return '';
  }
  try {
    const prompt_id = config.getSessionId() + '########' + geminiClient.getHistory().length;
    const stream = geminiClient.sendMessageStream(queryToSend, abortController.signal, prompt_id);
    const { content, toolCallRequests } = await processGeminiStreamEvents(
      stream,
      sessionId,
    );
    if (toolCallRequests.length > 0) {
      console.log(`Session ${sessionId}: 调度 ${toolCallRequests.length} 个工具调用`);
      
      // 使用超时处理函数执行工具
      const completedTools = await executeToolWithTimeout(scheduler, toolCallRequests, abortController);
      
      const toolResponse = await handleCompletedTools(completedTools);
      if (toolResponse) {
        const finalStream = geminiClient.sendMessageStream(toolResponse, abortController.signal, prompt_id);
        const finalResult = await processGeminiStreamEvents(finalStream, sessionId);
        return finalResult.content || content;
      }
    }
    return content;
  } catch (error: unknown) {
    if (error instanceof UnauthorizedError) {
      throw new Error('认证错误 - 请检查您的API密钥');
    } else {
      const errorMessage = getErrorMessage(error) || 'Unknown error';
      console.error(`Session ${sessionId}: 错误 -`, errorMessage);
      throw new Error(parseAndFormatApiError(errorMessage));
    }
  }
}

// 实现心跳机制，保持连接活跃
function startHeartbeat(res: Response, intervalMs: number = 15000): { stop: () => void } {
  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) {
      try {
        // 发送注释作为心跳，避免影响正常的事件流
        res.write(`: heartbeat\n\n`);
        if ('flush' in res && typeof res.flush === 'function') {
          res.flush();
        }
        console.log('心跳包已发送');
      } catch (err) {
        console.warn('发送心跳包失败:', err);
        clearInterval(heartbeatInterval);
      }
    } else {
      clearInterval(heartbeatInterval);
    }
  }, intervalMs);
  
  return {
    stop: () => {
      clearInterval(heartbeatInterval);
    }
  };
}

// 流式返回Gemini输出到客户端
async function streamGeminiToClient(
  userMessage: string,
  sessionId: string,
  abortController: AbortController,
  res: Response,
  model: string,
  config: Config,
  apiKey?: string,
) {
  // 启动心跳
  const heartbeat = startHeartbeat(res);

  try {
    const geminiClient = await getGeminiClient(sessionId, config, apiKey);
    const scheduler = getToolScheduler(sessionId, config);

    const prompt_id = config.getSessionId() + '########' + geminiClient.getHistory().length;

    // 准备查询
    const { queryToSend, shouldProceed } = await prepareQueryForGemini(
      userMessage,
      sessionId,
      config,
    );
    if (!shouldProceed || queryToSend === null) {
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || DEFAULT_CONFIG.model,
        choices: [
          {
            index: 0,
            delta: { error: formatError('没有可发送的查询', new Error('No query to send')) },
            finish_reason: "error",
          },
        ],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      heartbeat.stop();
      res.end();
      return;
    }

    console.log(`[streamGeminiToClient] 开始流式处理，使用模型: ${model}`);
    let currentQuery = queryToSend;
    try {
      while (true) {
        // 更新最后活动时间
        const toolCallRequests: ToolCallRequestInfo[] = [];
        
        // 尝试发送消息流，捕获可能的token计算错误
        let stream;
        try {
          stream = geminiClient.sendMessageStream(currentQuery, abortController.signal, prompt_id);
        } catch (streamError) {
          // 如果是token计算错误，记录并尝试不进行压缩的方式再次发送
          if (streamError instanceof Error && 
              streamError.message && 
              streamError.message.includes('token')) {
            console.warn(`[streamGeminiToClient] Token计算错误，尝试不进行压缩: ${streamError.message}`);
            
            // 尝试直接发送请求，不进行压缩处理
            stream = geminiClient.sendMessageStream(currentQuery, abortController.signal, prompt_id);
          } else {
            // 其他错误则重新抛出
            throw streamError;
          }
        }
        
        for await (const event of stream) {
          if ('value' in event) {
            if (event.type === 'content') {
              console.log(`Session ${sessionId}: Gemini event:`, event.type, typeof event.value);
            } else if (event.type === 'error') {
              console.log(`Session ${sessionId}: Gemini event:`, event.type);
              console.log('evet vallue: ', event.value);
            }
          } else {
            console.log(`Session ${sessionId}: Gemini event:`, event.type);
          }
          // Stream all event types in OpenAI-compatible format
          let delta: {[key: string]: unknown} = { };
          
          if (event.type === 'content') {
            delta = { content: event.value || '' };
          } else if (event.type === 'thought' && event.value) {
            // 以结构化方式处理思考事件
            delta = { 
              thinking: {
                subject: event.value.subject || '',
                description: event.value.description || '',
              }
            };
          } else if (event.type === 'tool_call_request' && event.value) {
            // 以结构化方式处理工具调用请求
            delta = { 
              tool_calls: [{
                id: event.value.callId || `tool-${Date.now()}`,
                type: "function",
                function: {
                  name: event.value.name || '',
                  arguments: event.value.args ? JSON.stringify(event.value.args) : '{}'
                }
              }]
            };
            toolCallRequests.push(event.value);
          } else if (event.type === 'error' && 'value' in event && event.value) {
            delta = { error: formatError("核心方法调用出错", event.value)};
          } else if (event.type !== 'user_cancelled' && 'value' in event && event.value) {
            delta = { [event.type]: event.value };
          } 

          const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || DEFAULT_CONFIG.model, // 保持模型名称一致性
            choices: [
              {
                index: 0,
                delta,
                finish_reason: null,
              },
            ],
          };
          
          // 发送数据并立即刷新
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          // 在Node.js环境中尝试刷新数据
          if ('flush' in res && typeof res.flush === 'function') {
            try {
              res.flush();
            } catch (flushErr) {
              console.warn(`无法刷新响应流: ${flushErr}`);
            }
          }
        }
        
        if (toolCallRequests.length === 0) {
          break; // 没有更多工具调用，完成流式传输
        }
        
        console.log(`[streamGeminiToClient] 处理 ${toolCallRequests.length} 个工具调用`);
        
        // 运行工具并为下一循环准备工具响应
        try {
          // 发送工具执行中间状态
          const toolExecutionChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || DEFAULT_CONFIG.model,
            choices: [
              {
                index: 0,
                delta: { tool_execution_status: "executing" },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(toolExecutionChunk)}\n\n`);
          
          // 使用超时处理函数执行工具
          const completedTools = await executeToolWithTimeout(scheduler, toolCallRequests, abortController);
          
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
            (toolCall) => toolCall.response?.responseParts || [],
          );
          
          // 准备下一个查询作为工具响应
          currentQuery = mergePartListUnions(responsesToSend);
          
          // 发送工具完成状态
          const toolCompletedChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || DEFAULT_CONFIG.model,
            choices: [
              {
                index: 0,
                delta: { tool_execution_status: "completed" },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(toolCompletedChunk)}\n\n`);
          
        } catch (toolError) {
          console.error(`[streamGeminiToClient] 工具执行错误:`, toolError);
          const errorMessage = toolError instanceof Error ? toolError.message : '工具执行失败';
          const errorChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || DEFAULT_CONFIG.model,
            choices: [
              {
                index: 0,
                delta: { error: formatError(errorMessage, toolError) },
                finish_reason: "tool_execution_error",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          break;
        }
      }
      // 结束流
      res.write('data: [DONE]\n\n');
      heartbeat.stop();
      res.end();
    } catch (error) {
      console.error(`[streamGeminiToClient] 流处理错误:`, error);
      const errorMessage = error instanceof Error ? error.message : '内部服务器错误';
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
      }
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || DEFAULT_CONFIG.model,
        choices: [
          {
            index: 0,
            delta: { error: formatError(errorMessage, error) },
            finish_reason: "error",
          },
        ],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      heartbeat.stop();
      res.end();
    }
  } catch (initError) {
    console.error(`[streamGeminiToClient] 初始化错误:`, initError);
    const errorMessage = initError instanceof Error ? initError.message : '服务初始化错误';
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }
    res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || DEFAULT_CONFIG.model,
        choices: [
          {
            index: 0,
            delta: { error: formatError(errorMessage, initError) },
            finish_reason: "error",
          },
        ],
      })}\n\n`);
    res.write('data: [DONE]\n\n');
    heartbeat.stop();
    res.end();
  }
}

// 添加API连接状态检查
async function checkApiConnection(apiKey?: string): Promise<boolean> {
  if (!process.env['OPENAI_API_URL']) {
    return false;
  }
  
  try {
    const response = await fetch(`${process.env['OPENAI_API_URL']}/models`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey || process.env['WCT_API_KEY']}`,
      }
    });
    
    if (response.ok) {
      console.log('API服务器连接正常');
      return true;
    } else {
      console.warn(`API服务器连接异常: ${response.status} ${response.statusText}`);
      return false;
    }
  } catch (error) {
    console.error('API服务器连接检查失败:', error);
    return false;
  }
}

// 验证模型名称
function validateModel(modelName: string): string {
  if (!modelName) return DEFAULT_CONFIG.model;
  
  // 直接返回模型名称，不做映射
  return modelName;
}

app.post('/v1/chat/completions', (req: Request, res: Response) => {
  // @ts-expect-error Not all code paths return a value.ts(7030)
  (async () => {
    const abortController = new AbortController();
    const { messages, model, temperature, top_p, max_tokens, stream, session_id, project_path, api_key, disable_telemetry } = req.body;
    // const abortSignal = abortController.signal;

    // 请求超时处理
    const requestTimeout = setTimeout(() => {
      abortController.abort();
      if (!res.headersSent) {
        res.status(408).json(formatError('请求处理超时', '请求处理超时'));
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || DEFAULT_CONFIG.model,
            choices: [
              {
                index: 0,
                delta: { error: formatError('请求处理超时', new Error('请求处理超时')) },
                finish_reason: "timeout",
              },
            ],
          })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 300000); // 5分钟超时
    
    try {
      console.log('请求体:', JSON.stringify(req.body, null, 2));
      const apiKeyFromHeader = req.headers['x-api-key'] as string;
      const finalApiKey = apiKeyFromHeader || api_key;

      if (disable_telemetry) {
        process.env['GEMINI_CLI_TELEMETRY_DISABLED'] = '1';
      }
      
      // 检查API连接状态
      const apiConnected = await checkApiConnection(finalApiKey);
      if (!apiConnected) {
        console.warn('API服务器连接不可用，可能导致请求失败');
      }
      
      // 记录并验证模型选择
      const requestedModel = model || DEFAULT_CONFIG.model;
      console.log(`接收到的模型参数: ${requestedModel}`);
      const validatedModel = validateModel(requestedModel);
      
      const currentConfig = await createConfig(project_path, validatedModel);
      await currentConfig.initialize();
      currentConfig.setFlashFallbackHandler(async()=>true);
      if (project_path) {
        console.log(`使用自定义项目路径: ${project_path}`);
        await currentConfig.refreshAuth(AuthType.USE_IWHALECLOUD);
      }
      
      // 验证模型配置
      console.log(`当前配置使用的模型: ${currentConfig.getModel()}`);
      
      // 运行模型诊断
      debugModelSelection(validatedModel, currentConfig);
      
      // 处理系统消息
      const systemMessage = messages.find((msg: {role: string}) => msg.role === 'system');
      if (systemMessage) {
        messages.splice(messages.indexOf(systemMessage), 1);
        console.log(`收到系统消息: ${systemMessage.content}`);
      }
      
      if (!messages || !Array.isArray(messages)) {
        console.error('响应:', formatError('无效的消息数组', '无效的消息数组'));
        return res.status(400).json(formatError('无效的消息数组', '无效的消息数组'));
      }
      const sessionId = session_id || 'default';
      const chatKey = `${sessionId}-${currentConfig.getTargetDir()}-${finalApiKey || ''}`;
      let chat = chatSessions.get(chatKey);
      if (!chat) {
        const contentGenerator = await getContentGenerator(currentConfig, finalApiKey);
        const generationConfig: GenerateContentConfig = {
          temperature,
          topP: top_p,
          maxOutputTokens: max_tokens,
        };
        chat = new GeminiChat(currentConfig, contentGenerator, generationConfig);
        chatSessions.set(chatKey, chat);
      }
      const userMessage = messages[messages.length - 1]?.content;
      if (!userMessage) {
        console.error('响应:', formatError('未提供用户消息', '未提供用户消息'));
        return res.status(400).json(formatError('未提供用户消息', '未提供用户消息'));
      }

      if (stream) {
        // 流式响应
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        try {
          await streamGeminiToClient(userMessage, sessionId, abortController, res, validatedModel, currentConfig, finalApiKey);
          console.log('响应: [流式传输完成]');
        } catch (streamErr) {
          console.error('流式传输错误:', streamErr);
          const errorMessage = streamErr instanceof Error ? streamErr.message : '内部服务器错误';
          console.error('响应:', formatError('流式传输错误', errorMessage));
          if (!res.headersSent) {
            res.status(500).json(formatError('流式传输错误', errorMessage));
          } else if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: validatedModel,
            choices: [
              {
                index: 0,
                delta: { error: formatError('流式传输错误', streamErr) },
                finish_reason: "error",
              },
            ],
          })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }
      } else {
        // 非流式（现有行为）
        try {
          const responseText = await submitQuery(userMessage, sessionId, abortController, currentConfig, finalApiKey);
          const contentString = typeof responseText === 'string' ? responseText : JSON.stringify(responseText);
          const responseObj = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: validatedModel,
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
          console.log('响应:', JSON.stringify(responseObj, null, 2));
          return res.json(responseObj);
        } catch (nonStreamErr) {
          console.error('非流式响应错误:', nonStreamErr);
          const errorMessage = nonStreamErr instanceof Error ? nonStreamErr.message : '内部服务器错误';
          console.error('响应:', formatError('非流式响应错误', errorMessage));
          if (!res.headersSent) {
            return res.status(500).json(formatError('非流式响应错误', errorMessage));
          } else if (!res.writableEnded) {
            res.end();
          }
        }
      }
    } catch (err) {
      console.error('请求处理错误:', err);
      const errorMessage = err instanceof Error ? err.message : '内部服务器错误';
      console.error('响应:', formatError('请求处理错误', errorMessage));
      if (!res.headersSent) {
        return res.status(500).json(formatError('请求处理错误', errorMessage));
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      clearTimeout(requestTimeout);
    }
  })();
});

// 清除聊天会话端点
app.delete('/v1/chat/sessions/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  // This is a simplified cleanup. A more robust solution would iterate through
  // all configs if project_path was used.
  chatSessions.forEach((_val, key) => {
    if (key.startsWith(sessionId)) {
      chatSessions.delete(key);
    }
  });
  geminiClients.forEach((_val, key) => {
    if (key.startsWith(sessionId)) {
      geminiClients.delete(key);
    }
  });
  toolSchedulers.forEach((_val, key) => {
    if (key.startsWith(sessionId)) {
      toolSchedulers.delete(key);
    }
  });
  res.json({ message: `与会话 ${sessionId} 相关的所有实例均已清除` });
});

// 列出活跃会话端点
app.get('/v1/chat/sessions', (req: Request, res: Response) => {
  const sessions = Array.from(chatSessions.keys());
  res.json({ sessions });
});

// 在根目录提供client-test.html
app.get('/v1/chatPage', (req, res) => {
  res.sendFile(path.join(__dirname, 'client-test.html'));
});

const port = Number(process.env['PORT']) || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`OpenAI兼容API服务正在监听端口 ${port}`);
  toolRegistryPromise.then(registry => {
    console.log(`工具注册表已初始化，共有 ${registry.getAllTools().length} 个工具`);
  });
}); 