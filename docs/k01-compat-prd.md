# K01：旧融合窗口能力委托core（待独立审查）

## 基线与边界

固定neo-cli `029a04018576a11c6d4182f39a482df0696ef3a2` /0.4.91（含#53）；core候选`6e38c30462f3e3c6fc0469cbaa7071f67a6c5993`堆叠于S1 `8adb19b`，不是main。#64及后续main增量待批，本片不实现。

本片四个基础函数只从core唯一构建的`@neo/core-compat/compat/v1`产物调用。本仓删除known表、错误正则/解析与基础fallback算法，只保留configuredExplicit和旧env扩展来源适配，返回原env对象且不改变数值/优先级。不得在旧侧双改已晋升算法；hotfix先core测试/构建，再改本归档与pin。最终TUI/GUI/手机仍纯协议，不得引用此过渡包，不包neo acp。

## 受限离线产物与pin

`vendor/neo-core-compat-v1.tgz`是已经构建的minified JS+DTO声明+清单+provenance，不带原TS/sourcemap/内核源码树；`vendor/compat-pin.json`固定core候选、归档SHA256、core锁和Bun构建器二进制SHA256。只有一个compat/v1包，无registry、邻仓引用或运行时Git请求。精确依赖由package.json及bun.lock固定；Bun本地tgz锁条目无内容digest，因此另有强制校验，不能只凭lock声称防篡改。

安装使用`bun run compat:install`：先校验pin再`bun install --frozen-lockfile`；普通bun install另有root preinstall防线（Bun可能先解析/解压依赖再调用生命周期，不能将它冒称解压前拦截）。`bun run compat:check`可独立校验。`--ignore-scripts`会绕开Bun生命周期，不是受支持的安装验收路径；全量新增pin用例还会核对真实root声明。

SHA256：`6942996c08baaeedec00cce82091116a46877c7f22810c0917f348fc4d2258e4`。core先固定候选→构建并实测两次干净断网同digest→本侧vendor/pin→最后配对登记；归档不嵌归档所在记录commit，避免双SHA循环。

## 验收与回滚

K01a五基线先绿/真实性行为红绿由core记录；本侧六项适配基线先绿，ownership结构红和实际错误pin安装红另存，不把它们当core功能红。新增pin生命周期覆盖digest、有效gzip篡改、候选/锁/工具链、依赖重定向、拒绝后恢复精确pin并安装运行。两仓原verify原样完整通过才交审，不改Matrix1.2协议/检查器/旧TUI路径策略、不安装实机服务。

Bun1.1.0/1.3.0均实测归档冷安装/构建/运行和纯适配链；原仓Bun1.1.0既有env/probe导入statfsSync失败，不属于本片引入，不提高或改写原最低版本，也不宣称整仓1.1全绿。完整闸门最终使用实际宿主Bun1.4.4；构建器固定1.3.0。Bun1.3.0原型原版另有两项CLI测试失败，S1原版WS握手亦超时，均以固定旧快照复现；不以本片顺手修复或静默改变最低版本。

首个兼容产物无上一版tgz。回滚以不可变029a040旧融合快照验证，或普通追加revert本次整组提交；恢复源码/manifest/锁/pin必须成组、先停止旧进程再切，不留活跃双实现。本片不改session格式，旧数据和协议锁不迁移。后续回滚则使用上一个已验归档+pin+锁组合。

证据/过程偏差以仓库外K01报告与原始日志为准，未独立审查前不称已接受、已发布或旧融合可退役。

## 固定配对记录（不反向嵌未来core记录SHA）

core构建候选`6e38c30462f3e3c6fc0469cbaa7071f67a6c5993` → 归档SHA256 `6942996c08baaeedec00cce82091116a46877c7f22810c0917f348fc4d2258e4` → 旧侧pin提交`2048463`。core后续仅记录提交与构建候选分开。旧侧bun.lock SHA256 `22d9f24e7621908096a335939e34ee29ca04c8fc2f3ac456b4cb7e52ba5cc5b5`，pin文件SHA256 `8818e2d2af4dea15fd980452cc67e5327e3871efa8f9bfb454ecc40b488c4c98`。两次干净断网构建相同digest；最终Bun1.1.0/1.3.0冷消费者安装/构建/运行通过。

两仓完整verify已实际ALL GREEN：core190/0，新旧原型2275/0/3skip、PTY32/0；三项skip是原本缺仓外bot-comments源文件，不伪造源文件消skip。固定029a040回滚快照完整verify为2262/0/3skip、PTY32/0。CLI无Matrix protocol.lock；ACP源码未改，core协议锁/源码/检查器原样。

neo-p真实失败/预算耗尽后接管事实与所有失败原始日志保留于外部报告；不宣称整套打包契约均先红。复审通过前不合main/tag/发布。开工及02:42:59北京时间远端main均029a040，无后续main增量；#64待批准，不实现。
