/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function isSiliconFlow(): boolean {
  return !!(!process.env.CI || process.env.WCT_API_KEY);
}

export const DEFAULT_MODEL = isSiliconFlow()
  ? 'gemini-2.5-flash'
  : 'gemini-2.5-flash';
export const DEFAULT_FLASH_MODEL = isSiliconFlow()
  ? 'gemini-2.5-pro'
  : 'gemini-2.5-pro';
export const DEFAULT_EMBEDDING_MODEL = isSiliconFlow()
  ? 'qwen3-embedding-0.6b'
  : 'gemini-embedding-001';

export const DEFAULT_GEMINI_MODEL = DEFAULT_MODEL;
export const DEFAULT_GEMINI_FLASH_MODEL = DEFAULT_FLASH_MODEL;
export const DEFAULT_GEMINI_EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL;
