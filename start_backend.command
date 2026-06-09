#!/bin/zsh
cd "$(dirname "$0")"

if [ ! -d "venv" ]; then
    echo "Virtual environment 'venv' not found. Please create it and install dependencies first."
    exit 1
fi

source venv/bin/activate
echo "Starting backend API on http://127.0.0.1:8080 ..."
uvicorn app:app --reload --port 8080
