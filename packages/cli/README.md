# agentprofile

One profile — skills, credentials, memory — synced to every agent tool.
Run it and your Claude Code, Cursor, and other MCP clients share one brain.

```bash
npx agentprofile            # create a profile + wire up every detected tool
npx agentprofile doctor     # diagnose server, token, and client config
npx agentprofile status     # print your profile (skills + memory)
npx agentprofile skill add ./SKILL.md
```

No signup required — `npx agentprofile` mints an anonymous profile whose token is
both your credential and your claim key.

Point at a self-hosted server with `--server` or `AGENTPROFILE_SERVER`:

```bash
AGENTPROFILE_SERVER=https://agentprofile.you.workers.dev npx agentprofile
```

Full project: https://github.com/USER/agentprofile · [Apache-2.0](../../LICENSE)
