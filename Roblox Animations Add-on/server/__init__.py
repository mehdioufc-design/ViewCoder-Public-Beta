"""
Server module for the Roblox Animations Blender Addon.

This module handles the HTTP server for live sync with Roblox Studio.
"""

from .server import (
    start_server,
    stop_server,
    is_server_running,
    get_server_status,
    handle_blend_file_loaded,
)
from .handler import (
    AnimationHandler,
)
from .requests import (
    process_pending_requests,
    execute_list_armatures,
    execute_in_main_thread,
)


def load_handler(dummy):
    """Handler for addon loading"""
    handle_blend_file_loaded(dummy)


__all__ = [
    # Server
    "start_server",
    "stop_server",
    "is_server_running",
    "get_server_status",
    "handle_blend_file_loaded",
    # Handler
    "AnimationHandler",
    # Requests
    "process_pending_requests",
    "execute_list_armatures",
    "execute_in_main_thread",
    # Load handler
    "load_handler",
]
