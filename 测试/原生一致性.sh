#!/bin/sh
# 原生编译通道的一致性门禁。
#
# 核心命题：同一份 .co 源码，走【自举解释器】和走【直接机器码产物】，
#          标准输出/标准错误必须逐字节相同、退出码必须相同。
# 只要这条不成立，原生后端就是不可信的——所以它必须进 make check。
#
# 通道说明（v0.1.16 起）：
#   直接机器码 = bin/cocn --编译（内部 node cocn.js --编译 → 机器码生成器.js，
#                产出静态 ELF，不依赖 gcc）
#   解释器对照 = COCN_FORCE=解释器 bin/cocn（强制走 引导器 + src/解释器.co）
#   浮点/真除法 = 直接后端编译期拒绝，只允许兜底通道出结果（0.1.15 的修法）
# 这也顺带把 npm 安装后的真实调用链（cocn → bin/cocn → cocn.js → 生成器）
# 整个过一遍，而不只是单测某个环节——0.1.12 的事故就是链条断裂没人发现。
#
# 用法: 测试/原生一致性.sh [cocn 可执行文件路径]
set -u

CO="${1:-bin/cocn}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
export HOME="$TMP/home"
mkdir -p "$HOME"

PASS=0
FAIL=0
RED=''
GRN=''
END=''
if [ -t 1 ]; then RED='\033[31m'; GRN='\033[32m'; END='\033[0m'; fi

say_fail() {
    printf "${RED}失败${END}: %s\n" "$1"
    FAIL=$((FAIL + 1))
}

# ---- 第一部分：直接机器码子集的双通道逐字节一致性 ----
# 这些用例必须能被 机器码生成器.js 编译；编不了就是回归，不再静默跳过。
CASES="测试/原生/直接子集.co 测试/基准/紧凑基准.co"

echo "---- 直弹子集：原生产物 vs 解释器 ----"
for f in $CASES; do
    printf '%-34s ' "$f"
    if [ ! -f "$f" ]; then say_fail "$f 不存在"; continue; fi

    base="$(basename "$f" .co)"
    io="$TMP/$base.interp.out"; ie="$TMP/$base.interp.err"
    no="$TMP/$base.native.out"; ne="$TMP/$base.native.err"
    bin="$TMP/$base.bin"

    COCN_FORCE=解释器 "$CO" "$f" > "$io" 2> "$ie"; irc=$?
    if [ "$irc" -ne 0 ]; then
        say_fail "解释器执行失败（退出码 $irc）"; sed 's/^/    /' "$ie"; continue
    fi

    if ! "$CO" --编译 "$f" "$bin" > "$TMP/cc.log" 2>&1; then
        say_fail "直接机器码编译失败（子集回归！）"; sed 's/^/    /' "$TMP/cc.log"; continue
    fi

    "$bin" > "$no" 2> "$ne"; nrc=$?
    if [ "$nrc" -ne "$irc" ]; then
        say_fail "退出码不一致（解释器 $irc / 原生 $nrc）"; sed 's/^/    /' "$ne"; continue
    fi
    if ! diff -u "$io" "$no" > "$TMP/diff.txt" 2>&1; then
        say_fail "标准输出不一致"; head -30 "$TMP/diff.txt" | sed 's/^/    /'; continue
    fi
    # 标准错误也必须一致：有了 `输出错误` 之后 stderr 是程序的正式输出通道之一，
    # 只对齐 stdout 是不够的。这些用例都成功退出，stderr 里不会有报错噪音。
    if ! diff -u "$ie" "$ne" > "$TMP/differr.txt" 2>&1; then
        say_fail "标准错误不一致"; head -30 "$TMP/differr.txt" | sed 's/^/    /'; continue
    fi

    printf "${GRN}一致${END}（出 %s 行 / 错 %s 行）\n" \
        "$(wc -l < "$io" | tr -d ' ')" "$(wc -l < "$ie" | tr -d ' ')"
    PASS=$((PASS + 1))
done

# ---- 第二部分：动态特性用例必须能经启动器自动兜底跑通 ----
# DirectGen 不支持的写法（断言/动态类型容器等）由启动器静默回落到解释器；
# 用户视角 `cocn 程序.co` 必须照样得到正确结果。
FALLBACK="测试/原生/列表原生.co 测试/原生/嵌套控制流.co 测试/原生/错误流分离.co 测试/原生/边界与断言.co 测试/原生/字符串边界.co 测试/原生/作用域与全局.co 测试/原生/系统函数原生.co"

echo "---- 自动兜底：cocn 一条命令跑动态用例 ----"
for f in $FALLBACK; do
    base="$(basename "$f" .co)"
    printf '%-34s ' "兜底/$base"
    if [ ! -f "$f" ]; then say_fail "$f 不存在"; continue; fi
    rc=0; "$CO" "$f" > "$TMP/$base.f.out" 2> "$TMP/$base.f.err"; rc=$?
    if [ "$rc" -ne 0 ]; then
        say_fail "兜底执行失败（退出码 $rc）"; sed 's/^/    /' "$TMP/$base.f.err"; continue
    fi
    if ! grep -q "通过" "$TMP/$base.f.out" "$TMP/$base.f.err" 2>/dev/null; then
        say_fail "兜底输出里没有『通过』——用例可能没真跑"; continue
    fi
    printf "${GRN}兜底可跑${END}\n"
    PASS=$((PASS + 1))
done

# ---- 第二·三部分组成：原生专项（解释器慢到没法对照的用例）----
# 有些用例的价值就在「直接机器码能扛住解释器扛不住的东西」，
# 比如深递归：自举两条通道有栈深度守卫（eval 700 层、VM 15000 层，本轮实测），
# 拿它做逐字节对照会把门禁拖死。这类用例只校验原生产物本身。
echo "---- 原生专项：只校验直接产物 ----"
printf '%-34s ' "原生/深递归"
DR="测试/原生/深递归.co"
if [ ! -f "$DR" ]; then
    say_fail "$DR 不存在"
elif ! "$CO" --编译 "$DR" "$TMP/深递归.bin" > "$TMP/深递归.cc" 2>&1; then
    say_fail "深递归用例编译失败（帧尺寸回归？）"; sed 's/^/    /' "$TMP/深递归.cc"
else
    "$TMP/深递归.bin" > "$TMP/深递归.out" 2> "$TMP/深递归.err"; drc=$?
    # 60000 层必须真算出来，且结果正确（不是碰巧少跑几层）
    if [ "$drc" -ne 0 ] || ! grep -q "^深递归:60000$" "$TMP/深递归.out" \
        || ! grep -q "^求和:500500$" "$TMP/深递归.out" \
        || ! grep -q "^校验:对$" "$TMP/深递归.out"; then
        say_fail "60000 层递归没算对（退出码 $drc）"; sed 's/^/    /' "$TMP/深递归.out" | head -5
    else
        printf "${GRN}原生 60000 层通过${END}\n"; PASS=$((PASS + 1))
    fi
fi

# 超出栈保护阈值时必须是【中文报错 + 退出码 3】，绝不能是裸 SIGSEGV(139)。
printf '%-34s ' "原生/栈溢出报错"
printf '%b' '函数 深(整数 n) -> 整数\n    如果 n <= 0 则\n        返回 0\n    结束\n    返回 1 + 深(n - 1)\n结束\n输出 深(2000000)\n' > "$TMP/溢出.co"
if ! "$CO" --编译 "$TMP/溢出.co" "$TMP/溢出.bin" > "$TMP/溢出.cc" 2>&1; then
    say_fail "编译失败"; sed 's/^/    /' "$TMP/溢出.cc"
else
    "$TMP/溢出.bin" > /dev/null 2> "$TMP/溢出.err"; orc=$?
    if [ "$orc" -eq 139 ]; then
        say_fail "又是裸 SIGSEGV（栈哨兵没生效）"
    elif [ "$orc" -ne 3 ]; then
        say_fail "退出码应为 3，实得 $orc"
    elif ! grep -q "栈溢出" "$TMP/溢出.err"; then
        say_fail "报错信息里没有『栈溢出』"; sed 's/^/    /' "$TMP/溢出.err" | head -2
    else
        printf "${GRN}中文报错 + 退出码 3${END}\n"; PASS=$((PASS + 1))
    fi
fi

# ---- 第二·四部分：静默算错类写法必须【拒绝编译】并兜底跑对 ----
# 0.1.15 修的三类坑全是「直接后端给得出结果，但结果是错的」：
#   浮点字面量（2.5 -> 0）、浮点声明（漏进只认整数的打印例程）、真除法 /（7/2 -> 3）。
# 修法是在生成器里编译期抛错，让启动器回落解释器。门禁要盯两件事：
#   1) --编译 必须失败（失败即左移到编译期，不给错误产物）
#   2) 用户敲 cocn 程序.co 必须拿到和解释器逐字节一致的正确输出
REFUSE="测试/原生/浮点兜底.co"

echo "---- 拒绝编译 + 兜底正确：静默算错类写法 ----"
for f in $REFUSE; do
    base="$(basename "$f" .co)"
    printf '%-34s ' "拒编/$base"
    if [ ! -f "$f" ]; then say_fail "$f 不存在"; continue; fi

    if "$CO" --编译 "$f" "$TMP/$base.r.bin" > "$TMP/$base.r.cc" 2>&1; then
        say_fail "竟然编译成功——静默算错的坑没堵住"; continue
    fi
    rc=0; "$CO" "$f" > "$TMP/$base.r.out" 2> "$TMP/$base.r.err"; rc=$?
    if [ "$rc" -ne 0 ]; then
        say_fail "兜底执行失败（退出码 $rc）"; sed 's/^/    /' "$TMP/$base.r.err"; continue
    fi
    COCN_FORCE=解释器 "$CO" "$f" > "$TMP/$base.i.out" 2> "$TMP/$base.i.err"; irc=$?
    if [ "$irc" -ne 0 ]; then
        say_fail "解释器对照失败（退出码 $irc）"; continue
    fi
    if ! diff -u "$TMP/$base.i.out" "$TMP/$base.r.out" > "$TMP/$base.r.diff" 2>&1; then
        say_fail "兜底输出与解释器不一致"; head -20 "$TMP/$base.r.diff" | sed 's/^/    /'; continue
    fi
    printf "${GRN}拒编且兜底一致${END}（出 %s 行）\n" "$(wc -l < "$TMP/$base.r.out" | tr -d ' ')"
    PASS=$((PASS + 1))
done

# ---- 第二·五部分：在案缺陷（只报告，不计通过/失败）----
# 这些用例暴露的是【自举解释器】里先于本次改动存在的问题（用 git stash
# 回到改动前复测，失败信息完全一致）。列在这里是为了不让它们被遗忘，
# 也不允许把它们悄悄算成通过。
# 0.1.16：原来的 4 项（字符串边界/边界与断言/作用域与全局/系统函数原生）
# 已全部修复并移入上面的兜底列表，这里留空转成哨兵——
# 一旦哪天又发现「基线即失败」的用例，先加回这个列表，别悄悄删断言。
echo "---- 在案缺陷（解释器侧，基线即失败）----"
KNOWN=""
for f in $KNOWN; do
    base="$(basename "$f" .co)"
    printf '%-34s ' "在案/$base"
    "$CO" "$f" > /dev/null 2> "$TMP/$base.k.err"; rc=$?
    if [ "$rc" -eq 0 ]; then
        printf "${GRN}已修复！请移入兜底用例列表${END}\n"
    else
        printf "预期失败：%s\n" "$(tail -1 "$TMP/$base.k.err" | head -c 70)"
    fi
done

# ---- 第三部分：错误用例双通道都必须失败（不能一个报错一个静默通过）----
mk() { printf '%b' "$2" > "$TMP/$1.co"; echo "$TMP/$1.co"; }

ERRC="$(mk 除以零 '输出(1 / 0)\n')
$(mk 字符串减法 '输出("a" - "b")\n')
$(mk 字符串越界 '字符串 s = "ab"\n输出(s[5])\n')
$(mk 列表越界 '列表 x = [1]\n输出(x[9])\n')
$(mk 未定义函数 '输出(不存在的函数(1))\n')"

echo "---- 错误路径：两条通道都必须拒绝 ----"
for f in $ERRC; do
    base="$(basename "$f" .co)"
    printf '%-34s ' "错误用例/$base"
    COCN_BACKEND=eval COCN_FORCE=解释器 "$CO" "$f" > /dev/null 2>&1; irc=$?
    if [ "$irc" -eq 0 ]; then say_fail "解释器竟然通过了（应当报错）"; continue; fi

    if ! "$CO" --编译 "$f" "$TMP/$base.bin" > "$TMP/cc.log" 2>&1; then
        # 编译期就拒绝也算正确（错误左移，比运行期更好）
        printf "${GRN}编译期拒绝${END}\n"; PASS=$((PASS + 1)); continue
    fi
    "$TMP/$base.bin" > /dev/null 2>&1; nrc=$?
    if [ "$nrc" -eq 0 ]; then say_fail "原生产物竟然通过了（应当报错）"; continue; fi
    printf "${GRN}运行期拒绝${END}\n"; PASS=$((PASS + 1))
done

# ---- 第四部分：缓存正确性——改源码必须重编，同源码必须命中 ----
echo "---- 编译缓存正确性 ----"
printf '%-34s ' "缓存/同源码命中"
G1="$TMP/缓存探针.co"
printf '%b' '输出("一")\n' > "$G1"
"$CO" "$G1" > "$TMP/c1a.out" 2>/dev/null
"$CO" "$G1" > "$TMP/c1b.out" 2>/dev/null
if [ "$(cat "$TMP/c1a.out")" = "一" ] && [ "$(cat "$TMP/c1b.out")" = "一" ]; then
    printf "${GRN}通过${END}\n"; PASS=$((PASS + 1))
else
    say_fail "重复运行结果不一致"
fi
printf '%-34s ' "缓存/改源码重编"
printf '%b' '输出("二")\n' > "$G1"
"$CO" "$G1" > "$TMP/c2.out" 2>/dev/null
if [ "$(cat "$TMP/c2.out")" = "二" ]; then
    printf "${GRN}通过${END}\n"; PASS=$((PASS + 1))
else
    say_fail "改源码后仍跑旧产物：$(cat "$TMP/c2.out")"
fi

# 多局部变量槽位冲突回归（0.1.16 帧尺寸改动顺带修掉的静默算错）。
# 老实现 tempBase 固定 64：函数里第 65 个以后的局部变量会和临时槽落在同一格，
# 算术结果悄悄错掉——实测 70 个变量的求和函数，旧产物给 4437，正确答案 2485。
# 现在按真实用量开帧，并且 allocVar 带撞槽硬校验，必须和解释器逐字节一致。
printf '%-34s ' "直弹/多局部变量"
python3 - "$TMP/many.co" <<'PYEOF' 2>/dev/null
import sys
L = 70
ls = ["函数 多(整数 p) -> 整数"]
ls += [f"    整数 v{i} = p + {i}" for i in range(L)]
ls += ["    整数 总 = 0"]
ls += [f"    总 = 总 + v{i}" for i in range(L)]
ls += ["    返回 总", "结束", "输出 多(1)"]
open(sys.argv[1], "w").write("\n".join(ls) + "\n")
PYEOF
if [ ! -s "$TMP/many.co" ]; then
    say_fail "用例生成失败（python3 不可用？）"
elif ! "$CO" --编译 "$TMP/many.co" "$TMP/many.bin" > "$TMP/many.cc" 2>&1; then
    # 撞槽校验主动拒绝也算通过——关键是绝不能给出错误答案
    printf "${GRN}编译期拒绝（撞槽校验生效）${END}\n"; PASS=$((PASS + 1))
else
    "$TMP/many.bin" > "$TMP/many.out" 2>&1
    COCN_FORCE=解释器 "$CO" "$TMP/many.co" > "$TMP/many.i.out" 2>&1
    if [ "$(cat "$TMP/many.out")" != "$(cat "$TMP/many.i.out")" ]; then
        say_fail "多局部变量算错：原生 [$(cat "$TMP/many.out")] vs 解释器 [$(cat "$TMP/many.i.out")]"
    elif [ ! -s "$TMP/many.out" ]; then
        say_fail "两边都没有输出"
    else
        printf "${GRN}一致（$(cat "$TMP/many.out")）${END}\n"; PASS=$((PASS + 1))
    fi
fi

# ---- 第四部分之二：升级后代次必须失效（0.1.16 的修法）----
# 缓存指纹若不掺包版本，老用户 ~/.cocn/cache/ 里旧版产物会被原样 execv：
# 0.1.14 那批「算错」的 ELF 正是这么躲过 0.1.15 的修复的（修了等于没修）。
# 这里把【另一份源码】编出的诱饵产物预埋到「旧代次串 cocn-direct-v1」算出的
# 哈希位置；跑真源码时若打印出「旧产物」，说明代次没失效，必须判失败。
printf '%-34s ' "缓存/旧代次作废"
UP="$TMP/代次探针.co"
printf '%b' '输出("新产物")\n' > "$UP"
BAIT="$TMP/诱饵.co"
printf '%b' '输出("旧产物")\n' > "$BAIT"
OLD_HASH=$(node -e '
const M = (1n << 64n) - 1n, fs = require("fs");
let h = 1469598103934665603n;                      // 启动器.c 里的 FNV-1a 基址
for (const b of [Buffer.from("cocn-direct-v1"), fs.readFileSync(process.argv[1])]) {
  for (const c of b) { h ^= BigInt(c); h = (h * 1099511628211n) & M; }
}
process.stdout.write(h.toString(16).padStart(16, "0"));
' "$UP")
if [ -z "$OLD_HASH" ]; then
    say_fail "算不出旧代次哈希（node 不可用？）"
elif ! "$CO" --编译 "$BAIT" "$HOME/.cocn/cache/$OLD_HASH" > "$TMP/bait.cc" 2>&1; then
    say_fail "诱饵产物编译失败，无法验证"; sed 's/^/    /' "$TMP/bait.cc" | head -3
else
    chmod +x "$HOME/.cocn/cache/$OLD_HASH"
    # 诱饵必须是原生 ELF：若源码写法让 --编译 走了兜底，文件其实不是可执行产物，
    # execv 会失败、测试就会假通过（看起来绿、其实没验证到）。这里显式排除。
    if ! head -c 4 "$HOME/.cocn/cache/$OLD_HASH" | grep -q 'ELF'; then
        say_fail "诱饵不是 ELF 产物（--编译 可能被兜底），此项无意义"
    else
    got=$("$CO" "$UP" 2>/dev/null | head -1)
    if [ "$got" = "旧产物" ]; then
        say_fail "命中旧代次缓存——修复对升级用户无效（指纹没掺版本）"
    elif [ "$got" = "新产物" ]; then
        printf "${GRN}旧代次产物已作废${END}\n"; PASS=$((PASS + 1))
    else
        say_fail "输出不对：[$got]"
    fi
    fi
fi

# ---- 第四部分之三：产物 ABI 尾戳自检（0.1.16 的修法）----
# 指纹掺版本只防得住「启动器自己写进缓存」的那批文件；把 --编译 产物
# 手工挪进 ~/.cocn/cache/、或者整目录跨版本拷贝，都不经过指纹。
# 现在每个 ELF 末尾带 32 字节 ABI 尾戳（在 p_filesz 之外，内核不映射，
# 只用来做出厂铭牌），启动器 execv 前核对魔数与代次串。
# 这里用【当前代次的正确指纹】预埋一份尾戳被改成旧代次的合法 ELF：
# 少了尾戳检查，它会被原样 execv 打出「假产物」；检查生效则重编出「真产物」。
printf '%-34s ' "缓存/尾戳自检"
TR="$TMP/尾戳探针.co"
printf '%b' '输出("真产物")\n' > "$TR"
TRBAIT="$TMP/尾戳诱饵.co"
printf '%b' '输出("假产物")\n' > "$TRBAIT"
GATE_ROOT=$(cd "$(dirname "$0")/.." && pwd)
CUR_HASH=$(node -e '
const M = (1n << 64n) - 1n, fs = require("fs");
const abi = "cocn-direct-" + JSON.parse(fs.readFileSync(process.argv[2] + "/package.json", "utf8")).version;
let h = 1469598103934665603n;                      // 启动器.c 里的 FNV-1a 基址
for (const b of [Buffer.from(abi), fs.readFileSync(process.argv[1])]) {
  for (const c of b) { h ^= BigInt(c); h = (h * 1099511628211n) & M; }
}
process.stdout.write(h.toString(16).padStart(16, "0"));
' "$TR" "$GATE_ROOT")
if [ -z "$CUR_HASH" ]; then
    say_fail "算不出当前代次哈希（node 不可用？）"
elif ! "$CO" --编译 "$TRBAIT" "$HOME/.cocn/cache/$CUR_HASH" > "$TMP/trail.cc" 2>&1; then
    say_fail "诱饵产物编译失败，无法验证"; sed 's/^/    /' "$TMP/trail.cc" | head -3
elif ! head -c 4 "$HOME/.cocn/cache/$CUR_HASH" | grep -q 'ELF'; then
    say_fail "诱饵不是 ELF 产物（--编译 可能被兜底），此项无意义"
elif ! node -e '
const fs = require("fs");
const p = process.argv[1];
const b = fs.readFileSync(p);
b.fill(0, b.length - 32);                           // 抹掉整段尾戳
fs.writeFileSync(p, b);
' "$HOME/.cocn/cache/$CUR_HASH"; then
    say_fail "篡改尾戳失败"
else
    chmod +x "$HOME/.cocn/cache/$CUR_HASH"
    got=$("$CO" "$TR" 2>/dev/null | head -1)
    if [ "$got" = "假产物" ]; then
        say_fail "无尾戳的旧产物被执行了——execv 前没做代次自检"
    elif [ "$got" = "真产物" ]; then
        printf "${GRN}无铭牌产物已挡下${END}\n"; PASS=$((PASS + 1))
    else
        say_fail "输出不对：[$got]"
    fi
fi

# ---- 第四部分之四：解释器诚实性（0.1.16 的修法）----
# 这一节专门盯「静默算错」那一类：错了必须报错、不能假装成功，
# 且报的必须是【对的答案】——三条都是反向控制：拿旧 bug 当诱饵，
# 只要修复回退（异常又被吞、输出错误 又变空操作、软标注又串参），
# 这里立刻变红。0.1.15 的门禁就是这么绿着放过一堆错答案的。
# 每条都用显式 OK 标记，而不是拿循环里最后一次退码当判据——
# 后者在「第一个通道就失败并 break」时会漏记失败、还能把 PASS 也加上，
# 而那正是本节点名要消灭的假绿。
printf '%-34s ' "诚实性/越界必须中断"
HN="$TMP/诚实_越界.co"
printf '%b' '变量 表 = [1, 2]\n输出(表[9])\n输出("不该到这")\n' > "$HN"
HOK=1
for HB in vm eval; do
    ho="$TMP/诚实_越界.$HB.out"; he="$TMP/诚实_越界.$HB.err"
    COCN_FORCE=解释器 COCN_BACKEND=$HB "$CO" "$HN" > "$ho" 2> "$he"; hr=$?
    if [ "$hr" -eq 0 ]; then
        say_fail "$HB：越界却退出码 0（异常被吞）"; HOK=0; break
    elif grep -q '不该到这' "$ho"; then
        say_fail "$HB：越界后还继续执行了后续语句"; HOK=0; break
    elif ! grep -q '越界' "$he"; then
        say_fail "$HB：标准错误里没有「越界」字样：[$(head -1 "$he")]"; HOK=0; break
    fi
done
if [ "$HOK" -eq 1 ]; then
    printf "${GRN}两通道均如实报错${END}\n"; PASS=$((PASS + 1))
fi

printf '%-34s ' "诚实性/输出错误非空操作"
HD="$TMP/诚实_双流.co"
printf '%b' '输出("数")\n输出错误("诊")\n' > "$HD"
DOK=1
for HB in vm eval; do
    do_="$TMP/诚实_双流.$HB.out"; de_="$TMP/诚实_双流.$HB.err"
    COCN_FORCE=解释器 COCN_BACKEND=$HB "$CO" "$HD" > "$do_" 2> "$de_"; dr=$?
    if [ "$dr" -ne 0 ]; then
        say_fail "$HB：正常程序却退出码 $dr"; DOK=0; break
    elif [ "$(cat "$do_")" != "数" ]; then
        say_fail "$HB：stdout 应为「数」，实为 [$(cat "$do_")]"; DOK=0; break
    elif [ "$(cat "$de_")" != "诊" ]; then
        say_fail "$HB：输出错误 没写进 stderr（空操作？）[$(cat "$de_")]"; DOK=0; break
    fi
done
if [ "$DOK" -eq 1 ]; then
    printf "${GRN}双流分离属实${END}\n"; PASS=$((PASS + 1))
fi

printf '%-34s ' "诚实性/软标注不串参"
HS="$TMP/诚实_标注.co"
printf '%b' '函数 安全除(数字 a, 数字 b)\n    尝试\n        返回 a / b\n    捕获 e\n        返回 -1\n    结束\n结束\n输出(安全除(10, 2))\n' > "$HS"
SOK=1
for HB in vm eval; do
    so="$TMP/诚实_标注.$HB.out"; se_="$TMP/诚实_标注.$HB.err"
    COCN_FORCE=解释器 COCN_BACKEND=$HB "$CO" "$HS" > "$so" 2> "$se_"; sr=$?
    if [ "$sr" -ne 0 ]; then
        say_fail "$HB：退出码 $sr，[$(head -1 "$se_")]"; SOK=0; break
    elif [ "$(cat "$so")" != "5" ]; then
        say_fail "$HB：安全除(10,2) 应为 5，实为 [$(cat "$so")]（标注把实参错位了）"; SOK=0; break
    fi
done
if [ "$SOK" -eq 1 ]; then
    printf "${GRN}实参绑定正确${END}\n"; PASS=$((PASS + 1))
fi

# ---- 第五部分：错误用例全量三通道审计（0.1.16 新增）----
# 44 个 测试/错误用例/*.co 每一个都必须【被拦下】：
#   解释双通道（eval / vm）：退出码非 0，且 stderr 有中文报错——
#     这一条盯的是「异常被吞、程序假装成功」。
#   原生通道：要么 --编译 编译期拒绝（rc≠0），要么产物退出码非 0；
#     并且必须在 5 秒内结束——这一条盯的是 0.1.16 审计抓到的死循环
#     （对于 … 步长 0 编成 ELF 后无限刷 stdout，timeout 才杀得掉）。
# 任何一条悄悄变成 rc=0，本节就变红。
echo "---- 错误用例全量：三通道必须拦下 ----"
printf '%-34s ' "错误用例/解释双通道拒绝"
EOK=1
E_TOTAL=0
E_BAD=""
for f in 测试/错误用例/*.co; do
    [ -f "$f" ] || continue
    n="$(basename "$f" .co)"
    E_TOTAL=$((E_TOTAL + 1))
    for HB in eval vm; do
        eo="$TMP/err.$n.$HB.out"; ee="$TMP/err.$n.$HB.err"
        COCN_FORCE=解释器 COCN_BACKEND=$HB timeout 20 "$CO" "$f" > "$eo" 2> "$ee"; er=$?
        if [ "$er" -eq 0 ]; then
            E_BAD="$E_BAD $n($HB:rc0)"
        elif [ "$er" -eq 124 ]; then
            E_BAD="$E_BAD $n($HB:挂死)"
        elif [ ! -s "$ee" ]; then
            E_BAD="$E_BAD $n($HB:无stderr)"
        fi
    done
done
if [ "$E_TOTAL" -lt 40 ]; then
    say_fail "只扫到 $E_TOTAL 个用例，用例目录可能被误删"
elif [ -n "$E_BAD" ]; then
    say_fail "漏网：$E_BAD"
else
    printf "${GRN}%d 例 × 2 通道全部拦下${END}\n" "$E_TOTAL"; PASS=$((PASS + 1))
fi

printf '%-34s ' "错误用例/原生拒绝或中断"
NOK=1
N_TOTAL=0
N_REJ=0
N_BAD=""
for f in 测试/错误用例/*.co; do
    [ -f "$f" ] || continue
    n="$(basename "$f" .co)"
    N_TOTAL=$((N_TOTAL + 1))
    nb="$TMP/err.$n.bin"
    if "$CO" --编译 "$f" "$nb" > "$TMP/err.$n.cc" 2>&1; then
        N_REJ=$((N_REJ + 1))
        timeout 5 "$nb" >/dev/null 2>"$TMP/err.$n.ne"; nr=$?
        if [ "$nr" -eq 0 ]; then
            N_BAD="$N_BAD $n(产物rc0)"
        elif [ "$nr" -eq 124 ]; then
            N_BAD="$N_BAD $n(产物挂死)"
        elif [ "$nr" -eq 139 ]; then
            N_BAD="$N_BAD $n(段错误)"
        fi
    fi
done
if [ "$N_TOTAL" -lt 40 ]; then
    say_fail "只扫到 $N_TOTAL 个用例"
elif [ -n "$N_BAD" ]; then
    say_fail "漏网：$N_BAD"
else
    printf "${GRN}%d 例：编译期拒绝 %d / 产物中断 %d${END}\n" \
        "$N_TOTAL" "$((N_TOTAL - N_REJ))" "$N_REJ"; PASS=$((PASS + 1))
fi

# ---- 布尔诚实性：反向控制 0.1.16 的修法 ----
# 布尔是独立类型：打印必须是「真/假」，不能是 1/0；转字符串、拼接同理。
# 旧后端把 布尔 当 int，这三处全静默值错。修复回退时本节立刻变红。
printf '%-34s ' "诚实性/布尔不是整数别名"
BOK=1
BC="$TMP/诚实_布尔.co"
printf '%b' '布尔 d = 假\n让 b = 1 > 0\n输出 b\n输出 d\n输出 转字符串(b)\n输出 "值" + b\n' > "$BC"
"$CO" --编译 "$BC" "$TMP/诚实_布尔.bin" >/dev/null 2>&1 && "$TMP/诚实_布尔.bin" > "$TMP/诚实_布尔.n.out" 2>"$TMP/诚实_布尔.n.err"; nbr=$?
for HB in eval vm; do
    bo="$TMP/诚实_布尔.$HB.out"; be="$TMP/诚实_布尔.$HB.err"
    COCN_FORCE=解释器 COCN_BACKEND=$HB "$CO" "$BC" > "$bo" 2> "$be"; br=$?
    if [ "$br" -ne 0 ]; then
        say_fail "$HB：正常布尔程序退出码 $br [$(head -1 "$be")]"; BOK=0; break
    fi
    if [ "$(cat "$bo")" != "$(printf '真\n假\n真\n值真')" ]; then
        say_fail "$HB：布尔打印不是 真/假：[$(tr '\n' '~' < "$bo")]"; BOK=0; break
    fi
done
if [ "$nbr" -ne 0 ]; then
    say_fail "原生：布尔用例编译或运行失败（rc=$nbr）"; BOK=0
elif [ -f "$TMP/诚实_布尔.n.out" ] && [ "$(cat "$TMP/诚实_布尔.n.out")" != "$(printf '真\n假\n真\n值真')" ]; then
    say_fail "原生：布尔打印不是 真/假：[$(tr '\n' '~' < "$TMP/诚实_布尔.n.out")]"; BOK=0
fi
if [ "$BOK" -eq 1 ]; then
    printf "${GRN}三通道均打印 真/假${END}\n"; PASS=$((PASS + 1))
fi

# ---- 步长 0 必须是中文报错而不是死循环（反向控制）----
printf '%-34s ' "诚实性/步长零不得挂死"
ZOK=1
ZC="$TMP/诚实_步长.co"
printf '%b' '整数 s = 0\n对于 i 从 1 到 3 步长 s 循环\n    输出 i\n结束\n' > "$ZC"
for HB in eval vm; do
    zo="$TMP/诚实_步长.$HB.out"; ze="$TMP/诚实_步长.$HB.err"
    COCN_FORCE=解释器 COCN_BACKEND=$HB timeout 5 "$CO" "$ZC" > "$zo" 2> "$ze"; zr=$?
    if [ "$zr" -eq 0 ] || [ "$zr" -eq 124 ]; then
        say_fail "$HB：步长 0 退出码 $zr（0=被吞，124=挂死）"; ZOK=0; break
    fi
    if ! grep -q '循环步长不能为 0' "$ze"; then
        say_fail "$HB：stderr 里没有「循环步长不能为 0」[$(head -1 "$ze")]"; ZOK=0; break
    fi
done
"$CO" --编译 "$ZC" "$TMP/诚实_步长.bin" >/dev/null 2>&1
if [ -f "$TMP/诚实_步长.bin" ]; then
    timeout 5 "$TMP/诚实_步长.bin" > "$TMP/诚实_步长.n.out" 2>/dev/null; nzr=$?
    # 产物可能因 整数→布尔 之类的静态性拒绝，但绝不允许 rc=0 或挂死
    if [ "$nzr" -eq 0 ] || [ "$nzr" -eq 124 ]; then
        say_fail "原生：动态步长 0 退出码 $nzr（旧行为是无限刷 stdout）"; ZOK=0
    fi
fi
if [ "$ZOK" -eq 1 ]; then
    printf "${GRN}报错退出，无挂死${END}\n"; PASS=$((PASS + 1))
fi

echo "===================================="
if [ "$FAIL" -eq 0 ]; then
    printf " 原生通道一致性门禁通过：%d 项全部一致\n" "$PASS"
    echo "===================================="
    exit 0
else
    printf "${RED}原生通道一致性门禁失败${END}：通过 %d / 失败 %d\n" "$PASS" "$FAIL"
    exit 1
fi
