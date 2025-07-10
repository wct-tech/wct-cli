#!/bin/bash

# Gemini CLI API Service Setup and Run Script
# This script automates the complete setup, build, and run process

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check Node.js version
check_node_version() {
    if ! command_exists node; then
        print_error "Node.js is not installed. Please install Node.js v18 or higher."
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_error "Node.js version 18 or higher is required. Current version: $(node -v)"
        exit 1
    fi
    
    print_success "Node.js version check passed: $(node -v)"
}

# Function to check npm version
check_npm_version() {
    if ! command_exists npm; then
        print_error "npm is not installed. Please install npm v8 or higher."
        exit 1
    fi
    
    NPM_VERSION=$(npm -v | cut -d'.' -f1)
    if [ "$NPM_VERSION" -lt 8 ]; then
        print_error "npm version 8 or higher is required. Current version: $(npm -v)"
        exit 1
    fi
    
    print_success "npm version check passed: $(npm -v)"
}

# Function to setup parent project
setup_parent_project() {
    print_status "Setting up parent Gemini CLI project..."
    
    if [ ! -d "packages" ]; then
        print_error "This script must be run from the root of the gemini-cli project"
        exit 1
    fi
    
    print_status "Installing parent project dependencies..."
    npm install
    
    print_status "Building parent project..."
    npm run build
    
    print_success "Parent project setup completed"
}

# Function to setup API module
setup_api_module() {
    print_status "Setting up API module..."
    
    if [ ! -d "packages/api" ]; then
        print_error "API module not found in packages/api. Please ensure it's properly copied."
        exit 1
    fi
    
    cd packages/api
    
    print_status "Installing API-specific dependencies..."
    npm install
    
    print_status "Building API module..."
    npm run build
    
    cd ../..
    print_success "API module setup completed"
}

# Function to fix known issues
fix_known_issues() {
    print_status "Running error fixing script..."
    
    if [ -f "packages/api/fix-errors.sh" ]; then
        ./packages/api/fix-errors.sh all
    else
        print_error "Error fixing script not found at packages/api/fix-errors.sh"
        exit 1
    fi
}

# Function to run the API service
run_api_service() {
    print_status "Starting API service..."
    
    cd packages/api
    
    # Check if tsx is available
    if ! command_exists tsx; then
        print_status "Installing tsx for development mode..."
        npm install -g tsx
    fi
    
    print_success "API service starting on port 3000..."
    print_status "Press Ctrl+C to stop the service"
    
    npx tsx apiService.ts
}

# Function to run in production mode
run_production() {
    print_status "Starting API service in production mode..."
    
    cd packages/api
    
    if [ ! -f "dist/apiService.js" ]; then
        print_error "Production build not found. Please run setup first."
        exit 1
    fi
    
    print_success "API service starting on port 3000 (production mode)..."
    print_status "Press Ctrl+C to stop the service"
    
    node dist/apiService.js
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  setup     - Complete setup (install dependencies, build packages)"
    echo "  run       - Run the API service in development mode"
    echo "  run-prod  - Run the API service in production mode"
    echo "  fix       - Fix known issues using separate fix-errors.sh script"
    echo "  all       - Setup and run in development mode"
    echo "  help      - Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 setup     # Setup everything"
    echo "  $0 run       # Run in development mode"
    echo "  $0 all       # Setup and run"
    echo "  $0 fix       # Fix known issues"
    echo ""
    echo "Note: Error fixing is now handled by packages/api/fix-errors.sh"
    echo "      Run './packages/api/fix-errors.sh help' for more options"
}

# Main script logic
main() {
    case "${1:-help}" in
        "setup")
            check_node_version
            check_npm_version
            setup_parent_project
            setup_api_module
            fix_known_issues
            print_success "Setup completed successfully!"
            ;;
        "run")
            check_node_version
            check_npm_version
            run_api_service
            ;;
        "run-prod")
            check_node_version
            check_npm_version
            run_production
            ;;
        "fix")
            fix_known_issues
            ;;
        "all")
            check_node_version
            check_npm_version
            setup_parent_project
            setup_api_module
            fix_known_issues
            run_api_service
            ;;
        "help"|*)
            show_usage
            ;;
    esac
}

# Run main function with all arguments
main "$@" 