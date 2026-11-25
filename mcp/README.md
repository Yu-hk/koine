# MCP server

The same engine the DeepSeek Harness plugin uses, exposed over the Model Context Protocol, so any
MCP-capable client can read a service's contract, generate code from it, and gate a new document —
without DeepSeek Harness.

## What it exposes

| Tool | Purpose |
| --- | --- |
| `bridge_discover` | Find candidate API documents in a project or on a running service, ranked with evidence |
| `bridge_extract` | Read a contract from a directory, an exported OpenAPI document, or a live URL, and write `bridge-contract.json` |
| `bridge_generate` | Generate a client or server skeleton: `java-client`, `python-client`, `typescript-client`, `java-server`, `python-server` |
| `bridge_check` | Compare two contracts and grade the drift; `failOn` turns it into a gate |

Contract arguments accept three shapes everywhere: a contract file, a project directory (extracted
first), or an `http(s)` URL of a running service.

## Resources

Contracts are also exposed as MCP resources, so a client can list and read them without an
`bridge_extract` call:

| Method | Returns |
| --- | --- |
| `resources/list` | every `bridge-contract.json` or `*.bridge.json` under the root, as `bridge://contracts/<relative path>` |
| `resources/read` | that file's text, `application/json` |

The root is `BRIDGE_MCP_ROOT` when set, otherwise the server's working directory. **Set it
explicitly** in the client configuration: a server started by an editor rarely runs in the project
directory, and the scan is bounded (depth 4, 200 files) so a wrong root is silently empty rather
than slow.

```json
{
  "mcpServers": {
    "polyglot-bridge": {
      "command": "node",
      "args": ["D:/workspace/polyglot-bridge/mcp/server.mjs"],
      "env": { "BRIDGE_MCP_ROOT": "D:/workspace/my-project" }
    }
  }
}
```

This is what lets an agent answer "what does this service expose?" by reading the resource, instead
of extracting first and asking afterwards.

## Requirements

Node 20 or newer. No dependencies: the server speaks newline-delimited JSON-RPC by itself.

Use an **absolute path** to `mcp/server.mjs` in every configuration below; forward slashes work on
Windows too, and avoid escaping problems in JSON.

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "polyglot-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/polyglot-bridge/mcp/server.mjs"]
    }
  }
}
```

Windows example:

```json
{
  "mcpServers": {
    "polyglot-bridge": {
      "command": "node",
      "args": ["D:/workspace/polyglot-bridge/mcp/server.mjs"]
    }
  }
}
```

Restart the client after editing; the config is read at startup.

## Cursor

`.cursor/mcp.json` in the project, or the global equivalent:

```json
{
  "mcpServers": {
    "polyglot-bridge": {
      "command": "node",
      "args": ["D:/workspace/polyglot-bridge/mcp/server.mjs"]
    }
  }
}
```

## VS Code (MCP support / Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "polyglot-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/workspace/polyglot-bridge/mcp/server.mjs"]
    }
  }
}
```

## Windows: absolute node path

Some clients do not inherit a shell `PATH`, so `node` may not resolve. In that case point at the
interpreter explicitly:

```json
{
  "mcpServers": {
    "polyglot-bridge": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["D:/workspace/polyglot-bridge/mcp/server.mjs"]
    }
  }
}
```

## Verify before blaming the client

Run the bundled check; it spawns the server exactly as a client would and exercises handshake, tool
listing, one real call and an error path:

```sh
node scripts/check-mcp.mjs
```

Expected: six `PASS` lines and `MCP OK`.

To see the raw protocol, send one message by hand:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/server.mjs
```

## Limits

- **Four tools, not five.** `bridge_service` is deliberately absent: it manages a long-running
  Python process with ports and reference counts, which does not belong in a request/response tool.
  Use `bridge_service` from the plugin, or `docker run` the service from `service/Dockerfile`.
- **No MCP resources for live services.** Contracts on disk are resources; a running service's
  document is reachable only through `bridge_extract` with `url`.
- **No sandbox.** The tools read the filesystem and fetch URLs as the server process. Point `outDir`
  at a directory you are willing to have written.
- **Resources are static.** `resources/list` scans the filesystem when asked; a contract created
  after the listing appears only on the next call, and a running service's document is not a
  resource at all (use `bridge_extract` with `url` for that).
