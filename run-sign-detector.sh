#!/bin/bash

# Parking Sign Detection App - Unified Run Script
# This script starts both backend and frontend services

set -e

echo "🚦 Starting Parking Sign Detection App..."
echo "========================================"

# Check if we're in the right directory
if [ ! -d "sign-detector" ]; then
    echo "❌ Error: sign-detector directory not found!"
    echo "Please run this script from the project root directory."
    exit 1
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check for required dependencies
echo "📋 Checking dependencies..."

if ! command_exists python3; then
    echo "❌ Python 3 is not installed. Please install Python 3.8+ first."
    exit 1
fi

# Check for uv
if command_exists uv; then
    PKG_MANAGER_PY="uv"
    echo "✅ Using uv for Python packages"
else
    # Check if virtual environment exists, if not create it
    if [ ! -d "venv" ]; then
        echo "📦 Creating Python virtual environment..."
        python3 -m venv venv
    fi

    # Activate virtual environment
    echo "🔧 Activating virtual environment..."
    source venv/bin/activate
    PKG_MANAGER_PY="pip"
    echo "✅ Using pip for Python packages"
fi

# Check if we need to install dependencies
cd sign-detector/backend
if [ "$PKG_MANAGER_PY" = "uv" ]; then
    # Set up uv environment
    if [ ! -d ".venv" ]; then
        echo "📦 Creating uv virtual environment..."
        uv venv
    fi
    source .venv/bin/activate

    # Check if uvicorn is installed
    if ! command_exists uvicorn; then
        echo "⚠️  uvicorn not found. Installing backend dependencies (CPU-only version)..."
        # Install CPU-only PyTorch first
        uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
        # Install other dependencies
        uv pip install -r requirements-cpu.txt
    fi
else
    # Use traditional pip
    if [ ! -d "../venv" ]; then
        echo "📦 Creating Python virtual environment..."
        cd ..
        python3 -m venv venv
        cd sign-detector/backend
    fi
    source ../venv/bin/activate

    # Check if uvicorn is installed
    if ! command_exists uvicorn; then
        echo "⚠️  uvicorn not found. Installing backend dependencies (CPU-only version)..."
        pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
        pip install -r requirements-cpu.txt
    fi
fi
cd ../..

if command_exists bun; then
    PKG_MANAGER="bun"
    INSTALL_CMD="bun install"
    RUN_CMD="bun dev"
elif command_exists npm; then
    PKG_MANAGER="npm"
    INSTALL_CMD="npm install"
    RUN_CMD="npm run dev"
else
    echo "❌ Neither bun nor npm found. Please install Node.js or Bun first."
    exit 1
fi

echo "✅ Using $PKG_MANAGER for frontend"

# Install frontend dependencies if needed
if [ ! -d "sign-detector/frontend/node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    cd sign-detector/frontend
    $INSTALL_CMD
    cd ../..
fi

# Create logs directory
mkdir -p logs

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping services..."

    # Kill background processes
    if [ ! -z "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null
        echo "✅ Backend stopped"
    fi

    if [ ! -z "$FRONTEND_PID" ]; then
        kill $FRONTEND_PID 2>/dev/null
        echo "✅ Frontend stopped"
    fi

    echo "👋 Goodbye!"
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Start backend
echo "🔧 Starting backend server..."
cd sign-detector/backend
if [ "$PKG_MANAGER_PY" = "uv" ]; then
    # Use uv's virtual environment
    source .venv/bin/activate
    uvicorn main:app --reload --port 8000 > ../../logs/backend.log 2>&1 &
else
    # Use traditional venv
    source ../venv/bin/activate
    uvicorn main:app --reload --port 8000 > ../../logs/backend.log 2>&1 &
fi
BACKEND_PID=$!
cd ../..

# Wait for backend to start
echo "⏳ Waiting for backend to start..."
sleep 3

# Check if backend is running
if curl -s http://localhost:8000/ > /dev/null; then
    echo "✅ Backend is running at http://localhost:8000"
else
    echo "❌ Backend failed to start. Check logs/backend.log for details."
    cleanup
fi

# Start frontend
echo "🎨 Starting frontend server..."
cd sign-detector/frontend
$RUN_CMD > ../../logs/frontend.log 2>&1 &
FRONTEND_PID=$!
cd ../..

# Wait for frontend to start
echo "⏳ Waiting for frontend to start..."
sleep 5

# Check if frontend is running
if curl -s http://localhost:3000/ > /dev/null; then
    echo "✅ Frontend is running at http://localhost:3000"
else
    echo "⚠️  Frontend may still be starting..."
fi

echo ""
echo "🎉 Parking Sign Detection App is ready!"
echo "========================================"
echo "📸 Frontend: http://localhost:3000"
echo "🔧 Backend API: http://localhost:8000"
echo "📚 API Docs: http://localhost:8000/docs"
echo ""
echo "📝 Logs are being written to the logs/ directory"
echo "Press Ctrl+C to stop both services"
echo ""

# Keep script running
while true; do
    sleep 1
done