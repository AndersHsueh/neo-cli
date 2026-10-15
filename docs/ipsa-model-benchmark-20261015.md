# ipsa 网关模型测评选型报告

> 测试时间：2026-10-15 11:41–12:15 (GMT+8)
> 测试对象：`settings.json` 中 ipsa provider（base_url `https://ipsapro.isoftstone.com/thor/v1`）
> 测试脚本：`/tmp/ipsa_bench/{probe,bench}.py`（Python 3.13 stdlib，流式 SSE 解析）
> 原始数据：`/tmp/ipsa_bench/result_speed.json`、`result_quiz.json`

## 1. 可用模型清单（GET /models）

chat 候选（supported_endpoint_types 含 openai）：

| 模型 | 上游 | 探测结论 |
|---|---|---|
| `glm-5.3-flash` | — | ✅ 可用，**推理模型**（返回 reasoning_content） |
| `deepseek-flash` | `Deepseek/deepseek-v4.1-flash` | ✅ 可用，直答型（reasoning_tokens=0） |
| `l-deepseek-v4-flash` | `/data/model/deepseek-ai/DeepSeek-V4-Flash-0731` | ⚠️ 能通但极不稳定（见 §3） |
| `gpt-image-2` | — | ❌ 图像模型，chat 返回 400 "operation unsupported"，排除 |

非 chat（不参与选型）：`Qwen3-Embedding-4B`、`Bge-Reranker-Large`、`text-embedding-ada-002`。

## 2. 速度测试（流式，3 次取中位数，任务：写 150 字中文产品介绍，temperature=0.6）

| 模型 | TTFT(首token) | 首内容token | 总时延 | 输出 tok/s | 请求成功率 |
|---|---|---|---|---|---|
| `deepseek-flash` | 2.93s | 2.93s | **3.03s** | 37.3 | 3/3 |
| `glm-5.3-flash` | 3.54s | 9.16s | 9.92s | 50.6 | 3/3 |
| `l-deepseek-v4-flash` | 19.62s | 19.62s | 20.97s | 32.3 | **2/3（1 次 502）** |

注：glm-5.3-flash 的 completion_tokens 中位数 491，其中 376 是 reasoning tokens——先思考约 6s 才出正文。

## 3. l-deepseek-v4-flash 稳定性实录

| 轮次 | 耗时 |
|---|---|
| curl 首次 | 99.7s |
| curl 第二次 | 0.88s |
| curl 第三次 | 79.7s |
| bench run1 | 39.0s |
| bench run2 | 2.9s |
| bench run3 | **HTTP 502** |
| quiz 4/6 题 | 2 题超时（60s/162s 各一），单题 131.8s |

结论：该模型实例处于频繁冷启/排队状态，延迟抖动 0.9s～160s 且会 502。**任何档位均不可用**。注意：`model_routes.fast` 此前正指向该模型（见 §6）。

## 4. 思维测试（6 题，temperature=0，max_tokens=4096）

题目：数学应用题（315km）｜逻辑排序（Carol,Bob,Alice）｜机器陷阱题（5分钟）｜概率题（3/28）｜代码 is_prime｜JSON 指令遵循。

| 模型 | 得分 | 单题平均耗时 | 说明 |
|---|---|---|---|
| `glm-5.3-flash` | **6/6** | ~4.3s | 概率题用两种方法交叉验证；代码为标准 6k±1 实现 |
| `deepseek-flash` | **6/6** | ~2.6s | 逻辑/概率题在正文中展示完整分步推理；代码同样正确 |
| `l-deepseek-v4-flash` | 4/6 | 61～162s | 2 题超时未答完 |

判定修正记录：首轮自动判定有 2 处正则误判（trap 题模型按指令只答裸 "5" 被判 FAIL；glm 概率题答案写成 LaTeX `\dfrac{3}{28}` 未被匹配），已对保存的原文人工复核后修正，未重新发请求。

## 5. 选型结论

候选仅剩 2 个可用 chat 模型：`deepseek-flash`（6/6，3.0s）与 `glm-5.3-flash`（6/6，9.9s，唯一推理模型）。4 个档位分配：

| 档位 | 选定模型 | 理由 |
|---|---|---|
| `default_model_name` | `deepseek-flash` | 思维分与 glm 持平（6/6），速度快 3.3 倍，3/3 全稳定；默认档承担最高频交互，延迟收益最大 |
| `balanced_model_name` | `deepseek-flash` | 同分更快，是质量/速度平衡的最优点 |
| `fast_model_name` | `deepseek-flash` | 无思考开销、TTFT 2.9s，实测最快最稳 |
| `deep_reasoning_model_name` | `glm-5.3-flash` | 唯一具备显式推理链（reasoning_content）的模型，重活/复杂规划场景上限更高；200K 上下文 |

反向备选：若更看重 default 档的推理链与难题上限，可将 `default_model_name` 改回 `glm-5.3-flash`（代价：交互延迟 ×3.3）。

## 6. 未决事项：model_routes 覆盖 provider 档位

`config.ts`（第 335–339 行）中 `model_routes.<tier>.model` 非空时**直接生效**，provider 的档位模型名被忽略。当前 settings.json：

```json
"model_routes": {
  "default":        { "provider": "ipsa", "model": "glm-5.3-flash" },
  "balanced":       { "provider": "ipsa", "model": "glm-5.3-flash" },
  "fast":           { "provider": "ipsa", "model": "l-deepseek-v4-flash" },
  "deep_reasoning": { "provider": "minimax", "model": "MiniMax-M3" }
}
```

影响：
1. 仅改 provider 四字段，CLI 实际使用的模型不变（default/balanced 仍走 glm-5.3-flash）；
2. `fast` 路由指向的 `l-deepseek-v4-flash` 已实测损坏（502 + 超时），必须处理。

建议改法（待社长确认后执行）：将 ipsa 三条路由与档位字段对齐，即 `default`/`balanced`/`fast` 的 model 均改为 `deepseek-flash`；或将这三条的 `model` 置为 null 让它们回落 provider 档位字段（单一数据源，以后只维护 provider 四字段）。`deep_reasoning` 指向 minimax 为原有跨 provider 设计，不动。

## 7. 复现方式

```bash
# 模型清单
curl -s https://ipsapro.isoftstone.com/thor/v1/models \
  -H "Authorization: Bearer <settings.json 中 ipsa api_key>"
# 速度 + 思维（脚本在 /tmp/ipsa_bench/bench.py，模型清单见文件头部常量）
```
