# RT-3 原始日志与驱动

| 文件 | 内容 |
|---|---|
| `00_harness_Rt3.java.txt` | 验证驱动源码（仓库外 `E:\legadoQ-runtime\rt3\Rt3.java` 的副本，便于复核） |
| `01_rt3_run1.log` | 第 1 遍完整 STRUCT 输出 |
| `02_rt3_run2.log` | 第 2 遍 |
| `03_rt3_run3.log` | 第 3 遍 |

日志格式：`STRUCT|<实验>|thread=<线程名>|<字段>=<值>`，末行 `RT3-END`。

重跑方式见 `20_RT3_RULEDATA_ISOLATION.md` §8。
驱动只通过 `RuleRunner` 公开构造函数注入 `responseFetcher` 替身，不联网、不碰数据库、不改产品源码。
