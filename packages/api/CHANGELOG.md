# Changelog

## [0.1.1] - 2024-07-05

### Fixed
- **Critical Runtime Error**: Fixed `TelemetryEvent` export issue in `packages/core/src/telemetry/index.ts`
  - Problem: TypeScript type-only export was being treated as a runtime export
  - Error: `SyntaxError: The requested module './types.js' does not provide an export named 'TelemetryEvent'`
  - Solution: Removed `TelemetryEvent` from runtime export list in `index.ts`
  - Impact: API service now starts successfully without runtime errors

### Added
- **Automation Script**: Created `setup-and-run.sh` for automated setup and deployment
  - Version checking for Node.js and npm
  - Automatic dependency installation and build process
  - Known issue fixing (including TelemetryEvent export problem)
  - Multiple run modes (development and production)
  - Comprehensive error handling and colored output
  - Usage: `./packages/api/setup-and-run.sh [setup|run|run-prod|fix|all|help]`

### Enhanced
- **README.md**: Significantly improved documentation
  - Added Quick Start section with automation script
  - Comprehensive troubleshooting section with common issues and solutions
  - Detailed explanation of the TelemetryEvent export fix
  - Build order importance and clean build instructions
  - Type-only exports explanation
  - Automation script documentation and usage examples

### Technical Details
- **Build Process**: Verified complete integration with parent gemini-cli project
- **Dependencies**: Confirmed all dependencies install and build correctly
- **Runtime**: API service successfully starts and responds to requests
- **TypeScript**: Fixed type-only export runtime import issues

### Files Modified
- `packages/core/src/telemetry/index.ts` - Removed TelemetryEvent from export list
- `packages/api/README.md` - Enhanced with troubleshooting and automation
- `packages/api/setup-and-run.sh` - New automation script (executable)
- `packages/api/CHANGELOG.md` - This changelog file

### Testing
- ✅ Successfully cloned gemini-cli repository
- ✅ Copied API module to packages/api
- ✅ Installed all dependencies
- ✅ Built entire project and individual packages
- ✅ Fixed TelemetryEvent export issue
- ✅ Started API service successfully
- ✅ Verified API responds to requests
- ✅ Created and tested automation script

## [0.1.0] - Initial Release

### Added
- OpenAI-compatible API service for Gemini CLI
- Integration with parent gemini-cli project
- Basic chat completions endpoint
- Session management
- TypeScript support
- Development and production build configurations 