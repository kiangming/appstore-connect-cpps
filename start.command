#!/bin/bash
# CPP Manager — macOS launcher
# Double-click file này để khởi động app

cd "$(dirname "$0")"

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo ""
  echo "❌  Node.js chưa được cài đặt."
  echo "    Tải tại: https://nodejs.org (chọn LTS)"
  echo ""
  read -p "Nhấn Enter để thoát..."
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  echo ""
  echo "❌  Node.js version quá cũ (hiện tại: v$(node -v | tr -d v), cần v18+)."
  echo "    Tải phiên bản mới tại: https://nodejs.org"
  echo ""
  read -p "Nhấn Enter để thoát..."
  exit 1
fi

# ── Check .env.local ──────────────────────────────────────────────────────────
if [ ! -f ".env.local" ]; then
  echo ""
  echo "⚠️   Chưa có file .env.local"
  echo "    1. Copy file .env.example thành .env.local"
  echo "    2. Điền đầy đủ thông tin (ASC credentials, Supabase, NextAuth...)"
  echo "    3. Chạy lại file này"
  echo ""
  read -p "Nhấn Enter để thoát..."
  exit 1
fi

# ── Start server ──────────────────────────────────────────────────────────────
PORT=${PORT:-3000}

echo ""
echo "🚀  Đang khởi động CPP Manager trên cổng $PORT..."
echo ""

# Chạy server trong background
# load-env.cjs parse .env.local trước rồi mới start server.js
# (tránh lỗi bash source và Node --env-file với JSON multi-line values)
PORT=$PORT node load-env.cjs &
SERVER_PID=$!

# Đợi server sẵn sàng (tối đa 10 giây)
for i in {1..10}; do
  sleep 1
  if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
    break
  fi
done

# Mở browser
open "http://localhost:$PORT"

echo "✅  CPP Manager đang chạy tại http://localhost:$PORT"
echo ""
echo "    Nhấn Ctrl+C để tắt app"
echo ""

# Giữ script chạy, catch Ctrl+C để kill server
trap "echo ''; echo '👋  Đang tắt...'; kill $SERVER_PID 2>/dev/null; exit 0" SIGINT SIGTERM
wait $SERVER_PID
