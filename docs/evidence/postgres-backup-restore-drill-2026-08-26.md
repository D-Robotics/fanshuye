# PostgreSQL 备份恢复演练证据（2026-08-26）

## 范围与隔离

- 时间：2026-08-26 18:44（Asia/Shanghai）
- 环境：仓库 `compose.yaml` 的 `postgres:17-alpine`
- 容器：`newproject3-postgres-1`，演练前后均为 `healthy`
- 隔离策略：仅创建 `fanshuye_drill_src_20260826t184451` 和 `fanshuye_drill_restore_20260826t184451` 两个临时数据库；未把 `fanshuye` 主数据库作为 dump 或 restore 目标
- 归档：PostgreSQL custom format，容器内临时文件，演练结束后删除

## 执行命令

从仓库根目录执行：

```powershell
.\scripts\postgres-backup-restore-drill.ps1 -DrillId 20260826T184451
```

脚本实际执行了以下恢复链路：

1. `pg_isready` 确认 Compose PostgreSQL 可用。
2. 创建隔离源数据库并写入 3 条确定性验证数据。
3. 使用 `pg_dump --format=custom --no-owner --no-privileges` 生成归档。
4. 用 `pg_restore --list` 确认归档包含唯一的验证表数据项，并记录 SHA-256。
5. 创建全新隔离恢复数据库，以 `pg_restore --exit-on-error --no-owner --no-privileges` 恢复。
6. 比较源库和恢复库的行数、数值总和及有序内容 MD5 指纹。
7. 强制断开临时连接后删除两个演练数据库，删除容器内归档，并再次查询系统目录确认清理完成。

## 原始成功输出

```text
RESULT=PASS
drill_id=20260826T184451
source_database=fanshuye_drill_src_20260826t184451
restore_database=fanshuye_drill_restore_20260826t184451
archive_format=custom
archive_sha256=4a6fa9492504da1a992cda184195bc36fc490ed46f926aade208c32051f60fc9
archive_table_data_entries=1
source_fingerprint=3|42|b52ad062ae269a6bf75a4cb2809fdc72
restored_fingerprint=3|42|b52ad062ae269a6bf75a4cb2809fdc72
cleanup_remaining_databases=0
elapsed_ms=3727
```

演练后追加检查：

```text
main_database=1
drill_databases=0
newproject3-postgres-1 ... Up ... (healthy)
```

容器内未找到本次 `/tmp/fanshuye_drill_src_20260826t184451.dump` 临时归档。

## 结论与边界

自定义格式归档可列出、可恢复，恢复内容与源内容指纹完全一致，且所有临时对象已清理。本地小数据集的端到端演练耗时 3.727 秒；该数字只证明当前开发环境链路可执行，不能作为生产数据规模下的 RTO。该验证数据在 dump 前已提交，因此本次样本恢复的数据恢复点无丢失；生产 RPO 仍应由托管 PostgreSQL 的备份频率和时间点恢复策略确定。

发布流程按 [运维手册](../operations.md) 执行：先校验备份和迁移，再发布服务端并验证唯一的 `/health` 探针及认证快照，最后发布桌面客户端。回滚时先回退应用和关闭新入口，数据恢复必须先在隔离库验证。
