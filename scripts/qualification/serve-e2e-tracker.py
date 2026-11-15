#!/usr/bin/env python3
"""Track descendants of one serve-e2e run across parent exit.

The shell starts this process in its own process group and asks it to spawn
each service. Linux adopts orphaned descendants with PR_SET_CHILD_SUBREAPER.
macOS has no subreaper and kqueue does not report the child pid, so each
service is launched with a fork/posix_spawn/exec interposer that records the
child before the call returns. dyld interposing makes dlsym(posix_spawn) return
the replacement, so the real functions are read from the Mach-O export trie.
Shebang scripts are re-executed with the instrumented shell; otherwise the
kernel would run platform /bin/sh and drop the interposer. Same-group processes
that were never spawned here are not recorded and are not killed.

The tracker stays in the caller's process group. It does not call setsid.
"""

from __future__ import annotations

import ctypes
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys

PR_SET_CHILD_SUBREAPER = 36

C_SOURCE = r"""
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if __has_feature(ptrauth_calls)
#include <ptrauth.h>
#endif

#define DYLD_INTERPOSE(_replacement, _replacee) \
    __attribute__((used)) static struct { const void *replacement; const void *replacee; } \
    _interpose_##_replacee __attribute__((section("__DATA,__interpose"))) = { \
        (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee }

extern char **environ;

static void record_pid(pid_t pid) {
    const char *path;
    char buf[32];
    int fd;
    int n;
    if (pid <= 1) return;
    path = getenv("SERVE_E2E_TRACK_FILE");
    if (path == NULL || path[0] == '\0') return;
    fd = open(path, O_WRONLY | O_APPEND | O_CLOEXEC);
    if (fd < 0) return;
    n = snprintf(buf, sizeof buf, "%ld\n", (long)pid);
    if (n > 0 && n < (int)sizeof buf) {
        ssize_t written = write(fd, buf, (size_t)n);
        (void)written;
    }
    close(fd);
}

static const char *replacement_shell(const char *path) {
    const char *base;
    const char *bash_path;
    const char *sh_path;
    if (path == NULL || path[0] == '\0') return NULL;
    base = strrchr(path, '/');
    base = base == NULL ? path : base + 1;
    bash_path = getenv("SERVE_E2E_SHELL_BASH");
    sh_path = getenv("SERVE_E2E_SHELL_SH");
    if (bash_path != NULL && bash_path[0] != '\0' && strcmp(path, bash_path) != 0 &&
        (strcmp(path, "/bin/bash") == 0 || strcmp(path, "/usr/bin/bash") == 0 ||
         strcmp(base, "bash") == 0)) {
        return bash_path;
    }
    if (sh_path != NULL && sh_path[0] != '\0' && strcmp(path, sh_path) != 0 &&
        (strcmp(path, "/bin/sh") == 0 || strcmp(path, "/usr/bin/sh") == 0 ||
         strcmp(base, "sh") == 0)) {
        return sh_path;
    }
    return NULL;
}

static int copy_token(const char *start, const char *end, char *out, size_t out_n) {
    size_t len = (size_t)(end - start);
    if (len == 0 || len >= out_n) return -1;
    memcpy(out, start, len);
    out[len] = '\0';
    return 0;
}

/* Returns the instrumented shell when path is a platform shell script. extra receives one shebang argument. */
static const char *shebang_shell(const char *path, char *extra, size_t extra_n) {
    char buf[256];
    char interp[256];
    char arg[128];
    char *line_end;
    char *cursor;
    char *token_end;
    const char *base;
    const char *mapped;
    int fd;
    ssize_t n;
    extra[0] = '\0';
    arg[0] = '\0';
    fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return NULL;
    n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n < 3 || buf[0] != '#' || buf[1] != '!') return NULL;
    buf[n] = '\0';
    line_end = strpbrk(buf, "\n\r");
    if (line_end != NULL) *line_end = '\0';
    cursor = buf + 2;
    while (*cursor == ' ' || *cursor == '\t') cursor++;
    token_end = cursor;
    while (*token_end != '\0' && *token_end != ' ' && *token_end != '\t') token_end++;
    if (copy_token(cursor, token_end, interp, sizeof interp) != 0) return NULL;
    cursor = token_end;
    while (*cursor == ' ' || *cursor == '\t') cursor++;
    token_end = cursor;
    while (*token_end != '\0' && *token_end != ' ' && *token_end != '\t') token_end++;
    if (cursor != token_end && copy_token(cursor, token_end, arg, sizeof arg) != 0) return NULL;
    base = strrchr(interp, '/');
    base = base == NULL ? interp : base + 1;
    if (strcmp(base, "env") == 0) {
        if (arg[0] == '\0') return NULL;
        return replacement_shell(arg);
    }
    mapped = replacement_shell(interp);
    if (mapped == NULL) return NULL;
    if (arg[0] != '\0' && strlen(arg) < extra_n) {
        memcpy(extra, arg, strlen(arg) + 1);
    }
    return mapped;
}

static int resolve_on_path(const char *file, char *out, size_t out_n) {
    const char *path;
    const char *cursor;
    if (file == NULL || file[0] == '\0') return -1;
    if (strchr(file, '/') != NULL) {
        if (strlen(file) >= out_n) return -1;
        memcpy(out, file, strlen(file) + 1);
        return 0;
    }
    path = getenv("PATH");
    if (path == NULL || path[0] == '\0') path = "/bin:/usr/bin";
    cursor = path;
    while (*cursor != '\0') {
        const char *end = strchr(cursor, ':');
        size_t dir_len = end == NULL ? strlen(cursor) : (size_t)(end - cursor);
        int written;
        if (dir_len == 0) {
            written = snprintf(out, out_n, "%s", file);
        } else {
            written = snprintf(out, out_n, "%.*s/%s", (int)dir_len, cursor, file);
        }
        if (written > 0 && (size_t)written < out_n && access(out, X_OK) == 0) return 0;
        if (end == NULL) break;
        cursor = end + 1;
    }
    return -1;
}

#define SERVE_E2E_MAX_ARGV 128

static char **shell_argv(const char *shell, const char *extra, const char *script,
    char *const argv[], char *storage[]) {
    int count = 0;
    int index;
    storage[count++] = (char *)shell;
    if (extra != NULL && extra[0] != '\0') storage[count++] = (char *)extra;
    if (script != NULL) storage[count++] = (char *)script;
    for (index = script == NULL ? 0 : 1; argv != NULL && argv[index] != NULL; index++) {
        if (count >= SERVE_E2E_MAX_ARGV - 1) return NULL;
        storage[count++] = argv[index];
    }
    storage[count] = NULL;
    return storage;
}

static uintptr_t read_uleb(const uint8_t **cursor, const uint8_t *end) {
    uintptr_t result = 0;
    int bit = 0;
    while (*cursor < end && bit < 64) {
        uint8_t byte = *(*cursor)++;
        result |= (uintptr_t)(byte & 0x7f) << bit;
        if ((byte & 0x80) == 0) return result;
        bit += 7;
    }
    return 0;
}

static void *walk_trie(const uint8_t *start, const uint8_t *node, const uint8_t *end,
    const char *symbol, uintptr_t base) {
    const uint8_t *cursor = node;
    uintptr_t terminal;
    const uint8_t *children;
    uint8_t count;
    uint8_t index;
    if (cursor < start || cursor >= end) return NULL;
    terminal = read_uleb(&cursor, end);
    children = cursor + terminal;
    if (symbol[0] == '\0') {
        uintptr_t flags;
        if (terminal == 0 || cursor >= end) return NULL;
        flags = read_uleb(&cursor, end);
        if ((flags & 0x08) != 0) return NULL;
        return (void *)(base + read_uleb(&cursor, end));
    }
    if (children >= end) return NULL;
    count = *children++;
    for (index = 0; index < count; index++) {
        const char *edge = (const char *)children;
        size_t length = strnlen(edge, (size_t)(end - children));
        size_t matched = 0;
        uintptr_t offset;
        children += length + 1;
        if (children > end) return NULL;
        offset = read_uleb(&children, end);
        while (matched < length && symbol[matched] != '\0' && symbol[matched] == edge[matched]) matched++;
        if (matched == length && offset < (uintptr_t)(end - start)) {
            return walk_trie(start, start + offset, end, symbol + matched, base);
        }
    }
    return NULL;
}

static void *find_export(const char *image_name, const char *symbol) {
    uint32_t image_count = _dyld_image_count();
    uint32_t image;
    for (image = 0; image < image_count; image++) {
        const char *name = _dyld_get_image_name(image);
        const struct mach_header_64 *header;
        intptr_t slide;
        const struct segment_command_64 *linkedit = NULL;
        uint32_t export_off = 0;
        uint32_t export_size = 0;
        const uint8_t *command;
        uint32_t command_index;
        uintptr_t linkedit_base;
        const uint8_t *trie;
        if (name == NULL || strstr(name, image_name) == NULL) continue;
        header = (const struct mach_header_64 *)_dyld_get_image_header(image);
        if (header == NULL || header->magic != MH_MAGIC_64) continue;
        slide = _dyld_get_image_vmaddr_slide(image);
        command = (const uint8_t *)(header + 1);
        for (command_index = 0; command_index < header->ncmds; command_index++) {
            const struct load_command *load = (const struct load_command *)command;
            if (load->cmd == LC_SEGMENT_64) {
                const struct segment_command_64 *segment = (const struct segment_command_64 *)command;
                if (strcmp(segment->segname, "__LINKEDIT") == 0) linkedit = segment;
            } else if (load->cmd == LC_DYLD_EXPORTS_TRIE) {
                const struct linkedit_data_command *info = (const struct linkedit_data_command *)command;
                export_off = info->dataoff;
                export_size = info->datasize;
            } else if ((load->cmd == LC_DYLD_INFO_ONLY || load->cmd == LC_DYLD_INFO) && export_off == 0) {
                const struct dyld_info_command *info = (const struct dyld_info_command *)command;
                export_off = info->export_off;
                export_size = info->export_size;
            }
            command += load->cmdsize;
        }
        if (linkedit == NULL || export_off == 0 || export_size == 0) return NULL;
        linkedit_base = (uintptr_t)linkedit->vmaddr + (uintptr_t)slide;
        trie = (const uint8_t *)(linkedit_base + export_off - linkedit->fileoff);
        return walk_trie(trie, trie, trie + export_size, symbol, (uintptr_t)header);
    }
    return NULL;
}

static void *sign_function(void *raw) {
#if __has_feature(ptrauth_calls)
    if (raw == NULL) return NULL;
    return ptrauth_sign_unauthenticated(raw, ptrauth_key_function_pointer, 0);
#else
    return raw;
#endif
}

static pid_t (*real_fork)(void);
static pid_t (*real_vfork)(void);
static int (*real_posix_spawn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
    const posix_spawnattr_t *, char *const[], char *const[]);
static int (*real_posix_spawnp)(pid_t *, const char *, const posix_spawn_file_actions_t *,
    const posix_spawnattr_t *, char *const[], char *const[]);
static int (*real_execve)(const char *, char *const[], char *const[]);
static int (*real_execvp)(const char *, char *const[]);

static void resolve_libc(void) __attribute__((constructor));
static void resolve_libc(void) {
    /* dlsym of an interposed name returns this library. The export trie does not.
       Use the public libc fork so the child still runs dyld's fork handler. */
    real_fork = (pid_t (*)(void))sign_function(find_export("libsystem_c.dylib", "_fork"));
    real_vfork = (pid_t (*)(void))sign_function(find_export("libsystem_c.dylib", "_vfork"));
    real_posix_spawn = (int (*)(pid_t *, const char *, const posix_spawn_file_actions_t *,
        const posix_spawnattr_t *, char *const[], char *const[]))sign_function(
        find_export("libsystem_kernel.dylib", "_posix_spawn"));
    real_posix_spawnp = (int (*)(pid_t *, const char *, const posix_spawn_file_actions_t *,
        const posix_spawnattr_t *, char *const[], char *const[]))sign_function(
        find_export("libsystem_c.dylib", "_posix_spawnp"));
    real_execve = (int (*)(const char *, char *const[], char *const[]))sign_function(
        find_export("libsystem_kernel.dylib", "_execve"));
    real_execvp = (int (*)(const char *, char *const[]))sign_function(
        find_export("libsystem_c.dylib", "_execvp"));
}

static pid_t track_fork(void) {
    pid_t pid = real_fork != NULL ? real_fork() : (pid_t)-1;
    if (pid > 0) record_pid(pid);
    return pid;
}
DYLD_INTERPOSE(track_fork, fork);

static pid_t track_vfork(void) {
    pid_t pid = real_vfork != NULL ? real_vfork() : (pid_t)-1;
    if (pid > 0) record_pid(pid);
    return pid;
}
DYLD_INTERPOSE(track_vfork, vfork);

static int spawn_recorded(int (*impl)(pid_t *, const char *, const posix_spawn_file_actions_t *,
        const posix_spawnattr_t *, char *const[], char *const[]),
    pid_t *pid, const char *path, const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attrp, char *const argv[], char *const envp[]) {
    const char *direct;
    const char *shell;
    char extra[128];
    char *storage[SERVE_E2E_MAX_ARGV];
    char **rewritten;
    pid_t child = 0;
    pid_t *out = pid != NULL ? pid : &child;
    int rc;
    if (impl == NULL || path == NULL) {
        errno = ENOSYS;
        return -1;
    }
    direct = replacement_shell(path);
    if (direct != NULL) {
        rc = impl(out, direct, file_actions, attrp, argv, envp);
    } else {
        shell = shebang_shell(path, extra, sizeof extra);
        rewritten = shell == NULL ? NULL : shell_argv(shell, extra, path, argv, storage);
        if (rewritten != NULL) {
            rc = impl(out, shell, file_actions, attrp, rewritten, envp);
        } else {
            rc = impl(out, path, file_actions, attrp, argv, envp);
        }
    }
    if (rc == 0) record_pid(*out);
    return rc;
}

static int track_posix_spawn(pid_t *pid, const char *path,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attrp, char *const argv[], char *const envp[]) {
    return spawn_recorded(real_posix_spawn, pid, path, file_actions, attrp, argv, envp);
}
DYLD_INTERPOSE(track_posix_spawn, posix_spawn);

static int track_posix_spawnp(pid_t *pid, const char *file,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attrp, char *const argv[], char *const envp[]) {
    char resolved[1024];
    if (file != NULL && strchr(file, '/') == NULL && resolve_on_path(file, resolved, sizeof resolved) == 0) {
        return spawn_recorded(real_posix_spawn, pid, resolved, file_actions, attrp, argv, envp);
    }
    return spawn_recorded(real_posix_spawnp, pid, file, file_actions, attrp, argv, envp);
}
DYLD_INTERPOSE(track_posix_spawnp, posix_spawnp);

static int exec_recorded(const char *path, char *const argv[], char *const envp[]) {
    const char *direct;
    const char *shell;
    char extra[128];
    char *storage[SERVE_E2E_MAX_ARGV];
    char **rewritten;
    if (real_execve == NULL || path == NULL) {
        errno = ENOSYS;
        return -1;
    }
    direct = replacement_shell(path);
    if (direct != NULL) return real_execve(direct, argv, envp);
    shell = shebang_shell(path, extra, sizeof extra);
    rewritten = shell == NULL ? NULL : shell_argv(shell, extra, path, argv, storage);
    if (rewritten != NULL) return real_execve(shell, rewritten, envp);
    return real_execve(path, argv, envp);
}

static int track_execve(const char *path, char *const argv[], char *const envp[]) {
    return exec_recorded(path, argv, envp);
}
DYLD_INTERPOSE(track_execve, execve);

static int track_execvp(const char *file, char *const argv[]) {
    char resolved[1024];
    if (file != NULL && resolve_on_path(file, resolved, sizeof resolved) == 0) {
        return exec_recorded(resolved, argv, environ);
    }
    if (real_execvp == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return real_execvp(file, argv);
}
DYLD_INTERPOSE(track_execvp, execvp);
"""


def enable_subreaper() -> None:
    if platform.system() != "Linux":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "prctl PR_SET_CHILD_SUBREAPER failed")


def compile_interposer(work_dir: str) -> str:
    source = os.path.join(work_dir, "track.c")
    library = os.path.join(work_dir, "track.dylib")
    with open(source, "w", encoding="utf-8") as handle:
        handle.write(C_SOURCE)
    machine = platform.machine()
    attempts = []
    if machine == "arm64":
        attempts.append(["cc", "-arch", "arm64", "-arch", "arm64e", "-dynamiclib", "-o", library, source])
    attempts.append(["cc", "-dynamiclib", "-o", library, source])
    last = "cc failed"
    for command in attempts:
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode == 0:
            return library
        last = (result.stderr or result.stdout or last).strip()
    raise RuntimeError(last)


def instrument_shell(work_dir: str, name: str) -> str:
    source = "/bin/bash" if name == "bash" else "/bin/sh"
    destination = os.path.join(work_dir, name)
    if os.path.exists(destination):
        return destination
    shutil.copy(source, destination)
    os.chmod(destination, 0o755)
    subprocess.check_call(["codesign", "--remove-signature", destination], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.check_call(["codesign", "-s", "-", "-f", destination], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return destination


def resolve_executable(path: str) -> str:
    if os.sep not in path:
        found = shutil.which(path)
        return found or path
    return path


def platform_shell_name(path: str) -> str | None:
    candidate = resolve_executable(path)
    try:
        real = os.path.realpath(candidate)
    except OSError:
        real = candidate
    table = {
        "/bin/bash": "bash",
        "/usr/bin/bash": "bash",
        "/bin/sh": "sh",
        "/usr/bin/sh": "sh",
    }
    return table.get(real) or table.get(candidate)


def read_shebang(path: str) -> list[str] | None:
    try:
        with open(path, "rb") as handle:
            first = handle.readline(256)
    except OSError:
        return None
    if not first.startswith(b"#!"):
        return None
    text = first[2:].decode("utf-8", "replace").strip()
    parts = text.split()
    return parts or None


class Tracker:
    def __init__(self, work_dir: str) -> None:
        self.work_dir = work_dir
        self.track_file = os.path.join(work_dir, "pids")
        self.sock_path = os.path.join(work_dir, "sock")
        self.spawned: set[int] = set()
        self.exits: dict[int, int] = {}
        self.darwin = platform.system() == "Darwin"
        self.library = ""
        self.shells: dict[str, str] = {}
        open(self.track_file, "a", encoding="utf-8").close()
        if self.darwin:
            self.library = compile_interposer(work_dir)
            self.shells = {
                "bash": instrument_shell(work_dir, "bash"),
                "sh": instrument_shell(work_dir, "sh"),
            }
        else:
            enable_subreaper()

    def rewrite(self, argv: list[str]) -> list[str]:
        if not argv or not self.darwin:
            return argv
        path = resolve_executable(argv[0])
        argv = [path, *argv[1:]]
        shebang = read_shebang(path)
        if shebang:
            interpreter = shebang[0]
            interpreter_args = shebang[1:]
            if os.path.basename(interpreter) == "env" and interpreter_args:
                name = platform_shell_name(interpreter_args[0])
                if name:
                    return [self.shells[name], *argv]
            name = platform_shell_name(interpreter)
            if name:
                return [self.shells[name], *interpreter_args, *argv]
        name = platform_shell_name(path)
        if name:
            return [self.shells[name], *argv[1:]]
        return argv

    def child_env(self, forwarded: dict[str, str]) -> dict[str, str]:
        env = dict(forwarded)
        if not self.darwin:
            return env
        env["DYLD_INSERT_LIBRARIES"] = self.library
        env["SERVE_E2E_TRACK_FILE"] = self.track_file
        env["SERVE_E2E_SHELL_BASH"] = self.shells["bash"]
        env["SERVE_E2E_SHELL_SH"] = self.shells["sh"]
        return env

    def spawn(self, argv: list[str], cwd: str, forwarded: dict[str, str]) -> int:
        argv = self.rewrite(argv)
        if not argv or not argv[0]:
            raise RuntimeError("missing command")
        env = self.child_env(forwarded)
        pid = os.fork()
        if pid == 0:
            try:
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            except Exception:
                os._exit(127)
        self.spawned.add(pid)
        with open(self.track_file, "a", encoding="utf-8") as handle:
            handle.write(f"{pid}\n")
        return pid

    def reap(self) -> None:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return
            self.exits[pid] = decode_status(status)

    def recorded_pids(self) -> set[int]:
        found: set[int] = set()
        try:
            with open(self.track_file, "r", encoding="utf-8") as handle:
                text = handle.read()
        except OSError:
            text = ""
        for line in text.splitlines():
            if line.isdigit() and int(line) > 1:
                found.add(int(line))
        return found

    def descendants(self, roots: set[int]) -> set[int]:
        children: dict[int, list[int]] = {}
        for pid, parent in process_parents().items():
            children.setdefault(parent, []).append(pid)
        seen: set[int] = set()
        stack = list(roots)
        while stack:
            current = stack.pop()
            for child in children.get(current, []):
                if child in seen or child == current or child <= 1:
                    continue
                seen.add(child)
                stack.append(child)
        return seen

    def collect(self) -> list[int]:
        self.reap()
        roots = set(self.spawned)
        roots.add(os.getpid())
        found = self.recorded_pids() | self.descendants(roots) | set(self.spawned)
        found.discard(os.getpid())
        found.discard(1)
        return sorted(pid for pid in found if pid_alive(pid))

    def status(self, pid: int) -> dict[str, object]:
        self.reap()
        if pid in self.exits:
            return {"state": "exited", "code": self.exits[pid]}
        try:
            os.kill(pid, 0)
        except OSError:
            self.reap()
            if pid in self.exits:
                return {"state": "exited", "code": self.exits[pid]}
            return {"state": "missing"}
        return {"state": "running"}


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def decode_status(status: int) -> int:
    if os.WIFEXITED(status):
        return int(os.WEXITSTATUS(status))
    if os.WIFSIGNALED(status):
        return 128 + int(os.WTERMSIG(status))
    return 1


def process_parents() -> dict[int, int]:
    mapping: dict[int, int] = {}
    if os.path.isdir("/proc"):
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            try:
                with open(f"/proc/{name}/status", "r", encoding="utf-8") as handle:
                    for line in handle:
                        if line.startswith("PPid:"):
                            mapping[int(name)] = int(line.split()[1])
                            break
            except (OSError, ValueError):
                continue
        return mapping
    result = subprocess.run(["ps", "-ax", "-o", "pid=,ppid="], capture_output=True, text=True)
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            mapping[int(parts[0])] = int(parts[1])
    return mapping


def serve(work_dir: str) -> int:
    tracker = Tracker(work_dir)
    if os.path.exists(tracker.sock_path):
        os.unlink(tracker.sock_path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(tracker.sock_path)
    os.chmod(tracker.sock_path, 0o600)
    server.listen(16)
    server.settimeout(0.2)
    ready = os.path.join(work_dir, "ready")
    with open(ready, "w", encoding="utf-8") as handle:
        handle.write("1\n")
    signal.signal(signal.SIGCHLD, lambda _signum, _frame: None)
    while True:
        try:
            connection, _addr = server.accept()
        except (TimeoutError, socket.timeout):
            tracker.reap()
            continue
        except InterruptedError:
            tracker.reap()
            continue
        try:
            handle_connection(tracker, connection)
        except Exception as error:  # noqa: BLE001 — report and keep serving
            try:
                payload = json.dumps({"ok": False, "error": str(error)}).encode() + b"\n"
                connection.sendall(payload)
            except OSError:
                pass
        finally:
            connection.close()


def handle_connection(tracker: Tracker, connection: socket.socket) -> None:
    buffer = b""
    while b"\n" not in buffer:
        chunk = connection.recv(1024 * 1024)
        if not chunk:
            return
        buffer += chunk
        if len(buffer) > 8_000_000:
            raise RuntimeError("tracker request too large")
    request = json.loads(buffer.split(b"\n", 1)[0].decode())
    op = request.get("op")
    if op == "spawn":
        pid = tracker.spawn(
            list(request.get("argv") or []),
            str(request.get("cwd") or os.getcwd()),
            dict(request.get("env") or {}),
        )
        response = {"ok": True, "pid": pid}
    elif op == "collect":
        response = {"ok": True, "pids": tracker.collect()}
    elif op == "status":
        report = tracker.status(int(request["pid"]))
        response = {"ok": True, **report}
    else:
        response = {"ok": False, "error": f"unknown op {op}"}
    connection.sendall((json.dumps(response) + "\n").encode())


def read_response(sock: socket.socket) -> dict[str, object]:
    buffer = b""
    while b"\n" not in buffer:
        chunk = sock.recv(1024 * 1024)
        if not chunk:
            break
        buffer += chunk
    if not buffer:
        raise RuntimeError("tracker closed the response")
    response = json.loads(buffer.split(b"\n", 1)[0].decode())
    if not response.get("ok"):
        raise RuntimeError(str(response.get("error") or "tracker request failed"))
    return response


def rpc(argv: list[str]) -> int:
    sock_path = argv[2]
    op = argv[3]
    if op == "spawn":
        if "--cwd" not in argv:
            raise RuntimeError("spawn requires --cwd")
        cwd_at = argv.index("--cwd")
        cwd = argv[cwd_at + 1]
        separator = argv.index("--")
        command = argv[separator + 1 :]
        payload = {"op": "spawn", "cwd": cwd, "argv": command, "env": dict(os.environ)}
    elif op == "collect":
        payload = {"op": "collect"}
    elif op == "status":
        payload = {"op": "status", "pid": int(argv[4])}
    else:
        raise RuntimeError(f"unknown rpc {op}")
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(sock_path)
    client.sendall((json.dumps(payload) + "\n").encode())
    response = read_response(client)
    client.close()
    if op == "spawn":
        sys.stdout.write(str(response["pid"]))
    elif op == "collect":
        sys.stdout.write(" ".join(str(pid) for pid in response["pids"]))
    elif op == "status":
        if response.get("state") == "exited":
            sys.stdout.write(str(response["code"]))
        else:
            sys.stdout.write(str(response.get("state") or "missing"))
    return 0


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--serve":
        return serve(sys.argv[2])
    if len(sys.argv) >= 4 and sys.argv[1] == "--rpc":
        return rpc(sys.argv)
    sys.stderr.write("usage: serve-e2e-tracker.py --serve DIR | --rpc SOCK spawn|collect|status\n")
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 — surface the failure to the shell
        sys.stderr.write(f"{error}\n")
        sys.exit(1)
