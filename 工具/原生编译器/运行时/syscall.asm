; ============================================================
; coCN 运行时 —— 直接系统调用封装 (x86-64 Linux, NASM 语法)
; 不经过 libc，直接使用 syscall 指令。
;
; System V AMD64 用户态调用约定:
;   参数顺序: rdi, rsi, rdx, rcx, r8, r9
; Linux 内核调用约定 (syscall 指令):
;   参数顺序: rdi, rsi, rdx, r10, r8, r9
;   (syscall 会破坏 rcx / r11, 故第4个参数需从 rcx 搬到 r10)
;   系统调用号在 rax, 返回值在 rax。
; ============================================================

default rel

section .text

; ------------------------------------------------------------
; long rt_write(int fd, const void *buf, size_t count)
;   sys_write = 1
; ------------------------------------------------------------
global rt_write
rt_write:
    mov     rax, 1
    syscall
    ret

; ------------------------------------------------------------
; void rt_exit(int code)   ; 不返回
;   sys_exit = 60
; ------------------------------------------------------------
global rt_exit
rt_exit:
    mov     rax, 60
    syscall
    ; 永不返回

; ------------------------------------------------------------
; void *rt_mmap(void *addr, size_t len, int prot, int flags,
;               int fd, long offset)
;   sys_mmap = 9
;   第4参数 flags: C 在 rcx, 内核要 r10
; ------------------------------------------------------------
global rt_mmap
rt_mmap:
    mov     rax, 9
    mov     r10, rcx        ; flags -> r10
    syscall
    ret

; ------------------------------------------------------------
; int rt_munmap(void *addr, size_t len)
;   sys_munmap = 11
; ------------------------------------------------------------
global rt_munmap
rt_munmap:
    mov     rax, 11
    syscall
    ret

; ------------------------------------------------------------
; long rt_brk(void *addr)
;   sys_brk = 12 ; 返回当前 program break
; ------------------------------------------------------------
global rt_brk
rt_brk:
    mov     rax, 12
    syscall
    ret

; ------------------------------------------------------------
; int rt_open(const char *path, int flags, int mode)
;   sys_open = 2
; ------------------------------------------------------------
global rt_open
rt_open:
    mov     rax, 2
    syscall
    ret

; ------------------------------------------------------------
; long rt_read(int fd, void *buf, size_t count)
;   sys_read = 0
; ------------------------------------------------------------
global rt_read
rt_read:
    xor     eax, eax        ; sys_read = 0
    syscall
    ret

; ------------------------------------------------------------
; int rt_close(int fd)
;   sys_close = 3
; ------------------------------------------------------------
global rt_close
rt_close:
    mov     rax, 3
    syscall
    ret

; ------------------------------------------------------------
; long rt_gettimeofday(void)
;   sys_gettimeofday = 96
;   返回值 = tv_sec * 1000000 + tv_usec  (微秒, 自 epoch)
; ------------------------------------------------------------
global rt_gettimeofday
rt_gettimeofday:
    sub     rsp, 24             ; struct timeval { long tv_sec; long tv_usec; } = 16B
    mov     rax, 96
    mov     rdi, rsp            ; tv
    xor     esi, esi            ; tz = NULL
    syscall
    mov     rax, [rsp]          ; tv_sec
    mov     rdx, [rsp + 8]      ; tv_usec
    mov     rcx, 1000000
    imul    rax, rcx            ; sec * 1e6
    add     rax, rdx            ; + usec
    add     rsp, 24
    ret

; ------------------------------------------------------------
; void *rt_mremap(void *old_addr, size_t old_size, size_t new_size, int flags)
;   sys_mremap = 25
;   第4参数 flags: C 在 rcx, 内核要 r10
; ------------------------------------------------------------
global rt_mremap
rt_mremap:
    mov     rax, 25
    mov     r10, rcx        ; flags -> r10
    syscall
    ret

; ------------------------------------------------------------
; long rt_monotonic_us(void)
;   sys_clock_gettime = 228, CLOCK_MONOTONIC = 1
;   返回单调时钟微秒 (用于 benchmark 计时)
; ------------------------------------------------------------
global rt_monotonic_us
rt_monotonic_us:
    sub     rsp, 16
    mov     rax, 228
    mov     rdi, 1              ; CLOCK_MONOTONIC
    mov     rsi, rsp            ; struct timespec *ts
    syscall
    mov     r8,  [rsp]          ; tv_sec
    mov     r9,  [rsp + 8]      ; tv_nsec
    add     rsp, 16
    imul    r8, r8, 1000000     ; sec -> usec
    mov     rax, r9
    xor     rdx, rdx
    mov     rcx, 1000
    div     rcx                 ; rax = nsec / 1000 (usec)
    add     rax, r8
    ret
