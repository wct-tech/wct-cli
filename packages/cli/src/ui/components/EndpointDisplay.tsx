import React from 'react';
import { Box, Text } from 'ink';
import { isSiliconFlow } from '@wct-cli/wct-cli-core';

interface EndpointDisplayProps {
  baseURL?: string;
}

export const EndpointDisplay: React.FC<EndpointDisplayProps> = ({ baseURL }) =>
  isSiliconFlow() ? (
    <Box>
      <Text>{baseURL}</Text>
    </Box>
  ) : null;
