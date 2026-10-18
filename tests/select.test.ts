/**
 * select 组件测试（PRD §8）。
 *
 * 本文件当前只覆盖纯状态机 reduce() —— bun test 直测的文本 oracle。
 * select() 集成测试（假 router + 假 stdout）在组件主体落盘后补。
 *
 * 运行：bun test tests/select.test.ts
 */
import { describe, expect, test } from "bun:test";

import { reduce, select, type SelectOption, type SelectState } from "../src/ui/select.ts";
import { displayWidth } from "../src/ui/theme.ts";

const st = (cursor: number, scroll: number): SelectState => ({ cursor, scroll });

describe("reduce · up/down clamp", () => {
  test("到顶后 up 不再动", () => {
    expect(reduce(st(0, 0), { type: "up" }, 5, 10)).toEqual(st(0, 0));
  });

  test("到底后 down 不再动", () => {
    expect(reduce(st(4, 0), { type: "down" }, 5, 10)).toEqual(st(4, 0));
  });

  test("窗口内 up/down 只动 cursor", () => {
    expect(reduce(st(2, 0), { type: "up" }, 5, 10)).toEqual(st(1, 0));
    expect(reduce(st(2, 0), { type: "down" }, 5, 10)).toEqual(st(3, 0));
  });
});

describe("reduce · 滚动窗口跟随", () => {
  test("cursor 下移越出窗口底 → scroll 下滑", () => {
    // viewport=3，cursor 从 2（窗口底）down 到 3 → 窗口 [1,4)
    expect(reduce(st(2, 0), { type: "down" }, 8, 3)).toEqual(st(3, 1));
  });

  test("cursor 上移越出窗口顶 → scroll 上滑", () => {
    // 窗口 [2,5)，cursor 从 2 up 到 1 → 窗口 [1,4)
    expect(reduce(st(2, 2), { type: "up" }, 8, 3)).toEqual(st(1, 1));
  });

  test("长列表连续 down：scroll 跟随到最后一屏", () => {
    // 10 项、viewport 3，从 0 一路 down 到底：cursor 9、窗口 [7,10)
    let s = st(0, 0);
    for (let i = 0; i < 9; i++) s = reduce(s, { type: "down" }, 10, 3);
    expect(s).toEqual(st(9, 7));
  });
});

describe("reduce · goto", () => {
  test("定位到指定下标，越界 clamp", () => {
    expect(reduce(st(0, 0), { type: "goto", index: 4 }, 8, 3)).toEqual(st(4, 2));
    expect(reduce(st(0, 0), { type: "goto", index: -1 }, 8, 3)).toEqual(st(0, 0));
    expect(reduce(st(0, 0), { type: "goto", index: 99 }, 8, 3)).toEqual(st(7, 5));
  });
});

describe("reduce · resize", () => {
  test("缩窗后 scroll 重算，cursor 拉回可见范围", () => {
    // 窗口 [0,5) cursor 4 → 缩到 3 行 → 窗口 [2,5)
    expect(reduce(st(4, 0), { type: "resize", viewportRows: 3 }, 8, 3)).toEqual(st(4, 2));
  });

  test("扩窗后 scroll 夹回 0", () => {
    // 窗口 [4,7) → 扩到 10 行 → scroll 夹到 max(0, 8-10)=0
    expect(reduce(st(6, 4), { type: "resize", viewportRows: 10 }, 8, 10)).toEqual(st(6, 0));
  });

  test("viewportRows 防御：0 按 1 处理", () => {
    expect(reduce(st(3, 0), { type: "resize", viewportRows: 0 }, 8, 0)).toEqual(st(3, 3));
  });
});

describe("reduce · 边界", () => {
  test("0 选项返回零态不崩", () => {
    expect(reduce(st(0, 0), { type: "down" }, 0, 10)).toEqual(st(0, 0));
  });

  test("1 选项：up/down 都停在 0", () => {
    expect(reduce(st(0, 0), { type: "up" }, 1, 10)).toEqual(st(0, 0));
    expect(reduce(st(0, 0), { type: "down" }, 1, 10)).toEqual(st(0, 0));
  });

  test("窗口大于选项数：scroll 恒 0", () => {
    expect(reduce(st(1, 0), { type: "down" }, 3, 10)).toEqual(st(2, 0));
  });
});

/* ------------------------------------------------------------------ */
/* select() 集成（假 router + 假 stdout，不碰真实 TTY）                */
/* ------------------------------------------------------------------ */

/** 假 router：记录 handler，测试里手动 emit 按键。 */
class FakeRouter {
  private map = new Map<string, Array<() => void>>();
  on(key: string, fn: () => void): () => void {
    const list = this.map.get(key) ?? [];
    list.push(fn);
    this.map.set(key, list);
    return () => {
      const cur = this.map.get(key) ?? [];
      const i = cur.indexOf(fn);
      if (i !== -1) cur.splice(i, 1);
    };
  }
  emit(key: string): void {
    for (const h of [...(this.map.get(key) ?? [])]) h();
  }
  get size(): number {
    return [...this.map.values()].reduce((n, l) => n + l.length, 0);
  }
}

/** 假 stdout：收集写入、记录 resize 监听。 */
class FakeOut {
  chunks: string[] = [];
  resizeFns: Array<() => void> = [];
  write(s: string): void {
    this.chunks.push(s);
  }
  on(_ev: "resize", fn: () => void): void {
    this.resizeFns.push(fn);
  }
  off(_ev: "resize", fn: () => void): void {
    const i = this.resizeFns.indexOf(fn);
    if (i !== -1) this.resizeFns.splice(i, 1);
  }
  text(): string {
    return this.chunks.join("");
  }
  resize(): void {
    for (const f of [...this.resizeFns]) f();
  }
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");

const opts3 = (): SelectOption<string>[] => [
  { label: "alpha", value: "A" },
  { label: "beta", value: "B" },
  { label: "gamma", value: "G" },
];

describe("select() 集成", () => {
  test("down down up enter → 返回正确 value", async () => {
    const router = new FakeRouter();
    const p = select("选一个", opts3(), { router: router as never, out: new FakeOut() as never, isTTY: true, graceMs: 0 });
    router.emit("down");
    router.emit("down");
    router.emit("up");
    router.emit("enter");
    expect(await p).toBe("B");
  });

  test("esc → null", async () => {
    const router = new FakeRouter();
    const p = select("q", opts3(), { router: router as never, out: new FakeOut() as never, isTTY: true, graceMs: 0 });
    router.emit("escape");
    expect(await p).toBeNull();
  });

  test("initial 定位：直接 enter 返回 initial 项", async () => {
    const router = new FakeRouter();
    const p = select("q", opts3(), { router: router as never, out: new FakeOut() as never, isTTY: true, graceMs: 0, initial: 2 });
    router.emit("enter");
    expect(await p).toBe("G");
  });

  test("打开宽限窗：窗内 enter 视为残留忽略（bun line→keypress 延迟派发回归）", async () => {
    const router = new FakeRouter();
    const p = select("q", opts3(), {
      router: router as never,
      out: new FakeOut() as never,
      isTTY: true,
      graceMs: 30, // 30ms 窗：窗内忽略、窗外放行
    });
    router.emit("enter"); // 模拟「打开菜单的那次回车」的残留 keypress → 忽略
    router.emit("down"); // 同样被忽略
    await new Promise((r) => setTimeout(r, 60)); // 出窗
    router.emit("enter"); // 真实确认
    expect(await p).toBe("A"); // cursor 未动（down 被忽略），停在 initial 0
  });

  test("graceMs: 0 关闭宽限窗（测试路径）", async () => {
    const router = new FakeRouter();
    const p = select("q", opts3(), {
      router: router as never,
      out: new FakeOut() as never,
      isTTY: true,
      graceMs: 0,
    });
    router.emit("down");
    router.emit("enter");
    expect(await p).toBe("B");
  });

  test("C9：onActiveChange 携带的 cancel 函数可取消选择（SIGINT 路径）", async () => {
    const router = new FakeRouter();
    let cancelFn: (() => void) | undefined;
    const p = select("q", opts3(), {
      router: router as never,
      out: new FakeOut() as never,
      isTTY: true,
      graceMs: 0,
      onActiveChange: (active, cancel) => {
        cancelFn = cancel; // 与 index.ts 接线一致：无条件赋值，false 时清引用
      },
    });
    expect(typeof cancelFn).toBe("function");
    cancelFn!(); // 模拟 SIGINT 处理器路由 Ctrl+C
    expect(await p).toBeNull();
    expect(cancelFn).toBeUndefined(); // 结束后回调以 undefined 清引用
  });

  test("注销干净（C3）：结束后 router 无残留 handler、out 无 resize 监听", async () => {
    const router = new FakeRouter();
    const out = new FakeOut();
    const p = select("q", opts3(), { router: router as never, out: out as never, isTTY: true, graceMs: 0 });
    router.emit("escape");
    await p;
    expect(router.size).toBe(0);
    expect(out.resizeFns.length).toBe(0);
  });

  test("resize 触发重画（C13）", async () => {
    const router = new FakeRouter();
    const out = new FakeOut();
    const p = select("q", opts3(), { router: router as never, out: out as never, isTTY: true, graceMs: 0 });
    const framesBefore = out.chunks.length;
    router.emit("down");
    out.resize();
    expect(out.chunks.length).toBeGreaterThan(framesBefore);
    router.emit("escape");
    await p;
  });

  test("非 TTY 回退：数字选择成功 / 非法输入 null（F8）", async () => {
    const a = await select("q", opts3(), {
      router: new FakeRouter() as never,
      out: new FakeOut() as never,
      isTTY: false,
      asker: async () => "2",
    });
    expect(a).toBe("B");
    const b = await select("q", opts3(), {
      router: new FakeRouter() as never,
      out: new FakeOut() as never,
      isTTY: false,
      asker: async () => "x",
    });
    expect(b).toBeNull();
    const c = await select("q", opts3(), {
      router: new FakeRouter() as never,
      out: new FakeOut() as never,
      isTTY: false,
    });
    expect(c).toBeNull();
  });

  test("CJK 截断：超宽 label 不产生超宽行（C6）", async () => {
    const router = new FakeRouter();
    const out = new FakeOut();
    const wide: SelectOption<number>[] = Array.from({ length: 15 }, (_, i) => ({
      label: `选项${i}测试中文超宽标签内容`,
      value: i,
    }));
    const p = select("q", wide, {
      router: router as never,
      out: out as never,
      isTTY: true,
      graceMs: 0,
      columns: () => 20,
    });
    const firstFrame = out.text(); // 首帧在 select() 调用时同步画出
    router.emit("escape");
    await p;
    const rows = firstFrame.split("\n").slice(1); // 第 0 行是 question
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(displayWidth(stripAnsi(r))).toBeLessThanOrEqual(20);
    }
  });
});
