"""Exceptions raised by the Healine MCP client.

Typed errors let callers handle API failures without matching error messages.
"""


class HealineError(Exception):
    """Base exception for MCP client errors talking to the Healine API."""


class AuthenticationError(HealineError):
    """Raised when the API key is rejected (HTTP 401)."""


class NotFoundError(HealineError):
    """Raised when a requested resource does not exist (HTTP 404)."""


class ConfigurationError(HealineError):
    """Raised when the client is not configured (e.g. missing API key)."""
