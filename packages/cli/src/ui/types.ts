/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CompressionStatus,
  MCPServerConfig,
  ThoughtSummary,
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolResultDisplay,
} from '@wct-cli/wct-cli-core';
import type { PartListUnion } from '@google/genai';
import { type ReactNode } from 'react';

export type { ThoughtSummary };

export enum AuthState {
  // Attemtping to authenticate or re-authenticate
  Unauthenticated = 'unauthenticated',
  // Auth dialog is open for user to select auth method
  Updating = 'updating',
  // Successfully authenticated
  Authenticated = 'authenticated',
}

// Only defining the state enum needed by the UI
export enum StreamingState {
  Idle = 'idle',
  Responding = 'responding',
  WaitingForConfirmation = 'waiting_for_confirmation',
}

// Copied from server/src/core/turn.ts for CLI usage
export enum GeminiEventType {
  Content = 'content',
  ToolCallRequest = 'tool_call_request',
  // Add other event types if the UI hook needs to handle them
}

export enum ToolCallStatus {
  Pending = 'Pending',
  Canceled = 'Canceled',
  Confirming = 'Confirming',
  Executing = 'Executing',
  Success = 'Success',
  Error = 'Error',
}

export interface ToolCallEvent {
  type: 'tool_call';
  status: ToolCallStatus;
  callId: string;
  name: string;
  args: Record<string, never>;
  resultDisplay: ToolResultDisplay | undefined;
  confirmationDetails: ToolCallConfirmationDetails | undefined;
}

export interface IndividualToolCallDisplay {
  callId: string;
  name: string;
  description: string;
  resultDisplay: ToolResultDisplay | undefined;
  status: ToolCallStatus;
  confirmationDetails: ToolCallConfirmationDetails | undefined;
  renderOutputAsMarkdown?: boolean;
  ptyId?: number;
  outputFile?: string;
}

export interface CompressionProps {
  isPending: boolean;
  originalTokenCount: number | null;
  newTokenCount: number | null;
  compressionStatus: CompressionStatus | null;
}

export interface HistoryItemBase {
  text?: string; // Text content for user/gemini/info/error messages
}

export type HistoryItemUser = HistoryItemBase & {
  type: 'user';
  text: string;
};

export type HistoryItemGemini = HistoryItemBase & {
  type: 'gemini';
  text: string;
};

export type HistoryItemGeminiContent = HistoryItemBase & {
  type: 'gemini_content';
  text: string;
};

export type HistoryItemInfo = HistoryItemBase & {
  type: 'info';
  text: string;
};

export type HistoryItemError = HistoryItemBase & {
  type: 'error';
  text: string;
};

export type HistoryItemWarning = HistoryItemBase & {
  type: 'warning';
  text: string;
};

export type HistoryItemAbout = HistoryItemBase & {
  type: 'about';
  cliVersion: string;
  osVersion: string;
  sandboxEnv: string;
  modelVersion: string;
  selectedAuthType: string;
  gcpProject: string;
  ideClient: string;
};

export type HistoryItemHelp = HistoryItemBase & {
  type: 'help';
  timestamp: Date;
};

export type HistoryItemStats = HistoryItemBase & {
  type: 'stats';
  duration: string;
};

export type HistoryItemModelStats = HistoryItemBase & {
  type: 'model_stats';
};

export type HistoryItemToolStats = HistoryItemBase & {
  type: 'tool_stats';
};

export type HistoryItemQuit = HistoryItemBase & {
  type: 'quit';
  duration: string;
};

export type HistoryItemToolGroup = HistoryItemBase & {
  type: 'tool_group';
  tools: IndividualToolCallDisplay[];
};

export type HistoryItemUserShell = HistoryItemBase & {
  type: 'user_shell';
  text: string;
};

export type HistoryItemCompression = HistoryItemBase & {
  type: 'compression';
  compression: CompressionProps;
};

export type HistoryItemExtensionsList = HistoryItemBase & {
  type: 'extensions_list';
};

export interface ToolDefinition {
  name: string;
  displayName: string;
  description?: string;
}

export type HistoryItemToolsList = HistoryItemBase & {
  type: 'tools_list';
  tools: ToolDefinition[];
  showDescriptions: boolean;
};

// JSON-friendly types for using as a simple data model showing info about an
// MCP Server.
export interface JsonMcpTool {
  serverName: string;
  name: string;
  description?: string;
  schema?: {
    parametersJsonSchema?: unknown;
    parameters?: unknown;
  };
}

export interface JsonMcpPrompt {
  serverName: string;
  name: string;
  description?: string;
}

export type HistoryItemMcpStatus = HistoryItemBase & {
  type: 'mcp_status';
  servers: Record<string, MCPServerConfig>;
  tools: JsonMcpTool[];
  prompts: JsonMcpPrompt[];
  authStatus: Record<
    string,
    'authenticated' | 'expired' | 'unauthenticated' | 'not-configured'
  >;
  blockedServers: Array<{ name: string; extensionName: string }>;
  discoveryInProgress: boolean;
  connectingServers: string[];
  showDescriptions: boolean;
  showSchema: boolean;
  showTips: boolean;
};

// Using Omit<HistoryItem, 'id'> seems to have some issues with typescript's
// type inference e.g. historyItem.type === 'tool_group' isn't auto-inferring that
// 'tools' in historyItem.
// Individually exported types extending HistoryItemBase
export type HistoryItemWithoutId =
  | HistoryItemUser
  | HistoryItemUserShell
  | HistoryItemGemini
  | HistoryItemGeminiContent
  | HistoryItemInfo
  | HistoryItemError
  | HistoryItemWarning
  | HistoryItemAbout
  | HistoryItemHelp
  | HistoryItemToolGroup
  | HistoryItemStats
  | HistoryItemModelStats
  | HistoryItemToolStats
  | HistoryItemQuit
  | HistoryItemCompression
  | HistoryItemExtensionsList
  | HistoryItemToolsList
  | HistoryItemMcpStatus;

export type HistoryItem = HistoryItemWithoutId & { id: number };

// Message types used by internal command feedback (subset of HistoryItem types)
export enum MessageType {
  INFO = 'info',
  ERROR = 'error',
  WARNING = 'warning',
  USER = 'user',
  ABOUT = 'about',
  HELP = 'help',
  STATS = 'stats',
  MODEL_STATS = 'model_stats',
  TOOL_STATS = 'tool_stats',
  QUIT = 'quit',
  GEMINI = 'gemini',
  COMPRESSION = 'compression',
  EXTENSIONS_LIST = 'extensions_list',
  TOOLS_LIST = 'tools_list',
  MCP_STATUS = 'mcp_status',
}

// Simplified message structure for internal feedback
export type Message =
  | {
      type: MessageType.INFO | MessageType.ERROR | MessageType.USER;
      content: string; // Renamed from text for clarity in this context
      timestamp: Date;
    }
  | {
      type: MessageType.ABOUT;
      timestamp: Date;
      cliVersion: string;
      osVersion: string;
      sandboxEnv: string;
      modelVersion: string;
      selectedAuthType: string;
      gcpProject: string;
      ideClient: string;
      content?: string; // Optional content, not really used for ABOUT
    }
  | {
      type: MessageType.HELP;
      timestamp: Date;
      content?: string; // Optional content, not really used for HELP
    }
  | {
      type: MessageType.STATS;
      timestamp: Date;
      duration: string;
      content?: string;
    }
  | {
      type: MessageType.MODEL_STATS;
      timestamp: Date;
      content?: string;
    }
  | {
      type: MessageType.TOOL_STATS;
      timestamp: Date;
      content?: string;
    }
  | {
      type: MessageType.QUIT;
      timestamp: Date;
      duration: string;
      content?: string;
    }
  | {
      type: MessageType.COMPRESSION;
      compression: CompressionProps;
      timestamp: Date;
    };

export interface ConsoleMessageItem {
  type: 'log' | 'warn' | 'error' | 'debug' | 'info';
  content: string;
  count: number;
}

/**
 * Result type for a slash command that should immediately result in a prompt
 * being submitted to the Gemini model.
 */
export interface SubmitPromptResult {
  type: 'submit_prompt';
  content: PartListUnion;
}

/**
 * Defines the result of the slash command processor for its consumer (useGeminiStream).
 */
export type SlashCommandProcessorResult =
  | {
      type: 'schedule_tool';
      toolName: string;
      toolArgs: Record<string, unknown>;
    }
  | {
      type: 'handled'; // Indicates the command was processed and no further action is needed.
    }
  | SubmitPromptResult;

export interface ShellConfirmationRequest {
  commands: string[];
  onConfirm: (
    outcome: ToolConfirmationOutcome,
    approvedCommands?: string[],
  ) => void;
}

export interface ConfirmationRequest {
  prompt: ReactNode;
  onConfirm: (confirm: boolean) => void;
}

export interface LoopDetectionConfirmationRequest {
  onComplete: (result: { userSelection: 'disable' | 'keep' }) => void;
}
