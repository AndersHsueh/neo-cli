/**
 * Neo 标题动画状态机（v0.3.1 B1/B2）：fake timer 驱动，不真等 10–20s。
 */
import { describe, expect, test } from "bun:test";
import { TitleAnimator } from "../src/tui/title.ts";
import { displayWidth } from "../src/ui/theme.ts";

interface FakeTimer { fn: () => void; ms: number; cleared: boolean }

function harness(overrides: Partial<ConstructorParameters<typeof TitleAnimator>[0]> = {}) {
  const timers: FakeTimer[] = [];
  const anim = new TitleAnimator({
    rng: () => 0.5, // 固定间隔 15s；字符雨随机位置也确定
    setTimeout: ((fn: () => void, ms: number) => {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    }) as never,
    clearTimeout: ((t: FakeTimer) => {
      t.cleared = true;
    }) as never,
    minSwitchMs: 10_000,
    maxSwitchMs: 20_000,
    flashFrames: 3,
    flashFrameMs: 80,
    ...overrides,
  });
  const pending = (): FakeTimer | undefined => timers.filter((t) => !t.cleared).at(-1);
  const fire = (): void => {
    const t = pending();
    if (!t) throw new Error("没有待触发的 timer");
    t.cleared = true;
    t.fn();
  };
  return { anim, timers, pending, fire };
}

describe("T1 标题状态机（非 neo）", () => {
  test("T1a 普通名字：恒定 Agent: <name>，无 timer", () => {
    const { anim, timers } = harness();
    anim.setName("Trinity");
    const frames: string[] = [];
    anim.start(() => frames.push(anim.getView().text));
    expect(anim.getView()).toEqual({ prefix: "Agent", text: "Trinity", matrix: false });
    expect(timers.length).toBe(0);
    expect(frames.length).toBe(1);
    anim.stop();
  });

  test("T1b 从 neo 改回普通名：立即停 timer、回落 dim 名字", () => {
    const { anim, fire, pending } = harness();
    anim.setName("neo");
    anim.start(() => {});
    expect(pending()?.ms).toBe(15_000);
    anim.setName("Morpheus");
    expect(anim.getView().text).toBe("Morpheus");
    expect(anim.getView().matrix).toBe(false);
    expect(pending()).toBeUndefined();
    expect(() => fire()).toThrow();
    anim.stop();
  });
});

describe("T2 Neo 动画", () => {
  test("T2a 初始 Mr.Anderson；10–20s 后 3 帧雨切到 N E O（绿色），再往复", () => {
    const { anim, pending, fire } = harness();
    anim.setName("neo");
    anim.start(() => {});
    expect(anim.getView()).toEqual({ prefix: "Agent", text: "Mr.Anderson", matrix: false });
    expect(pending()?.ms).toBe(15_000);

    // 触发切换：第 1 帧雨（5 列、绿色、尚未等于 N E O）
    fire();
    expect(anim.getView().matrix).toBe(true);
    expect(displayWidth(anim.getView().text)).toBe(5);
    expect(pending()?.ms).toBe(80);
    expect(anim.getView().text).not.toBe("N E O");

    fire(); // 第 2 帧
    fire(); // 第 3 帧
    fire(); // 第 4 次触发 = 最终 N E O
    expect(anim.getView()).toEqual({ prefix: "Agent", text: "N E O", matrix: true });
    expect(pending()?.ms).toBe(15_000);

    // 切回 Mr.Anderson：11 列、dim
    fire();
    expect(anim.getView().matrix).toBe(false);
    expect(displayWidth(anim.getView().text)).toBe(11);
    fire();
    fire();
    expect(anim.getView()).toEqual({ prefix: "Agent", text: "Mr.Anderson", matrix: false });
    anim.stop();
  });

  test("T2b 每帧字符雨显示宽度 == 目标宽度（防顶线抖动）", () => {
    const { anim, fire } = harness();
    const widths: number[] = [];
    anim.setName("neo");
    anim.start(() => widths.push(displayWidth(anim.getView().text)));
    // 起始 Mr.Anderson + 三帧后 N E O：收集中间每帧宽度
    fire();
    fire();
    fire();
    expect(widths.slice(-4).every((w) => w === 5 || w === 11)).toBe(true);
    expect(widths.at(-1)).toBe(5);
    anim.stop();
  });

  test("T2c 切换间隔每次重新随机（两次间隔不同）", () => {
    // 第 1 次间隔 0 → 10s；随后 3 次字符雨随机字符消耗 0.5；第 2 次间隔 0.999 → 19990ms
    let vals = [0, 0.5, 0.5, 0.5, 0.999];
    const { anim, pending, fire } = harness({ rng: () => vals.shift() ?? 0.5 });
    anim.setName("neo");
    anim.start(() => {});
    const first = pending()?.ms;
    fire();
    fire();
    fire();
    fire(); // 完成 N E O
    const second = pending()?.ms;
    expect(first).toBe(10_000);
    expect(second).toBe(19_990);
    anim.stop();
  });

  test("T2d stop 清 timer / flash；setName(neo) 重启；同名不重启", () => {
    const { anim, timers, pending } = harness();
    anim.setName("neo");
    anim.start(() => {});
    const before = timers.length;
    anim.setName("neo"); // 同名：不重启
    expect(timers.length).toBe(before);
    anim.stop();
    expect(anim.isStarted()).toBe(false);
    expect(anim.getView().text).toBe("Mr.Anderson");
    anim.setName("neo");
    anim.start(() => {});
    expect(pending()?.ms).toBe(15_000);
    anim.stop();
  });
});
