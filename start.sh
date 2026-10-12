#!/bin/bash
# Start everything for the event: FTP receiver, indexer, API.
# Usage:  ./start.sh          (Ctrl+C stops all three)
# Keeps the Mac awake while running (caffeinate), so it won't sleep mid-event.
cd "$(dirname "$0")"
PY=.venv/bin/python
mkdir -p logs

IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1)
echo "event-photos starting on $IP"

$PY ftp_receiver.py >> logs/ftp.out 2>&1 &  FTP=$!
$PY indexer.py      >> logs/indexer.out 2>&1 &  IDX=$!
.venv/bin/uvicorn api:app --host 0.0.0.0 --port 8000 >> logs/api.out 2>&1 &  API=$!

TUN=""
if [ -f tunnel.yml ]; then
  cloudflared tunnel --config tunnel.yml --no-autoupdate run >> logs/tunnel.out 2>&1 &  TUN=$!
fi

caffeinate -dimsu -w $API &

cleanup() {
  echo; echo "stopping ..."
  kill $FTP $IDX $API $TUN 2>/dev/null
  wait 2>/dev/null
  echo "stopped"
}
trap cleanup INT TERM

sleep 5
echo
echo "  Camera FTP : $IP  port 2121  user a7v"
echo "  Guest page : http://$IP:8000"
[ -n "$TUN" ] && echo "  Public     : https://photos.example.com  (API via tunnel: https://api.example.com)"
echo "  Logs       : logs/   (Ctrl+C to stop everything)"
echo

# If any part dies, say so loudly and stop the rest.
while kill -0 $FTP 2>/dev/null && kill -0 $IDX 2>/dev/null && kill -0 $API 2>/dev/null; do
  sleep 5
done
echo "!!! a service stopped unexpectedly - check logs/"
cleanup
