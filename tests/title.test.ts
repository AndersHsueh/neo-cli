/**
 * #82 标题静态渲染：统一 Agent: <名字>，无动画、无定时器。
 */
import { describe, expect, test } from "bun:test";
import { TitleAnimator } from "../src/tui/title.ts";

describe("T1 标题静态状态机", () => {
  test("T1a 普通名字：恒定 Agent: <name>", () => {
    const anim = new TitleAnimator();
    anim.setName("Trinity");
    const frames: string[] = [];
    anim.start(() => frames.push(anim.getView().text));
    expect(anim.getView()).toEqual({ prefix: "Agent", text: "Trinity", matrix: false });
    expect(frames.length).toBe(1);
    anim.stop();
  });

  test("T1b 名字为 neo：仍显示 Agent: neo，不开 Mr.Anderson 动画", () => {
    const anim = new TitleAnimator();
    anim.setName("neo");
    anim.start(() => {});
    expect(anim.getView()).toEqual({ prefix: "Agent", text: "neo", matrix: false });
    anim.stop();
  });

  test("T1c 默认编号名 Neo#1：静态 Agent: Neo#1", () => {
    const anim = new TitleAnimator();
    anim.setName("Neo#1");
    anim.start(() => {});
    expect(anim.getView()).toEqual({ prefix: "Agent", text: "Neo#1", matrix: false });
    anim.stop();
  });

  test("T1d setName 立即切换；start/stop 不注册 timer", () => {
    const origSet = globalThis.setTimeout;
    const origInterval = globalThis.setInterval;
    const calls: string[] = [];
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      calls.push(`timeout:${String(args[1])}`);
      return origSet(...args);
    }) as typeof setTimeout;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      calls.push(`interval:${String(args[1])}`);
      return origInterval(...args);
    }) as typeof setInterval;
    try {
      const anim = new TitleAnimator();
      anim.setName("neo");
      anim.start(() => {});
      anim.setName("Morpheus");
      expect(anim.getView()).toEqual({ prefix: "Agent", text: "Morpheus", matrix: false });
      anim.setName("neo");
      expect(anim.getView()).toEqual({ prefix: "Agent", text: "neo", matrix: false });
      anim.stop();
      expect(anim.isStarted()).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      globalThis.setTimeout = origSet;
      globalThis.setInterval = origInterval;
    }
  });
});
