# Claude-created visuals and raster artifacts

Checked 2026-10-06 for the claimed image-workflow decision. Documentation and existing local source only; no inference call, browser execution, installation, authentication change, or artifact-import round trip was performed.

## Answer

**Yes: Claude can author a visual in code, render it with an available tool, and return the resulting image file.** Lack of a native image-generation model does not prevent this workflow. Anthropic explicitly describes HTML/SVG visuals in Claude chat, while its API vision documentation describes image understanding rather than model image generation. That chat feature's documented availability in Claude web/desktop does not establish an identical built-in renderer in a custom Agent SDK client. [Claude visuals](https://support.claude.com/en/articles/9002504-can-claude-produce-images), [API vision](https://platform.claude.com/docs/en/build-with-claude/vision)

The earlier blanket recommendation that a Claude conversation needs a different provider for image outputs was too broad. Another image-generation service is needed for that service's photo/illustration generation capability; code-created diagrams, designed layouts, SVG illustrations, charts, and screenshots can stay in the Claude conversation when suitable rendering tools are available. This is a workflow conclusion, not a claim that Claude produces raster pixels directly through its model.

## Documented rendering paths and conditions

The Agent SDK embeds Claude Code's agent loop with file editing, command execution, permissions, and MCP extension points. Claude can write HTML/SVG or a program that draws an image; an installed renderer or configured browser tool must then produce the raster file. A skill can describe that procedure, but does not itself install the renderer or provide browser capabilities. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [MCP configuration](https://code.claude.com/docs/en/agent-sdk/mcp), [Skills](https://code.claude.com/docs/en/skills)

Anthropic's own Claude Code Chrome integration documents both local-web-app testing and saving screenshots to disk, with the saved image's file path reported afterward. Screenshot file saving works from Claude Code v2.1.211. Its current prerequisites include a compatible Chromium browser, Claude-in-Chrome extension, supported direct Anthropic plan, and interactive `/login`; API-key and long-lived-token sessions keep this integration off. It is therefore a concrete supported example, not a promise that every SDK session already has this integration. Other configured MCP/command renderers are another possible path. [Claude Code with Chrome](https://code.claude.com/docs/en/chrome)

Frameboard must check the tools available in its actual Claude session. T3's collaborative preview tools and ChatGPT's image tool are host capabilities, not automatically built-in Claude Code features. No real rendering path was tested here.

## What a custom chat client can receive

The current official TypeScript reference documents:

- `SDKUserMessage.tool_use_result`: tool-specific structured output, alongside the matched `tool_result`.
- `Read` image output: base64 bytes, MIME type, size, and optional dimensions. This shows image reading, not creation provenance.
- MCP `resource_link` output: `resourceLinks` with URI/name and optional MIME/size, from Agent SDK v0.3.257; background MCP completions use `resource_links`. Results from subagents have documented omissions.
- `Query.readFile(path, {encoding: 'base64'})`: image-file retrieval from v0.2.121, limited to regular files in session working directories and selected session files; permissions and byte caps apply.
- A successful final `SDKResultMessage` has text `result` and optional `structured_output`, rather than a universal list of all images created on disk.

These affordances let an application display returned files; the application still owns importing bytes, durable storage, preview presentation, and adoption. Source was retrieved from the official Markdown reference when the HTML reference exceeded the web reader's size limit. [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Markdown reference](https://code.claude.com/docs/en/agent-sdk/typescript.md)

Hooks can inspect completed tools, and structured output can carry an app-defined artifact manifest. Neither establishes that every arbitrary shell-created file is automatically discovered. [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks), [Structured output](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

## Recommended Frameboard contract

This section is a design recommendation inferred from those contracts, not implemented behavior.

Use one image-artifact pipeline for native generated images, returned tool images, rendered code, and screenshots. Require explicit registration of the intended output file or returned bytes with its card-chat conversation, source turn/tool, MIME type, title, provenance, and exact selected references. Import into application-owned storage before displaying a persistent candidate. Validate file existence, complete bytes, format, and size, and restrict file imports to the card workspace or an explicit trusted artifact location. Do not scan unrelated filesystem images or equate every image `Read` event with new output.

Preserve source HTML/SVG/program files as linked assets when available, with renderer/output metadata. Label code-created imagery **Rendered with Claude** or **Claude · HTML/SVG render**; label a page capture **Screenshot · Claude**. Label image-model results by their actual producing tool/provider/model. The conversation provider may differ from the image-producing service; never describe a Codex/external generation result as native Claude image generation.

Display valid imported outputs as image candidates in card chat. **Add to gallery** performs image adoption; roles are selected afterward in the gallery. Re-rendering, editing code, or image-model editing produces a new candidate/version linked to its source, using only the user's exact selected references. Generation/rendering and candidate import do not assign gallery roles.

The implementation proof remains: produce a raster through the actual Claude session's available tools, register/import the file, display it, add it to the gallery, retain another version, and reopen after restart. This investigation establishes feasibility and transport affordances, not that Frameboard's current adapter already implements them.
