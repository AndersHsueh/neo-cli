# 代码智能 LSP PRD（issue #23）

> 状态：实现中（待审查）
> 关联：GitHub #23。**首期只做「编辑后诊断 + 只读符号导航」**；多语言 server 的自动发现/安装不在范围。

## 1 背景

探索路径只有 `glob`/`grep`/`read_file`：改 TS/Python/Go 时模型常要再开一轮 `tsc`/`pytest` 才发现自己刚引入的类型错误；
找定义只能全文 grep。LSP 是只读情报通道，不引入隔离执行。

## 2 需求（首期）

1. **配置驱动接入**（不捆绑 server）：
   ```json
   "lsp": { "enabled": true, "diagnostics_timeout_ms": 1500,
            "servers": [ { "command": "typescript-language-server", "args": ["--stdio"],
                           "extensions": [".ts", ".tsx", ".js", ".jsx"] } ] }
   ```
   - `extensions` 省略时按 server 名/命令推断（typescript/ts-ls/vtsls → ts 家族；pyright/pylsp → .py；gopls → .go；rust-analyzer → .rs），推断不出就跳过并告警；
   - 未配置 servers = **零开销**（不 spawn、不扫盘）；启动失败的 server 只记 error 状态，不拖垮会话；
   - `diagnostics_timeout_ms` 是「编辑后等新诊断」的上限（默认 1500）。
2. **编辑后诊断**：`write_file` / `edit_file` 成功后，若文件由已连接 server 处理 → 同步文档（didOpen/didChange）
   并等待该文件的新 `publishDiagnostics`（≤ 超时），把摘要（前 10 条，`文件:行:列 [severity] 消息`）附进工具结果；
   无 server / 无诊断 = 结果不变。
3. **只读工具 `lsp`**：`operation = definition | references | hover`，参数 `file` / `line`（1 起）/ `character`（1 起）。
   - 返回 `文件:行:列` 列表（最多 20 处）或 hover 文本（最多 20 行）；
   - 未配置/未连接/没 server 处理该后缀 → **可读错误**（不静默失败）；
   - 非敏感、只读、不可并行标记（不写盘无副作用，但首期先串行）。
4. **协议**：JSON-RPC over stdio + `Content-Length` 帧；initialize/initialized；textDocument/didOpen|didChange；
   publishDiagnostics；definition/references/hover。
5. **生命周期**：会话退出 closeAll()，不留孤儿语言服务器进程。
6. **零配置零开销**：没有 `lsp.servers` 时工具返回「没有可用的语言服务器」并提示配置方式。

## 3 验收

1. 可配置启动本机已安装的语言服务器（至少 TypeScript 路径可用）；
2. write/edit 后把新增诊断注入工具结果（无 server 时行为不变）；
3. `lsp` 工具支持 definition / references / hover；server 未启动时返回可读错误；
4. 文档写明「需自行安装语言服务器二进制；neo 不捆绑、不做沙箱」与关闭方式（`lsp.enabled=false` 或空 servers）；
5. `bun x tsc --noEmit` 零错误、`bun test` 全绿、`bash scripts/verify.sh` 为 `ALL GREEN`。

## 4 非目标 / 后续

- 不捆绑/自动安装语言服务器；不做插件市场；
- 不做 call hierarchy / workspace symbol / rename / completion（后续可基于同一 client 扩展）；
- 不做多 server 同名扩展名的仲裁（首期第一个匹配的 server 生效）；
- 不做 Python/Go/Rust 的专门验证（协议通用；只按配置推断扩展名）；
- 不引入沙箱（项目立场）。
