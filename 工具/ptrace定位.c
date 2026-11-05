/* coCN 崩溃定位器 —— ptrace 跟踪子进程，SIGSEGV 时打印寄存器
 * 用法: ptrash ./程序
 * 为什么需要它：沙箱里没有 gdb/strace，而内核 dmesg 只给 rip 和出错地址，
 * 看不出是哪个寄存器为 0。直接读 user_regs_struct 是唯一可靠的路。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/user.h>
#include <errno.h>

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "用法: %s 程序 [参数...]\n", argv[0]); return 1; }
  pid_t p = fork();
  if (p == 0) {
    ptrace(PTRACE_TRACEME, 0, NULL, NULL);
    execv(argv[1], argv + 1);
    _exit(127);
  }
  int st;
  waitpid(p, &st, 0);
  for (int i = 0; i < 64; i++) {
    if (WIFEXITED(st)) { fprintf(stderr, "正常退出 %d\n", WEXITSTATUS(st)); return 0; }
    int sig = WIFSTOPPED(st) ? WSTOPSIG(st) : WTERMSIG(st);
    struct user_regs_struct r;
    if (ptrace(PTRACE_GETREGS, p, NULL, &r) == 0 && sig == SIGSEGV) {
      fprintf(stderr, "SIGSEGV rip=%llx rsp=%llx\n", (unsigned long long)r.rip, (unsigned long long)r.rsp);
      fprintf(stderr, "  rax=%llx rbx=%llx rcx=%llx rdx=%llx\n",
        (unsigned long long)r.rax, (unsigned long long)r.rbx,
        (unsigned long long)r.rcx, (unsigned long long)r.rdx);
      fprintf(stderr,
        "  rsi=%llx rdi=%llx rbp=%llx rsp=%llx\n",
        (unsigned long long)r.rsi, (unsigned long long)r.rdi,
        (unsigned long long)r.rbp, (unsigned long long)r.rsp);
      fprintf(stderr, "   r8=%llx  r9=%llx r10=%llx r11=%llx\n",
        (unsigned long long)r.r8, (unsigned long long)r.r9,
        (unsigned long long)r.r10, (unsigned long long)r.r11);
      fprintf(stderr, "  r12=%llx r13=%llx r14=%llx r15=%llx\n",
        (unsigned long long)r.r12, (unsigned long long)r.r13,
        (unsigned long long)r.r14, (unsigned long long)r.r15);
      return 2;
    }
    if (sig != SIGTRAP) fprintf(stderr, "信号 %d\n", sig);
    ptrace(PTRACE_CONT, p, NULL, sig == SIGTRAP ? 0 : sig);
    waitpid(p, &st, 0);
  }
  return 0;
}
