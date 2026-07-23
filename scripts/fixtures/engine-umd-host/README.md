# Engine UMD host fixture

This fixture supplies a minimal browser/kintone host to the Node `vm` smoke.
It records Cursor API calls, global lifecycle listeners, console diagnostics,
and fetch fallback attempts without installing any engine-owned global state.
