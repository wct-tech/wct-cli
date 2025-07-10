# Gemini CLI API Service 

This repository provides an OpenAI-compatible API service for Gemini CLI. It is designed to be integrated into the parent Gemini CLI project.

## Prerequisites

- Node.js v18 or higher (recommended: v20+)
- npm v8 or higher

## Quick Start with Automation Script

For the fastest setup, use the included automation script:

```bash
# Make the scripts executable (first time only)
chmod +x packages/api/setup-and-run.sh
chmod +x packages/api/fix-errors.sh

# Complete setup and run
./packages/api/setup-and-run.sh all

# Or run individual steps:
./packages/api/setup-and-run.sh setup  # Setup only
./packages/api/setup-and-run.sh run    # Run in development mode
./packages/api/setup-and-run.sh run-prod # Run in production mode
./packages/api/setup-and-run.sh fix    # Fix known issues using separate script

# Or use the dedicated error fixing script directly:
./packages/api/fix-errors.sh all       # Fix all known issues
./packages/api/fix-errors.sh telemetry # Fix only TelemetryEvent issue
```

## Complete Installation Process (TLDR; For AI only)

This section outlines the complete process from cloning the repository to running the API service.

### Step 1: Clone and Setup Parent Project

```bash
# Clone the main Gemini CLI repository
git clone https://github.com/google-gemini/gemini-cli.git
cd gemini-cli

# Install dependencies
npm install

# Build the entire project
npm run build
```

### Step 2: Fix Known Issues and Rebuild

```bash
# Fix known issues (like TelemetryEvent export problem)
./packages/api/fix-errors.sh all

# Rebuild the project after fixes
npm run build
```

### Step 3: Setup API Module

```bash
# Copy API module to the parent project (if not already present)
# Note: If you're working with the integrated repository, this step may be skipped

# Navigate to the API package
cd packages/api

# Install API-specific dependencies
npm install

# Build the API service
npm run build
```

### Step 4: Run the API Service

```bash
# Development mode (with hot-reload)
npx tsx apiService.ts

# Or production mode
node dist/apiService.js
```

## Manual Installation and Setup (Alternative)

### Step 1: Copy API Module to Parent Project

```bash
# From the parent project root
mkdir -p packages/api

# Copy this API module to the packages/api directory
cp -r /path/to/your/gemini-cli-api/* packages/api/

# Navigate to the API package
cd packages/api

# Install API-specific dependencies
npm install
```

### Step 2: Build and Run the Integrated API

```bash
# Build the API service
npm run build

# Run the service
npx tsx apiService.ts
```

## Building the API Service

### Integrated Build (within parent project)
```bash
# From the parent project root
npm run build:packages

# Or specifically for the API package
cd packages/api
npm run build
```

This will:
- Compile TypeScript files to JavaScript in the `dist/` directory
- The main entry point becomes `dist/apiService.js`

## Running the API Service

### Development (TypeScript, hot-reload)

```bash
npx tsx apiService.ts
```

### Production (Compiled JavaScript)

```bash
node dist/apiService.js
```

The service will start on port 3000 by default.

## Configuration

### Environment Variables

You can configure the service using the following environment variables:

- `PORT` - The port to run the service on (default: 3000)
- `GEMINI_API_KEY` - Your Gemini API key for authentication

### Authentication

On first run, the service may prompt you to authenticate with Google in your browser. Alternatively, you can set the `GEMINI_API_KEY` environment variable with your API key.

## API Endpoints

- `POST /v1/chat/completions` — OpenAI-compatible chat completions endpoint
- `GET /v1/chat/sessions` — List active chat sessions
- `DELETE /v1/chat/sessions/:sessionId` — Clear a chat session

## Testing the API

### Web Client Interface

A web-based test client is included to easily test the API functionality:

1. **Start the API service** (see Running the API Service section above)
2. **Open the test client** in your browser:
   ```bash
   # Open the HTML file directly in your browser
   open packages/api/client-test.html
   
   # Or serve it with a simple HTTP server
   cd packages/api
   python3 -m http.server 8080
   # Then visit http://localhost:8080/client-test.html
   ```

3. **Configure the client**:
   - Set the **Base URL** to `http://localhost:3000` (or your custom port)
   - Optionally set a **Session ID** for conversation continuity
   - Click **New Session** to start a fresh conversation

4. **Test features**:
   - Send messages and see streaming responses
   - View thought processes and tool calls in real-time
   - Test session management
   - Use Ctrl+Enter to send messages quickly
   - Resizable interface with drag-and-drop panel sizing
   - Markdown rendering for responses
   - Local storage for session persistence
   - Mobile-responsive design

### Client Features

The web client includes several advanced features:

- **Streaming Responses**: Real-time display of AI responses as they're generated
- **Thought Process Visualization**: See the AI's reasoning process with highlighted thought bubbles
- **Tool Call Display**: View tool execution requests in a formatted code block
- **Session Management**: Maintain conversation context across multiple interactions
- **Responsive Design**: Works on desktop and mobile devices
- **Keyboard Shortcuts**: Ctrl+Enter to send messages quickly
- **Auto-resizing**: Text area automatically adjusts to content
- **Persistent Settings**: Base URL and session ID are saved in browser storage

### API Testing with curl

You can also test the API directly using curl:

```bash
# Basic chat completion
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello, how are you?"}],
    "stream": false
  }'

# Streaming chat completion
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'

# With session management
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "What did we talk about before?"}],
    "session_id": "my-session-123",
    "stream": false
  }'

### Troubleshooting the Test Client

**Common Issues:**

1. **"Streaming not supported" error**: 
   - Ensure you're using a modern browser that supports ReadableStream
   - Try Chrome, Firefox, or Safari (latest versions)

2. **Connection refused errors**:
   - Verify the API service is running on the correct port
   - Check that the Base URL is set to `http://localhost:3000` (or your custom port)
   - Ensure no firewall is blocking the connection

3. **CORS errors**:
   - The API service should handle CORS automatically
   - If issues persist, try serving the HTML file through a local HTTP server

4. **Authentication issues**:
   - Make sure you've authenticated with Google (see Authentication section above)
   - Check that your `GEMINI_API_KEY` environment variable is set correctly

5. **Responses not appearing**:
   - Check the browser's developer console for JavaScript errors
   - Verify the API service logs for any backend errors

## Development

### Project Structure (Integrated)
```
gemini-cli/
├── packages/
│   ├── api/               # This API service
│   ├── core/              # Core Gemini CLI functionality
│   └── cli/               # CLI interface
├── bundle/                # Bundled CLI
└── ...
```

### Available Scripts

- `npm run build` - Build the TypeScript source to JavaScript
- `npm run start` - Start the service using Node.js
- `npm run dev` - Start the service in development mode with ts-node

## Complete Development Workflow

```bash
# 1. Clone and setup parent project
git clone https://github.com/google-gemini/gemini-cli.git
cd gemini-cli
npm install
npm run build

# 2. Copy and setup API module
cp -r /path/to/gemini-cli-api packages/api/
cd packages/api
npm install

# 3. Fix known issues and rebuild
./packages/api/fix-errors.sh all
cd packages/api
npm run build

# 4. Development cycle
npx tsx apiService.ts

# 5. If you modify core dependencies, rebuild parent
cd ../..
npm run build
cd packages/api
npm run build
```

## Troubleshooting

### Common Issues and Solutions

#### 1. TelemetryEvent Export Error
**Error**: `SyntaxError: The requested module './types.js' does not provide an export named 'TelemetryEvent'`

**Solution**: This is a known issue with type-only exports. The automation scripts will fix this automatically, or you can fix it manually:

```bash
# Use the dedicated error fixing script (recommended)
./packages/api/fix-errors.sh telemetry

# Or fix manually:
# Remove TelemetryEvent from the export list in core telemetry
sed -i '/TelemetryEvent,/d' packages/core/src/telemetry/index.ts

# Clean and rebuild both packages
cd packages/core && rm -rf dist && npm run build && cd ../..
cd packages/api && rm -rf dist && npm run build && cd ../..
```

#### 2. Integration Issues
- If you see errors about missing `@google/gemini-cli-core` dependencies, ensure the parent project is properly built first.
- If you encounter build errors, try rebuilding the parent project: `cd ../.. && npm run build`
- Make sure the API module is properly copied to `packages/api/` directory.

#### 3. Dependency Issues
- If you see errors about missing type declarations for `express` or `cors`, ensure you have run `npm install`.
- If you encounter authentication issues, make sure you have a valid Gemini API key set in the `GEMINI_API_KEY` environment variable.

#### 4. Port Issues
- Check that port 3000 (or your configured port) is available and not being used by another service.

#### 5. Clean Build Issues
If you encounter strange errors after making changes, try a clean build:

```bash
# Clean and rebuild core package
cd packages/core
rm -rf dist
npm run build
cd ../..

# Clean and rebuild API package
cd packages/api
rm -rf dist
npm run build
cd ../..
```

### Build Order Importance
When making changes to core packages, always rebuild in this order:
1. Core package (`packages/core`)
2. API package (`packages/api`)

This ensures all dependencies are properly updated.

### Type-Only Exports
Remember that TypeScript type-only exports (`export type`) are erased at runtime and cannot be imported as runtime values. If you encounter import errors for types, ensure they are only imported using `import type { ... }`.

## Automation Scripts

The project includes two automation scripts to streamline the setup and error fixing process:

### setup-and-run.sh
The main automation script that handles the entire setup and run process:

**Features:**
- **Version checking**: Validates Node.js and npm versions
- **Automatic setup**: Installs dependencies and builds packages
- **Issue fixing**: Calls the separate error fixing script
- **Multiple modes**: Development and production run modes
- **Error handling**: Comprehensive error checking and reporting

**Usage:**
```bash
# Complete automation (setup + run)
./packages/api/setup-and-run.sh all

# Individual operations
./packages/api/setup-and-run.sh setup     # Setup only
./packages/api/setup-and-run.sh run       # Run in development mode
./packages/api/setup-and-run.sh run-prod  # Run in production mode
./packages/api/setup-and-run.sh fix       # Fix known issues using separate script
./packages/api/setup-and-run.sh help      # Show help
```

### fix-errors.sh
A dedicated script for handling known issues and errors:

**Features:**
- **Modular error fixing**: Separate functions for different types of issues
- **Extensible design**: Easy to add new error fixes
- **Targeted fixes**: Can fix specific issues or all issues
- **Comprehensive logging**: Detailed output for each fix

**Usage:**
```bash
# Fix all known issues
./packages/api/fix-errors.sh all

# Fix specific issues
./packages/api/fix-errors.sh telemetry  # Fix only TelemetryEvent export issue

# Get help
./packages/api/fix-errors.sh help
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[Apache-2.0](LICENSE) 