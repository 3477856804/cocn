/* coCN 原生启动器 —— 让「运行 coCN 程序」这件事本身也是原生速度
 *
 * 三条路径，按代价从低到高：
 *   一（缓存命中，常态）：读源 → FNV-1a 指纹 → ~/.cocn/cache/<指纹> 命中
 *       → execv 直接执行原生 ELF。全程不启动 node、不启动解释器，
 *         实测启动约 0.7ms（一次 execve + 静态 ELF 自举）。
 *   二（首次运行 / 缓存过期）：node cocn.js --编译 源 目标
 *       → 走直接机器码后端（不依赖 gcc），产物原子写入缓存后 execv。
 *   三（原生后端不支持的语法）：引导器 + 自解释器兜底执行。
 *
 * 为什么必须有路径三：0.1.12 之前路径二把 --编译 交给 cocn.js，而 cocn.js
 * 根本没实现 --编译，于是把 "--编译" 当成 .co 文件去找，报
 * 「找不到文件: --编译」直接退出——首次运行全挂、缓存永远是空的，
 * README 里承诺的「原生速度」在真实安装里从没发生过。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <sys/resource.h>
#define MAXSRC (16u << 20)

/* 解释器兜底通道的栈余量：自举解释器（求值器.co）每层语言调用要吃约 17KB
 * C 栈（实测 8MB 默认栈只能撑 ~460 层就触发宿主栈守卫——那类错误跨 .co
 * 边界不可捕获，rc=1 直接死）。宿主守卫按 pthread_attr_getstack 读到的
 * 【真实栈大小】画红线，所以只要 execv 之前把软限抬到 64MB（硬限通常
 * unlimited），自举层合法递归就能到千层级；无限递归则由 .co 层自己的
 * 1200 层可捕获守卫先拦下（见 求值器.co/虚拟机.co 的 调用栈 消息）。
 * 只在能抬的时候抬：用户自己 ulimit 更大就不动；硬限不够就取硬限。 */
static void raise_stack_soft_limit(void) {
    struct rlimit rl;
    const rlim_t want = (rlim_t)64u << 20;
    if (getrlimit(RLIMIT_STACK, &rl) != 0) return;
    if (rl.rlim_cur >= want || rl.rlim_cur == RLIM_INFINITY) return;
    rlim_t up = want;
    if (rl.rlim_max != RLIM_INFINITY && rl.rlim_max < up) up = rl.rlim_max;
    if (up > rl.rlim_cur) {
        rl.rlim_cur = up;
        setrlimit(RLIMIT_STACK, &rl);   /* 失败无妨：退回默认 8MB 行为 */
    }
}

/* 缓存指纹掺一层「编译器代次」：后端语义变了（对象布局、字符串规则），
 * 老缓存必须自动失效，否则同一个 .co 会跑出上一个版本的二进制。
 *
 * 为什么必须把【包版本】编进串里：指纹只由「ABI 串 + 源码内容」算出来，
 * 里面没有任何版本信息。0.1.15 修了三类「编得过但算错」的产物语义
 * （浮点字面量、浮点声明、真除法 / 改判、INT64_MIN 无符号取位），
 * 但老用户 ~/.cocn/cache/ 里 0.1.14 生成的错误 ELF 指纹完全没变，
 * 升级后启动器照样 execv 命中它 —— 修了等于没修。靠人记得手改 v1/v2
 * 迟早再漏一次，所以这里改成：版本号由构建时 -DCOCN_ABI= 注入，
 * 每次发版自动作废一次缓存（代价是每个程序每版重编一次，约 80ms）。 */
/* 兜底默认值必须和发版号同步（缺口一：开发者手 gcc 不带 -D 时，
 * 若默认值还停在旧串，npm 用户与开发者的缓存就不互通，门禁也可能
 * 在两种启动器下得出不同结论）。install.js 构建时会注入 -DCOCN_ABI，
 * 这里的默认串由 测试/原生一致性.sh 的同款脚本定期核对，发版清单里也有它。 */
#ifndef COCN_ABI
#define COCN_ABI "cocn-direct-0.1.20"
#endif
static const char *COCN_ABI_STR = COCN_ABI;

static unsigned long long fnv1a_update(unsigned long long h, const char *s, unsigned long long n) {
    for (unsigned long long i = 0; i < n; i++) {
        h ^= (unsigned char)s[i];
        h *= 1099511628211ULL;
    }
    return h;
}

static int is_dir(const char *p) { struct stat st; return stat(p, &st) == 0 && S_ISDIR(st.st_mode); }

/* ELF ABI 尾戳自检（缺口二/三：产物本身没有版本信息，缓存文件名虽掺了
 * 版本盐，但 --编译 直接产出的文件、被手工挪进缓存的文件都不经过盐）：
 * 机器码生成器在 PT_LOAD 的 p_filesz 之外追加 32 字节 ——
 *   [0..7]   魔数 "COCNABI\x01"
 *   [8..31]  代次串（如 "cocn-direct-0.1.16"，UTF-8，补 0，超长截断）
 * 内核不会映射这段（在 filesz 之外），execv 行为完全不受影响；
 * 这里只把它当作「产物的出厂铭牌」来读。
 * 规则：宁可错杀（重编一次 ~80ms）不可放行错误代次（跑出旧语义的 ELF）。
 *   - 读不到文件/太短/魔数不对/代次不匹配 → 判为不合格。 */
static int 产物代次合格(const char *路径) {
    int ok = 0;
    int fd = open(路径, O_RDONLY);
    if (fd < 0) return 0;
    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_size < 64 + 112) { close(fd); return 0; }
    unsigned char 尾[32];
    off_t 起 = (off_t)st.st_size - 32;
    ssize_t n = pread(fd, 尾, 32, 起);
    close(fd);
    if (n != 32) return 0;
    if (memcmp(尾, "COCNABI\x01", 8) != 0) return 0;
    char 代[25];
    memcpy(代, 尾 + 8, 24);
    代[24] = 0;
    size_t 期长 = strlen(COCN_ABI_STR);
    if (期长 > 24) 期长 = 24;                    /* 串太长：生成器同样截断 */
    ok = (memcmp(代, COCN_ABI_STR, 期长) == 0 && 代[期长] == '\0');
    return ok;
}

/* 从 /proc/self/exe 反推包内布局：
 *   self   = <包根>/bin/cocn
 *   js     = <包根>/bin/入口.js（纯 JS 入口；bin/cocn.js 是 sh 薄壳）
 *   guide  = <包根>/bin/引导器  或  平台子包里的引导器
 *   interp = <包根>/src/解释器.co
 *   srcdir = <包根>/src （自解释器的模块解析根，chdir 到这里）
 * 环境变量 COCN_JS / COCN_HOME 可覆盖（开发时直接跑仓库里的副本）。
 *
 * 引导器在哪（0.1.31 起按 npm 语言包的通行形态发布）：
 *   主包不再携带平台二进制，引导器在平台专属子包里
 *   （@yeyelailou/co-linux-x64 / -linux-arm64 …），
 *   npm 把它装在 node_modules 下。npm 有两种布局：
 *     扁平化：node_modules/@yeyelailou/co 与 node_modules/@yeyelailou/co-linux-x64 同级
 *     嵌套：  node_modules/@yeyelailou/co/node_modules/@yeyelailou/co-linux-x64
 *   所以从包根逐级向上，每级都试「内嵌 node_modules」与「上两级 node_modules」。
 */
static int locate(char *self, size_t cap, char *js, size_t jscap,
                  char *guide, size_t gcap, char *interp, size_t icap,
                  char *srcdir, size_t scap) {
    const char *env_js = getenv("COCN_JS");
    char bindir[4096], pkg[4096];
    if (env_js && env_js[0]) {
        snprintf(js, jscap, "%s", env_js);
        snprintf(bindir, sizeof bindir, "%s", env_js);
    } else {
        ssize_t sl = readlink("/proc/self/exe", self, cap - 1);
        if (sl <= 0) return -1;
        self[sl] = 0;
        snprintf(bindir, sizeof bindir, "%s", self);
    }
    char *b = strrchr(bindir, '/');
    if (!b) return -1;
    *b = 0;                                    /* bindir = <包根>/bin */
    snprintf(pkg, sizeof pkg, "%s", bindir);
    char *p = strrchr(pkg, '/');
    if (p) *p = 0;                             /* pkg = <包根> */
    if (!env_js || !env_js[0])
        snprintf(js, jscap, "%s/入口.js", bindir);
    snprintf(guide, gcap, "%s/引导器", bindir);
    snprintf(srcdir, scap, "%s/src", pkg);
    snprintf(interp, icap, "%s/解释器.co", srcdir);

    /* 主包里没有引导器时，去平台子包里找。 */
    if (access(guide, R_OK) != 0) {
#if defined(__x86_64__)
        const char *sub = "co-linux-x64";
#elif defined(__aarch64__)
        const char *sub = "co-linux-arm64";
#elif defined(__arm__)
        const char *sub = "co-linux-arm";
#else
        const char *sub = NULL;
#endif
        if (sub) {
            char dir[4096];
            /* 逐级向上找：<当前>/node_modules/@yeyelailou/<sub>/bin/引导器
             * 起点是【包根】而不是包根的父目录 —— 全局安装时 npm 把平台
             * 子包放在【主包自己的 node_modules 里】
             *   <prefix>/lib/node_modules/@yeyelailou/co/node_modules/@yeyelailou/co-linux-arm64
             * 从包根往上的第一层正好命中；局部安装时则命中上两层的
             * node_modules（npm 扁平化布局）。两种都覆盖到。
             * 每轮只去掉一层目录（strrchr 找的是最后一个 '/'）。 */
            snprintf(dir, sizeof dir, "%s", pkg);
            for (int i = 0; i < 8; i++) {
                const char *rel = "node_modules/@yeyelailou/";
                size_t need = strlen(dir) + 1 + strlen(rel) + strlen(sub) + 16;
                if (need < gcap) {
                    snprintf(guide, gcap, "%s/%s%s/bin/引导器", dir, rel, sub);
                    if (access(guide, R_OK) == 0) break;
                }
                char *slash = strrchr(dir, '/');
                if (!slash || slash == dir) break;
                *slash = 0;
            }
            if (access(guide, R_OK) != 0)
                snprintf(guide, gcap, "%s/../%s/bin/引导器", pkg, sub);
        }
    }

    /* npm 解包可能不保留可执行位（实测装完是 -rw-------），
     * 而引导器必须能被 execve 执行；缺执行位时表现为「找不到引导器」。
     * 这里就地补上执行位（覆盖 --ignore-scripts 跳过 postinstall 的场景）。 */
    if (access(guide, R_OK) == 0 && access(guide, X_OK) != 0) {
        chmod(guide, 0755);
    }
    return 0;
}

/* 把 argv 原样转发给 `node <包根>/bin/入口.js`（生态子命令 / REPL / 选项）。
 * 成功时本进程被 execvp 替换，不返回；定位失败或 execvp 失败返回 -1。
 * 为什么需要它：C 启动器只认 .co 目标，会把 `new`/`publish`/`search` 当成
 * 文件名去 open 并报「找不到文件」。这些子命令由 JS 侧实现
 * （bin/入口.js → 工具/生态/cli.js），转发后 `cocn publish` 等才可用，
 * 同时 `cocn 程序.co` 仍走下面的原生快路径，速度不受影响。 */
static int 转发到cocnjs(int argc, char **argv) {
    char self[4096], js[4224], guide[4224], interp[4352], srcdir[4224];
    if (locate(self, sizeof self, js, sizeof js, guide, sizeof guide,
               interp, sizeof interp, srcdir, sizeof srcdir) != 0)
        return -1;
    static char *av[4352];
    int n = 0;
    av[n++] = (char *)"node";
    av[n++] = js;
    for (int i = 1; i < argc && n < 4350; i++) av[n++] = argv[i];
    av[n] = NULL;
    execvp("node", av);
    return -1;   /* execvp 失败：调用方回落到原有行为 */
}

/* 调 node 入口.js --编译 <源> <输出>；成功返回 0
 * quiet=1 时吞掉子进程 stderr：自动兜底路径下「原生不支持」是正常情况，
 * 不该把编译器的报错喷进用户程序的 stderr（会污染输出比对）。
 * 设 COCN_DEBUG=1 可恢复可见。 */
static int node_compile(const char *js, const char *target, const char *out, int quiet) {
    char *av[6];
    av[0] = (char *)"node"; av[1] = (char *)js;
    av[2] = (char *)"--编译"; av[3] = (char *)target; av[4] = (char *)out; av[5] = NULL;
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        if (quiet && !getenv("COCN_DEBUG")) {
            int devnull = open("/dev/null", O_WRONLY);
            if (devnull >= 0) { dup2(devnull, 1); dup2(devnull, 2); close(devnull); }
        }
        execvp("node", av);
        _exit(127);
    }
    int st = 0;
    waitpid(pid, &st, 0);
    if (WIFEXITED(st) && WEXITSTATUS(st) == 0 && access(out, R_OK) == 0) return 0;
    return -1;
}

int main(int argc, char **argv) {
    /* 先抬栈软限：之后 fork/execv 的全部子进程（引导器、原生 ELF）都继承，
     * 自举解释器的深递归与原生通道的深递归同时受益。单次 getrlimit/
     * setrlimit 开销在微秒级，实测不影响 5ms 门禁。 */
    raise_stack_soft_limit();

    /* 无参数：进入 REPL —— 由 JS 侧实现（bin/入口.js），与 `co` 命令一致。
     * 转发失败才退回打印用法。 */
    if (argc < 2) {
        if (转发到cocnjs(argc, argv) != 0) {
            fprintf(stderr, "[coCN] 用法: cocn 程序.co [参数...]\n");
            fprintf(stderr, "[coCN]        cocn <子命令>   （new/publish/search… 见 cocn help）\n");
            fprintf(stderr, "[coCN]        cocn --编译 程序.co 输出可执行文件\n");
            return 1;
        }
        return 0;
    }

    const char *target = argv[1];

    /* 程序参数（argv[2..]）编码进 COCN_ARGV（换行分隔），供层内置 读取命令行
     * 取回。宿主不提供命令行参数能力，此为层扩展；以换行分隔，故参数不应含
     * 换行（CLI 约定）。编译失败兜底解释器与缓存命中 execv 的子进程都继承本
     * 环境变量，三通道口径一致。 */
    {
        static char argv_buf[65536];
        argv_buf[0] = '\0';
        for (int i = 2; i < argc; i++) {
            if (i > 2) strcat(argv_buf, "\n");
            strcat(argv_buf, argv[i]);
        }
        setenv("COCN_ARGV", argv_buf, 1);
    }

    /* 外部可直接调用：cocn --编译 a.co out（等价于 node 入口.js --编译 …） */
    if (strcmp(target, "--编译") == 0) {
        if (argc < 4) { fprintf(stderr, "[coCN] --编译 需要 输入  输出 两个参数\n"); return 1; }
        char self[4096], js[4224], guide[4224], interp[4352], srcdir[4224];
        if (locate(self, sizeof self, js, sizeof js, guide, sizeof guide,
                   interp, sizeof interp, srcdir, sizeof srcdir) != 0) {
            fprintf(stderr, "\033[31m[coCN]\033[0m 无法定位 入口.js\n");
            return 1;
        }
        if (node_compile(js, argv[2], argv[3], 0) != 0) {
            /* node 侧已打印详细原因（非静默模式直通终端），此处只负责退出码 */
            return 1;
        }
        return 0;
    }

    /* 生态子命令 / 选项：转发给 JS 侧（bin/cocn.js → 工具/生态/cli.js）。
     * 判定：argv[1] 命中子命令白名单，或以 '-' 开头且非 --编译（避免把
     * 选项当文件名去 open 而报「找不到文件」）。 */
    {
        static const char *生态命令[] = {
            "new", "install", "add", "remove", "update", "publish", "search",
            "yank", "unyank", "tree", "build", "run", "test", "bench", "doc",
            "fmt", "login", "logout", "link", "help", NULL
        };
        int 需转发 = 0;
        for (int k = 0; 生态命令[k]; k++) {
            if (strcmp(target, 生态命令[k]) == 0) { 需转发 = 1; break; }
        }
        if (!需转发 && target[0] == '-') 需转发 = 1;   /* --编译 已在上方 return */
        if (需转发 && 转发到cocnjs(argc, argv) != 0) {
            fprintf(stderr, "\033[31m[coCN]\033[0m 无法定位 cocn.js，子命令不可用\n");
            return 1;
        }
    }

    /* 立刻把目标解析成绝对路径：兜底通道会 chdir 到 <包>/src 找它的 .co
     * 模块，相对路径在那之后会指向错误目录（实测：cocn 子目录/程序.co 报
     * 「找不到文件」）。 */
    static char 绝对目标[4096];
    if (target[0] != '/') {
        if (getcwd(绝对目标, sizeof 绝对目标)) {
            size_t 用 = strlen(绝对目标);
            if (用 + 1 + strlen(target) + 1 < sizeof 绝对目标) {
                绝对目标[用] = '/';
                strcpy(绝对目标 + 用 + 1, target);
                target = 绝对目标;
                argv[1] = 绝对目标;   /* 让 execv 传出去的也是绝对路径 */
            }
        }
    }

    int fd = open(target, O_RDONLY);
    if (fd < 0) {
        fprintf(stderr, "\033[31m[coCN]\033[0m 找不到文件: %s\n", target);
        return 1;
    }
    /* 按实际文件大小读取：避免一次性申请 16MB 造成无谓缺页 */
    struct stat fst;
    long size = 0;
    if (fstat(fd, &fst) == 0 && fst.st_size > 0) size = (long)fst.st_size;
    if (size > (long)MAXSRC) size = (long)MAXSRC;
    char *src = (char *)malloc(size > 0 ? size : 1);
    long n = (long)read(fd, src, size > 0 ? size : 1);
    close(fd);
    if (n < 0) n = 0;

    unsigned long long h = 1469598103934665603ULL;
    h = fnv1a_update(h, COCN_ABI_STR, (unsigned long long)strlen(COCN_ABI_STR));
    h = fnv1a_update(h, src, (unsigned long long)n);
    free(src);

    const char *home = getenv("HOME");
    if (!home) home = "/tmp";
    char cdir[4096];
    snprintf(cdir, sizeof cdir, "%s/.cocn/cache", home);

    char elf[4224];
    snprintf(elf, sizeof elf, "%s/%016llx", cdir, h);

    /* 路径一：缓存命中 → 直接原生执行
     * COCN_FORCE=解释器 时跳过原生通道（一致性门禁用它拿双通道对照）
     * 代次自检：命中文件必须带本代尾戳，否则当作未命中重编（挡住
     * 手工投毒、跨版本拷贝缓存、旧代产物这三种情况）。 */
    int 强制解释器 = (getenv("COCN_FORCE") && strcmp(getenv("COCN_FORCE"), "解释器") == 0);
    if (!强制解释器 && access(elf, X_OK) == 0 && 产物代次合格(elf)) {
        execv(elf, argv + 1);
        /* execv 失败（缓存损坏/权限）则落到路径二重编 */
    }

    /* 递归建目录：$HOME/.cocn/cache 的父目录可能不存在（首装、HOME 被换），
     * 单层 mkdir 会 ENOENT，导致编译产物写不进去。 */
    if (!is_dir(cdir)) {
        char buf[4096];
        snprintf(buf, sizeof buf, "%s", cdir);
        for (char *p = buf + 1; *p; p++) {
            if (*p == '/') { *p = '\0'; if (!is_dir(buf)) mkdir(buf, 0755); *p = '/'; }
        }
        mkdir(buf, 0755);
    }

    char self[4096], js[4224], guide[4224], interp[4352], srcdir[4224];
    int located = (locate(self, sizeof self, js, sizeof js, guide, sizeof guide,
                          interp, sizeof interp, srcdir, sizeof srcdir) == 0);

    /* 路径二：先试原生编译。产物先写临时名再 rename，避免半截文件被
     * 并发运行的另一个 cocn 当成有效缓存直接 execv。 */
    if (!强制解释器 && located && access(js, R_OK) == 0) {
        char tmp[4400];
        snprintf(tmp, sizeof tmp, "%s.tmp%ld", elf, (long)getpid());
        if (node_compile(js, target, tmp, 1) == 0 && 产物代次合格(tmp)) {
            chmod(tmp, 0755);
            if (rename(tmp, elf) == 0) {
                execv(elf, argv + 1);
            } else {
                execv(tmp, argv + 1);   /* 跨设备/权限：就地执行 */
            }
        }
        /* 不合格（例如生成器读不到 package.json、产物无尾戳）：
         * 不落缓存、不执行，直接删掉走解释器兜底，避免把
         * 「未知代次」的产物固化成缓存。 */
        unlink(tmp);
    }

    /* 路径三：解释执行兜底。原生后端覆盖不到的写法（动态类型容器、
     * 类、并发等）必须照样能跑，只是慢——这是语言可用性的底线。 */
    if (located && access(guide, X_OK) == 0) {
        char *av[3];
        av[0] = guide; av[1] = interp; av[2] = NULL;
        setenv("COCN_TARGET", target, 1);
        setenv("COCN_BACKEND", getenv("COCN_BACKEND") ? getenv("COCN_BACKEND") : "vm", 1);
        if (is_dir(srcdir) && chdir(srcdir) != 0) { /* 切不过去也继续试 */ }
        execv(guide, av);
        fprintf(stderr, "\033[31m[coCN]\033[0m 引导器启动失败: %s\n", strerror(errno));
        return 1;
    }

    fprintf(stderr, "\033[31m[coCN]\033[0m 无法运行 %s：原生编译失败，且找不到引导器\n", target);
    fprintf(stderr, "[coCN] 编译失败通常是源码里用了原生后端暂未支持的写法。\n");
    return 1;
}
