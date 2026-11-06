# coCN —— 构建与门禁入口
#
# 用法：
#   make build        用本机 cc 构建原生加速器 bin/cocn（可选）
#   make test         语言套件 × 三通道一致性
#   make test-native  原生产物与解释器逐字节对照
#   make coordinates  坐标用例：宿主真值 vs eval/vm
#   make bootstrap    自举门禁：coCN 写的编译器直出机器码
#   make check        test + test-native + coordinates
#   make clean        清理构建产物
#
# 没有 bin/cocn 时测试可用解释器通道：
#   make test CO=bin/cocn.js

# 注意：不能用 CO ?= bin/cocn —— GNU make 自带内置变量 CO=co（COBOL
# 编译器），?= 视为“已定义”而不覆盖，导致 make test 实际去找可执行文件
# “co”而报错。改用 := 强制覆盖内置值；命令行 CO=... 仍可覆盖本行。
CO := bin/cocn

.PHONY: all build test test-native coordinates bootstrap check clean help

all: build

help:
	@sed -n '3,16p' Makefile

build:
	@node install.js

test:
	@bash 测试/套件三通道.sh "$(CO)"

test-native:
	@sh 测试/原生一致性.sh "$(CO)"

coordinates:
	@bash 测试/坐标对照.sh "$(CO)"

bootstrap:
	@sh 测试/自举.sh "$(CO)"

check: test test-native coordinates

clean:
	@rm -f bin/cocn bin/引导器 自举cc 自举输出 自举产物.c
	@rm -rf 工具/原生编译器/build ~/.cocn/cache
	@echo "已清理构建产物"
