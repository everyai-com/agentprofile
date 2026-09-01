# agentprofile

One profile — skills, credentials, memory — synced to every agent tool.
Run it and your Claude Code, Cursor, and other MCP clients share one brain.

```bash
npx @magicteams_ai/agentprofile            # create a profile + wire up every detected tool
npx @magicteams_ai/agentprofile doctor     # diagnose server, token, and client config
npx @magicteams_ai/agentprofile status     # print your profile (skills + memory)
npx @magicteams_ai/agentprofile skill add ./SKILL.md
```

No signup required — `npx @magicteams_ai/agentprofile` mints an anonymous profile whose token is
both your credential and your claim key.

Point at a self-hosted server with `--server` or `AGENTPROFILE_SERVER`:

```bash
AGENTPROFILE_SERVER=https://agentprofile.you.workers.dev npx @magicteams_ai/agentprofile
```

Full project: https://github.com/everyai-com/agentprofile · [Apache-2.0](../../LICENSE)
