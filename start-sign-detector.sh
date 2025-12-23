#!/bin/bash

echo "🚦 Starting Parking Sign Detection App..."
echo "========================================"

# Create and activate virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

source venv/bin/activate

# Install backend dependencies
cd sign-detector/backend
pip install -q fastapi uvicorn python-multipart httpx pillow ultralytics torch --index-url https://download.pytorch.org/whl/cpu

# Start backend
echo "🔧 Starting backend on port 8000..."
uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

cd ../frontend

# Install frontend dependencies
echo "📦 Installing frontend dependencies..."
bun install > /dev/null 2>&1

# Start frontend
echo "🎨 Starting frontend on port 3000..."
bun dev &
FRONTEND_PID=$!

cd ../..

# Wait a bit
sleep 5

echo ""
echo "🎉 Parking Sign Detection App is ready!"
echo "========================================"
echo "📸 Frontend: http://localhost:3000"
echo "🔧 Backend API: http://localhost:8000"
echo ""
echo "Press Ctrl+C to stop both services"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping services..."
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    echo "✅ Services stopped"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for user to stop
while true; do
    sleep 1
done