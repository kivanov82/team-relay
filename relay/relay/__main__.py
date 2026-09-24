"""``python -m relay``: serve ``relay.app:app`` on $PORT (default 8080).

Binds 127.0.0.1 unless RELAY_HOST says otherwise; the container image sets RELAY_HOST=0.0.0.0
because Cloud Run (and a published Docker port) needs it.
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("RELAY_HOST", "127.0.0.1")
    uvicorn.run(
        "relay.app:app",
        host=host,
        port=port,
        server_header=False,
        date_header=True,
        # Long polls hold a request for up to 25 s; keep-alive beyond that is not needed.
        timeout_keep_alive=30,
        log_level=os.environ.get("RELAY_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
