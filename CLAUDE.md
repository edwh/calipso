# Calipso Project

## Chrome DevTools MCP - Launching Chrome with Remote Debugging (WSL2)

Chrome must be launched with `--remote-debugging-port=9222` AND a non-default `--user-data-dir` for debugging to work.

```bash
# Kill existing Chrome first
pkill -9 -f chrome; sleep 2

# Launch with debugging enabled and extension pre-loaded (WSL2 requires display env vars)
DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 \
  nohup google-chrome --remote-debugging-port=9222 --no-first-run \
  --user-data-dir=/home/edward/.config/google-chrome-debug \
  --load-extension=/home/edward/calipso/Chrome/unified-calendar \
  > /home/edward/chrome-debug.log 2>&1 &

# Verify (wait a few seconds first)
sleep 6 && curl -s http://localhost:9222/json/version
```

Key gotchas:
- **Must use `--user-data-dir`**: Chrome refuses remote debugging with the default profile. Use `/home/edward/.config/google-chrome-debug`.
- **This is a separate profile**: Extensions, logins, etc. from the main profile won't be present. You'll need to load extensions manually.
- **After launching Chrome**, run `/mcp` in Claude Code to reconnect the MCP server.
- **WSL2 display vars**: `DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000` are required.
- **`--load-extension`**: Pre-loads the extension so you don't need to use the file picker (which can't be automated via MCP). Points to the project root which has a `manifest.json` referencing `dist/` files.
- **File picker workaround**: `chrome.developerPrivate.loadUnpacked()` always opens a file picker that can't be automated. Use `--load-extension` flag instead.

## WebGPU / WebLLM in WSL2

- WebGPU requires `--enable-unsafe-webgpu --enable-features=Vulkan,UseSkiaRenderer` Chrome flags
- Even with flags, WSL2 GPU drivers may not support all shader operations WebLLM needs
- Error: `Invalid ShaderModule` during compute shader compilation = GPU driver limitation
- LLM integration works correctly (downloads model, compiles shaders) but WSL2 GPU is insufficient
- To test LLM fully, use native Chrome on Windows/Linux with a real GPU

## Unified Calendar Extension

- Source: `Chrome/unified-calendar/src/`
- Build output: `Chrome/unified-calendar/dist/`
- Build: `cd Chrome/unified-calendar && npm run build`
- Root `manifest.json` references `dist/` files so Chrome can load from the project root
