#!/usr/bin/env bash
#
# mutate.sh — the ONLY sanctioned way to apply and undo a mutation-test edit.
#
# ⚠⚠ WHY THIS EXISTS. Three times in one session a mutation was undone with
# `git checkout -- <file>`, and every time the file ALSO carried uncommitted
# real work, which `git checkout` silently discarded. Written warnings did not
# stop it (CLAUDE.md, KB P13, and an explicit line in the session kickoff all
# said so beforehand). The whole arc's thesis is that guards must be
# STRUCTURAL rather than remembered — this applies that thesis to the person
# holding the keyboard.
#
# ⚠ HONEST LIMIT, STATED UP FRONT: a script cannot physically stop anyone from
# typing `git checkout`. What it does is (a) remove every REASON to reach for
# it, and (b) make the unsafe shape fail loudly — `restore` REFUSES when it has
# no backup of that exact file, instead of falling back to HEAD. "Refuses" is
# the part that matters: the failure mode of `git checkout` was that it
# succeeded.
#
#   scripts/mutate.sh apply   <file>   # back up + record md5, THEN edit
#   scripts/mutate.sh restore <file>   # restore from backup + verify md5
#   scripts/mutate.sh status           # list outstanding backups
#
set -euo pipefail

BACKUP_DIR="${MUTATE_BACKUP_DIR:-${TMPDIR:-/tmp}/mutate-backups}"
mkdir -p "$BACKUP_DIR"

md5_of() { md5 -q "$1" 2>/dev/null || md5sum "$1" | cut -d' ' -f1; }
key_for() { printf '%s' "$1" | tr '/' '_'; }

cmd="${1:-}"; file="${2:-}"

case "$cmd" in
  apply)
    [ -n "$file" ] || { echo "usage: mutate.sh apply <file>" >&2; exit 2; }
    [ -f "$file" ] || { echo "mutate: no such file: $file" >&2; exit 2; }
    k="$(key_for "$file")"
    if [ -f "$BACKUP_DIR/$k" ]; then
      echo "mutate: REFUSING — a backup for '$file' already exists." >&2
      echo "        An un-restored mutation is still in the tree. Run:" >&2
      echo "          scripts/mutate.sh restore $file" >&2
      exit 1
    fi
    cp "$file" "$BACKUP_DIR/$k"
    md5_of "$file" > "$BACKUP_DIR/$k.md5"
    echo "mutate: backed up $file"
    echo "mutate:   md5 $(cat "$BACKUP_DIR/$k.md5")"
    echo "mutate:   now apply the mutation, run the tests, then: scripts/mutate.sh restore $file"
    ;;

  restore)
    [ -n "$file" ] || { echo "usage: mutate.sh restore <file>" >&2; exit 2; }
    k="$(key_for "$file")"
    # ⚠⚠ THE REFUSAL IS THE POINT. No backup ⇒ this command does NOTHING.
    # It must never "helpfully" fall back to `git checkout`, because that is
    # the exact behaviour that destroyed uncommitted work three times.
    if [ ! -f "$BACKUP_DIR/$k" ]; then
      echo "mutate: REFUSING — no backup for '$file'." >&2
      echo "        Nothing is restored. Do NOT run 'git checkout -- $file':" >&2
      echo "        if that file has uncommitted work, checkout deletes it." >&2
      exit 1
    fi
    cp "$BACKUP_DIR/$k" "$file"
    want="$(cat "$BACKUP_DIR/$k.md5")"
    got="$(md5_of "$file")"
    if [ "$want" != "$got" ]; then
      echo "mutate: md5 MISMATCH after restore (want $want, got $got)" >&2
      exit 1
    fi
    rm -f "$BACKUP_DIR/$k" "$BACKUP_DIR/$k.md5"
    echo "mutate: restored $file"
    echo "mutate:   md5 $got ✓ matches pre-mutation"
    ;;

  status)
    shopt -s nullglob
    found=0
    for b in "$BACKUP_DIR"/*.md5; do
      found=1
      echo "outstanding mutation backup: $(basename "${b%.md5}" | tr '_' '/')"
    done
    [ "$found" -eq 0 ] && echo "mutate: no outstanding backups — tree is clean of mutations"
    ;;

  *)
    echo "usage: scripts/mutate.sh {apply|restore|status} [file]" >&2
    exit 2
    ;;
esac
