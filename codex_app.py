"""Platform-specific Codex desktop process adapter."""
import sys
if sys.platform == "darwin":
    from codex_app_macos import *
else:
    from codex_app_windows import *
