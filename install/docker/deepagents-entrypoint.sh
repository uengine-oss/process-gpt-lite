#!/bin/sh
# deepagents computes its workspace as <app dir>/workspace and hands that path to the host Docker
# daemon when it starts a sandbox container. Inside a container that path must also exist on the
# host, so run the app from DEEPAGENTS_HOME (= <host data dir>/deepagents, bind-mounted at the same
# path for workspace/ and skills/) with the code linked in from /app.
set -e
D="${DEEPAGENTS_HOME:?DEEPAGENTS_HOME is required}"
mkdir -p "$D/workspace" "$D/skills"
for f in /app/* /app/.[!.]*; do
  [ -e "$f" ] || continue
  n=$(basename "$f")
  case "$n" in workspace|skills) continue ;; esac
  ln -sfn "$f" "$D/$n"
done
# first start: the bundled skills collection
if [ -d /app/skills ] && [ ! -e "$D/skills/.seeded" ]; then
  cp -R /app/skills/. "$D/skills/" && touch "$D/skills/.seeded"
fi
export SKILLS_DIRS="$D/skills" SKILLS_HOST="$D/skills" WORKSPACE="$D/workspace" PYTHONPATH="$D"
cd "$D"
# -m keeps sys.path[0] at $D (a script path would be resolved back to /app)
exec python -m server "$@"
