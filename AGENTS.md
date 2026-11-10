# AE agent entrypoint

Before planning changes, selecting work or editing this repository, read the [canonical AE AI agent standard](https://github.com/Aureate-Empyrean/architecture/blob/main/AI_AGENT_INSTRUCTIONS.md) using existing authorized GitHub access. This is a pointer, not a copied policy.

From any local checkout (no sibling repository path assumed):

```text
gh api -H 'Accept: application/vnd.github.raw+json' 'repos/Aureate-Empyrean/architecture/contents/AI_AGENT_INSTRUCTIONS.md?ref=main'
```

The command prints Markdown. If access fails, stop new execution and report the blocker; never change visibility/permissions to obtain access. Preserve any existing provider-specific or nested instructions.

GitHub Issues across Aureate-Empyrean are canonical. Module issues belong in their application repositories; architecture holds ecosystem/cross-repository/architectural work. Only one autonomous session may select/claim work; other sessions execute explicitly assigned, nonoverlapping tasks. Never take already-assigned/blocked work. Continue only within session authorization and limits. No unauthorized admin changes, merge, deployment, destructive operations, release-history changes or fabricated validation. Read the canonical standard for exact rules, prompt templates and start/stop/handoff procedures.
