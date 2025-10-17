/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

type Model = string;
type TokenCount = number;

export const DEFAULT_TOKEN_LIMIT = 128_000;

export function tokenLimit(model: Model): TokenCount {
  // Add other models as they become relevant or if specified by config
  // Pulled from https://ai.google.dev/gemini-api/docs/models
  switch (model) {
    case 'gemini-1.5-pro':
      return 2_097_152;
    case 'gemini-1.5-flash':
    case 'gemini-2.5-pro-preview-05-06':
    case 'gemini-2.5-pro-preview-06-05':
    case 'gemini-2.5-pro':
    case 'gemini-2.5-flash-preview-05-20':
    case 'gemini-2.5-flash':
    case 'gemini-2.5-flash-lite':
    case 'gemini-2.0-flash':
    case 'qwen3-coder-plus':
      return 1_048_576;
    case 'DeepSeek-V3':
    case 'DeepSeek-V3.1':
    case 'glm-4.5':
    case 'glm-4.5-x':
    case 'glm-4.5-air':
    case 'glm-4.5-flash':
    case 'kimi-k2':
      // 128k
      return 128_000;
    case 'glm-4.6':
      // 200k
      return 200_000;
    case 'gemini-2.0-flash-preview-image-generation':
      return 32_000;
    default:
      return DEFAULT_TOKEN_LIMIT;
  }
}
