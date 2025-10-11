/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest/globals" />

// Mock 'os' first.
import * as osActual from 'node:os'; // Import for type info for the mock factory

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof osActual>();
  return {
    ...actualOs,
    homedir: vi.fn(() => '/mock/home/user'),
    platform: vi.fn(() => 'linux'),
  };
});

// Mock './settings.js' to ensure it uses the mocked 'os.homedir()' for its internal constants.
vi.mock('./settings.js', async (importActual) => {
  const originalModule = await importActual<typeof import('./settings.js')>();
  return {
    __esModule: true, // Ensure correct module shape
    ...originalModule, // Re-export all original members
    // We are relying on originalModule's USER_SETTINGS_PATH being constructed with mocked os.homedir()
  };
});

// Mock trustedFolders
vi.mock('./trustedFolders.js', () => ({
  isWorkspaceTrusted: vi
    .fn()
    .mockReturnValue({ isTrusted: true, source: 'file' }),
}));

// NOW import everything else, including the (now effectively re-exported) settings.js
import path, * as pathActual from 'node:path'; // Restored for MOCK_WORKSPACE_SETTINGS_PATH
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
  type Mock,
  fail,
} from 'vitest';
import * as fs from 'node:fs'; // fs will be mocked separately
import stripJsonComments from 'strip-json-comments'; // Will be mocked separately
import { isWorkspaceTrusted } from './trustedFolders.js';
import { disableExtension } from './extension.js';

// These imports will get the versions from the vi.mock('./settings.js', ...) factory.
import {
  loadSettings,
  USER_SETTINGS_PATH, // This IS the mocked path.
  getSystemSettingsPath,
  getSystemDefaultsPath,
  SETTINGS_DIRECTORY_NAME, // This is from the original module, but used by the mock.
  migrateSettingsToV1,
  needsMigration,
  type Settings,
  loadEnvironment,
  migrateDeprecatedSettings,
  SettingScope,
} from './settings.js';
import { FatalConfigError, GEMINI_DIR } from '@wct-cli/wct-cli-core';

const MOCK_WORKSPACE_DIR = '/mock/workspace';
// Use the (mocked) SETTINGS_DIRECTORY_NAME for consistency
const MOCK_WORKSPACE_SETTINGS_PATH = pathActual.join(
  MOCK_WORKSPACE_DIR,
  SETTINGS_DIRECTORY_NAME,
  'settings.json',
);

// A more flexible type for test data that allows arbitrary properties.
type TestSettings = Settings & { [key: string]: unknown };

vi.mock('fs', async (importOriginal) => {
  // Get all the functions from the real 'fs' module
  const actualFs = await importOriginal<typeof fs>();

  return {
    ...actualFs, // Keep all the real functions
    // Now, just override the ones we need for the test
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    realpathSync: (p: string) => p,
  };
});

vi.mock('./extension.js', () => ({
  disableExtension: vi.fn(),
}));

vi.mock('strip-json-comments', () => ({
  default: vi.fn((content) => content),
}));

describe('Settings Loading and Merging', () => {
  let mockFsExistsSync: Mocked<typeof fs.existsSync>;
  let mockStripJsonComments: Mocked<typeof stripJsonComments>;
  let mockFsMkdirSync: Mocked<typeof fs.mkdirSync>;

  beforeEach(() => {
    vi.resetAllMocks();

    mockFsExistsSync = vi.mocked(fs.existsSync);
    mockFsMkdirSync = vi.mocked(fs.mkdirSync);
    mockStripJsonComments = vi.mocked(stripJsonComments);

    vi.mocked(osActual.homedir).mockReturnValue('/mock/home/user');
    (mockStripJsonComments as unknown as Mock).mockImplementation(
      (jsonString: string) => jsonString,
    );
    (mockFsExistsSync as Mock).mockReturnValue(false);
    (fs.readFileSync as Mock).mockReturnValue('{}'); // Return valid empty JSON
    (mockFsMkdirSync as Mock).mockImplementation(() => undefined);
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: 'file',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadSettings', () => {
    it('should load empty settings if no files exist', () => {
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.system.settings).toEqual({});
      expect(settings.user.settings).toEqual({});
      expect(settings.workspace.settings).toEqual({});
      expect(settings.merged).toEqual({});
    });

    it('should load system settings if only system file exists', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === getSystemSettingsPath(),
      );
      const systemSettingsContent = {
        ui: {
          theme: 'system-default',
        },
        tools: {
          sandbox: false,
        },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemSettingsPath())
            return JSON.stringify(systemSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(fs.readFileSync).toHaveBeenCalledWith(
        getSystemSettingsPath(),
        'utf-8',
      );
      expect(settings.system.settings).toEqual(systemSettingsContent);
      expect(settings.user.settings).toEqual({});
      expect(settings.workspace.settings).toEqual({});
      expect(settings.merged).toEqual({
        ...systemSettingsContent,
      });
    });

    it('should load user settings if only user file exists', () => {
      const expectedUserSettingsPath = USER_SETTINGS_PATH; // Use the path actually resolved by the (mocked) module

      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === expectedUserSettingsPath,
      );
      const userSettingsContent = {
        ui: {
          theme: 'dark',
        },
        context: {
          fileName: 'USER_CONTEXT.md',
        },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === expectedUserSettingsPath)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(fs.readFileSync).toHaveBeenCalledWith(
        expectedUserSettingsPath,
        'utf-8',
      );
      expect(settings.user.settings).toEqual(userSettingsContent);
      expect(settings.workspace.settings).toEqual({});
      expect(settings.merged).toEqual({
        ...userSettingsContent,
      });
    });

    it('should load workspace settings if only workspace file exists', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const workspaceSettingsContent = {
        tools: {
          sandbox: true,
        },
        context: {
          fileName: 'WORKSPACE_CONTEXT.md',
        },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(fs.readFileSync).toHaveBeenCalledWith(
        MOCK_WORKSPACE_SETTINGS_PATH,
        'utf-8',
      );
      expect(settings.user.settings).toEqual({});
      expect(settings.workspace.settings).toEqual(workspaceSettingsContent);
      expect(settings.merged).toEqual({
        ...workspaceSettingsContent,
      });
    });

    it('should merge system, user and workspace settings, with system taking precedence over workspace, and workspace over user', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) =>
          p === getSystemSettingsPath() ||
          p === USER_SETTINGS_PATH ||
          p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const systemSettingsContent = {
        ui: {
          theme: 'system-theme',
        },
        tools: {
          sandbox: false,
        },
        mcp: {
          allowed: ['server1', 'server2'],
        },
        telemetry: { enabled: false },
      };
      const userSettingsContent = {
        ui: {
          theme: 'dark',
        },
        tools: {
          sandbox: true,
        },
        context: {
          fileName: 'USER_CONTEXT.md',
        },
      };
      const workspaceSettingsContent = {
        tools: {
          sandbox: false,
          core: ['tool1'],
        },
        context: {
          fileName: 'WORKSPACE_CONTEXT.md',
        },
        mcp: {
          allowed: ['server1', 'server2', 'server3'],
        },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemSettingsPath())
            return JSON.stringify(systemSettingsContent);
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.system.settings).toEqual(systemSettingsContent);
      expect(settings.user.settings).toEqual(userSettingsContent);
      expect(settings.workspace.settings).toEqual(workspaceSettingsContent);
      expect(settings.merged).toEqual({
        ui: {
          theme: 'system-theme',
        },
        tools: {
          sandbox: false,
          core: ['tool1'],
        },
        telemetry: { enabled: false },
        context: {
          fileName: 'WORKSPACE_CONTEXT.md',
        },
        mcp: {
          allowed: ['server1', 'server2'],
        },
      });
    });

    it('should correctly migrate a complex legacy (v1) settings file', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const legacySettingsContent = {
        theme: 'legacy-dark',
        vimMode: true,
        contextFileName: 'LEGACY_CONTEXT.md',
        model: 'gemini-pro',
        mcpServers: {
          'legacy-server-1': {
            command: 'npm',
            args: ['run', 'start:server1'],
            description: 'Legacy Server 1',
          },
          'legacy-server-2': {
            command: 'node',
            args: ['server2.js'],
            description: 'Legacy Server 2',
          },
        },
        allowMCPServers: ['legacy-server-1'],
        someUnrecognizedSetting: 'should-be-preserved',
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(legacySettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.merged).toEqual({
        ui: {
          theme: 'legacy-dark',
        },
        general: {
          vimMode: true,
        },
        context: {
          fileName: 'LEGACY_CONTEXT.md',
        },
        model: {
          name: 'gemini-pro',
        },
        mcpServers: {
          'legacy-server-1': {
            command: 'npm',
            args: ['run', 'start:server1'],
            description: 'Legacy Server 1',
          },
          'legacy-server-2': {
            command: 'node',
            args: ['server2.js'],
            description: 'Legacy Server 2',
          },
        },
        mcp: {
          allowed: ['legacy-server-1'],
        },
        someUnrecognizedSetting: 'should-be-preserved',
      });
    });

    it('should rewrite allowedTools to tools.allowed during migration', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const legacySettingsContent = {
        allowedTools: ['fs', 'shell'],
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(legacySettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.merged.tools?.allowed).toEqual(['fs', 'shell']);
      expect((settings.merged as TestSettings)['allowedTools']).toBeUndefined();
    });

    it('should correctly merge and migrate legacy array properties from multiple scopes', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const legacyUserSettings = {
        includeDirectories: ['/user/dir'],
        excludeTools: ['user-tool'],
        excludedProjectEnvVars: ['USER_VAR'],
      };
      const legacyWorkspaceSettings = {
        includeDirectories: ['/workspace/dir'],
        excludeTools: ['workspace-tool'],
        excludedProjectEnvVars: ['WORKSPACE_VAR', 'USER_VAR'],
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(legacyUserSettings);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(legacyWorkspaceSettings);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      // Verify includeDirectories are concatenated
      expect(settings.merged.context?.includeDirectories).toEqual([
        '/user/dir',
        '/workspace/dir',
      ]);

      // Verify excludeTools are concatenated and de-duped
      expect(settings.merged.tools?.exclude).toEqual([
        'user-tool',
        'workspace-tool',
      ]);

      // Verify excludedProjectEnvVars are concatenated and de-duped
      expect(settings.merged.advanced?.excludedEnvVars).toEqual(
        expect.arrayContaining(['USER_VAR', 'WORKSPACE_VAR']),
      );
      expect(settings.merged.advanced?.excludedEnvVars).toHaveLength(2);
    });

    it('should merge all settings files with the correct precedence', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const systemDefaultsContent = {
        ui: {
          theme: 'default-theme',
        },
        tools: {
          sandbox: true,
        },
        telemetry: true,
        context: {
          includeDirectories: ['/system/defaults/dir'],
        },
      };
      const userSettingsContent = {
        ui: {
          theme: 'user-theme',
        },
        context: {
          fileName: 'USER_CONTEXT.md',
          includeDirectories: ['/user/dir1', '/user/dir2'],
        },
      };
      const workspaceSettingsContent = {
        tools: {
          sandbox: false,
        },
        context: {
          fileName: 'WORKSPACE_CONTEXT.md',
          includeDirectories: ['/workspace/dir'],
        },
      };
      const systemSettingsContent = {
        ui: {
          theme: 'system-theme',
        },
        telemetry: false,
        context: {
          includeDirectories: ['/system/dir'],
        },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemDefaultsPath())
            return JSON.stringify(systemDefaultsContent);
          if (p === getSystemSettingsPath())
            return JSON.stringify(systemSettingsContent);
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.systemDefaults.settings).toEqual(systemDefaultsContent);
      expect(settings.system.settings).toEqual(systemSettingsContent);
      expect(settings.user.settings).toEqual(userSettingsContent);
      expect(settings.workspace.settings).toEqual(workspaceSettingsContent);
      expect(settings.merged).toEqual({
        context: {
          fileName: 'WORKSPACE_CONTEXT.md',
          includeDirectories: [
            '/system/defaults/dir',
            '/user/dir1',
            '/user/dir2',
            '/workspace/dir',
            '/system/dir',
          ],
        },
        telemetry: false,
        tools: {
          sandbox: false,
        },
        ui: {
          theme: 'system-theme',
        },
      });
    });

    it('should use folderTrust from workspace settings when trusted', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = {
        security: {
          folderTrust: {
            enabled: true,
          },
        },
      };
      const workspaceSettingsContent = {
        security: {
          folderTrust: {
            enabled: false, // This should be used
          },
        },
      };
      const systemSettingsContent = {
        // No folderTrust here
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemSettingsPath())
            return JSON.stringify(systemSettingsContent);
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.security?.folderTrust?.enabled).toBe(false); // Workspace setting should be used
    });

    it('should use system folderTrust over user setting', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = {
        security: {
          folderTrust: {
            enabled: false,
          },
        },
      };
      const workspaceSettingsContent = {
        security: {
          folderTrust: {
            enabled: true, // This should be ignored
          },
        },
      };
      const systemSettingsContent = {
        security: {
          folderTrust: {
            enabled: true,
          },
        },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemSettingsPath())
            return JSON.stringify(systemSettingsContent);
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.security?.folderTrust?.enabled).toBe(true); // System setting should be used
    });

    it('should handle contextFileName correctly when only in user settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const userSettingsContent = { context: { fileName: 'CUSTOM.md' } };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.context?.fileName).toBe('CUSTOM.md');
    });

    it('should handle contextFileName correctly when only in workspace settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const workspaceSettingsContent = {
        context: { fileName: 'PROJECT_SPECIFIC.md' },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.context?.fileName).toBe('PROJECT_SPECIFIC.md');
    });

    it('should handle excludedProjectEnvVars correctly when only in user settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const userSettingsContent = {
        general: {},
        advanced: { excludedEnvVars: ['DEBUG', 'NODE_ENV', 'CUSTOM_VAR'] },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.advanced?.excludedEnvVars).toEqual([
        'DEBUG',
        'NODE_ENV',
        'CUSTOM_VAR',
      ]);
    });

    it('should handle excludedProjectEnvVars correctly when only in workspace settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const workspaceSettingsContent = {
        general: {},
        advanced: { excludedEnvVars: ['WORKSPACE_DEBUG', 'WORKSPACE_VAR'] },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.advanced?.excludedEnvVars).toEqual([
        'WORKSPACE_DEBUG',
        'WORKSPACE_VAR',
      ]);
    });

    it('should merge excludedProjectEnvVars with workspace taking precedence over user', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) =>
          p === USER_SETTINGS_PATH || p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const userSettingsContent = {
        general: {},
        advanced: { excludedEnvVars: ['DEBUG', 'NODE_ENV', 'USER_VAR'] },
      };
      const workspaceSettingsContent = {
        general: {},
        advanced: { excludedEnvVars: ['WORKSPACE_DEBUG', 'WORKSPACE_VAR'] },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.user.settings.advanced?.excludedEnvVars).toEqual([
        'DEBUG',
        'NODE_ENV',
        'USER_VAR',
      ]);
      expect(settings.workspace.settings.advanced?.excludedEnvVars).toEqual([
        'WORKSPACE_DEBUG',
        'WORKSPACE_VAR',
      ]);
      expect(settings.merged.advanced?.excludedEnvVars).toEqual([
        'DEBUG',
        'NODE_ENV',
        'USER_VAR',
        'WORKSPACE_DEBUG',
        'WORKSPACE_VAR',
      ]);
    });

    it('should default contextFileName to undefined if not in any settings file', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) =>
          p === USER_SETTINGS_PATH || p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const userSettingsContent = { ui: { theme: 'dark' } };
      const workspaceSettingsContent = { tools: { sandbox: true } };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.context?.fileName).toBeUndefined();
    });

    it('should load telemetry setting from user settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const userSettingsContent = { telemetry: { enabled: true } };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.telemetry?.enabled).toBe(true);
    });

    it('should load telemetry setting from workspace settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const workspaceSettingsContent = { telemetry: { enabled: false } };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.telemetry?.enabled).toBe(false);
    });

    it('should prioritize workspace telemetry setting over user setting', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = { telemetry: { enabled: true } };
      const workspaceSettingsContent = { telemetry: { enabled: false } };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.telemetry?.enabled).toBe(false);
    });

    it('should have telemetry as undefined if not in any settings file', () => {
      (mockFsExistsSync as Mock).mockReturnValue(false); // No settings files exist
      (fs.readFileSync as Mock).mockReturnValue('{}');
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.telemetry).toBeUndefined();
      expect(settings.merged.ui).toBeUndefined();
      expect(settings.merged.mcpServers).toBeUndefined();
    });

    it('should merge MCP servers correctly, with workspace taking precedence', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) =>
          p === USER_SETTINGS_PATH || p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const userSettingsContent = {
        mcpServers: {
          'user-server': {
            command: 'user-command',
            args: ['--user-arg'],
            description: 'User MCP server',
          },
          'shared-server': {
            command: 'user-shared-command',
            description: 'User shared server config',
          },
        },
      };
      const workspaceSettingsContent = {
        mcpServers: {
          'workspace-server': {
            command: 'workspace-command',
            args: ['--workspace-arg'],
            description: 'Workspace MCP server',
          },
          'shared-server': {
            command: 'workspace-shared-command',
            description: 'Workspace shared server config',
          },
        },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.user.settings).toEqual(userSettingsContent);
      expect(settings.workspace.settings).toEqual(workspaceSettingsContent);
      expect(settings.merged.mcpServers).toEqual({
        'user-server': {
          command: 'user-command',
          args: ['--user-arg'],
          description: 'User MCP server',
        },
        'workspace-server': {
          command: 'workspace-command',
          args: ['--workspace-arg'],
          description: 'Workspace MCP server',
        },
        'shared-server': {
          command: 'workspace-shared-command',
          description: 'Workspace shared server config',
        },
      });
    });

    it('should handle MCP servers when only in user settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const userSettingsContent = {
        mcpServers: {
          'user-only-server': {
            command: 'user-only-command',
            description: 'User only server',
          },
        },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.mcpServers).toEqual({
        'user-only-server': {
          command: 'user-only-command',
          description: 'User only server',
        },
      });
    });

    it('should handle MCP servers when only in workspace settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      const workspaceSettingsContent = {
        mcpServers: {
          'workspace-only-server': {
            command: 'workspace-only-command',
            description: 'Workspace only server',
          },
        },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.mcpServers).toEqual({
        'workspace-only-server': {
          command: 'workspace-only-command',
          description: 'Workspace only server',
        },
      });
    });

    it('should have mcpServers as undefined if not in any settings file', () => {
      (mockFsExistsSync as Mock).mockReturnValue(false); // No settings files exist
      (fs.readFileSync as Mock).mockReturnValue('{}');
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.mcpServers).toBeUndefined();
    });

    it('should merge MCP servers from system, user, and workspace with system taking precedence', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const systemSettingsContent = {
        mcpServers: {
          'shared-server': {
            command: 'system-command',
            args: ['--system-arg'],
          },
          'system-only-server': {
            command: 'system-only-command',
          },
        },
      };
      const userSettingsContent = {
        mcpServers: {
          'user-server': {
            command: 'user-command',
          },
          'shared-server': {
            command: 'user-command',
            description: 'from user',
          },
        },
      };
      const workspaceSettingsContent = {
        mcpServers: {
          'workspace-server': {
            command: 'workspace-command',
          },
          'shared-server': {
            command: 'workspace-command',
            args: ['--workspace-arg'],
          },
        },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemSettingsPath())
            return JSON.stringify(systemSettingsContent);
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.merged.mcpServers).toEqual({
        'user-server': {
          command: 'user-command',
        },
        'workspace-server': {
          command: 'workspace-command',
        },
        'system-only-server': {
          command: 'system-only-command',
        },
        'shared-server': {
          command: 'system-command',
          args: ['--system-arg'],
        },
      });
    });

    it('should merge mcp allowed/excluded lists with system taking precedence over workspace', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const systemSettingsContent = {
        mcp: {
          allowed: ['system-allowed'],
        },
      };
      const userSettingsContent = {
        mcp: {
          allowed: ['user-allowed'],
          excluded: ['user-excluded'],
        },
      };
      const workspaceSettingsContent = {
        mcp: {
          allowed: ['workspace-allowed'],
          excluded: ['workspace-excluded'],
        },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemSettingsPath())
            return JSON.stringify(systemSettingsContent);
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.merged.mcp).toEqual({
        allowed: ['system-allowed'],
        excluded: ['workspace-excluded'],
      });
    });

    it('should merge chatCompression settings, with workspace taking precedence', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = {
        general: {},
        model: { chatCompression: { contextPercentageThreshold: 0.5 } },
      };
      const workspaceSettingsContent = {
        general: {},
        model: { chatCompression: { contextPercentageThreshold: 0.8 } },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      const e = settings.user.settings.model?.chatCompression;
      console.log(e);

      expect(settings.user.settings.model?.chatCompression).toEqual({
        contextPercentageThreshold: 0.5,
      });
      expect(settings.workspace.settings.model?.chatCompression).toEqual({
        contextPercentageThreshold: 0.8,
      });
      expect(settings.merged.model?.chatCompression).toEqual({
        contextPercentageThreshold: 0.8,
      });
    });

    it('should merge output format settings, with workspace taking precedence', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = {
        output: { format: 'text' },
      };
      const workspaceSettingsContent = {
        output: { format: 'json' },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.merged.output?.format).toBe('json');
    });

    it('should handle chatCompression when only in user settings', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const userSettingsContent = {
        general: {},
        model: { chatCompression: { contextPercentageThreshold: 0.5 } },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.model?.chatCompression).toEqual({
        contextPercentageThreshold: 0.5,
      });
    });

    it('should have model as undefined if not in any settings file', () => {
      (mockFsExistsSync as Mock).mockReturnValue(false); // No settings files exist
      (fs.readFileSync as Mock).mockReturnValue('{}');
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.model).toBeUndefined();
    });

    it('should ignore chatCompression if contextPercentageThreshold is invalid', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const userSettingsContent = {
        general: {},
        model: { chatCompression: { contextPercentageThreshold: 1.5 } },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.model?.chatCompression).toEqual({
        contextPercentageThreshold: 1.5,
      });
      warnSpy.mockRestore();
    });

    it('should deep merge chatCompression settings', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = {
        general: {},
        model: { chatCompression: { contextPercentageThreshold: 0.5 } },
      };
      const workspaceSettingsContent = {
        general: {},
        model: { chatCompression: {} },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.merged.model?.chatCompression).toEqual({
        contextPercentageThreshold: 0.5,
      });
    });

    it('should merge includeDirectories from all scopes', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const systemSettingsContent = {
        context: { includeDirectories: ['/system/dir'] },
      };
      const systemDefaultsContent = {
        context: { includeDirectories: ['/system/defaults/dir'] },
      };
      const userSettingsContent = {
        context: { includeDirectories: ['/user/dir1', '/user/dir2'] },
      };
      const workspaceSettingsContent = {
        context: { includeDirectories: ['/workspace/dir'] },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemSettingsPath())
            return JSON.stringify(systemSettingsContent);
          if (p === getSystemDefaultsPath())
            return JSON.stringify(systemDefaultsContent);
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.merged.context?.includeDirectories).toEqual([
        '/system/defaults/dir',
        '/user/dir1',
        '/user/dir2',
        '/workspace/dir',
        '/system/dir',
      ]);
    });

    it('should handle JSON parsing errors gracefully', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true); // Both files "exist"
      const invalidJsonContent = 'invalid json';
      const userReadError = new SyntaxError(
        "Expected ',' or '}' after property value in JSON at position 10",
      );
      const workspaceReadError = new SyntaxError(
        'Unexpected token i in JSON at position 0',
      );

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH) {
            // Simulate JSON.parse throwing for user settings
            vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
              throw userReadError;
            });
            return invalidJsonContent; // Content that would cause JSON.parse to throw
          }
          if (p === MOCK_WORKSPACE_SETTINGS_PATH) {
            // Simulate JSON.parse throwing for workspace settings
            vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
              throw workspaceReadError;
            });
            return invalidJsonContent;
          }
          return '{}'; // Default for other reads
        },
      );

      try {
        loadSettings(MOCK_WORKSPACE_DIR);
        fail('loadSettings should have thrown a FatalConfigError');
      } catch (e) {
        expect(e).toBeInstanceOf(FatalConfigError);
        const error = e as FatalConfigError;
        expect(error.message).toContain(
          `Error in ${USER_SETTINGS_PATH}: ${userReadError.message}`,
        );
        expect(error.message).toContain(
          `Error in ${MOCK_WORKSPACE_SETTINGS_PATH}: ${workspaceReadError.message}`,
        );
        expect(error.message).toContain(
          'Please fix the configuration file(s) and try again.',
        );
      }

      // Restore JSON.parse mock if it was spied on specifically for this test
      vi.restoreAllMocks(); // Or more targeted restore if needed
    });

    it('should resolve environment variables in user settings', () => {
      process.env['TEST_API_KEY'] = 'user_api_key_from_env';
      const userSettingsContent: TestSettings = {
        apiKey: '$TEST_API_KEY',
        someUrl: 'https://test.com/${TEST_API_KEY}',
      };
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect((settings.user.settings as TestSettings)['apiKey']).toBe(
        'user_api_key_from_env',
      );
      expect((settings.user.settings as TestSettings)['someUrl']).toBe(
        'https://test.com/user_api_key_from_env',
      );
      expect((settings.merged as TestSettings)['apiKey']).toBe(
        'user_api_key_from_env',
      );
      delete process.env['TEST_API_KEY'];
    });

    it('should resolve environment variables in workspace settings', () => {
      process.env['WORKSPACE_ENDPOINT'] = 'workspace_endpoint_from_env';
      const workspaceSettingsContent: TestSettings = {
        endpoint: '${WORKSPACE_ENDPOINT}/api',
        nested: { value: '$WORKSPACE_ENDPOINT' },
      };
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === MOCK_WORKSPACE_SETTINGS_PATH,
      );
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect((settings.workspace.settings as TestSettings)['endpoint']).toBe(
        'workspace_endpoint_from_env/api',
      );
      expect(
        (settings.workspace.settings as TestSettings)['nested']['value'],
      ).toBe('workspace_endpoint_from_env');
      expect((settings.merged as TestSettings)['endpoint']).toBe(
        'workspace_endpoint_from_env/api',
      );
      delete process.env['WORKSPACE_ENDPOINT'];
    });

    it('should correctly resolve and merge env variables from different scopes', () => {
      process.env['SYSTEM_VAR'] = 'system_value';
      process.env['USER_VAR'] = 'user_value';
      process.env['WORKSPACE_VAR'] = 'workspace_value';
      process.env['SHARED_VAR'] = 'final_value';

      const systemSettingsContent: TestSettings = {
        configValue: '$SHARED_VAR',
        systemOnly: '$SYSTEM_VAR',
      };
      const userSettingsContent: TestSettings = {
        configValue: '$SHARED_VAR',
        userOnly: '$USER_VAR',
        ui: {
          theme: 'dark',
        },
      };
      const workspaceSettingsContent: TestSettings = {
        configValue: '$SHARED_VAR',
        workspaceOnly: '$WORKSPACE_VAR',
        ui: {
          theme: 'light',
        },
      };

      (mockFsExistsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === getSystemSettingsPath()) {
            return JSON.stringify(systemSettingsContent);
          }
          if (p === USER_SETTINGS_PATH) {
            return JSON.stringify(userSettingsContent);
          }
          if (p === MOCK_WORKSPACE_SETTINGS_PATH) {
            return JSON.stringify(workspaceSettingsContent);
          }
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      // Check resolved values in individual scopes
      expect((settings.system.settings as TestSettings)['configValue']).toBe(
        'final_value',
      );
      expect((settings.system.settings as TestSettings)['systemOnly']).toBe(
        'system_value',
      );
      expect((settings.user.settings as TestSettings)['configValue']).toBe(
        'final_value',
      );
      expect((settings.user.settings as TestSettings)['userOnly']).toBe(
        'user_value',
      );
      expect((settings.workspace.settings as TestSettings)['configValue']).toBe(
        'final_value',
      );
      expect(
        (settings.workspace.settings as TestSettings)['workspaceOnly'],
      ).toBe('workspace_value');

      // Check merged values (system > workspace > user)
      expect((settings.merged as TestSettings)['configValue']).toBe(
        'final_value',
      );
      expect((settings.merged as TestSettings)['systemOnly']).toBe(
        'system_value',
      );
      expect((settings.merged as TestSettings)['userOnly']).toBe('user_value');
      expect((settings.merged as TestSettings)['workspaceOnly']).toBe(
        'workspace_value',
      );
      expect(settings.merged.ui?.theme).toBe('light'); // workspace overrides user

      delete process.env['SYSTEM_VAR'];
      delete process.env['USER_VAR'];
      delete process.env['WORKSPACE_VAR'];
      delete process.env['SHARED_VAR'];
    });

    it('should correctly merge dnsResolutionOrder with workspace taking precedence', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = {
        advanced: { dnsResolutionOrder: 'ipv4first' },
      };
      const workspaceSettingsContent = {
        advanced: { dnsResolutionOrder: 'verbatim' },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.advanced?.dnsResolutionOrder).toBe('verbatim');
    });

    it('should use user dnsResolutionOrder if workspace is not defined', () => {
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      const userSettingsContent = {
        advanced: { dnsResolutionOrder: 'verbatim' },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.advanced?.dnsResolutionOrder).toBe('verbatim');
    });

    it('should leave unresolved environment variables as is', () => {
      const userSettingsContent: TestSettings = { apiKey: '$UNDEFINED_VAR' };
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect((settings.user.settings as TestSettings)['apiKey']).toBe(
        '$UNDEFINED_VAR',
      );
      expect((settings.merged as TestSettings)['apiKey']).toBe(
        '$UNDEFINED_VAR',
      );
    });

    it('should resolve multiple environment variables in a single string', () => {
      process.env['VAR_A'] = 'valueA';
      process.env['VAR_B'] = 'valueB';
      const userSettingsContent: TestSettings = {
        path: '/path/$VAR_A/${VAR_B}/end',
      };
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect((settings.user.settings as TestSettings)['path']).toBe(
        '/path/valueA/valueB/end',
      );
      delete process.env['VAR_A'];
      delete process.env['VAR_B'];
    });

    it('should resolve environment variables in arrays', () => {
      process.env['ITEM_1'] = 'item1_env';
      process.env['ITEM_2'] = 'item2_env';
      const userSettingsContent: TestSettings = {
        list: ['$ITEM_1', '${ITEM_2}', 'literal'],
      };
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );
      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect((settings.user.settings as TestSettings)['list']).toEqual([
        'item1_env',
        'item2_env',
        'literal',
      ]);
      delete process.env['ITEM_1'];
      delete process.env['ITEM_2'];
    });

    it('should correctly pass through null, boolean, and number types, and handle undefined properties', () => {
      process.env['MY_ENV_STRING'] = 'env_string_value';
      process.env['MY_ENV_STRING_NESTED'] = 'env_string_nested_value';

      const userSettingsContent: TestSettings = {
        nullVal: null,
        trueVal: true,
        falseVal: false,
        numberVal: 123.45,
        stringVal: '$MY_ENV_STRING',
        nestedObj: {
          nestedNull: null,
          nestedBool: true,
          nestedNum: 0,
          nestedString: 'literal',
          anotherEnv: '${MY_ENV_STRING_NESTED}',
        },
      };

      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect((settings.user.settings as TestSettings)['nullVal']).toBeNull();
      expect((settings.user.settings as TestSettings)['trueVal']).toBe(true);
      expect((settings.user.settings as TestSettings)['falseVal']).toBe(false);
      expect((settings.user.settings as TestSettings)['numberVal']).toBe(
        123.45,
      );
      expect((settings.user.settings as TestSettings)['stringVal']).toBe(
        'env_string_value',
      );
      expect(
        (settings.user.settings as TestSettings)['undefinedVal'],
      ).toBeUndefined();

      expect(
        (settings.user.settings as TestSettings)['nestedObj']['nestedNull'],
      ).toBeNull();
      expect(
        (settings.user.settings as TestSettings)['nestedObj']['nestedBool'],
      ).toBe(true);
      expect(
        (settings.user.settings as TestSettings)['nestedObj']['nestedNum'],
      ).toBe(0);
      expect(
        (settings.user.settings as TestSettings)['nestedObj']['nestedString'],
      ).toBe('literal');
      expect(
        (settings.user.settings as TestSettings)['nestedObj']['anotherEnv'],
      ).toBe('env_string_nested_value');

      delete process.env['MY_ENV_STRING'];
      delete process.env['MY_ENV_STRING_NESTED'];
    });

    it('should resolve multiple concatenated environment variables in a single string value', () => {
      process.env['TEST_HOST'] = 'myhost';
      process.env['TEST_PORT'] = '9090';
      const userSettingsContent: TestSettings = {
        serverAddress: '${TEST_HOST}:${TEST_PORT}/api',
      };
      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect((settings.user.settings as TestSettings)['serverAddress']).toBe(
        'myhost:9090/api',
      );

      delete process.env['TEST_HOST'];
      delete process.env['TEST_PORT'];
    });

    describe('when GEMINI_CLI_SYSTEM_SETTINGS_PATH is set', () => {
      const MOCK_ENV_SYSTEM_SETTINGS_PATH = '/mock/env/system/settings.json';

      beforeEach(() => {
        process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] =
          MOCK_ENV_SYSTEM_SETTINGS_PATH;
      });

      afterEach(() => {
        delete process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'];
      });

      it('should load system settings from the path specified in the environment variable', () => {
        (mockFsExistsSync as Mock).mockImplementation(
          (p: fs.PathLike) => p === MOCK_ENV_SYSTEM_SETTINGS_PATH,
        );
        const systemSettingsContent = {
          ui: { theme: 'env-var-theme' },
          tools: { sandbox: true },
        };
        (fs.readFileSync as Mock).mockImplementation(
          (p: fs.PathOrFileDescriptor) => {
            if (p === MOCK_ENV_SYSTEM_SETTINGS_PATH)
              return JSON.stringify(systemSettingsContent);
            return '{}';
          },
        );

        const settings = loadSettings(MOCK_WORKSPACE_DIR);

        expect(fs.readFileSync).toHaveBeenCalledWith(
          MOCK_ENV_SYSTEM_SETTINGS_PATH,
          'utf-8',
        );
        expect(settings.system.path).toBe(MOCK_ENV_SYSTEM_SETTINGS_PATH);
        expect(settings.system.settings).toEqual(systemSettingsContent);
        expect(settings.merged).toEqual({
          ...systemSettingsContent,
        });
      });
    });
  });

  describe('excludedProjectEnvVars integration', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should exclude DEBUG and DEBUG_MODE from project .env files by default', () => {
      // Create a workspace settings file with excludedProjectEnvVars
      const workspaceSettingsContent = {
        general: {},
        advanced: { excludedEnvVars: ['DEBUG', 'DEBUG_MODE'] },
      };

      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === MOCK_WORKSPACE_SETTINGS_PATH,
      );

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      // Mock findEnvFile to return a project .env file
      const originalFindEnvFile = (
        loadSettings as unknown as { findEnvFile: () => string }
      ).findEnvFile;
      (loadSettings as unknown as { findEnvFile: () => string }).findEnvFile =
        () => '/mock/project/.env';

      // Mock fs.readFileSync for .env file content
      const originalReadFileSync = fs.readFileSync;
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === '/mock/project/.env') {
            return 'DEBUG=true\nDEBUG_MODE=1\nGEMINI_API_KEY=test-key';
          }
          if (p === MOCK_WORKSPACE_SETTINGS_PATH) {
            return JSON.stringify(workspaceSettingsContent);
          }
          return '{}';
        },
      );

      try {
        // This will call loadEnvironment internally with the merged settings
        const settings = loadSettings(MOCK_WORKSPACE_DIR);

        // Verify the settings were loaded correctly
        expect(settings.merged.advanced?.excludedEnvVars).toEqual([
          'DEBUG',
          'DEBUG_MODE',
        ]);

        // Note: We can't directly test process.env changes here because the mocking
        // prevents the actual file system operations, but we can verify the settings
        // are correctly merged and passed to loadEnvironment
      } finally {
        (loadSettings as unknown as { findEnvFile: () => string }).findEnvFile =
          originalFindEnvFile;
        (fs.readFileSync as Mock).mockImplementation(originalReadFileSync);
      }
    });

    it('should respect custom excludedProjectEnvVars from user settings', () => {
      const userSettingsContent = {
        general: {},
        advanced: { excludedEnvVars: ['NODE_ENV', 'DEBUG'] },
      };

      (mockFsExistsSync as Mock).mockImplementation(
        (p: fs.PathLike) => p === USER_SETTINGS_PATH,
      );

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.user.settings.advanced?.excludedEnvVars).toEqual([
        'NODE_ENV',
        'DEBUG',
      ]);
      expect(settings.merged.advanced?.excludedEnvVars).toEqual([
        'NODE_ENV',
        'DEBUG',
      ]);
    });

    it('should merge excludedProjectEnvVars with workspace taking precedence', () => {
      const userSettingsContent = {
        general: {},
        advanced: { excludedEnvVars: ['DEBUG', 'NODE_ENV', 'USER_VAR'] },
      };
      const workspaceSettingsContent = {
        general: {},
        advanced: { excludedEnvVars: ['WORKSPACE_DEBUG', 'WORKSPACE_VAR'] },
      };

      (mockFsExistsSync as Mock).mockReturnValue(true);

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.user.settings.advanced?.excludedEnvVars).toEqual([
        'DEBUG',
        'NODE_ENV',
        'USER_VAR',
      ]);
      expect(settings.workspace.settings.advanced?.excludedEnvVars).toEqual([
        'WORKSPACE_DEBUG',
        'WORKSPACE_VAR',
      ]);
      expect(settings.merged.advanced?.excludedEnvVars).toEqual([
        'DEBUG',
        'NODE_ENV',
        'USER_VAR',
        'WORKSPACE_DEBUG',
        'WORKSPACE_VAR',
      ]);
    });
  });

  describe('with workspace trust', () => {
    it('should merge workspace settings when workspace is trusted', () => {
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = {
        ui: { theme: 'dark' },
        tools: { sandbox: false },
      };
      const workspaceSettingsContent = {
        tools: { sandbox: true },
        context: { fileName: 'WORKSPACE.md' },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.merged.tools?.sandbox).toBe(true);
      expect(settings.merged.context?.fileName).toBe('WORKSPACE.md');
      expect(settings.merged.ui?.theme).toBe('dark');
    });

    it('should NOT merge workspace settings when workspace is not trusted', () => {
      vi.mocked(isWorkspaceTrusted).mockReturnValue({
        isTrusted: false,
        source: 'file',
      });
      (mockFsExistsSync as Mock).mockReturnValue(true);
      const userSettingsContent = {
        ui: { theme: 'dark' },
        tools: { sandbox: false },
        context: { fileName: 'USER.md' },
      };
      const workspaceSettingsContent = {
        tools: { sandbox: true },
        context: { fileName: 'WORKSPACE.md' },
      };

      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const settings = loadSettings(MOCK_WORKSPACE_DIR);

      expect(settings.merged.tools?.sandbox).toBe(false); // User setting
      expect(settings.merged.context?.fileName).toBe('USER.md'); // User setting
      expect(settings.merged.ui?.theme).toBe('dark'); // User setting
    });
  });

  describe('migrateSettingsToV1', () => {
    it('should handle an empty object', () => {
      const v2Settings = {};
      const v1Settings = migrateSettingsToV1(v2Settings);
      expect(v1Settings).toEqual({});
    });

    it('should migrate a simple v2 settings object to v1', () => {
      const v2Settings = {
        general: {
          preferredEditor: 'vscode',
          vimMode: true,
        },
        ui: {
          theme: 'dark',
        },
      };
      const v1Settings = migrateSettingsToV1(v2Settings);
      expect(v1Settings).toEqual({
        preferredEditor: 'vscode',
        vimMode: true,
        theme: 'dark',
      });
    });

    it('should handle nested properties correctly', () => {
      const v2Settings = {
        security: {
          folderTrust: {
            enabled: true,
          },
          auth: {
            selectedType: 'oauth',
          },
        },
        advanced: {
          autoConfigureMemory: true,
        },
      };
      const v1Settings = migrateSettingsToV1(v2Settings);
      expect(v1Settings).toEqual({
        folderTrust: true,
        selectedAuthType: 'oauth',
        autoConfigureMaxOldSpaceSize: true,
      });
    });

    it('should preserve mcpServers at the top level', () => {
      const v2Settings = {
        general: {
          preferredEditor: 'vscode',
        },
        mcpServers: {
          'my-server': {
            command: 'npm start',
          },
        },
      };
      const v1Settings = migrateSettingsToV1(v2Settings);
      expect(v1Settings).toEqual({
        preferredEditor: 'vscode',
        mcpServers: {
          'my-server': {
            command: 'npm start',
          },
        },
      });
    });

    it('should carry over unrecognized top-level properties', () => {
      const v2Settings = {
        general: {
          vimMode: false,
        },
        unrecognized: 'value',
        another: {
          nested: true,
        },
      };
      const v1Settings = migrateSettingsToV1(v2Settings);
      expect(v1Settings).toEqual({
        vimMode: false,
        unrecognized: 'value',
        another: {
          nested: true,
        },
      });
    });

    it('should handle a complex object with mixed properties', () => {
      const v2Settings = {
        general: {
          disableAutoUpdate: true,
        },
        ui: {
          hideBanner: true,
          customThemes: {
            myTheme: {},
          },
        },
        model: {
          name: 'gemini-pro',
          chatCompression: {
            contextPercentageThreshold: 0.5,
          },
        },
        mcpServers: {
          'server-1': {
            command: 'node server.js',
          },
        },
        unrecognized: {
          should: 'be-preserved',
        },
      };
      const v1Settings = migrateSettingsToV1(v2Settings);
      expect(v1Settings).toEqual({
        disableAutoUpdate: true,
        hideBanner: true,
        customThemes: {
          myTheme: {},
        },
        model: 'gemini-pro',
        chatCompression: {
          contextPercentageThreshold: 0.5,
        },
        mcpServers: {
          'server-1': {
            command: 'node server.js',
          },
        },
        unrecognized: {
          should: 'be-preserved',
        },
      });
    });

    it('should not migrate a v1 settings object', () => {
      const v1Settings = {
        preferredEditor: 'vscode',
        vimMode: true,
        theme: 'dark',
      };
      const migratedSettings = migrateSettingsToV1(v1Settings);
      expect(migratedSettings).toEqual({
        preferredEditor: 'vscode',
        vimMode: true,
        theme: 'dark',
      });
    });

    it('should migrate a full v2 settings object to v1', () => {
      const v2Settings: TestSettings = {
        general: {
          preferredEditor: 'code',
          vimMode: true,
        },
        ui: {
          theme: 'dark',
        },
        privacy: {
          usageStatisticsEnabled: false,
        },
        model: {
          name: 'gemini-pro',
          chatCompression: {
            contextPercentageThreshold: 0.8,
          },
        },
        context: {
          fileName: 'CONTEXT.md',
          includeDirectories: ['/src'],
        },
        tools: {
          sandbox: true,
          exclude: ['toolA'],
        },
        mcp: {
          allowed: ['server1'],
        },
        security: {
          folderTrust: {
            enabled: true,
          },
        },
        advanced: {
          dnsResolutionOrder: 'ipv4first',
          excludedEnvVars: ['SECRET'],
        },
        mcpServers: {
          'my-server': {
            command: 'npm start',
          },
        },
        unrecognizedTopLevel: {
          value: 'should be preserved',
        },
      };

      const v1Settings = migrateSettingsToV1(v2Settings);

      expect(v1Settings).toEqual({
        preferredEditor: 'code',
        vimMode: true,
        theme: 'dark',
        usageStatisticsEnabled: false,
        model: 'gemini-pro',
        chatCompression: {
          contextPercentageThreshold: 0.8,
        },
        contextFileName: 'CONTEXT.md',
        includeDirectories: ['/src'],
        sandbox: true,
        excludeTools: ['toolA'],
        allowMCPServers: ['server1'],
        folderTrust: true,
        dnsResolutionOrder: 'ipv4first',
        excludedProjectEnvVars: ['SECRET'],
        mcpServers: {
          'my-server': {
            command: 'npm start',
          },
        },
        unrecognizedTopLevel: {
          value: 'should be preserved',
        },
      });
    });

    it('should handle partial v2 settings', () => {
      const v2Settings: TestSettings = {
        general: {
          vimMode: false,
        },
        ui: {},
        model: {
          name: 'gemini-1.5-pro',
        },
        unrecognized: 'value',
      };

      const v1Settings = migrateSettingsToV1(v2Settings);

      expect(v1Settings).toEqual({
        vimMode: false,
        model: 'gemini-1.5-pro',
        unrecognized: 'value',
      });
    });

    it('should handle settings with different data types', () => {
      const v2Settings: TestSettings = {
        general: {
          vimMode: false,
        },
        model: {
          maxSessionTurns: 0,
        },
        context: {
          includeDirectories: [],
        },
        security: {
          folderTrust: {
            enabled: null,
          },
        },
      };

      const v1Settings = migrateSettingsToV1(v2Settings);

      expect(v1Settings).toEqual({
        vimMode: false,
        maxSessionTurns: 0,
        includeDirectories: [],
        folderTrust: null,
      });
    });

    it('should preserve unrecognized top-level keys', () => {
      const v2Settings: TestSettings = {
        general: {
          vimMode: true,
        },
        customTopLevel: {
          a: 1,
          b: [2],
        },
        anotherOne: 'hello',
      };

      const v1Settings = migrateSettingsToV1(v2Settings);

      expect(v1Settings).toEqual({
        vimMode: true,
        customTopLevel: {
          a: 1,
          b: [2],
        },
        anotherOne: 'hello',
      });
    });

    it('should handle an empty v2 settings object', () => {
      const v2Settings = {};
      const v1Settings = migrateSettingsToV1(v2Settings);
      expect(v1Settings).toEqual({});
    });

    it('should correctly handle mcpServers at the top level', () => {
      const v2Settings: TestSettings = {
        mcpServers: {
          serverA: { command: 'a' },
        },
        mcp: {
          allowed: ['serverA'],
        },
      };

      const v1Settings = migrateSettingsToV1(v2Settings);

      expect(v1Settings).toEqual({
        mcpServers: {
          serverA: { command: 'a' },
        },
        allowMCPServers: ['serverA'],
      });
    });

    it('should correctly migrate customWittyPhrases', () => {
      const v2Settings: Partial<Settings> = {
        ui: {
          customWittyPhrases: ['test phrase'],
        },
      };
      const v1Settings = migrateSettingsToV1(v2Settings as Settings);
      expect(v1Settings).toEqual({
        customWittyPhrases: ['test phrase'],
      });
    });
  });

  describe('loadEnvironment', () => {
    function setup({
      isFolderTrustEnabled = true,
      isWorkspaceTrustedValue = true,
    }) {
      delete process.env['TESTTEST']; // reset
      const geminiEnvPath = path.resolve(path.join(GEMINI_DIR, '.env'));

      vi.mocked(isWorkspaceTrusted).mockReturnValue({
        isTrusted: isWorkspaceTrustedValue,
        source: 'file',
      });
      (mockFsExistsSync as Mock).mockImplementation((p: fs.PathLike) =>
        [USER_SETTINGS_PATH, geminiEnvPath].includes(p.toString()),
      );
      const userSettingsContent: Settings = {
        ui: {
          theme: 'dark',
        },
        security: {
          folderTrust: {
            enabled: isFolderTrustEnabled,
          },
        },
        context: {
          fileName: 'USER_CONTEXT.md',
        },
      };
      (fs.readFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === geminiEnvPath) return 'TESTTEST=1234';
          return '{}';
        },
      );
    }

    it('sets environment variables from .env files', () => {
      setup({ isFolderTrustEnabled: false, isWorkspaceTrustedValue: true });
      loadEnvironment(loadSettings(MOCK_WORKSPACE_DIR).merged);

      expect(process.env['TESTTEST']).toEqual('1234');
    });

    it('does not load env files from untrusted spaces', () => {
      setup({ isFolderTrustEnabled: true, isWorkspaceTrustedValue: false });
      loadEnvironment(loadSettings(MOCK_WORKSPACE_DIR).merged);

      expect(process.env['TESTTEST']).not.toEqual('1234');
    });
  });

  describe('needsMigration', () => {
    it('should return false for an empty object', () => {
      expect(needsMigration({})).toBe(false);
    });

    it('should return false for settings that are already in V2 format', () => {
      const v2Settings: Partial<Settings> = {
        ui: {
          theme: 'dark',
        },
        tools: {
          sandbox: true,
        },
      };
      expect(needsMigration(v2Settings)).toBe(false);
    });

    it('should return true for settings with a V1 key that needs to be moved', () => {
      const v1Settings = {
        theme: 'dark', // v1 key
      };
      expect(needsMigration(v1Settings)).toBe(true);
    });

    it('should return true for settings with a mix of V1 and V2 keys', () => {
      const mixedSettings = {
        theme: 'dark', // v1 key
        tools: {
          sandbox: true, // v2 key
        },
      };
      expect(needsMigration(mixedSettings)).toBe(true);
    });

    it('should return false for settings with only V1 keys that are the same in V2', () => {
      const v1Settings = {
        mcpServers: {},
        telemetry: {},
        extensions: [],
      };
      expect(needsMigration(v1Settings)).toBe(false);
    });

    it('should return true for settings with a mix of V1 keys that are the same in V2 and V1 keys that need moving', () => {
      const v1Settings = {
        mcpServers: {}, // same in v2
        theme: 'dark', // needs moving
      };
      expect(needsMigration(v1Settings)).toBe(true);
    });

    it('should return false for settings with unrecognized keys', () => {
      const settings = {
        someUnrecognizedKey: 'value',
      };
      expect(needsMigration(settings)).toBe(false);
    });

    it('should return false for settings with v2 keys and unrecognized keys', () => {
      const settings = {
        ui: { theme: 'dark' },
        someUnrecognizedKey: 'value',
      };
      expect(needsMigration(settings)).toBe(false);
    });
  });

  describe('migrateDeprecatedSettings', () => {
    let mockFsExistsSync: Mocked<typeof fs.existsSync>;
    let mockFsReadFileSync: Mocked<typeof fs.readFileSync>;
    let mockDisableExtension: Mocked<typeof disableExtension>;

    beforeEach(() => {
      vi.resetAllMocks();

      mockFsExistsSync = vi.mocked(fs.existsSync);
      mockFsReadFileSync = vi.mocked(fs.readFileSync);
      mockDisableExtension = vi.mocked(disableExtension);

      (mockFsExistsSync as Mock).mockReturnValue(true);
      vi.mocked(isWorkspaceTrusted).mockReturnValue(true);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should migrate disabled extensions from user and workspace settings', () => {
      const userSettingsContent = {
        extensions: {
          disabled: ['user-ext-1', 'shared-ext'],
        },
      };
      const workspaceSettingsContent = {
        extensions: {
          disabled: ['workspace-ext-1', 'shared-ext'],
        },
      };

      (mockFsReadFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const loadedSettings = loadSettings(MOCK_WORKSPACE_DIR);
      const setValueSpy = vi.spyOn(loadedSettings, 'setValue');

      migrateDeprecatedSettings(loadedSettings, MOCK_WORKSPACE_DIR);

      // Check user settings migration
      expect(mockDisableExtension).toHaveBeenCalledWith(
        'user-ext-1',
        SettingScope.User,
        MOCK_WORKSPACE_DIR,
      );
      expect(mockDisableExtension).toHaveBeenCalledWith(
        'shared-ext',
        SettingScope.User,
        MOCK_WORKSPACE_DIR,
      );

      // Check workspace settings migration
      expect(mockDisableExtension).toHaveBeenCalledWith(
        'workspace-ext-1',
        SettingScope.Workspace,
        MOCK_WORKSPACE_DIR,
      );
      expect(mockDisableExtension).toHaveBeenCalledWith(
        'shared-ext',
        SettingScope.Workspace,
        MOCK_WORKSPACE_DIR,
      );

      // Check that setValue was called to remove the deprecated setting
      expect(setValueSpy).toHaveBeenCalledWith(
        SettingScope.User,
        'extensions',
        {
          disabled: undefined,
        },
      );
      expect(setValueSpy).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'extensions',
        {
          disabled: undefined,
        },
      );
    });

    it('should not do anything if there are no deprecated settings', () => {
      const userSettingsContent = {
        extensions: {
          enabled: ['user-ext-1'],
        },
      };
      const workspaceSettingsContent = {
        someOtherSetting: 'value',
      };

      (mockFsReadFileSync as Mock).mockImplementation(
        (p: fs.PathOrFileDescriptor) => {
          if (p === USER_SETTINGS_PATH)
            return JSON.stringify(userSettingsContent);
          if (p === MOCK_WORKSPACE_SETTINGS_PATH)
            return JSON.stringify(workspaceSettingsContent);
          return '{}';
        },
      );

      const loadedSettings = loadSettings(MOCK_WORKSPACE_DIR);
      const setValueSpy = vi.spyOn(loadedSettings, 'setValue');

      migrateDeprecatedSettings(loadedSettings, MOCK_WORKSPACE_DIR);

      expect(mockDisableExtension).not.toHaveBeenCalled();
      expect(setValueSpy).not.toHaveBeenCalled();
    });
  });
});
