"""FTP receiver for the Sony A7V: files the camera sends land in ./inbox.

Stage 1 test tool. Logs every login, upload start and finished file so we
can see exactly what the camera does.

Run:  .venv/bin/python ftp_receiver.py
Camera settings: server = this Mac's IP, port 2121, user "a7v", password below,
passive mode ON, secure protocol (FTPS) OFF.
"""
import logging
import os
import socket
import time
from pathlib import Path

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

BASE = Path(__file__).resolve().parent
INBOX = BASE / "inbox"
PORT = int(os.environ.get("FTP_PORT", "2121"))
USER = os.environ.get("FTP_USER", "a7v")
PASSWORD = os.environ.get("FTP_PASSWORD", "")
PASSIVE_PORTS = range(60000, 60100)


def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


class CameraHandler(FTPHandler):
    def on_connect(self):
        logging.info("connect from %s:%s", self.remote_ip, self.remote_port)

    def on_login(self, username):
        logging.info("login OK user=%s from %s", username, self.remote_ip)

    def on_login_failed(self, username, password):
        logging.warning("login FAILED user=%s from %s", username, self.remote_ip)

    def on_file_received(self, file):
        size = os.path.getsize(file)
        logging.info("RECEIVED %s (%.1f MB)", os.path.relpath(file, BASE), size / 1e6)

    def on_incomplete_file_received(self, file):
        logging.warning("INCOMPLETE %s - removing", file)
        try:
            os.remove(file)
        except OSError:
            pass

    def on_disconnect(self):
        logging.info("disconnect %s", self.remote_ip)


def main():
    INBOX.mkdir(exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(), logging.FileHandler(BASE / "ftp_receiver.log")],
    )
    # pyftpdlib's own per-command log is useful while testing the camera.
    logging.getLogger("pyftpdlib").setLevel(logging.INFO)

    auth = DummyAuthorizer()
    # e=change dir, l=list, r=read, a=append, d=delete, f=rename, m=mkdir, w=write
    auth.add_user(USER, PASSWORD, str(INBOX), perm="elradfmw")

    handler = CameraHandler
    handler.authorizer = auth
    handler.passive_ports = PASSIVE_PORTS
    handler.banner = "event-photos receiver ready"

    ip = local_ip()
    server = FTPServer(("0.0.0.0", PORT), handler)
    logging.info("FTP server on %s:%d  user=%s  inbox=%s", ip, PORT, USER, INBOX)
    server.serve_forever()


if __name__ == "__main__":
    main()
