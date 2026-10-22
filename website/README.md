# getplenipo.com

The website for Pleni, and for Plenipo for Windows, which is no longer updated. Made by
8 West Ventures, LLC.

The site lives here since 2026-10-22. Before that it was `apps/website` in the
[Plenipo repository](https://github.com/Seckcey/plenipo) (last there at commit `b0285dbe`). It
moved so a change to the site is checked in a few minutes instead of waiting for Plenipo's long
desktop-app checks, and because new work goes into Pleni.

**It is separate from Pleni.** It has its own `package.json` with its own add-on packages (React,
React Flow, esbuild and TypeScript), its own tests, and its own GitHub check. Pleni never imports
anything from this folder, and it is not in Pleni's npm package. Pleni's zero-dependency rule
covers everything outside this folder.

## What is where

| Path                                    | What it is                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `index.html`, `styles.css`, `main.js`   | The page: Pleni first, then Plenipo for Windows, What's new, download, FAQ     |
| `src/`                                  | The interactive Plenipo sample team (React Flow), built into `/demo/`          |
| `public/`                               | Pictures, the tour video, fonts, brand files, the brand kit, the share page    |
| `legal/`                                | Terms of service and privacy statement, shown at `/terms/` and `/privacy/`     |
| `scripts/`                              | The build, the release-notes and legal-page renderers, and the tests           |
| `deploy/`                               | The updater that runs on Coastline, with its systemd service and timer         |
| `Dockerfile`, `nginx.conf`, `compose*`  | The production container                                                       |
| `../docs/releases/vX.Y.Z.md`            | Pleni's release notes; What's new shows the ones for the version on the page   |

## Check it on your computer

You need Node.js 22.12 or newer.

```sh
cd website
npm ci
npm test
npm run typecheck
SOURCE_REVISION="$(git rev-parse HEAD)" npm run build   # makes website/dist
```

`npm test` runs `scripts/*.test.mjs`. The updater's tests run on Linux only (Coastline is Linux).
The GitHub check (`.github/workflows/website.yml`) runs the same, then builds the production
container, starts it, and checks its pages, `release.json`, a real 404, and the old addresses'
redirects. It runs when something in `website/`, `docs/releases/`, the root `package.json` or
the workflow changes.

## Versions and What's new

The page never types a version by hand. The build fills in two marks:

- `__PLENI_VERSION__`: Pleni's version, from the root `package.json`, or `PLENI_VERSION` when it
  is given (a container build has no repository around it, so the updater passes the release it
  checked). It goes into Pleni's structured data, its npm link, and What's new.
- `__PLENIPO_VERSION__`: Plenipo for Windows' last version, `PLENIPO_LAST_VERSION` in
  `scripts/build.mjs` (1.28.0). Its download buttons and version labels keep pointing there.

What's new shows Pleni's notes for that version. The build looks for them in
`PLENI_RELEASE_NOTES` (a file it must be able to read), then `website/release-notes/vX.Y.Z.md`
(where the updater puts them, because a container build sees only this folder), then
`docs/releases/vX.Y.Z.md`. With no notes, the section links to the release on GitHub. The notes
start with `# vX.Y.Z — Title`, then a short intro; the rest opens under **Read the full release
notes**. Every character is escaped; only headings, paragraphs, lists, code, bold and http(s)
links are shown.

`release.json` names the source commit, Pleni's version, its npm link, and whether the page has
notes (`releaseNotes`).

**For each Pleni release,** add `docs/releases/vX.Y.Z.md` in the release pull request. After the
merge, publish to npm first, then the GitHub release. The site shows the new version within about
15 minutes of both.

## On Coastline

| Setting                  | Value                                                         |
| ------------------------ | ------------------------------------------------------------- |
| Host                     | `ssh coastline`                                               |
| App folder               | `/srv/8west/apps/plenipo-website`                             |
| Compose project          | `plenipo-website`                                             |
| Container port           | `8080`, bound to `127.0.0.1:14380` only                       |
| Docker network           | `10.204.229.0/28` (`compose.coastline.yaml`)                  |
| Cloudflare Tunnel origin | `http://127.0.0.1:14380`                                      |
| Public address           | `https://getplenipo.com/`                                     |

`www.getplenipo.com` and the old `plenipo.8westit.com` answer with a permanent 308 redirect that
keeps the path and query string. Cloudflare gives the public HTTPS; the Tunnel's hostname is set
in Cloudflare, outside this repository.

### How it updates itself

A systemd timer runs `deploy/auto-release.sh` every 15 minutes, as the account that owns the app
folder (never as root). Each run:

1. finds Pleni's latest published GitHub release (not a draft or pre-release) and checks npm has
   that version, since the page tells people to run `npx pleni`. Until npm has it, the running
   site stays;
2. reads the release's notes, `docs/releases/vX.Y.Z.md`, from `main` (so a correction shows), or
   from the release's tag if `main` has none;
3. does nothing more when the site already shows that version, those notes, and the same website
   files. Otherwise it waits for a passing CI run at that commit of `main`, and a passing Website
   run at the last commit that changed `website/` or its workflow. `--force` never skips these;
4. exports the website and the notes into a new folder that is never edited,
   `releases/<commit>-v<version>`, and builds `plenipo-website:<commit>-v<version>`;
5. swaps the container while holding `/srv/8west/port-allocations/allocations.lock`, then checks
   health, the home page and its What's new for this version, `release.json`, the terms and
   privacy pages, a real 404, the image, its restart count, and the loopback-only port;
6. if a check fails, puts the previous image back, with the Compose files it was started from.

It keeps `auto-release/current.env` (what runs now), `auto-release/release.json`,
`auto-release/history.jsonl` (one line per update or roll-back), and its own copy of this
repository in `auto-release/source-pleni.git`. It reads GitHub and npm without a login. It never
prunes images, and never touches other services, the firewall, DNS or the Tunnel. It needs `curl`,
`jq`, `git`, `docker` with Compose, `flock` and `sha256sum`, and says which is missing.

Options: `--check` (say what would happen, change nothing), `--force` (rebuild even if up to
date), `--version X.Y.Z` (show an older Pleni release), and `--source-ref REF` (website code from
another branch, tag or commit). `PORT`, `SUBNET` and `ALLOCATION_LOCK` can be changed in
`/srv/8west/apps/plenipo-website/auto-release.env`.

### Switch the updater from Plenipo to Pleni (once, after the move)

Until this is done, Coastline keeps showing the site from the Plenipo repository, as before. Run
it after the pull request that moved the site is merged. Replace `REVIEWED_PLENI_COMMIT` with
that merge commit on Pleni's `main` (the full 40-character id).

```sh
ssh coastline
cd /srv/8west/apps/plenipo-website
revision="REVIEWED_PLENI_COMMIT"
deploy_user="$(stat -c %U .)"

# 1. Pause the timer, and wait until no update is running.
sudo systemctl disable --now plenipo-website-update.timer
sudo -u "$deploy_user" flock auto-release/run.lock true

# 2. Keep a copy of the current updater and its settings, to go back if needed.
stamp="$(date +%Y%m%d-%H%M)"
sudo -u "$deploy_user" cp -p bin/auto-release.sh "bin/auto-release.sh.before-pleni-$stamp"
[ -f auto-release.env ] && sudo -u "$deploy_user" cp -p auto-release.env "auto-release.env.before-pleni-$stamp"

# 3. The settings must not point at the Plenipo repository. This shows any line that does:
grep -nE '^(REPO_URL|REPO_API|SOURCE_REF)=' auto-release.env 2> /dev/null || echo "none: good"
#    If it showed lines, take them out (the new updater knows Pleni's addresses):
#    sudo -u "$deploy_user" sed -i -E '/^(REPO_URL|REPO_API|SOURCE_REF)=/d' auto-release.env

# 4. Install the reviewed updater from Pleni.
updater_tmp="$(sudo -u "$deploy_user" mktemp bin/.auto-release.XXXXXX)"
sudo -u "$deploy_user" curl -fsSL \
  "https://raw.githubusercontent.com/Seckcey/pleni/$revision/website/deploy/auto-release.sh" \
  -o "$updater_tmp"
sudo -u "$deploy_user" bash -n "$updater_tmp"
sudo -u "$deploy_user" chmod 755 "$updater_tmp"
sudo -u "$deploy_user" mv "$updater_tmp" bin/auto-release.sh

# 5. See what it would do, then do it.
sudo -u "$deploy_user" bin/auto-release.sh --source-ref "$revision" --check
sudo -u "$deploy_user" bin/auto-release.sh --source-ref "$revision"

# 6. Turn the timer back on.
sudo systemctl enable --now plenipo-website-update.timer
systemctl list-timers plenipo-website-update.timer
```

Step 5's check should end with a plan for `version 0.2.0` (or the newest Pleni release), and the
real run with `Done: the site shows v0.2.0 with its notes`. Then open
<https://getplenipo.com/release.json>: it should show Pleni's version and a `sourceRevision` from
Pleni's repository.

- If a download or syntax check fails, stop before `mv`; the installed updater stays as it was.
- If a run says **Waiting for passing ... checks** or **Waiting for npm**, the current site keeps
  running. Turn the timer back on; it tries again every 15 minutes.
- If the new site fails a check, the updater puts the old one back by itself and says so.
- To go back to the Plenipo-based updater: pause the timer, copy the `before-pleni` files back
  over `bin/auto-release.sh` and `auto-release.env`, and turn the timer back on.

### Check on it, pause it, go back

```sh
systemctl status plenipo-website-update          # the last run: finished, or why it stopped
journalctl -u plenipo-website-update -n 100      # what each run did
tail -n 5 /srv/8west/apps/plenipo-website/auto-release/history.jsonl
sudo systemctl disable --now plenipo-website-update.timer    # pause automatic updates
sudo -u "$(stat -c %U /srv/8west/apps/plenipo-website)" \
  /srv/8west/apps/plenipo-website/bin/auto-release.sh --version 0.1.0   # show an older release
```

Going back to an older release while the timer is on lasts only until the next run; pause the
timer first to stay on it. Release folders are read-only; to delete an old one, run
`chmod -R u+w` on it first, and keep the current and previous ones (`auto-release/current.env`).

## Rules

- Container builds, tests and previews run on Coastline, never on Docker Desktop.
- Hold `/srv/8west/port-allocations/allocations.lock` while checking, reserving and starting a
  port. Never remove that lock file or the updater's `run.lock`.
- Never prune images, stop another project's containers, or change the firewall, DNS, the Tunnel
  or Docker's address pools for a website release.
- Pictures of Pleni come from its demo (`npx pleni --demo`), never from real sessions.
- The legal pages are 8 West Ventures, LLC's; change them only with the owner.

## History

The decisions behind this setup were made while the site was in the Plenipo repository:
[ADR-069 (the website follows new releases)](https://github.com/Seckcey/plenipo/blob/main/docs/adr/ADR-069-website-follows-releases.md),
[publishing checked website changes](https://github.com/Seckcey/plenipo/blob/main/docs/adr/website-changes-follow-checks.md),
[ADR-130 (the move to getplenipo.com)](https://github.com/Seckcey/plenipo/blob/main/docs/adr/ADR-130-website-domain-migration.md),
and [the legal statements](https://github.com/Seckcey/plenipo/blob/main/docs/adr/website-legal-statements.md).
The full old guide, with the interactive sample's design and the brand files' history, is
[Plenipo's `docs/development/website.md`](https://github.com/Seckcey/plenipo/blob/b0285dbec4438e5186db0a139041bb2fc7f751e5/docs/development/website.md).
