# K01：旧融合窗口能力委托core（待独立审查）

## 基线与边界

固定neo-cli `029a04018576a11c6d4182f39a482df0696ef3a2` /0.4.91（含#53）；core候选`f90a50ee3b708410658ff68143c1808d7fc4a49f`堆叠于S1 `8adb19b`，不是main。#64及后续main增量待批，本片不实现。

本片四个基础函数只从core唯一构建的`@neo/core-compat/compat/v1`产物调用。本仓删除known表、错误正则/解析与基础fallback算法，只保留configuredExplicit和旧env扩展来源适配，返回原env对象且不改变数值/优先级。不得在旧侧双改已晋升算法；hotfix先core测试/构建，再改本归档与pin。最终TUI/GUI/手机仍纯协议，不得引用此过渡包，不包neo acp。

## 受限离线产物与pin

`vendor/neo-core-compat-v1.tgz`是已经构建的minified JS+DTO声明+清单+provenance，不带原TS/sourcemap/内核源码树；`vendor/compat-pin.json`固定core候选、归档SHA256、core锁和Bun构建器二进制SHA256。只有一个compat/v1包，无registry、邻仓引用或运行时Git请求。精确依赖由package.json及bun.lock固定；Bun本地tgz锁条目无内容digest，因此另有强制校验，不能只凭lock声称防篡改。

安装使用`bun run compat:install`：先校验pin再`bun install --frozen-lockfile`；普通bun install另有root preinstall防线（Bun可能先解析/解压依赖再调用生命周期，不能将它冒称解压前拦截）。`bun run compat:check`可独立校验。`--ignore-scripts`会绕开Bun生命周期，不是受支持的安装验收路径；全量新增pin用例还会核对真实root声明。

SHA256：`d1cd54b14e42263a9aa1dbe511f94142c3efc989e5d03d2abea3518f8dfcb83a`。core先固定候选→构建并实测两次干净断网同digest→本侧vendor/pin→最后配对登记；归档不嵌归档所在记录commit，避免双SHA循环。

## 验收与回滚

K01a五基线先绿/真实性行为红绿由core记录；本侧六项适配基线先绿，ownership结构红和实际错误pin安装红另存，不把它们当core功能红。新增pin生命周期覆盖digest、有效gzip篡改、候选/锁/工具链、依赖重定向、拒绝后恢复精确pin并安装运行。两仓原verify原样完整通过才交审，不改Matrix1.2协议/检查器/旧TUI路径策略、不安装实机服务。

Bun1.1.0/1.3.0均实测归档冷安装/构建/运行和纯适配链；原仓Bun1.1.0既有env/probe导入statfsSync失败，不属于本片引入，不提高或改写原最低版本，也不宣称整仓1.1全绿。完整闸门在Bun1.3.0实跑。

首个兼容产物无上一版tgz。回滚以不可变029a040旧融合快照验证，或普通追加revert本次整组提交；恢复源码/manifest/锁/pin必须成组、先停止旧进程再切，不留活跃双实现。本片不改session格式，旧数据和协议锁不迁移。后续回滚则使用上一个已验归档+pin+锁组合。

证据/过程偏差以仓库外K01报告与原始日志为准，未独立审查前不称已接受、已发布或旧融合可退役。
