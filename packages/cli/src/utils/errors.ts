/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@wct-cli/wct-cli-core';
import {
  OutputFormat,
  JsonFormatter,
  parseAndFormatApiError,
  FatalTurnLimitedError,
  FatalToolExecutionError,
  FatalCancellationError,
} from '@wct-cli/wct-cli-core';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface ErrorWithCode extends Error {
  exitCode?: number;
  code?: string | number;
  status?: string | number;
}

/**
 * Extracts the appropriate error code from an error object.
 */
function extractErrorCode(error: unknown): string | number {
  const errorWithCode = error as ErrorWithCode;

  // Prioritize exitCode for FatalError types, fall back to other codes
  if (typeof errorWithCode.exitCode === 'number') {
    return errorWithCode.exitCode;
  }
  if (errorWithCode.code !== undefined) {
    return errorWithCode.code;
  }
  if (errorWithCode.status !== undefined) {
    return errorWithCode.status;
  }

  return 1; // Default exit code
}

/**
 * Converts an error code to a numeric exit code.
 */
function getNumericExitCode(errorCode: string | number): number {
  return typeof errorCode === 'number' ? errorCode : 1;
}

/**
 * Handles errors consistently for both JSON and text output formats.
 * In JSON mode, outputs formatted JSON error and exits.
 * In text mode, outputs error message and re-throws.
 */
export function handleError(
  error: unknown,
  config: Config,
  customErrorCode?: string | number,
): never {
  const errorMessage = parseAndFormatApiError(
    error,
    config.getContentGeneratorConfig()?.authType,
  );

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const errorCode = customErrorCode ?? extractErrorCode(error);

    const formattedError = formatter.formatError(
      error instanceof Error ? error : new Error(getErrorMessage(error)),
      errorCode,
    );

    console.error(formattedError);
    process.exit(getNumericExitCode(errorCode));
  } else {
    console.error(errorMessage);
    throw error;
  }
}

/**
 * Handles tool execution errors specifically.
 * In JSON mode, outputs formatted JSON error and exits.
 * In text mode, outputs error message to stderr only.
 */
export function handleToolError(
  toolName: string,
  toolError: Error,
  config: Config,
  errorCode?: string | number,
  resultDisplay?: string,
): void {
  const errorMessage = `Error executing tool ${toolName}: ${resultDisplay || toolError.message}`;
  const toolExecutionError = new FatalToolExecutionError(errorMessage);

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      toolExecutionError,
      errorCode ?? toolExecutionError.exitCode,
    );

    console.error(formattedError);
    process.exit(
      typeof errorCode === 'number' ? errorCode : toolExecutionError.exitCode,
    );
  } else {
    console.error(errorMessage);
  }
}

/**
 * Handles cancellation/abort signals consistently.
 */
export function handleCancellationError(config: Config): never {
  const cancellationError = new FatalCancellationError('Operation cancelled.');

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      cancellationError,
      cancellationError.exitCode,
    );

    console.error(formattedError);
    process.exit(cancellationError.exitCode);
  } else {
    console.error(cancellationError.message);
    process.exit(cancellationError.exitCode);
  }
}

/**
 * Handles max session turns exceeded consistently.
 */
export function handleMaxTurnsExceededError(config: Config): never {
  const maxTurnsError = new FatalTurnLimitedError(
    'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
  );

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      maxTurnsError,
      maxTurnsError.exitCode,
    );

    console.error(formattedError);
    process.exit(maxTurnsError.exitCode);
  } else {
    console.error(maxTurnsError.message);
    process.exit(maxTurnsError.exitCode);
  }
}
