/* coCN 原生可执行文件入口 */
void co_main(void);
void rt_flush(void);
int main(int argc, char **argv) {
    (void)argc; (void)argv;
    co_main();
    rt_flush();
    return 0;
}
