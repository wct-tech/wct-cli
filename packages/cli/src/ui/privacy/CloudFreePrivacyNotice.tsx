/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Newline, Text } from 'ink';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import { usePrivacySettings } from '../hooks/usePrivacySettings.js';

import type { Config } from '@wct-cli/wct-cli-core';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface CloudFreePrivacyNoticeProps {
  config: Config;
  onExit: () => void;
}

export const CloudFreePrivacyNotice = ({
  config,
  onExit,
}: CloudFreePrivacyNoticeProps) => {
  const { privacyState, updateDataCollectionOptIn } =
    usePrivacySettings(config);

  useKeypress(
    (key) => {
      if (
        (privacyState.error || privacyState.isFreeTier === false) &&
        key.name === 'escape'
      ) {
        onExit();
      }
    },
    { isActive: true },
  );

  if (privacyState.isLoading) {
    return <Text color={theme.text.secondary}>Loading...</Text>;
  }

  if (privacyState.error) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color={theme.status.error}>
          Error loading Opt-in settings: {privacyState.error}
        </Text>
        <Text color={theme.text.secondary}>Press Esc to exit.</Text>
      </Box>
    );
  }

  if (privacyState.isFreeTier === false) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text bold color={theme.text.accent}>
          Gemini Code Assist Privacy Notice
        </Text>
        <Newline />
        <Text>
          https://developers.google.com/gemini-code-assist/resources/privacy-notices
        </Text>
        <Newline />
        <Text color={theme.text.secondary}>Press Esc to exit.</Text>
      </Box>
    );
  }

  const items = [
    { label: 'Yes', value: true, key: 'true' },
    { label: 'No', value: false, key: 'false' },
  ];

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={theme.text.accent}>
        Gemini Code Assist for Individuals Privacy Notice
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        This notice and our Privacy Policy
        <Text color={theme.text.link}>[1]</Text> describe how Gemini Code Assist
        handles your data. Please read them carefully.
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        When you use Gemini Code Assist for individuals with Gemini CLI, Google
        collects your prompts, related code, generated output, code edits,
        related feature usage information, and your feedback to provide,
        improve, and develop Google products and services and machine learning
        technologies.
      </Text>
      <Newline />
      <Text color={theme.text.primary}>
        To help with quality and improve our products (such as generative
        machine-learning models), human reviewers may read, annotate, and
        process the data collected above. We take steps to protect your privacy
        as part of this process. This includes disconnecting the data from your
        Google Account before reviewers see or annotate it, and storing those
        disconnected copies for up to 18 months. Please don&apos;t submit
        confidential information or any data you wouldn&apos;t want a reviewer
        to see or Google to use to improve our products, services and
        machine-learning technologies.
      </Text>
      <Newline />
      <Box flexDirection="column">
        <Text color={theme.text.primary}>
          Allow Google to use this data to develop and improve our products?
        </Text>
        <RadioButtonSelect
          items={items}
          initialIndex={privacyState.dataCollectionOptIn ? 0 : 1}
          onSelect={(value) => {
            updateDataCollectionOptIn(value);
            // Only exit if there was no error.
            if (!privacyState.error) {
              onExit();
            }
          }}
        />
      </Box>
      <Newline />
      <Text>
        <Text color={theme.text.link}>[1]</Text>{' '}
        https://policies.google.com/privacy
      </Text>
      <Newline />
      <Text color={theme.text.secondary}>
        Press Enter to choose an option and exit.
      </Text>
    </Box>
  );
};
