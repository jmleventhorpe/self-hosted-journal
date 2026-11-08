"""Container entrypoint: drops root before running the server.

The container starts as root only long enough to make sure the data volume
belongs to the unprivileged `journal` user - volumes created by older
images, which ran everything as root, hold root-owned files the server
couldn't otherwise write to - then switches to that user and replaces
itself with the real command (gunicorn, from the Dockerfile's CMD).

Started as a non-root user already (e.g. `user:` in compose), it just runs
the command.
"""

import os
import pwd
import sys

APP_USER = "journal"


def take_ownership(path, uid, gid):
    """chown `path` and everything under it to uid:gid, skipping anything
    already right."""
    for root, dirs, files in os.walk(path):
        for name in [root] + [os.path.join(root, n) for n in dirs + files]:
            st = os.lstat(name)
            if (st.st_uid, st.st_gid) != (uid, gid):
                os.lchown(name, uid, gid)


def main(argv):
    if os.getuid() == 0:
        user = pwd.getpwnam(APP_USER)
        take_ownership(os.environ.get("JOURNAL_DATA_DIR", "/data"), user.pw_uid, user.pw_gid)
        os.setgroups([])
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
        os.environ["HOME"] = user.pw_dir
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    main(sys.argv[1:])
