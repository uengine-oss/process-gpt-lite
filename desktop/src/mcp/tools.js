'use strict'
// The Process GPT tools the desktop app gives its person's own CLI in a chat run (design docs/local-agents/design.md §13 — the user's
// request 2026-11-27: 「채팅의 대화로 로컬 에이전트를 선택하여 내 pc 에 있는 스킬중 어떤 스킬을 등록해줘라고 하면 서버에 스킬을 등록한다」
// · 「폴더 등록 또한 채팅으로 시킬 수 있겠지」). The CLI reads these descriptions and decides by itself when a tool fits what the person
// asked — nothing here or in the app reads the person's words.
// What the tools do is the app's (runner/tools.js): they read this computer's files themselves (the model never carries a file's
// content), leave out what a champion folder leaves out, and only PROPOSE — the server shows a confirmation card in the chat and nothing
// is registered or uploaded until the person presses its button.
// One list for the stdio server (mcp/server.js — what the CLI is told) and the runner (what it accepts).

const SERVER_NAME = 'process_gpt_lite'
const VERSION = '0.2.8'

const PATH_HINT = 'An absolute path, a path starting with ~/ (the home folder), or a path relative to your current working folder. ' +
  'Pass the folder itself (or its SKILL.md for a skill). Use exactly what the person named or what a list tool returned.'

const TOOLS = [
  {
    name: 'lite_list_pc_skills',
    description: 'List the agent skills on this computer that could be registered on Process GPT Lite: Claude Code\'s own skills ' +
      '(~/.claude/skills), Codex\'s (~/.codex/skills, ~/.agents/skills) and the current working folder\'s (.claude/skills). Each has a name, ' +
      'its description (from SKILL.md) and its path. Give `under` to look in a folder the person named instead. Read-only: nothing is sent. ' +
      'Use it to find which skill the person means before proposing it with lite_propose_skill.',
    inputSchema: {
      type: 'object',
      properties: { under: { type: 'string', description: `Optional: a folder to look in for skills (its own SKILL.md, or */SKILL.md one level down). ${PATH_HINT}` } },
      additionalProperties: false,
    },
  },
  {
    name: 'lite_list_my_skills',
    description: 'List the skills already on the person\'s Process GPT Lite server that they can use: their own private skills (mine) and ' +
      'the company\'s. Read-only. Use it to see whether a skill with that name is already there before proposing one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lite_propose_skill',
    description: 'Propose registering a skill folder of this computer (a folder with a SKILL.md) as a skill on the person\'s Process GPT Lite ' +
      'server. The desktop app reads the folder itself — do not read, summarise or paste its files. It leaves out secrets, personal settings, ' +
      'links and large files, and shows the person a card 「스킬을 등록할까요?」 (Register this skill?) in this chat: what goes up, what was ' +
      'left out, any run settings (hooks, allowed tools) and where it goes (their own skills, or the company\'s when they may). NOTHING is ' +
      'registered until the person presses 「등록」 (Register) on that card. After calling it, tell the person to check the card and stop — ' +
      'do not call it again for the same skill, and do not try to register it any other way.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `The skill's folder. ${PATH_HINT}` },
        name: { type: 'string', description: 'Optional: the name to register it under, when the person gave one (default: the name in its SKILL.md, else the folder\'s name).' },
        scope: { type: 'string', enum: ['mine', 'company'], description: 'Where the person wants it: "mine" (only them — the default) or "company" (everyone in the company; the card offers it only to people who may). The person still chooses on the card.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'lite_list_my_folders',
    description: 'List the shared folders on the person\'s Process GPT Lite server that they are a member of (name, their role, the agent assets ' +
      'found in each). Read-only. Use it to say what is already there before proposing a folder.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lite_propose_folder',
    description: 'Propose uploading a folder of this computer to the person\'s Process GPT Lite server as a shared folder — the same as 「내 PC ' +
      '폴더 올리기」 (Upload a folder from my PC) in the app. The desktop app reads the folder itself — do not read or list its files for this. ' +
      'It leaves out secrets, personal settings, large files, links and git control files, finds the agent assets in it (skills, commands, ' +
      'instructions), and shows the person a card 「폴더를 올릴까요?」 (Upload this folder?) in this chat with that preview. NOTHING is ' +
      'uploaded until the person presses 「올리기」 (Upload) on that card. After calling it, tell the person to check the card and stop — do ' +
      'not call it again for the same folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `The folder to upload. ${PATH_HINT}` },
        name: { type: 'string', description: 'Optional: the shared folder\'s name, when the person gave one (default: the folder\'s own name). The person can change it on the card.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
]
const NAMES = TOOLS.map((t) => t.name)
// Claude Code's name for a tool of this server (its permission rules): mcp__<server>__<tool>
const claudeName = (tool) => `mcp__${SERVER_NAME}__${tool}`

module.exports = { SERVER_NAME, VERSION, TOOLS, NAMES, claudeName }
