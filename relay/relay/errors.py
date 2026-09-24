"""The one error type the service raises; the app turns it into ``{"error", "detail"}``."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, code: str, detail: str | None = None) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.detail = detail

    def body(self) -> dict[str, str]:
        if self.detail is None:
            return {"error": self.code}
        return {"error": self.code, "detail": self.detail}


class ConfigError(Exception):
    """A startup error: the relay refuses to start."""


def not_found() -> ApiError:
    # Deliberately no detail: a 404 never says which part did not exist.
    return ApiError(404, "not_found")
