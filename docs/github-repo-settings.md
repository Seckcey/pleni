# GitHub repository settings

How the Pleni repository should look and be set up on GitHub. Editing this file does not change
any setting; a maintainer applies them by hand (or with the `gh` commands below) and checks the
result on GitHub.

## About

Description (under 350 characters):

```text
Watch your Claude Code and Codex sessions, their sub-agents, and the hand-offs between them, live in your browser. Read-only, local-first, zero dependencies. Pleni is the simple browser edition of Plenipo, by 8 West Ventures, LLC.
```

Website: <https://getplenipo.com>

Topics (20, GitHub's limit):

```text
plenipo claude-code codex ai-agents multi-agent agent-orchestration local-first developer-tools dashboard observability nodejs zero-dependencies browser monitoring sub-agents openai-codex anthropic llm-tools agent-monitoring productivity
```

Topics should describe what Pleni really is and does. They help people find related
repositories; they do not promise any ranking. See
[GitHub's topic guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).

To apply the About section from a terminal:

```sh
gh repo edit Seckcey/pleni \
  --description "Watch your Claude Code and Codex sessions, their sub-agents, and the hand-offs between them, live in your browser. Read-only, local-first, zero dependencies. Pleni is the simple browser edition of Plenipo, by 8 West Ventures, LLC." \
  --homepage "https://getplenipo.com" \
  --add-topic plenipo,claude-code,codex,ai-agents,multi-agent,agent-orchestration,local-first,developer-tools,dashboard,observability \
  --add-topic nodejs,zero-dependencies,browser,monitoring,sub-agents,openai-codex,anthropic,llm-tools,agent-monitoring,productivity
```

## Features

- **Issues:** on. The issue forms are in `.github/ISSUE_TEMPLATE/`; blank issues are off.
- **Discussions:** on. The README, the issue forms, and SUPPORT.md send questions and ideas there.
- **Wiki:** off. Keep all documentation in the repository, so it is reviewed like code.
- **Private vulnerability reporting:** on (**Settings → Security → Private vulnerability
  reporting**). [SECURITY.md](../SECURITY.md) depends on it.
- **Reported content:** on, sent to the maintainers (**Settings → Moderation options → Reported
  content**). [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) depends on it.
- **Dependabot alerts and security updates:** on. Version updates for GitHub Actions come from
  `.github/dependabot.yml`.
- **Branch protection for `main`:** require the CI checks to pass before merging.

```sh
gh repo edit Seckcey/pleni --enable-issues --enable-discussions --enable-wiki=false
gh api -X PUT repos/Seckcey/pleni/private-vulnerability-reporting
```

Do not change account, permission, or notification settings while you update how the repository
looks.

## Social preview

GitHub shows this picture when someone shares a link to the repository. Upload it at
**Settings → General → Social preview → Edit → Upload an image**.

**Upload [`assets/pleni-social-preview.png`](../assets/pleni-social-preview.png).** It is the
Pleni preview: a 1280 × 640 PNG under 1 MB with a solid dark background, the Plenipo logo
unchanged, the name "Pleni" and "Plenipo Browser", one plain line that says what Pleni does, and
a strip of the map captured from demo mode (`node bin/pleni.js --demo`), never real session data.

Never use the Plenipo desktop app's social preview here. Its words describe the desktop app (a
Windows app that runs its own workers), not Pleni, so it is not kept in this repository.

If you make a new Pleni preview later, keep the same rules: 1280 × 640, under 1 MB, the logo
unchanged, plain words, and a capture from demo mode only.

[GitHub recommends](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
1280 × 640 for best display and needs a PNG, JPG, or GIF under 1 MB. Check the saved preview after
you upload it. Other sites can keep showing an older card for a while.

## README pictures

- The logo uses `assets/plenipo-horizontal-on-dark.png` and `assets/plenipo-horizontal-on-light.png`
  in a `<picture>` element, so it matches the reader's light or dark theme. Check both on GitHub
  after any change.
- The map screenshot uses `docs/assets/pleni-map.png` (dark) and `docs/assets/pleni-map-light.png`
  (light) in a `<picture>` element. When the page changes, retake both from demo mode
  (`node bin/pleni.js --demo`), check them for anything private, and keep each under 400 KB.

## Community entry points

Before you mark an issue `good first issue` or `help wanted`, make it truly ready: describe the
problem, the files involved, the expected result, and how to check it. Do not create filler issues
or suggest that labels alone get a repository featured.

## Visibility plan

1. **Keep the first visit useful.** Keep a real screenshot from demo mode, a short and correct
   "Start here", and a clear line between what works today and what is planned.
2. **Publish useful releases.** Explain what changed and its limits, and refresh the README at the
   same time.
3. **Make contributing easy.** Answer questions, sort real reports, and label only work that is
   ready for a contributor.
4. **Show one real outcome.** A short recording of demo mode, with hand-offs lighting up, would be
   a useful next asset. Record the real page; do not fake a demo.
5. **Share where invited.** The owner can pin the repository to a relevant profile and share useful
   releases with communities that welcome them. This plan does not authorize posting or outreach.

GitHub's home feed is personalized. [Stars](https://docs.github.com/en/get-started/exploring-projects-on-github/saving-repositories-with-stars)
help people save and discover related projects, and some rankings use popularity. Public
[dashboard activity](https://docs.github.com/en/account-and-profile/reference/personal-dashboard)
can include releases and activity from people a user follows. Those mechanisms support a useful
repository and genuine interest; no repository setting guarantees Home, Explore, or Trending
placement. Do not buy engagement, solicit artificial stars, or promise placement.
