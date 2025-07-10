#!/bin/bash

# Gemini CLI API Service Error Fixing Script
# This script handles known issues and fixes them automatically

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

# Function to check if we're in the right directory
check_project_root() {
    if [ ! -d "packages" ]; then
        print_error "This script must be run from the root of the gemini-cli project"
        exit 1
    fi
}

# Function to fix TelemetryEvent export issue
fix_telemetry_event_export() {
    print_status "Checking for TelemetryEvent export issue..."
    
    if grep -q "TelemetryEvent" packages/core/src/telemetry/index.ts; then
        print_warning "Found TelemetryEvent export issue, fixing..."
        
        # Remove TelemetryEvent from export list
        sed -i '/TelemetryEvent,/d' packages/core/src/telemetry/index.ts
        
        print_status "Rebuilding core package..."
        cd packages/core
        rm -rf dist
        npm run build
        cd ../..
        
        print_status "Rebuilding API package..."
        cd packages/api
        rm -rf dist
        npm run build
        cd ../..
        
        print_success "TelemetryEvent export issue fixed"
        return 0
    else
        print_success "No TelemetryEvent export issue found"
        return 1
    fi
}

# Function to fix other known issues (placeholder for future issues)
fix_other_issues() {
    print_status "Checking for other known issues..."
    
    # Add more issue fixes here as they are discovered
    # Example:
    # if [ -f "some_problematic_file" ]; then
    #     print_warning "Found some issue, fixing..."
    #     # Fix logic here
    #     print_success "Some issue fixed"
    #     return 0
    # fi
    
    print_success "No other known issues found"
    return 1
}

# Main function to fix all known issues
fix_all_known_issues() {
    print_status "Starting error fixing process..."
    
    check_project_root
    
    issues_fixed=0
    
    # Fix TelemetryEvent export issue
    if fix_telemetry_event_export; then
        ((issues_fixed++))
    fi
    
    # Fix other known issues
    if fix_other_issues; then
        ((issues_fixed++))
    fi
    
    if [ $issues_fixed -eq 0 ]; then
        print_success "No issues were found that needed fixing"
    else
        print_success "Fixed $issues_fixed issue(s)"
    fi
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  all       - Fix all known issues (default)"
    echo "  telemetry - Fix only TelemetryEvent export issue"
    echo "  help      - Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0         # Fix all known issues"
    echo "  $0 all     # Fix all known issues"
    echo "  $0 telemetry # Fix only TelemetryEvent issue"
}

# Main script logic
main() {
    case "${1:-all}" in
        "all")
            fix_all_known_issues
            ;;
        "telemetry")
            check_project_root
            fix_telemetry_event_export
            ;;
        "help"|*)
            show_usage
            ;;
    esac
}

# Run main function with all arguments
main "$@" 