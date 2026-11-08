"""The container entrypoint that drops root. The root-only system calls are
replaced with recorders, since the tests don't run as root."""

import os
import types

import entrypoint


def test_takes_ownership_of_only_what_isnt_already_right(tmp_path, monkeypatch):
    (tmp_path / "journal.db").write_text("x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "f").write_text("y")
    me = os.getuid(), os.getgid()
    root_owned = {str(tmp_path / "journal.db"), str(tmp_path / "sub" / "f")}
    real_lstat = os.lstat

    class Stat:
        """The real stat result, but owned by root for the root_owned paths.
        (os.walk itself relies on lstat too, so everything else passes through.)"""
        def __init__(self, path):
            self._real = real_lstat(path)
            self.st_uid, self.st_gid = (0, 0) if str(path) in root_owned else me

        def __getattr__(self, name):
            return getattr(self._real, name)

    def fake_lstat(path, *args, **kwargs):
        return Stat(path)

    chowned = []
    monkeypatch.setattr(entrypoint.os, "lstat", fake_lstat)
    monkeypatch.setattr(entrypoint.os, "lchown", lambda p, u, g: chowned.append((str(p), u, g)))
    entrypoint.take_ownership(str(tmp_path), *me)
    assert sorted(chowned) == sorted((p, *me) for p in root_owned)


def test_as_root_hands_over_data_then_drops_group_then_user(monkeypatch):
    calls = []
    monkeypatch.setattr(entrypoint.os, "getuid", lambda: 0)
    monkeypatch.setattr(entrypoint.pwd, "getpwnam",
                        lambda name: types.SimpleNamespace(pw_uid=999, pw_gid=998, pw_dir="/nonexistent"))
    monkeypatch.setattr(entrypoint, "take_ownership", lambda path, uid, gid: calls.append(("chown", path, uid, gid)))
    monkeypatch.setattr(entrypoint.os, "setgroups", lambda groups: calls.append(("setgroups", groups)))
    monkeypatch.setattr(entrypoint.os, "setgid", lambda gid: calls.append(("setgid", gid)))
    monkeypatch.setattr(entrypoint.os, "setuid", lambda uid: calls.append(("setuid", uid)))
    monkeypatch.setattr(entrypoint.os, "execvp", lambda f, argv: calls.append(("exec", argv)))
    monkeypatch.setenv("JOURNAL_DATA_DIR", "/data")

    entrypoint.main(["gunicorn", "app:app"])

    assert calls == [
        ("chown", "/data", 999, 998),
        ("setgroups", []),
        ("setgid", 998),  # group first: once setuid drops root, setgid isn't allowed
        ("setuid", 999),
        ("exec", ["gunicorn", "app:app"]),
    ]


def test_not_root_just_runs_the_command(monkeypatch):
    calls = []
    monkeypatch.setattr(entrypoint.os, "getuid", lambda: 1000)
    monkeypatch.setattr(entrypoint.os, "setuid", lambda uid: calls.append("setuid"))
    monkeypatch.setattr(entrypoint.os, "execvp", lambda f, argv: calls.append(("exec", argv)))
    entrypoint.main(["gunicorn", "app:app"])
    assert calls == [("exec", ["gunicorn", "app:app"])]
