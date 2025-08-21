/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { getReleaseVersion } from './get-release-version.js';
import path from 'path';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = join(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  console.log('args:', args);
  console.log('argv:', process.argv);
  const nightlyIndex = args.indexOf('--nightly');
  const versionIndex = args.findIndex(arg => arg.startsWith('--version='));
  
  if (nightlyIndex !== -1) {
    process.env.IS_NIGHTLY = 'true';
  }
  
  if (versionIndex !== -1) {
    const versionArg = args[versionIndex];
    const version = versionArg.includes('=') 
      ? versionArg.split('=')[1] 
      : args[versionIndex + 1];
    if (version) {
      process.env.MANUAL_VERSION = version;
    }
  }
}

function updatePackageJsonVersion(version, packagePath) {
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    packageJson.version = version;
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
    console.error(`Updated version in ${packagePath} to ${version}`);
  } catch (error) {
    console.error(`Error updating ${packagePath}: ${error.message}`);
    process.exit(1);
  }
}

function updateCoreDependencyVersion(version, packagePath) {
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (packageJson.dependencies && packageJson.dependencies['@wct-cli/wct-cli-core']) {
      packageJson.dependencies['@wct-cli/wct-cli-core'] = `^${version}`;
      writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
      console.error(`Updated @wct-cli/wct-cli-core dependency in ${packagePath} to ^${version}`);
    }
  } catch (error) {
    console.error(`Error updating core dependency in ${packagePath}: ${error.message}`);
    process.exit(1);
  }
}

try {
  // Parse command line arguments
  parseArgs();
  
  const versions = getReleaseVersion();
  const { releaseVersion, npmTag } = versions;

  console.error(`Publishing version: ${releaseVersion} with tag: ${npmTag}`);

  // Update package.json files
  updatePackageJsonVersion(releaseVersion, join(rootDir, 'package.json'));
  updatePackageJsonVersion(releaseVersion, join(rootDir, 'packages', 'cli', 'package.json'));
  updatePackageJsonVersion(releaseVersion, join(rootDir, 'packages', 'core', 'package.json'));
  
  // Update @wct-cli/wct-cli-core dependency in cli package.json
  updateCoreDependencyVersion(releaseVersion, join(rootDir, 'packages', 'cli', 'package.json'));

  // Run build after version updates
  console.error('Running build after version updates...');
  execSync('npm run build', { stdio: 'inherit' });
  execSync('npm install', { stdio: 'inherit' });

  // Publish core package
  console.error('Publishing core package...');
  const coreDir = join(rootDir, 'packages', 'core');
  process.chdir(coreDir);
  execSync(`npm publish --tag ${npmTag}`, { stdio: 'inherit' });

  // Publish cli package
  console.error('Publishing cli package...');
  const cliDir = join(rootDir, 'packages', 'cli');
  process.chdir(cliDir);
  execSync(`npm publish --tag ${npmTag}`, { stdio: 'inherit' });

  console.error(`Successfully published ${releaseVersion} to npm with tag ${npmTag}`);
  process.exit(0);
} catch (error) {
  console.error(`Error publishing to npm: ${error.message}`);
  process.exit(1);
}